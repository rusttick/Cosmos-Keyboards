/**
 * Bone-length ratios from a set of real InterHand2.6M frames, all belonging to one subject -- see
 * `docs/thumbs/interhand-2-average.md` Stage 3a. The variance produced here is *within-subject*
 * spread (how consistent this one person's own frames are), not population spread across people --
 * for a single subject this is an individual-level statistic, the same kind of confidence a real
 * `/scan3` capture would produce, not the between-subject population variance a many-subject fit
 * would need (see the "population vs. individual variance" discussion in
 * `docs/thumbs/interhand-2-average.md`). Every value here is a candidate for Stage 4's human review,
 * never written into `handModelData.ts` automatically.
 *
 * **`handLengthMM` is a bone-chain SUM, not a straight-line distance -- this matters a lot.** An
 * earlier version of this file computed it as the direct 3D distance from landmark 0 to landmark 12
 * (wrist to middle fingertip), which is what `handModelData.ts`'s doc comment describes in words but
 * NOT what its own `HAND_LENGTH_MM` constant actually is (a sum of the middle finger's own segments) --
 * a real mismatch, found only by checking actual numbers: that straight-line distance is highly
 * pose-dependent (it shrinks whenever the middle finger curls -- confirmed directly on subject 0, down
 * to ~59mm in some frames vs. ~190mm extended, a >3x range across otherwise-ordinary pose sequences),
 * while every bone segment being ratio'd against it (a rigid, pose-invariant length) is not. Dividing a
 * stable numerator by a wildly pose-dependent denominator produced a spuriously inflated tail in every
 * ratio this file computes, not just one segment -- confirmed by checking the index finger's own
 * metacarpal ratio the same way (median 0.517, but p90 already at 1.25). The bone-chain-sum definition
 * below is itself built from segments already shown to be individually stable, so it doesn't reproduce
 * the problem it fixes.
 */

import { CONNECTIONS, type Finger, FINGERS } from '$lib/hand'
import type { InterhandFrame } from './loadFrames'
import { computeSegmentMedians, DEFAULT_THRESHOLD, isSegmentTrustworthy, type SegmentMedians } from './segmentConsistency'

/** `handModelData.ts`'s own segment-name convention, in project chain order. Thumb's leading segment
 * (`wristToCmc`) is exactly `CONNECTIONS.thumb[0]` (landmark 0 -> 1) -- the same "no real bone, an
 * artifact of the tracked landmark layout" segment `handModelData.ts` currently seeds as an unsourced
 * guess. Every other finger's segments line up 1:1 with `CONNECTIONS[finger]`. */
const SEGMENT_NAMES: Record<Finger, string[]> = {
  thumb: ['wristToCmc', 'metacarpal', 'proximal', 'distal'],
  indexFinger: ['metacarpal', 'proximal', 'middle', 'distal'],
  middleFinger: ['metacarpal', 'proximal', 'middle', 'distal'],
  ringFinger: ['metacarpal', 'proximal', 'middle', 'distal'],
  pinky: ['metacarpal', 'proximal', 'middle', 'distal'],
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

export interface FittedScalar {
  mean: number
  variance: number
  n: number
}

export interface FittedFingerBoneLengths {
  segments: string[]
  /** ratio to hand length (wrist -> middle fingertip), same convention as `BoneLengthPriors` */
  mean: number[]
  /** diagonal-only, within-subject variance per segment -- see module doc comment */
  variance: number[]
  /** frames actually used, PER SEGMENT (they can differ -- a frame excluded for one finger's segment
   * because ITS length looked untrustworthy, or because that frame's own handLength reference did, may
   * still be fine for a different segment). */
  n: number[]
  /** how many otherwise-available frames were dropped for each segment, and why: either that segment's
   * own length failed the consistency check, or the frame's `handLengthMM` reference did (see module
   * doc comment) -- reported together since both end in the same "this frame's ratio isn't trustworthy"
   * outcome, not because they're indistinguishable (a caller wanting the breakdown can re-derive it from
   * `computeSegmentMedians`/`isSegmentTrustworthy` directly). */
  excluded: number[]
}

/** Adjacent non-thumb MCP landmarks, index-to-pinky order -- matches `boneLengths.knuckleRow`'s own
 * `KNUCKLE_ROW_CHAIN` (`boneSpan.ts`). Not derived from `CONNECTIONS`, since these landmark pairs
 * aren't a bone segment within one finger's chain -- straight-line distance between two different
 * fingers' MCPs, same computation `resolveKnuckleSpan`'s caliper path uses for a live measurement. */
const KNUCKLE_ROW_LANDMARK_PAIRS: [number, number][] = [[5, 9], [9, 13], [13, 17]]

export interface FittedBoneLengths {
  handLengthMM: FittedScalar
  fingers: Record<Finger, FittedFingerBoneLengths>
  /** [index-middle, middle-ring, ring-pinky] MCP-to-MCP ratios -- same shape/units as a finger's own
   * segments, feeding `boneLengths.knuckleRow` via `buildSubjectPrior.ts`. Filtered per-gap (see
   * `KNUCKLE_ROW_OUTLIER_THRESHOLD`'s own doc comment) -- `n`/`excludedByBadGap` report how much. */
  knuckleRow: { mean: number[]; variance: number[]; n: number; excludedByBadGap: number[] }
}

/** Fractional deviation from a gap's own median RAW distance beyond which a frame is dropped for that
 * gap -- same mechanism and threshold `segmentConsistency.ts` established for `fitRom.ts`. Kept as a
 * small local equivalent rather than reusing `segmentConsistency.ts`'s own functions directly, since
 * those are keyed by `Finger` (a within-one-finger segment) and a knuckle gap is cross-finger. */
const KNUCKLE_ROW_OUTLIER_THRESHOLD = 0.3

const MIDDLE_FINGER_PAIRS = CONNECTIONS.middleFinger // [[0,9],[9,10],[10,11],[11,12]]

/** The reference "hand length," in millimeters: the SUM of the middle finger's own 4 segments (each
 * already individually stable, per this module's own doc comment), not the straight-line distance
 * between its endpoints -- matching `handModelData.ts`'s actual `HAND_LENGTH_MM` definition (also a
 * segment sum), not the pose-dependent shortcut an earlier version of this function used. */
function chainHandLengthMM(frame: InterhandFrame): number {
  return MIDDLE_FINGER_PAIRS.reduce((sum, [from, to]) => sum + frame.points[from].distanceTo(frame.points[to]), 0)
}

/** A frame's `handLengthMM` is only as trustworthy as the 4 middle-finger segments it's built from --
 * if any of them fails the same per-segment consistency check every other segment gets, this frame's
 * reference length (and therefore every ratio computed against it) is dropped for this fit. */
function handLengthTrustworthy(frame: InterhandFrame, medians: SegmentMedians, threshold: number): boolean {
  return MIDDLE_FINGER_PAIRS.every(([from, to]) => isSegmentTrustworthy(frame, 'middleFinger', from, to, medians, threshold))
}

export function fitBoneLengths(frames: InterhandFrame[], threshold: number = DEFAULT_THRESHOLD): FittedBoneLengths {
  if (frames.length === 0) throw new Error('fitBoneLengths: no frames given')
  const medians = computeSegmentMedians(frames)

  const hlTrustworthy = frames.filter(f => handLengthTrustworthy(f, medians, threshold))
  const handLengthByFrame = new Map(hlTrustworthy.map(f => [f, chainHandLengthMM(f)]))
  const handLengths = [...handLengthByFrame.values()]
  const handLengthMean = mean(handLengths)
  const handLengthVariance = mean(handLengths.map(h => (h - handLengthMean) ** 2))

  const fingers = {} as Record<Finger, FittedFingerBoneLengths>
  for (const finger of FINGERS) {
    const pairs = CONNECTIONS[finger]
    const segMeans: number[] = []
    const segVariances: number[] = []
    const segN: number[] = []
    const segExcluded: number[] = []
    for (const [from, to] of pairs) {
      const usable = hlTrustworthy.filter(f => isSegmentTrustworthy(f, finger, from, to, medians, threshold))
      const ratios = usable.map(f => f.points[from].distanceTo(f.points[to]) / handLengthByFrame.get(f)!)
      const m = mean(ratios)
      segMeans.push(m)
      segVariances.push(mean(ratios.map(r => (r - m) ** 2)))
      segN.push(usable.length)
      segExcluded.push(frames.length - usable.length)
    }
    fingers[finger] = { segments: SEGMENT_NAMES[finger], mean: segMeans, variance: segVariances, n: segN, excluded: segExcluded }
  }

  const knuckleMeans: number[] = []
  const knuckleVariances: number[] = []
  const knuckleN: number[] = []
  const excludedByBadGap: number[] = []
  for (const [from, to] of KNUCKLE_ROW_LANDMARK_PAIRS) {
    const rawDistances = hlTrustworthy.map(f => f.points[from].distanceTo(f.points[to]))
    const med = median(rawDistances)
    const trustworthy: number[] = [] // indices into `hlTrustworthy`
    rawDistances.forEach((d, i) => {
      if (med === 0 || Math.abs(d - med) / med <= KNUCKLE_ROW_OUTLIER_THRESHOLD) trustworthy.push(i)
    })
    const ratios = trustworthy.map(i => rawDistances[i] / handLengthByFrame.get(hlTrustworthy[i])!)
    const m = mean(ratios)
    knuckleMeans.push(m)
    knuckleVariances.push(mean(ratios.map(r => (r - m) ** 2)))
    knuckleN.push(trustworthy.length)
    excludedByBadGap.push(frames.length - trustworthy.length)
  }

  return {
    handLengthMM: { mean: handLengthMean, variance: handLengthVariance, n: hlTrustworthy.length },
    fingers,
    knuckleRow: { mean: knuckleMeans, variance: knuckleVariances, n: Math.min(...knuckleN), excludedByBadGap },
  }
}
