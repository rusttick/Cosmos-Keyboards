/**
 * `HandPriorState`: what this project currently believes about one person's hand -- a mean and a
 * covariance (uncertainty, including how quantities are correlated with each other) for every bone
 * length, joint range of motion, joint axis, and coupling coefficient the hand model tracks.
 *
 * This file only defines the shape of that belief. `handModelData.ts` fills it in with actual
 * numbers seeded from anatomy literature and this project's own measurements. Nothing here reads or
 * writes the state -- a solver reads it every tracking frame to constrain what pose is anatomically
 * plausible, and a separate update step is the only thing allowed to change it (only after a
 * deliberate measurement, never from ordinary live tracking).
 */

import type { Finger } from '$lib/hand'

/** The thumb has a fundamentally different joint structure than the other four fingers (a saddle
 * joint at the base instead of a simple hinge), so most of this model treats it separately. */
export type NonThumbFinger = Exclude<Finger, 'thumb'>

/** A belief about a single number: its current best-guess value and how uncertain that guess is
 * (variance -- bigger means less confident). `source` says where the number came from (a citation,
 * or a note that it's an unsourced placeholder) so anyone reading the seed data can tell a real
 * measurement from a guess. */
export interface ScalarPrior {
  mean: number
  variance: number
  source: string
  /** How many deliberate observations (not counting the literature seed itself) have gone into this
   * belief so far -- `update.ts` increments it. Optional and absent on every seed value in
   * `handModelData.ts`, since none of those come from an observation. */
  evidenceCount?: number
}

/** A belief about several numbers that move together -- a mean for each, plus their full covariance
 * matrix (row-major, same size as `mean` in both dimensions) so that learning one narrows what we
 * believe about the others. Used wherever quantities shouldn't be treated as independent, e.g. one
 * finger's bone-length ratios, or a pair of coupling coefficients that were fit together. */
export interface VectorPrior {
  mean: number[]
  covariance: number[][]
  source: string
  /** Same meaning as `ScalarPrior.evidenceCount`. */
  evidenceCount?: number
}

/** A belief about a joint angle that has a hard anatomical limit -- a joint can't bend past its
 * ligament stop, so this isn't a plain bell curve, it's bounded. Stored here as the numbers a
 * research paper would actually report (mean, standard deviation, min/max range) rather than as raw
 * statistical shape parameters -- converting to whatever the solver needs internally is the solver's
 * job, not this data's. */
export interface BetaRom {
  minDeg: number
  maxDeg: number
  meanDeg: number
  sdDeg: number
  source: string
}

// ---------------------------------------------------------------------------------------------------
// Bone lengths

/** The four segments making up one finger's bone chain, from the palm out. The thumb doesn't have a
 * `'middle'` phalanx, but does have an extra `'wristToCmc'` segment before its metacarpal: MediaPipe
 * (the hand-tracking library this project uses) represents the thumb with one more landmark than it
 * has real independently-moving bones, so there's a small "segment" from the wrist landmark to the
 * base of the thumb that doesn't correspond to an actual bone. */
export type FingerBoneSegment = 'wristToCmc' | 'metacarpal' | 'proximal' | 'middle' | 'distal'

/** One finger's bone lengths, each expressed as a ratio to `BoneLengthPriors.handLength` rather than
 * an absolute length (so the same prior works for hands of different overall size). `segments` labels
 * what each entry of `mean`/`covariance` refers to. These ratios are always positive and their
 * natural distribution shape is lognormal (a bell curve in log-space) rather than a plain bell curve
 * -- this struct just stores plain mean/variance in ratio units, and leaves that transformation to
 * whatever reads it. */
export interface FingerBoneLengths extends VectorPrior {
  segments: FingerBoneSegment[]
}

/** Order `knuckleRow`'s 3 entries are always in: adjacent MCP-to-MCP gaps, index-to-pinky. */
export const KNUCKLE_ROW_PAIRS = ['indexToMiddle', 'middleToRing', 'ringToPinky'] as const

export interface BoneLengthPriors {
  /** The reference length everything else is a ratio of, in millimeters: the standard
   * wrist-to-middle-fingertip "hand length" measurement used in hand anthropometry. */
  handLength: ScalarPrior
  fingers: Record<Finger, FingerBoneLengths>
  /** Straight-line MCP-to-MCP distances (ratio to `handLength`) for the three adjacent non-thumb
   * knuckle pairs, in `KNUCKLE_ROW_PAIRS` order -- anatomically close to fixed (the metacarpals'
   * relative spacing barely changes with finger motion, much like a within-finger bone length), but
   * never actually modeled before this field existed: `ikSolve.ts`'s `buildDefaultSkeleton` used a
   * fixed, uncited fan angle for joint-0 splay instead of any real measured spacing. `ikSolve.ts` now
   * derives that splay geometrically (law of cosines) from this field plus each finger's own
   * `fingers[finger]` metacarpal length -- see its own doc comment. */
  knuckleRow: VectorPrior
}

// ---------------------------------------------------------------------------------------------------
// PIP/DIP -- the two outer finger joints

/** The two joints past the knuckle on each of the four fingers (not the thumb, which doesn't have
 * them) are simple one-axis hinges, so each just needs one range-of-motion belief. */
export interface PipDipRomPriors {
  pip: Record<NonThumbFinger, BetaRom>
  dip: Record<NonThumbFinger, BetaRom>
}

// ---------------------------------------------------------------------------------------------------
// MCP -- the knuckle joint

/** A knuckle (MCP) joint isn't a simple hinge: it flexes, it also spreads side-to-side, and the two
 * motions interact (a finger can spread less once it's bent, because the ligaments on the sides
 * tighten). `abAdChokeCoeff` is how much side-to-side range shrinks per degree of flexion. There's
 * also a small twisting rotation that happens automatically as the finger bends, which
 * `axialRotationWeight` captures. Both are relationships fit from data, not free pose variables --
 * they change slowly (if at all) rather than every tracking frame. */
export interface McpAxisPrior {
  flexExtRom: BetaRom
  abAdRom: BetaRom
  abAdChokeCoeff: ScalarPrior
  axialRotationWeight: ScalarPrior
}

export type McpAxisPriors = Record<NonThumbFinger, McpAxisPrior>

// ---------------------------------------------------------------------------------------------------
// CMC -- the base-of-hand joints (thumb, ring, pinky)

/** The thumb's base joint is a saddle joint: it actively flexes and spreads (2 controlled axes), and
 * twists as a side effect of that motion rather than being twistable on its own. `conjunctCoupling`
 * captures that side-effect twist as `[aCoeff, bCoeff]` in `twist ≈ aCoeff·flexion + bCoeff·abduction`
 * -- the same relationship this project's existing thumb-fitting code (`ConjunctCoupling` in
 * `hand.ts`) already uses, reused here rather than reinvented. */
export interface ThumbCmcPrior {
  flexExtRom: BetaRom
  abAdRom: BetaRom
  conjunctCoupling: VectorPrior
}

/** The ring and pinky fingers' base joints aren't rigid the way the middle two are -- they flex a
 * small amount on their own to help cup the palm, a motion distinct from (and easy to mistake for)
 * their knuckle's own flexion. */
export interface RingPinkyCmcPrior {
  flexionRom: BetaRom
}

export interface CmcMobilityPriors {
  thumb: ThumbCmcPrior
  ring: RingPinkyCmcPrior
  pinky: RingPinkyCmcPrior
}

// ---------------------------------------------------------------------------------------------------
// DIP/PIP coupling -- how the two outer joints move together

/** The two outer finger joints don't flex fully independently -- bending one tends to bend the other
 * along with it. Modeled per non-thumb finger as a straight line, `dip ≈ slope·pip + intercept`. */
export type DipPipCouplingPriors = Record<NonThumbFinger, VectorPrior>

// ---------------------------------------------------------------------------------------------------
// Enslaving -- fingers dragging each other along

/** Flexing one finger tends to drag its neighbors along a little, even when you're not trying to move
 * them ("enslaving"). Stored as one flattened matrix rather than a nested array so its own
 * uncertainty/correlation can eventually be tracked the same way any other multi-number belief is:
 * `coefficients.mean[fingerOrder.length * i + j]` is how much finger `i` moves per unit of finger `j`'s
 * driven movement. The thumb is excluded -- it isn't part of this project's existing enslaving
 * measurement either. */
export interface EnslavingPriors {
  fingerOrder: NonThumbFinger[]
  coefficients: VectorPrior
}

// ---------------------------------------------------------------------------------------------------
// Wrist, forearm, and elbow

/** The wrist bends two ways (up/down and side/side) and those two motions aren't independent of each
 * other or of the fingers -- bending the wrist back tends to make the fingers curl (the "tenodesis"
 * effect), which `tenodesisCoupling` captures. The forearm twists (pronation/supination) and the
 * elbow bends and can also swivel around the wrist-to-shoulder line for a fixed hand position, which
 * `elbowSwivelAngle` and `swivelWristForearmCoupling` describe. None of these have a way to be
 * measured directly from a single hand-tracking camera -- they're only ever inferred indirectly, so
 * most entries here start wide/uncertain and only narrow via their correlation with something that
 * *can* be measured (like the fingers' own rest posture, or forearm length via caliper). */
export interface WristForearmPriors {
  wristFlexExtRom: BetaRom
  wristRadialUlnarRom: BetaRom
  forearmPronationSupinationRom: BetaRom
  elbowFlexionRom: BetaRom
  /** Degrees. Not really a population-average angle -- it's set by a geometric rule (the forearm
   * tends to rotate so the palm faces toward the head) that has to be evaluated against a solved
   * wrist/hand pose, not read off as a fixed number. Kept wide/neutral here for that reason. */
  elbowSwivelAngle: ScalarPrior
  /** Ratio to `BoneLengthPriors.handLength`, same lognormal-ratio treatment as the finger bones. */
  forearmLengthRatio: ScalarPrior
  tenodesisCoupling: ScalarPrior
  forearmLengthStatureCoupling: ScalarPrior
  swivelWristForearmCoupling: ScalarPrior
}

export interface HandPriorState {
  boneLengths: BoneLengthPriors
  pipDipRom: PipDipRomPriors
  mcpAxes: McpAxisPriors
  cmcMobility: CmcMobilityPriors
  dipPipCoupling: DipPipCouplingPriors
  enslaving: EnslavingPriors
  wristForearm: WristForearmPriors
}
