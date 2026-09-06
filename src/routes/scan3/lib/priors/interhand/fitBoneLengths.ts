/**
 * Bone-length ratios from a set of real InterHand2.6M frames, all belonging to one subject -- see
 * `docs/thumbs/interhand-2-average.md` Stage 3a. The variance produced here is *within-subject*
 * spread (how consistent this one person's own frames are), not population spread across people --
 * for a single subject this is an individual-level statistic, the same kind of confidence a real
 * `/scan3` capture would produce, not the between-subject population variance a many-subject fit
 * would need (see the "population vs. individual variance" discussion in
 * `docs/thumbs/interhand-2-average.md`). Every value here is a candidate for Stage 4's human review,
 * never written into `handModelData.ts` automatically.
 */

import { CONNECTIONS, type Finger, FINGERS } from '$lib/hand'
import type { InterhandFrame } from './loadFrames'

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
  n: number
}

export interface FittedBoneLengths {
  handLengthMM: FittedScalar
  fingers: Record<Finger, FittedFingerBoneLengths>
}

/** Reference "hand length": wrist (landmark 0) to middle fingertip (landmark 12) -- the same
 * measurement `handModelData.ts`'s own `HAND_LENGTH_MM` is built from. */
function handLengthMM(frame: InterhandFrame): number {
  return frame.points[0].distanceTo(frame.points[12])
}

export function fitBoneLengths(frames: InterhandFrame[]): FittedBoneLengths {
  if (frames.length === 0) throw new Error('fitBoneLengths: no frames given')

  const handLengths = frames.map(handLengthMM)
  const handLengthMean = mean(handLengths)
  const handLengthVariance = mean(handLengths.map(h => (h - handLengthMean) ** 2))

  const fingers = {} as Record<Finger, FittedFingerBoneLengths>
  for (const finger of FINGERS) {
    const pairs = CONNECTIONS[finger]
    const ratiosPerSegment = pairs.map(([from, to]) => frames.map((f, i) => f.points[from].distanceTo(f.points[to]) / handLengths[i]))
    const segMeans = ratiosPerSegment.map(mean)
    const segVariances = ratiosPerSegment.map((ratios, i) => mean(ratios.map(r => (r - segMeans[i]) ** 2)))
    fingers[finger] = {
      segments: SEGMENT_NAMES[finger],
      mean: segMeans,
      variance: segVariances,
      n: frames.length,
    }
  }

  return {
    handLengthMM: { mean: handLengthMean, variance: handLengthVariance, n: frames.length },
    fingers,
  }
}
