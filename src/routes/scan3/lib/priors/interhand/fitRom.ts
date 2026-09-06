/**
 * Per-joint bend-angle statistics from real InterHand2.6M frames -- Stage 3d of
 * `docs/thumbs/interhand-2-average.md`, scoped deliberately narrow: the goal right now is "rule out
 * impossible motions," not a full population ROM refit. `bendAngleDeg` needs no per-subject axis
 * calibration -- it's the angle between the two bone vectors meeting at a joint (0 = straight, larger
 * = more flexed), the same "a pure hinge's bend magnitude doesn't depend on axis convention" reasoning
 * from `docs/thumbs/interhand-2-average.md`'s Stage 3b.
 *
 * Not every joint's bend angle maps onto its target `HandPriorState` field the same way, and treating
 * them as equally trustworthy would be dishonest -- so every result below carries a `Directness` tag,
 * derived from this project's own FK joint structure (`degreesFor` in `ikSolve.ts`), not guessed:
 *
 * - `'clean-hinge'`: a single driven axis with its own dedicated landmark, nothing else sharing it --
 *   PIP, DIP (every finger), and the thumb's own "MCP"/"IP" hinges (`degreesFor`'s `degree: 1` joints
 *   past the CMC). The bend angle IS the target field.
 * - `'flex-abd-combined'`: a real single joint, but one that drives two axes (flexion and ab/ad) the
 *   model tracks as two separate `BetaRom` fields -- the thumb's CMC and every other finger's true MCP
 *   (`degreesFor`'s `degree: 3` joints). The raw bend is their combined total, at least as large as
 *   either axis alone -- a safe upper bound, not a clean measurement of `flexExtRom` by itself.
 * - `'joint-stacked'`: two entirely separate joints landing on one landmark, because no tracked point
 *   separates them -- specific to ring/pinky's base joint. Their own small "cup the palm" flex
 *   (`cmcMobility.ring`/`pinky.flexionRom`, `degreesFor`'s `degree: 1` joint 0 for these two fingers
 *   only) has no dedicated landmark the way the thumb's extra `wristToCmc` point gives it one -- so the
 *   measured bend there is that flex ADDED to the true MCP's own rotation, with no way to separate them
 *   from position data alone. This is NOT a candidate for either target field's mean/SD -- only usable
 *   as a combined upper-bound envelope.
 *
 * `VARIANCE_MULTIPLIER` turns that tag into an actual number: the declared variance a caller should use
 * is `sdDeg**2 * VARIANCE_MULTIPLIER[directness]`, not the raw within-subject `sdDeg**2` alone -- the
 * same "declared variance should reflect confidence in the mapping, not just in the sample" reasoning
 * already applied to InterHand2.6M's population-level contribution in
 * `docs/thumbs/interhand-2-average.md`, here applied per-joint instead of per-dataset. These starting
 * multipliers are a judgment call, not a fitted number -- revise them if a specific joint's mapping
 * turns out to deserve a different one.
 */

import { CONNECTIONS, type Finger, FINGERS } from '$lib/hand'
import { Vector3 } from 'three'
import type { InterhandFrame } from './loadFrames'
import { computeSegmentMedians, DEFAULT_THRESHOLD, isSegmentTrustworthy, type SegmentMedians } from './segmentConsistency'

export type Directness = 'clean-hinge' | 'flex-abd-combined' | 'joint-stacked'

export const VARIANCE_MULTIPLIER: Record<Directness, number> = {
  'clean-hinge': 1,
  'flex-abd-combined': 4,
  'joint-stacked': 9,
}

/** Angle (degrees) between the incoming segment (a->joint) and outgoing segment (joint->b) --
 * 0 when the three points are collinear (straight), approaching 180 as the joint folds back on
 * itself. This is the same "flexion, 0 at straight, increasing with more bend" convention
 * `BetaRom`'s `minDeg`/`maxDeg` already use elsewhere in this project. */
export function bendAngleDeg(a: Vector3, joint: Vector3, b: Vector3): number {
  const inVec = joint.clone().sub(a).normalize()
  const outVec = b.clone().sub(joint).normalize()
  const cos = Math.max(-1, Math.min(1, inVec.dot(outVec)))
  return (Math.acos(cos) * 180) / Math.PI
}

interface JointSpec {
  jointName: string
  a: number
  joint: number
  b: number
  directness: Directness
}

/** One measurable joint's landmark triple, in project order, per finger -- see the module doc comment
 * for how `directness` was derived from `degreesFor`, not assumed. */
function jointSpecs(finger: Finger): JointSpec[] {
  const pairs = CONNECTIONS[finger]
  const landmarks = [pairs[0][0], ...pairs.map(([, to]) => to)] // [wrist, j1, j2, j3, j4]
  const isRingOrPinky = finger === 'ringFinger' || finger === 'pinky'
  const baseJointName = finger === 'thumb' ? 'cmc' : 'mcp'
  const midJointName = finger === 'thumb' ? 'mcp' : 'pip'
  const lastJointName = finger === 'thumb' ? 'ip' : 'dip'
  return [
    {
      jointName: baseJointName,
      a: landmarks[0],
      joint: landmarks[1],
      b: landmarks[2],
      directness: isRingOrPinky ? 'joint-stacked' : 'flex-abd-combined',
    },
    { jointName: midJointName, a: landmarks[1], joint: landmarks[2], b: landmarks[3], directness: 'clean-hinge' },
    { jointName: lastJointName, a: landmarks[2], joint: landmarks[3], b: landmarks[4], directness: 'clean-hinge' },
  ]
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

export interface FittedJointRom {
  finger: Finger
  jointName: string
  directness: Directness
  meanDeg: number
  /** raw within-subject standard deviation -- NOT the declared confidence, see `declaredSdDeg` */
  sdDeg: number
  /** `sdDeg * sqrt(VARIANCE_MULTIPLIER[directness])` -- what a caller should actually declare as this
   * observation's uncertainty when folding it into an `Observation`/`VectorObservation`. */
  declaredSdDeg: number
  minDeg: number
  maxDeg: number
  /** frames actually used, after excluding any where a segment feeding this joint's angle failed the
   * consistency check (see `excludedByBadSegment`) */
  n: number
  /** how many otherwise-valid frames were dropped for this joint specifically because one of its two
   * adjacent segments deviated from its own subject-median length by more than `threshold` -- see
   * `segmentConsistency.ts`. Reported explicitly so filtering is visible, not silent. */
  excludedByBadSegment: number
}

/** `threshold` is the fractional segment-length deviation (from that segment's own subject-median)
 * beyond which a frame is dropped for any joint touching that segment -- see `segmentConsistency.ts`'s
 * module doc comment for how `DEFAULT_THRESHOLD` was chosen from subject 0's actual data, not guessed. */
export function fitRom(frames: InterhandFrame[], threshold: number = DEFAULT_THRESHOLD): FittedJointRom[] {
  if (frames.length === 0) throw new Error('fitRom: no frames given')
  const medians = computeSegmentMedians(frames)

  const results: FittedJointRom[] = []
  for (const finger of FINGERS) {
    for (const { jointName, a, joint, b, directness } of jointSpecs(finger)) {
      const trustworthy = frames.filter(f =>
        isSegmentTrustworthy(f, finger, a, joint, medians, threshold)
        && isSegmentTrustworthy(f, finger, joint, b, medians, threshold)
      )
      const angles = trustworthy.map(f => bendAngleDeg(f.points[a], f.points[joint], f.points[b]))
      const m = mean(angles)
      const sd = Math.sqrt(mean(angles.map(x => (x - m) ** 2)))
      results.push({
        finger,
        jointName,
        directness,
        meanDeg: m,
        sdDeg: sd,
        declaredSdDeg: sd * Math.sqrt(VARIANCE_MULTIPLIER[directness]),
        minDeg: Math.min(...angles),
        maxDeg: Math.max(...angles),
        n: angles.length,
        excludedByBadSegment: frames.length - trustworthy.length,
      })
    }
  }
  return results
}
