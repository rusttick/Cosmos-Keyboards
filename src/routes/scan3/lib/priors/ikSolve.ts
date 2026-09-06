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
 * its own) and their knuckle has two driven axes without a twist. Ring and pinky are the other
 * exception to that rigid base segment: each flexes a small, independent amount of its own toward the
 * palm (see `calculateJoints`'s own doc comment in `hand.ts`), so their base segment gets one driven
 * axis instead of none. Everything past that (what this project's own tooling already calls the
 * thumb's "MCP" and "IP", by the same generic joint-position convention flexion-fitting code elsewhere
 * uses) is a plain one-axis hinge, same as the other fingers' two outer joints. */
function degreesFor(finger: Finger): (0 | 1 | 2 | 3)[] {
  if (finger === 'thumb') return [0, 3, 1, 1]
  if (finger === 'ringFinger' || finger === 'pinky') return [1, 2, 1, 1]
  return [0, 2, 1, 1]
}

/** A hand skeleton built purely from `HandPriorState`, with no per-user calibration behind it -- for
 * use before any real scan exists (e.g. an evaluation page loaded with only the population prior). A
 * real, calibrated skeleton (once a scan has actually fit one) should be used instead whenever one is
 * available; this is the fallback, not the preferred path.
 *
 * Each joint's own local axis orientation (`V`/`Vinv`) is a real per-user calibration fact this
 * project only ever gets from fitting actual captured motion (`fitNorms`/`averageNorms`) -- there's no
 * literature source or population prior for it, and `HandPriorState` doesn't model it. This builds
 * every joint's frame as the identity: a plain, honest placeholder, not a real anatomical estimate. It
 * does mean this fallback skeleton's *raw* per-frame angles won't line up with a real calibrated
 * skeleton's -- consistent internally, but not a substitute for one. */
export function buildDefaultSkeleton(prior: HandPriorState): Joints {
  return Object.fromEntries(
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
          const [aCoeff, bCoeff] = prior.cmcMobility.thumb.conjunctCoupling.mean
          // r2 isn't part of this project's prior model (see handModel.ts) -- 0 here just satisfies
          // the existing `ConjunctCoupling` type, it isn't a real fit-quality claim.
          return { length, degree, V, Vinv, conjunctCoupling: { aCoeff, bCoeff, r2: 0 } }
        }
        return { length, degree, V, Vinv }
      })
      return [finger, joints]
    }),
  ) as Joints
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
      if (joint.degree >= 2) angleY = Math.asin(clampUnit(x.z / -Math.cos(angleZ)))
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

/** Given one tracked frame and the current hand-model belief, produce the pose that best balances
 * "matches what the camera actually saw this frame" against "is anatomically plausible" -- see the
 * module doc comment for the overall approach and its two named simplifications (no memory of previous
 * frames; a flat, not-yet-calibrated assumption for how noisy the raw tracking is). */
export function solvePose(skeleton: Joints, prior: HandPriorState, hand: Hand): SolveResult {
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
  for (let k = 0; k < n; k++) dataWeight[k] = 1 / DATA_NOISE_SD_RAD ** 2
  // No tracked value exists for the wrist/forearm/elbow group -- `tracked` only ever gets read for
  // the first `n` (finger) indices below (the residual sum, and this group's own cold-start init).

  const romWeight = new Array(totalVars).fill(0)
  const romCenter = new Array(totalVars).fill(0)
  const romBounds: (readonly [number, number] | undefined)[] = new Array(totalVars).fill(undefined)

  layout.forEach((v, k) => {
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

  // Cold start every frame (see module doc comment): finger joints start from what the raw tracked
  // data says; the wrist/forearm/elbow group has no tracked data at all, so it starts at its own
  // current prior mean instead, the same "neutral, prior-consistent value" rule average-hand.md
  // specifies for any pose variable with nothing observed yet.
  let vec = [...tracked, romCenter[WRIST_FLEX_EXT], romCenter[WRIST_RADIAL_ULNAR], romCenter[FOREARM_PRON_SUP], romCenter[ELBOW_FLEXION], romCenter[ELBOW_SWIVEL]]

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
