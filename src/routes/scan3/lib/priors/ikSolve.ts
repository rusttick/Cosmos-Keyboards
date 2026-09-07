/**
 * The per-frame solver: given one tracked hand-camera frame and the current `HandPriorState`, produce
 * a pose (joint angles) that's pulled toward whatever the prior model is currently confident about,
 * so a single bad or noisy frame doesn't get displayed as if it were real anatomy. Where the prior is
 * still wide/unconfident, the tracked data is barely resisted and effectively passes through
 * unchanged -- there isn't yet anatomy to trust over it.
 *
 * This solves ONE frame at a time, with no memory of the previous frame (no warm start, no temporal
 * smoothness) -- an intentional simplification for this first version, not an oversight; worth
 * revisiting only if a jittery frame-to-frame result actually shows up once this is wired into a live
 * view.
 *
 * The wrist, forearm, and elbow are a different kind of variable from every finger joint above: no
 * camera-tracked landmark observes any of them directly (see `handModel.ts`'s own doc comment on this
 * group), so they never get a "does this match the tracked frame" pull the way a finger joint does --
 * only their own anatomical belief, and whichever named correlations to the rest of the pose currently
 * apply. Right now that's just one: a confident, currently-flexed set of fingers pulls the wrist toward
 * the posture that goes with that (the "tenodesis" effect -- bending the wrist back tends to curl the
 * fingers, and the reverse read is what this solver actually uses, since the fingers are what's
 * observed). The other two named correlations in `handModel.ts` (forearm length's link to stature, and
 * the elbow-swivel geometric criterion) are real gaps this file doesn't fill: the first is a
 * length-estimation question for a future cross-session update step, not a per-frame pose correction;
 * the second needs an actual 3D geometric computation against the solved wrist pose, not a linear
 * coefficient, and `handModelData.ts`'s own seed value already says as much. Both stay exactly at
 * whatever `HandPriorState` already holds until something actually implements them.
 *
 * A note on what "comparing predicted vs. tracked landmark positions" reduces to here: this project's
 * existing `SolvedHand.fromLimbs()` already computes, directly and without any correction, the one
 * best-fitting angle for a joint from that joint's own raw tracked bone direction and its own fixed
 * calibration frame -- it does this per joint, using only that joint's own data, never anything
 * upstream's *current guess*. That means "how far is a candidate angle from what the raw tracking
 * data alone would say" is already exactly what a walk down `fromLimbs`' own per-joint direction
 * recovery computes, joint by joint; there's no separate 3D-position math this file needs to redo to
 * get the same answer. So the "does this pose match the tracked frame" half of the correction below is
 * just: recover every joint's raw-data angle once per frame this same way, then treat each of those as
 * one input the corrected pose gets pulled toward, the same way a prior mean or a coupling-predicted
 * value is. This file recovers those angles directly (`trackedPose`, below) rather than by calling
 * `fromLimbs` and reading the result back off with `decomposeAngles`: that pair builds a rotation
 * matrix with one Euler axis order and reads it back with a different one, which only agrees with the
 * original two angles when one of them happens to be exactly zero -- fine for this project's existing
 * uses of `decomposeAngles` (they only ever read a joint whose other axis is always zero), not fine
 * here, where a knuckle bent and splayed at the same time is an entirely ordinary thing to see.
 *
 * The actual correction is done by repeatedly nudging every angle toward a weighted average of
 * everything currently pulling on it (its raw tracked value, its anatomical range-of-motion belief,
 * and whatever it's coupled to), then repeating until it settles -- simpler to get right than a general
 * nonlinear solver, and exact for this kind of problem (every pull is a plain squared-distance
 * penalty), just slower to converge in principle. In practice a fixed number of passes is enough,
 * since every angle here is anchored fairly strongly to its own tracked value and its own prior --
 * nothing pulls hard enough to need many passes to settle.
 */

import type { Finger, Hand, Joint, Joints } from '$lib/hand'
import { CONNECTIONS, FINGERS, SolvedHand } from '$lib/hand'
import { Euler, Matrix4, Vector3 } from 'three'
import type { BetaRom, HandPriorState, NonThumbFinger } from './handModel'

function clampUnit(x: number): number {
  return Math.max(-1, Math.min(1, x))
}

const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI

/** One finger's four joints, each with the two angles `SolvedHand.fkBy`/`decomposeAngles` use
 * (flexion/extension and side-to-side pan). A joint that doesn't actually have one or both of these
 * DOF (per its `degree`) just carries an unused 0 there -- `fkBy` already ignores whichever angles a
 * joint's `degree` doesn't call for. */
export type Pose = Record<Finger, { angleZ: number; angleY: number }[]>

/** The wrist/forearm/elbow angles, radians -- degrees of freedom this project's hand-tracking skeleton
 * has no landmark chain for at all (there's no bone-chain data structure proximal to the wrist the way
 * `Joints`/`CONNECTIONS` gives every finger), so they're solved as five plain scalars alongside `Pose`
 * rather than through it. */
export interface WristForearmPose {
  wristFlexExt: number
  wristRadialUlnar: number
  forearmPronationSupination: number
  elbowFlexion: number
  elbowSwivelAngle: number
}

export interface SolveResult {
  pose: Pose
  wristForearm: WristForearmPose
  /** How far the corrected pose still sits from this frame's raw tracked data, summed across every
   * joint, weighted the same way each joint's own data pull was weighted. Small: the prior barely had
   * to correct anything. Large: either this frame's tracking is bad, or the prior itself doesn't fit
   * this hand well yet -- a live diagnostic, not something this file interprets further. Covers only
   * the finger joints above -- `wristForearm` has no tracked data to compare against at all (see the
   * module doc comment), so there's nothing to include here for it. */
  residual: number
}

function emptyPose(): Pose {
  return Object.fromEntries(FINGERS.map(f => [f, [0, 1, 2, 3].map(() => ({ angleZ: 0, angleY: 0 }))])) as Pose
}

/** This project's hand-tracking skeleton represents the thumb with one extra joint (a
 * wrist-to-thumb-base segment with no real bone behind it) and gives its base joint (the true CMC) two
 * driven axes plus a derived twist, where index/middle's own base segment is rigid (no real rotation of
 * its own). Ring and pinky are the other exception to that rigid base segment: each flexes a small,
 * independent amount of its own toward the palm (see `calculateJoints`'s own doc comment in `hand.ts`),
 * so their base segment gets one driven axis instead of none. Everything past that (what this
 * project's own tooling already calls the thumb's "MCP" and "IP", by the same generic joint-position
 * convention flexion-fitting code elsewhere uses) is a plain one-axis hinge, same as the other fingers'
 * two outer joints.
 *
 * Every non-thumb finger's knuckle (MCP) is `degree: 3`, the same shape as the thumb CMC: two driven
 * axes (flexion, ab/ad) plus a derived third rotation -- `goals.md`'s documented flexion-phase-dependent
 * axial twist (4D-CT studies: e.g. the index finger pronates through early flexion, supinates through
 * late flexion), read from `mcpAxes[finger].axialRotationWeight` in `buildDefaultSkeleton` below via the
 * exact same `ConjunctCoupling` mechanism `$lib/hand.ts`'s `fkBy`/`fromLimbs` already implement
 * generically for any `degree: 3` joint -- not a new FK case, just a new caller of the existing one.
 * `calculateJoints`'s real per-user fitting (producing a `degree: 3` MCP with a *fitted*, not seeded,
 * `axialRotationWeight`/`conjunctCoupling` from captured motion, the way `thumbCmc.ts` does for the CMC)
 * is a separate, larger task this doesn't attempt -- every real scan still produces `degree: 2` MCP
 * joints today, so this only takes effect for `buildDefaultSkeleton`'s population-prior fallback until
 * that fitting exists. */
function degreesFor(finger: Finger): (0 | 1 | 2 | 3)[] {
  if (finger === 'thumb') return [0, 3, 1, 1]
  if (finger === 'ringFinger' || finger === 'pinky') return [1, 3, 1, 1]
  return [0, 3, 1, 1]
}

/** Joint-0 splay for the four non-thumb fingers, shared by `buildDefaultSkeleton` and
 * `buildRestExtensionSkeleton`: how much each finger's base fans out from a pure collinear reach,
 * relative to the middle finger (always 0, the reference). Derived geometrically (law of cosines) from
 * two things `HandPriorState` actually models: each finger's own metacarpal length
 * (`boneLengths.fingers[finger].mean[0] * handLength`) and the measured adjacent MCP-to-MCP spacing
 * (`boneLengths.knuckleRow`) -- given two known side lengths of a triangle (the two fingers' wrist-to-
 * MCP reaches) and the known third side (the measured gap between their MCPs), the angle between the
 * two reaches is exactly recoverable, no assumption needed beyond "these three points form a
 * triangle." Replaces an earlier version of this function that used a single fixed, uncited fan angle
 * (`KNUCKLE_FAN_DEG = 10`) with no real length behind it at all -- back-computing what that angle
 * implied for actual MCP spacing gave ~12/8/6mm for the three gaps, well under a real adult hand's
 * ~15-20mm, confirmed directly once `/bones`' numbered-landmark view made the mismatch visible. Assumes
 * the four MCPs lie close to one straight line (true near full extension, the pose this mostly matters
 * for) so adjacent angles can simply be summed for a non-adjacent pair (e.g. index-to-ring) -- a
 * reasonable approximation, not an exact geometric claim. */
function knuckleRowSplayDeg(prior: HandPriorState): Record<NonThumbFinger, number> {
  const handLength = prior.boneLengths.handLength.mean
  const metacarpalMM = (f: NonThumbFinger) => prior.boneLengths.fingers[f].mean[0] * handLength
  const gapMM = prior.boneLengths.knuckleRow.mean.map(ratio => ratio * handLength)

  function angleBetween(l1: number, l2: number, gap: number): number {
    if (l1 <= 0 || l2 <= 0) return 0
    const cos = clampUnit((l1 ** 2 + l2 ** 2 - gap ** 2) / (2 * l1 * l2))
    return (Math.acos(cos) * 180) / Math.PI
  }

  const indexMiddle = angleBetween(metacarpalMM('indexFinger'), metacarpalMM('middleFinger'), gapMM[0])
  const middleRing = angleBetween(metacarpalMM('middleFinger'), metacarpalMM('ringFinger'), gapMM[1])
  const ringPinky = angleBetween(metacarpalMM('ringFinger'), metacarpalMM('pinky'), gapMM[2])

  return {
    indexFinger: indexMiddle,
    middleFinger: 0,
    ringFinger: -middleRing,
    pinky: -(middleRing + ringPinky),
  }
}

/** The thumb splays far more aggressively away from the finger row than any finger-to-finger gap --
 * same sign as `knuckleRowSplayDeg`'s own `indexFinger` entry (both positive in the base, unmirrored
 * convention) so the thumb lands on the index side, not the pinky side -- getting this wrong isn't just a cosmetic
 * mirroring bug, it's an anatomically impossible hand (thumb and pinky on the same side). A fixed,
 * clearly-thumb-shaped placeholder angle, not a fitted or cited one. */
const THUMB_SPLAY_DEG = 45

/** A hand skeleton built purely from `HandPriorState`, with no per-user calibration behind it -- for
 * use before any real scan exists (e.g. an evaluation page loaded with only the population prior). A
 * real, calibrated skeleton (once a scan has actually fit one) should be used instead whenever one is
 * available; this is the fallback, not the preferred path.
 *
 * Each joint's own local axis orientation (`V`/`Vinv`) is a real per-user calibration fact this
 * project only ever gets from fitting actual captured motion (`fitNorms`/`averageNorms`) -- there's no
 * literature source or population prior for it, and `HandPriorState` doesn't model it. Every joint
 * past joint 0 is still built as the identity for exactly that reason: a plain, honest placeholder,
 * not a real anatomical estimate, for a fact this project genuinely doesn't have yet.
 *
 * Joint 0 is the one exception, and deliberately so: `V`/`Vinv` identity there doesn't just mean "no
 * per-user calibration" the way it does elsewhere -- it makes every finger's knuckle-row landmark (5,
 * 9, 13, 17) sit exactly collinear along the same ray from the wrist, *regardless of pose*, since
 * joint 0 (index/middle/thumb's rigid metacarpal, `degree: 0`) has no driven rotation at all, and
 * ring/pinky's own joint 0 (`degree: 1`) drives only flexion, never ab/ad. No live tracked pose can
 * un-collapse that -- only a non-identity joint-0 *frame* can -- so identity there isn't a neutral
 * placeholder the way it is for every other joint; it's a structurally degenerate one that made every
 * corrected view built on this skeleton (multi-view's 8 side tiles, its center overlay) read as an
 * implausible, tearing-apart hand regardless of how good the rest of the model was (confirmed live,
 * 2026-09-06 -- see docs/thumbs/mv1.png). `knuckleRowSplayDeg`/`THUMB_SPLAY_DEG` (module-level, shared
 * with `buildRestExtensionSkeleton`) fix that -- `knuckleRowSplayDeg` from a real measured span
 * (`boneLengths.knuckleRow`, see its own doc comment) once one exists, `THUMB_SPLAY_DEG` still an
 * eyeballed placeholder every real scan will eventually replace with a fitted one.
 *
 * `handedness` DOES matter here, despite `hand.limbs` already being run through `makeHand`'s own
 * chirality-reversal correction (`makeBasis`'s `reverse` parameter in `$lib/hand.ts`) -- an earlier
 * version of this doc comment assumed that correction made one fixed splay convention agree with real
 * tracked data for both real-world hands, and reasoned this parameter away entirely. Wrong: confirmed
 * directly against a live capture, 2026-09-06 -- with no `handedness` parameter (the fixed convention
 * below, unmirrored), a real Right hand's corrected model put the thumb on the pinky side while a real
 * Left hand fit correctly. `handedness: 'Left'` is exactly that pre-existing fixed convention
 * (`mirror = 1`); `'Right'` negates it. Defaults to `'Left'` so callers that only care about
 * self-consistent round-tripping (most of this file's own tests) don't need updating -- any caller
 * solving a real tracked frame must pass the frame's own real `handedness` explicitly. */
export function buildDefaultSkeleton(prior: HandPriorState, handedness: 'Left' | 'Right' = 'Left'): Joints {
  const nonThumb = FINGERS.filter((f): f is NonThumbFinger => f !== 'thumb')
  const mirror = handedness === 'Left' ? 1 : -1
  const skeleton = Object.fromEntries(
    FINGERS.map(finger => {
      const degrees = degreesFor(finger)
      const bones = prior.boneLengths.fingers[finger]
      const handLength = prior.boneLengths.handLength.mean
      const joints: Joint[] = degrees.map((degree, i) => {
        const length = bones.mean[i] * handLength
        const V = new Matrix4()
        const Vinv = new Matrix4()
        if (degree === 0) return { length, degree: 0, position: new Vector3(1, 0, 0), V, Vinv }
        if (degree === 3) {
          // r2 isn't part of this project's prior model (see handModel.ts) -- 0 here just satisfies
          // the existing `ConjunctCoupling` type, it isn't a real fit-quality claim.
          if (finger === 'thumb') {
            const [aCoeff, bCoeff] = prior.cmcMobility.thumb.conjunctCoupling.mean
            return { length, degree, V, Vinv, conjunctCoupling: { aCoeff, bCoeff, r2: 0 } }
          }
          // The MCP's documented twist depends only on flexion phase (goals.md), never on ab/ad --
          // unlike the thumb CMC's conjunct rotation, which genuinely depends on both driven axes. A
          // hardcoded bCoeff of 0 is that documented asymmetry, not a missing term.
          const aCoeff = prior.mcpAxes[finger as NonThumbFinger].axialRotationWeight.mean
          return { length, degree, V, Vinv, conjunctCoupling: { aCoeff, bCoeff: 0, r2: 0 } }
        }
        return { length, degree, V, Vinv }
      })
      return [finger, joints]
    }),
  ) as Joints
  const splayDeg = knuckleRowSplayDeg(prior)
  for (const f of nonThumb) {
    const splay = new Matrix4().makeRotationY(splayDeg[f] * mirror * DEG2RAD)
    skeleton[f][0].Vinv.copy(splay)
    skeleton[f][0].V.copy(splay).invert()
  }
  const thumbSplay = new Matrix4().makeRotationY(THUMB_SPLAY_DEG * mirror * DEG2RAD)
  skeleton.thumb[0].Vinv.copy(thumbSplay)
  skeleton.thumb[0].V.copy(thumbSplay).invert()
  return skeleton
}

/** A mirrored variant of `buildDefaultSkeleton`, for `buildRestExtensionPose`'s static diagnostic
 * render only -- never used by the solver or any live-tracking path. `buildDefaultSkeleton` now
 * carries a real knuckle/thumb splay (see its own doc comment), but only one fixed chirality's worth,
 * since it only ever interprets already-chirality-normalized `hand.limbs`. This function's whole job
 * is the one thing a single convention can't provide on its own: multi-view's static tile synthesizes
 * a hand from nothing (no tracked data to normalize), so it has to pick which real-world hand -- Left
 * or Right -- that synthetic shape represents, and `handedness` mirrors the splay (fan fractions and
 * thumb angle negated together, about the Y axis) to do that -- a real left hand *is* a real right
 * hand's mirror image, so this is the correct way to get the other hand's shape from the same
 * convention, not two independently-tuned constants.
 *
 * This function's own `mirror` sign is calibrated separately from, and is NOT required to agree with,
 * `buildDefaultSkeleton`'s own `handedness` parameter -- they solve different problems (this one:
 * "which synthetic hand should a `handedness` dropdown show, matching the mirrored video's convention,
 * confirmed 2026-09-06 below"; that one: "which sign makes a REAL tracked Left/Right hand's corrected
 * model come out right," confirmed separately and oppositely-signed, 2026-09-06, in its own doc
 * comment). Don't assume the two `mirror` formulas share a sign just because they share
 * `knuckleRowSplayDeg`/`THUMB_SPLAY_DEG` -- they only share the fan's *shape* and *magnitude*,
 * calibrated once; each still picks its own sign against its own real-world check. */
export function buildRestExtensionSkeleton(prior: HandPriorState, handedness: 'Left' | 'Right'): Joints {
  const skeleton = buildDefaultSkeleton(prior)
  const nonThumb = FINGERS.filter((f): f is NonThumbFinger => f !== 'thumb')
  // The video feed is mirrored (selfie-style), so "matches the video" is the spec, not plain anatomy:
  // a real right hand shown mirrored reads with the thumb on the LEFT of the display, and a real left
  // hand's thumb reads on the RIGHT -- confirmed directly against the live center-tile video overlay,
  // 2026-09-06 (an earlier version of this had the two swapped).
  const mirror = handedness === 'Right' ? 1 : -1
  const splayDeg = knuckleRowSplayDeg(prior)
  for (const f of nonThumb) {
    const splay = new Matrix4().makeRotationY(splayDeg[f] * mirror * DEG2RAD)
    skeleton[f][0].Vinv.copy(splay)
    skeleton[f][0].V.copy(splay).invert()
  }
  const thumbSplay = new Matrix4().makeRotationY(THUMB_SPLAY_DEG * mirror * DEG2RAD)
  skeleton.thumb[0].Vinv.copy(thumbSplay)
  skeleton.thumb[0].V.copy(thumbSplay).invert()
  return skeleton
}

/** A synthetic, never-tracked pose for diagnostic display only (multi-view's static "model rest"
 * tile) -- every flexion DOF pinned to its own ROM prior's `minDeg`, the modeled "most extended" end
 * of that joint's range. For PIP/DIP/thumb-CMC/ring-pinky-CMC this really does mean straight/uncupped;
 * MCP's rough placeholder ROM's own `minDeg` of -20 is a few degrees of hyperextension, an artifact of
 * that placeholder data, not a claim about real anatomy. Together this approximates a hand pressed
 * flat against a hard surface in maximum plausible extension, per `goals.md`'s own ROM bounds -- so an
 * impossible angle here is a real seed-data bug, not a rendering artifact.
 *
 * Each non-thumb finger's MCP ab/ad is additionally pinned to a fraction of `abAdRom`'s own max
 * magnitude, fanned symmetrically around the middle finger (index +max, middle 0, ring -max/2, pinky
 * -max) purely so the fingers visually spread apart in this static reference instead of overlapping
 * the single line `buildDefaultSkeleton`'s degenerate identity splay would otherwise collapse them
 * onto (multi-view's own documented gap -- see its page doc comment). This fan order/magnitude is a
 * display convention with no anatomical citation behind it, not a captured or literature-sourced
 * stance -- it exists only to make a `buildDefaultSkeleton` render legible, is never consumed by the
 * solver, and is never written from real per-user data.
 *
 * Thumb's own "MCP"/"IP" hinges (see `romPrior`'s doc comment) have no modeled ROM prior at all --
 * left at 0 (straight), the same value every other simple hinge's own `minDeg` happens to be here, so
 * this doesn't invent a number where none exists.
 *
 * `handedness` must be the same value passed to `buildRestExtensionSkeleton` -- both mirror their own
 * half of the fan (fingertip ab/ad here, knuckle-row splay there) by the same `mirror` sign, so the
 * two stay consistent with each other (fingertips spreading the same direction their own knuckle
 * splayed, not opposite ways). */
export function buildRestExtensionPose(prior: HandPriorState, handedness: 'Left' | 'Right'): Pose {
  const pose = emptyPose()
  const nonThumb = FINGERS.filter((f): f is NonThumbFinger => f !== 'thumb')
  // Must match buildRestExtensionSkeleton's own mirror sign -- see that function's comment on why
  // 'Right' maps to mirror=1 (the video-mirroring convention), not 'Left'.
  const mirror = handedness === 'Right' ? 1 : -1
  const abAdFraction: Record<NonThumbFinger, number> = {
    indexFinger: 1,
    middleFinger: 0,
    ringFinger: -0.5,
    pinky: -1,
  }
  for (const f of nonThumb) {
    const mcp = prior.mcpAxes[f]
    pose[f][1] = { angleZ: mcp.flexExtRom.minDeg * DEG2RAD, angleY: mcp.abAdRom.maxDeg * abAdFraction[f] * mirror * DEG2RAD }
    pose[f][2] = { angleZ: prior.pipDipRom.pip[f].minDeg * DEG2RAD, angleY: 0 }
    pose[f][3] = { angleZ: prior.pipDipRom.dip[f].minDeg * DEG2RAD, angleY: 0 }
  }
  pose.ringFinger[0] = { angleZ: prior.cmcMobility.ring.flexionRom.minDeg * DEG2RAD, angleY: 0 }
  pose.pinky[0] = { angleZ: prior.cmcMobility.pinky.flexionRom.minDeg * DEG2RAD, angleY: 0 }
  // Segment 1->2's direction is expressed relative to joint 0's own splay frame
  // (buildRestExtensionSkeleton's THUMB_SPLAY_DEG) -- both are rotations about the same (Y) axis, so
  // they simply add: the segment's total angle off the reach axis is
  // THUMB_SPLAY_DEG + THUMB_MCP_BEND_DEG, not just the second term on its own. Tying this to a
  // fraction of abAdRom.maxDeg (two earlier attempts) was never well-justified -- abAdRom is a real
  // anatomical ROM limit, this is a separate, purely cosmetic "what looks like a natural relaxed
  // curve" choice for a diagnostic-only static pose, so it's a plain, independent angle instead.
  // Direction and magnitude both eyeballed against live renders (docs/thumbs/model_rest_2.png,
  // model_rest_3.png, 2026-09-06): the first two attempts (+17deg, then +6deg, both widening away from
  // the reach axis) bent landmark 1 the wrong way -- the correct-looking bend narrows back toward the
  // reach axis instead, hence the negative sign here. Not sourced data -- tune directly if it still
  // doesn't look right.
  const THUMB_MCP_BEND_DEG = -10
  pose.thumb[1] = {
    angleZ: prior.cmcMobility.thumb.flexExtRom.minDeg * DEG2RAD,
    angleY: THUMB_MCP_BEND_DEG * mirror * DEG2RAD,
  }
  return pose
}

/** Every free angle in the pose, in a fixed order, derived from which axes `skeleton`'s joints
 * actually have (so a caller with a differently-shaped skeleton, e.g. one still missing a joint, still
 * gets a consistent layout rather than a mismatched one). */
interface PoseVar {
  finger: Finger
  joint: 0 | 1 | 2 | 3
  axis: 'angleZ' | 'angleY'
}

function poseLayout(skeleton: Joints): PoseVar[] {
  const vars: PoseVar[] = []
  for (const finger of FINGERS) {
    skeleton[finger].forEach((joint, i) => {
      const joint_ = i as 0 | 1 | 2 | 3
      if (joint.degree >= 1) vars.push({ finger, joint: joint_, axis: 'angleZ' })
      if (joint.degree >= 2) vars.push({ finger, joint: joint_, axis: 'angleY' })
    })
  }
  return vars
}

function poseToVector(pose: Pose, layout: PoseVar[]): number[] {
  return layout.map(v => pose[v.finger][v.joint][v.axis])
}

function vectorToPose(vec: number[], layout: PoseVar[]): Pose {
  const pose = emptyPose()
  layout.forEach((v, k) => {
    pose[v.finger][v.joint][v.axis] = vec[k]
  })
  return pose
}

/** The direct, uncorrected angle each joint's own raw tracked bone direction implies this frame --
 * see the module doc comment for why this doubles as the "landmark reprojection" data term without
 * needing a separate position-space computation. */
function trackedPose(skeleton: Joints, hand: Hand): Pose {
  const pose = emptyPose()
  for (const finger of FINGERS) {
    const joints = skeleton[finger]
    const limbs = hand.limbs[finger]
    const reference = new Matrix4()
    joints.forEach((joint, i) => {
      const refToLocal = new Matrix4().extractRotation(reference).invert().premultiply(joint.V)
      const x = limbs[i].clone().applyMatrix4(refToLocal).normalize()

      let angleZ = 0
      let angleY = 0
      if (joint.degree >= 1) angleZ = Math.asin(clampUnit(x.y))
      // Gimbal-lock-style singularity as angleZ -> +-90deg: cos(angleZ) -> 0, so any nonzero x.z
      // (even pure floating-point noise) gets divided by a near-zero denominator and blows up into a
      // spurious large angleY, however tiny the actual off-axis component is -- confirmed directly: a
      // synthetic 90deg-exact MCP flexion recovered a ~9deg phantom ab/ad that a 89.9deg or 80deg
      // flexion did not (2026-09-06, surfaced by buildDefaultSkeleton's new joint-0 splay perturbing
      // x.z away from the exact 0 that masked this before). angleY is genuinely unrecoverable from a
      // direction vector at this exact singularity regardless -- defaulting to 0 there is the standard
      // gimbal-lock convention, not a new approximation.
      const GIMBAL_LOCK_COS_EPSILON = 1e-6
      const cosZ = Math.cos(angleZ)
      if (joint.degree >= 2 && Math.abs(cosZ) > GIMBAL_LOCK_COS_EPSILON) angleY = Math.asin(clampUnit(x.z / -cosZ))
      pose[finger][i] = { angleZ, angleY }

      // The derived twist doesn't change this joint's own two angles above, only how its frame
      // composes into the next joint's -- same as `fromLimbs`, so the chain below stays correct.
      const angleX = joint.degree === 3 ? joint.conjunctCoupling.aCoeff * angleZ + joint.conjunctCoupling.bCoeff * angleY : 0
      const m = new Matrix4().makeRotationFromEuler(new Euler(angleX, angleY, angleZ, 'XYZ'))
      reference.multiply(joint.Vinv).multiply(m)
    })
  }
  return pose
}

/** This joint's anatomical range-of-motion belief, in radians, if `HandPriorState` has one for it.
 * Thumb's own "MCP"/"IP" hinges (see `degreesFor`) have no modeled prior yet -- a real gap, not
 * silently papered over: those two joints are corrected only by the raw tracked data (below), with
 * nothing pulling them toward an anatomical range at all. */
function romPrior(v: PoseVar, prior: HandPriorState): BetaRom | undefined {
  const nonThumb = v.finger as NonThumbFinger
  if (v.finger === 'thumb') {
    if (v.joint !== 1) return undefined
    return v.axis === 'angleZ' ? prior.cmcMobility.thumb.flexExtRom : prior.cmcMobility.thumb.abAdRom
  }
  if (v.joint === 0 && v.axis === 'angleZ' && v.finger === 'ringFinger') return prior.cmcMobility.ring.flexionRom
  if (v.joint === 0 && v.axis === 'angleZ' && v.finger === 'pinky') return prior.cmcMobility.pinky.flexionRom
  if (v.joint === 1) return v.axis === 'angleZ' ? prior.mcpAxes[nonThumb].flexExtRom : prior.mcpAxes[nonThumb].abAdRom
  if (v.joint === 2 && v.axis === 'angleZ') return prior.pipDipRom.pip[nonThumb]
  if (v.joint === 3 && v.axis === 'angleZ') return prior.pipDipRom.dip[nonThumb]
  return undefined
}

/** How much this project's own raw per-frame angle recovery is assumed to be off by, absent any
 * per-landmark confidence signal (this project doesn't have one yet -- the same named gap
 * `average-hand.md` calls out: "no landmark-level confidence downweighting yet," bootstraps once bone
 * lengths have real confidence to compare against). One flat number for every joint, every frame,
 * until that exists. */
const DATA_NOISE_SD_RAD = 5 * DEG2RAD
const SOLVE_SWEEPS = 30

/** Which fingers' tracked data this frame is under an excluded capture condition (dorsal orientation,
 * thumb-lateral angle, self-occlusion) -- `goals.md`'s exclusion rule: "An observation from an excluded
 * condition never enters the likelihood for that quantity, regardless of how many accumulate." `'all'`
 * covers a whole-hand condition (dorsal orientation observes every finger equally badly); a `Set`
 * covers a condition specific to one or more fingers (the thumb-lateral angle only affects the thumb;
 * self-occlusion is typically one finger hidden behind another). Undefined/empty means nothing this
 * frame is excluded, the same as every caller before this parameter existed. */
export type ExcludedFingers = ReadonlySet<Finger> | 'all'

function isFingerExcluded(finger: Finger, excluded: ExcludedFingers | undefined): boolean {
  return excluded === 'all' || (excluded !== undefined && excluded.has(finger))
}

/** Given one tracked frame and the current hand-model belief, produce the pose that best balances
 * "matches what the camera actually saw this frame" against "is anatomically plausible" -- see the
 * module doc comment for the overall approach and its two named simplifications (no memory of previous
 * frames; a flat, not-yet-calibrated assumption for how noisy the raw tracking is). `excluded` names
 * any finger whose tracked data this frame must be kept out of the objective entirely (see
 * `ExcludedFingers`) -- an excluded finger still gets a solved pose, pulled only by its own anatomical
 * prior and whatever it's coupled to, exactly as if this frame had tracked nothing for it at all. */
export function solvePose(skeleton: Joints, prior: HandPriorState, hand: Hand, excluded?: ExcludedFingers): SolveResult {
  const layout = poseLayout(skeleton)
  const tracked = poseToVector(trackedPose(skeleton, hand), layout)
  const n = layout.length

  // The wrist/forearm/elbow group, appended after the finger layout at these five fixed indices --
  // see the module doc comment for why they're solved as plain scalars instead of through `layout`.
  const WRIST_FLEX_EXT = n
  const WRIST_RADIAL_ULNAR = n + 1
  const FOREARM_PRON_SUP = n + 2
  const ELBOW_FLEXION = n + 3
  const ELBOW_SWIVEL = n + 4
  const totalVars = n + 5

  const dataWeight = new Array(totalVars).fill(0)
  for (let k = 0; k < n; k++) {
    // An excluded finger's tracked reading never enters the objective, however many frames accumulate
    // -- not merely down-weighted (`goals.md`'s exclusion rule). Zero weight, not a smaller one.
    if (isFingerExcluded(layout[k].finger, excluded)) continue
    dataWeight[k] = 1 / DATA_NOISE_SD_RAD ** 2
  }
  // No tracked value exists for the wrist/forearm/elbow group -- `tracked` only ever gets read for
  // the first `n` (finger) indices below (the residual sum, and this group's own cold-start init).

  const romWeight = new Array(totalVars).fill(0)
  const romCenter = new Array(totalVars).fill(0)
  const romBounds: (readonly [number, number] | undefined)[] = new Array(totalVars).fill(undefined)

  layout.forEach((v, k) => {
    // MCP ab/ad is choke-coupled to this joint's own (per-sweep, settling) flexion angle -- handled
    // dynamically inside the sweep loop below instead of as one of these fixed, pose-independent terms.
    if (v.finger !== 'thumb' && v.joint === 1 && v.axis === 'angleY') return
    const rom = romPrior(v, prior)
    if (!rom) return
    romWeight[k] = 1 / (rom.sdDeg * DEG2RAD) ** 2
    romCenter[k] = rom.meanDeg * DEG2RAD
    romBounds[k] = [rom.minDeg * DEG2RAD, rom.maxDeg * DEG2RAD]
  })

  const groupGRoms: [number, { meanDeg: number; sdDeg: number; minDeg: number; maxDeg: number }][] = [
    [WRIST_FLEX_EXT, prior.wristForearm.wristFlexExtRom],
    [WRIST_RADIAL_ULNAR, prior.wristForearm.wristRadialUlnarRom],
    [FOREARM_PRON_SUP, prior.wristForearm.forearmPronationSupinationRom],
    [ELBOW_FLEXION, prior.wristForearm.elbowFlexionRom],
    // Elbow swivel has no anatomical stop the way a joint's ROM does -- it's a full-circle-ish
    // geometric quantity, not a hinge -- so it gets no hard clamp (a very wide placeholder bound
    // instead of `romBounds[k]` staying `undefined`, which the final clamp step treats as "no limit").
    [ELBOW_SWIVEL, {
      meanDeg: prior.wristForearm.elbowSwivelAngle.mean,
      sdDeg: Math.sqrt(prior.wristForearm.elbowSwivelAngle.variance),
      minDeg: -180,
      maxDeg: 180,
    }],
  ]
  for (const [k, rom] of groupGRoms) {
    romWeight[k] = 1 / (rom.sdDeg * DEG2RAD) ** 2
    romCenter[k] = rom.meanDeg * DEG2RAD
    romBounds[k] = [rom.minDeg * DEG2RAD, rom.maxDeg * DEG2RAD]
  }

  // Fixed (pose-independent) part of each variable's weighted-average update: its own raw tracked
  // value (finger joints only) plus its own range-of-motion belief. Coupling terms (below) add to
  // this fresh every sweep, since they depend on other variables' current values.
  const fixedWeight = dataWeight.map((w, k) => w + romWeight[k])
  const fixedWeightedSum = dataWeight.map((w, k) => w * (k < n ? tracked[k] : 0) + romWeight[k] * romCenter[k])

  const indexOf = new Map<string, number>()
  layout.forEach((v, k) => indexOf.set(`${v.finger}.${v.joint}.${v.axis}`, k))
  const nonThumbFingers = FINGERS.filter((f): f is NonThumbFinger => f !== 'thumb')
  const pipIndex = new Map(nonThumbFingers.map(f => [f, indexOf.get(`${f}.2.angleZ`)]))
  const dipIndex = new Map(nonThumbFingers.map(f => [f, indexOf.get(`${f}.3.angleZ`)]))
  const flexionIndices = new Map(
    nonThumbFingers.map(f => [f, [1, 2, 3].map(j => indexOf.get(`${f}.${j}.angleZ`))]),
  )
  const mcpFlexIndex = new Map(nonThumbFingers.map(f => [f, indexOf.get(`${f}.1.angleZ`)]))
  const mcpAbAdIndex = new Map(nonThumbFingers.map(f => [f, indexOf.get(`${f}.1.angleY`)]))

  // Cold start every frame (see module doc comment): finger joints start from what the raw tracked
  // data says; the wrist/forearm/elbow group has no tracked data at all, so it starts at its own
  // current prior mean instead, the same "neutral, prior-consistent value" rule average-hand.md
  // specifies for any pose variable with nothing observed yet. An excluded finger gets that same
  // treatment -- its tracked reading is exactly as unusable as a group with no tracked reading at all.
  const coldStartFinger = layout.map((v, k) => (isFingerExcluded(v.finger, excluded) ? romCenter[k] : tracked[k]))
  let vec = [...coldStartFinger, romCenter[WRIST_FLEX_EXT], romCenter[WRIST_RADIAL_ULNAR], romCenter[FOREARM_PRON_SUP], romCenter[ELBOW_FLEXION], romCenter[ELBOW_SWIVEL]]

  for (let sweep = 0; sweep < SOLVE_SWEEPS; sweep++) {
    const weight = fixedWeight.slice()
    const weightedSum = fixedWeightedSum.slice()

    // The two outer finger joints don't flex fully independently -- pull the last joint's angle
    // toward what the middle joint's current angle predicts, one-directionally (this never adjusts
    // the middle joint itself), weighted by how confident that relationship currently is.
    for (const finger of nonThumbFingers) {
      const dip = dipIndex.get(finger)
      const pip = pipIndex.get(finger)
      if (dip === undefined || pip === undefined) continue
      const [slope, intercept] = prior.dipPipCoupling[finger].mean
      const pipDeg = vec[pip] * RAD2DEG
      const predictedDeg = slope * pipDeg + intercept
      // Variance of a slope*x+intercept prediction, propagated from the coupling coefficients' own
      // uncertainty (their covariance's off-diagonal term is dropped here -- a minor approximation,
      // not a claim the two are actually independent).
      const varianceDeg2 = prior.dipPipCoupling[finger].covariance[0][0] * pipDeg ** 2
        + prior.dipPipCoupling[finger].covariance[1][1]
      const w = 1 / (varianceDeg2 * DEG2RAD ** 2)
      weight[dip] += w
      weightedSum[dip] += w * (predictedDeg * DEG2RAD)
    }

    // MCP ab/ad range chokes down toward straight as flexion increases -- "widest near extension,
    // mechanically choked as the joint flexes toward it, per collateral-ligament tightening"
    // (goals.md). `abAdChokeCoeff` is degrees of ab/ad half-range lost per degree of flexion;
    // recomputed every sweep since it reads the joint's own current (settling) flexion angle. A floor
    // keeps the effective range -- and its weight -- well-defined even for a fully-flexed joint or an
    // aggressive coefficient; this is a floor, not an anatomical claim that a joint always keeps that
    // much play. The choked bound is also written into `romBounds` for the final hard-clamp step below,
    // so a converged, heavily-flexed joint can't be clamped back out to the joint's *unchoked* range.
    const MIN_AB_AD_HALF_RANGE_DEG = 1
    for (const f of nonThumbFingers) {
      const abAd = mcpAbAdIndex.get(f)
      const flex = mcpFlexIndex.get(f)
      if (abAd === undefined || flex === undefined) continue
      const base = prior.mcpAxes[f].abAdRom
      const halfRangeDeg = (base.maxDeg - base.minDeg) / 2
      if (halfRangeDeg <= 0) continue
      const flexDeg = Math.max(vec[flex] * RAD2DEG, 0)
      const chokeCoeff = prior.mcpAxes[f].abAdChokeCoeff.mean
      const effectiveHalfRangeDeg = Math.max(halfRangeDeg - chokeCoeff * flexDeg, MIN_AB_AD_HALF_RANGE_DEG)
      const scale = effectiveHalfRangeDeg / halfRangeDeg
      const effectiveSdDeg = Math.max(base.sdDeg * scale, MIN_AB_AD_HALF_RANGE_DEG / 2)
      const w = 1 / (effectiveSdDeg * DEG2RAD) ** 2
      weight[abAd] += w
      weightedSum[abAd] += w * (base.meanDeg * DEG2RAD)
      romBounds[abAd] = [
        (base.meanDeg - effectiveHalfRangeDeg) * DEG2RAD,
        (base.meanDeg + effectiveHalfRangeDeg) * DEG2RAD,
      ]
    }

    // Flexing one finger tends to drag its neighbors along -- applied to each finger's outermost
    // joint as this version's one representative DOF per finger, rather than distributed across all
    // three of a finger's flexion joints (a further simplification: see the module doc comment).
    const totalFlexionDeg = new Map<NonThumbFinger, number>()
    for (const f of nonThumbFingers) {
      const indices = flexionIndices.get(f)!
      const total = indices.reduce<number>((s, idx) => s + (idx === undefined ? 0 : vec[idx] * RAD2DEG), 0)
      totalFlexionDeg.set(f, total)
    }
    const n2 = nonThumbFingers.length
    for (let i = 0; i < n2; i++) {
      const fi = nonThumbFingers[i]
      const dip = dipIndex.get(fi)
      if (dip === undefined) continue
      let predictedDeg = 0
      let varianceDeg2 = 0
      for (let j = 0; j < n2; j++) {
        if (i === j) continue
        const fj = nonThumbFingers[j]
        const flatIndex = n2 * i + j
        const coeff = prior.enslaving.coefficients.mean[flatIndex]
        const coeffVariance = prior.enslaving.coefficients.covariance[flatIndex][flatIndex]
        const flexJ = totalFlexionDeg.get(fj)!
        predictedDeg += coeff * flexJ
        varianceDeg2 += coeffVariance * flexJ ** 2
      }
      if (varianceDeg2 === 0) continue
      const w = 1 / (varianceDeg2 * DEG2RAD ** 2)
      weight[dip] += w
      weightedSum[dip] += w * (predictedDeg * DEG2RAD)
    }

    // Tenodesis: a confidently-flexed set of fingers pulls the wrist toward the posture that goes
    // with that, even though the wrist itself is never directly observed (see module doc comment).
    // The same one coupling strength applies to both wrist DOF, since `HandPriorState` only carries
    // one coefficient for this whole relationship, not one per wrist axis.
    {
      const avgFlexionDeg = nonThumbFingers.reduce((s, f) => s + totalFlexionDeg.get(f)!, 0) / nonThumbFingers.length
      const coeff = prior.wristForearm.tenodesisCoupling.mean
      const coeffVariance = prior.wristForearm.tenodesisCoupling.variance
      const predictedDeg = coeff * avgFlexionDeg
      const varianceDeg2 = coeffVariance * avgFlexionDeg ** 2
      if (varianceDeg2 > 0) {
        const w = 1 / (varianceDeg2 * DEG2RAD ** 2)
        for (const idx of [WRIST_FLEX_EXT, WRIST_RADIAL_ULNAR]) {
          weight[idx] += w
          weightedSum[idx] += w * (predictedDeg * DEG2RAD)
        }
      }
    }

    vec = weightedSum.map((sum, k) => (weight[k] > 0 ? sum / weight[k] : vec[k]))
  }

  // A hard safety net: whatever the weighted balance above settled on, never actually report a joint
  // bent past its anatomical stop -- this is the one place a soft belief becomes a real limit.
  vec = vec.map((value, k) => {
    const bounds = romBounds[k]
    return bounds ? Math.min(bounds[1], Math.max(bounds[0], value)) : value
  })

  // Only the finger joints (the first `n` entries) have tracked data to compare against at all.
  const residual = tracked.reduce((sum, value, k) => sum + dataWeight[k] * (vec[k] - value) ** 2, 0)
  const wristForearm: WristForearmPose = {
    wristFlexExt: vec[WRIST_FLEX_EXT],
    wristRadialUlnar: vec[WRIST_RADIAL_ULNAR],
    forearmPronationSupination: vec[FOREARM_PRON_SUP],
    elbowFlexion: vec[ELBOW_FLEXION],
    elbowSwivelAngle: vec[ELBOW_SWIVEL],
  }
  return { pose: vectorToPose(vec.slice(0, n), layout), wristForearm, residual }
}

// ---------------------------------------------------------------------------------------------------
// Render glue: turning a solved `Pose` back into the same shape a raw tracked frame comes in as
// (a 21-entry array of world-space landmark positions, matching MediaPipe's own landmark numbering),
// so anything that already knows how to draw a `Hand` can draw a solved one too, unchanged. No new FK
// math -- this is exactly `SolvedHand.fkBy`/`worldPositions`, already reused as-is per
// `average-hand.md`'s Stage 5 note; the only work here is mapping each finger's chain positions onto
// MediaPipe's landmark numbers via `CONNECTIONS`, the same mapping the rest of this project already
// treats as the source of truth for which landmark is which.

/** A solved pose's world-space landmark positions, indexed 0-20 exactly like MediaPipe's own landmark
 * numbering (and like `Hand.vectors`) -- so it can be handed to any code that already renders a
 * tracked `Hand`, in place of `hand.vectors`. */
export function poseToLandmarkVectors(skeleton: Joints, pose: Pose): Vector3[] {
  const solved = new SolvedHand(skeleton, new Matrix4())
  for (const finger of FINGERS) {
    solved.fkBy(finger, i => [pose[finger][i].angleZ, pose[finger][i].angleY])
  }
  const vectors: Vector3[] = new Array(21)
  for (const finger of FINGERS) {
    const positions = solved.worldPositions(finger) // [wrist, ...4 chain positions]
    const landmarks = [0, ...CONNECTIONS[finger].map(([, to]) => to)]
    landmarks.forEach((landmark, i) => {
      vectors[landmark] = positions[i]
    })
  }
  return vectors
}

/** Each landmark's current confidence, as the plain standard deviation (degrees) of the least-certain
 * joint between the wrist and it -- the same "a sphere's color reflects the worst joint along its
 * chain, not just the nearest one" rule `scan3-architecture.md`'s contact-sphere preview already uses,
 * applied to confidence instead of posture deviation. `undefined` means no belief is modeled for any
 * joint up to that landmark at all (this project's own gap, e.g. thumb's un-modeled "MCP"/"IP" hinges
 * -- see `romPrior`'s doc comment), not "fully confident": a caller should render that landmark as
 * visibly different from a genuinely narrow, converged one, not silently treat it as one. Lower
 * numbers mean more confident -- a caller wanting an opacity or color scale maps this the way it wants
 * to display; this file doesn't bake in a display convention of its own. */
export function poseConfidenceSdDeg(skeleton: Joints, prior: HandPriorState): (number | undefined)[] {
  const layout = poseLayout(skeleton)

  // Worst (largest) sdDeg across an individual joint's own axes.
  const jointSdDeg = new Map<string, number>()
  layout.forEach(v => {
    const rom = romPrior(v, prior)
    if (!rom) return
    const key = `${v.finger}.${v.joint}`
    jointSdDeg.set(key, Math.max(jointSdDeg.get(key) ?? 0, rom.sdDeg))
  })

  const vectors: (number | undefined)[] = new Array(21)
  for (const finger of FINGERS) {
    const landmarks = [0, ...CONNECTIONS[finger].map(([, to]) => to)]
    let worst: number | undefined
    let anyDefined = false
    landmarks.forEach((landmark, i) => {
      if (i > 0) {
        // Landmark `i` is downstream of joint `i - 1` (the joint that produced it via fkBy).
        const sd = jointSdDeg.get(`${finger}.${i - 1}`)
        if (sd !== undefined) {
          anyDefined = true
          worst = worst === undefined ? sd : Math.max(worst, sd)
        }
      }
      vectors[landmark] = anyDefined ? worst : undefined
    })
  }
  return vectors
}
