/**
 * Per-frame quality filter for ROM extraction, built on the same signal Stage 1's bone-length
 * invariance check already validated (`docs/thumbs/interhand-2-average.md`): a segment whose length
 * this frame deviates a lot from its own subject-median length is a frame where that landmark was
 * probably badly triangulated (occlusion during a tight fist, a hidden fingertip, etc.), not a frame
 * telling us something real about the joint's range.
 *
 * Concretely investigated on subject 0's ring-finger DIP: every frame with an implausible (>100deg)
 * DIP reading also had a distal segment 34-75% shorter than its own median (typical 24.7mm, down to
 * 5.7-14.8mm) -- and critically, those bad frames came from FOUR different pose sequences
 * ('0017_fist_rigid', '0016_fist', '0010_thumbtuckrigid', '0048_index_point'), not just
 * fist-named ones. A hardcoded "exclude fist poses" rule would have missed two of the four. The
 * relative-deviation distribution itself has a real gap -- a smooth climb from 0% to ~25% through the
 * bulk of frames, then a jump to 42%+ by the 90th percentile -- which is where `DEFAULT_THRESHOLD`
 * below sits, not picked as a round number in isolation.
 */

import { CONNECTIONS, type Finger, FINGERS } from '$lib/hand'
import type { InterhandFrame } from './loadFrames'

export const DEFAULT_THRESHOLD = 0.3

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/** `key(finger, from, to)` for one segment -- matches `CONNECTIONS[finger]` pairs. */
function segmentKey(finger: Finger, from: number, to: number): string {
  return `${finger}:${from}-${to}`
}

export interface SegmentMedians {
  medianMM: Map<string, number>
}

/** Computes each tracked segment's median length across every frame given -- call once per subject
 * (or per fit-subject set), not per frame. */
export function computeSegmentMedians(frames: InterhandFrame[]): SegmentMedians {
  const medianMM = new Map<string, number>()
  for (const finger of FINGERS) {
    for (const [from, to] of CONNECTIONS[finger]) {
      const lengths = frames.map(f => f.points[from].distanceTo(f.points[to]))
      medianMM.set(segmentKey(finger, from, to), median(lengths))
    }
  }
  return { medianMM }
}

/** Whether the segment (`finger`, `from`->`to`) in this one frame is within `threshold` fractional
 * deviation of its own subject-median length -- `false` means this frame's reading for anything
 * depending on that segment (a bend angle at either of its endpoints) should be excluded. */
export function isSegmentTrustworthy(
  frame: InterhandFrame,
  finger: Finger,
  from: number,
  to: number,
  medians: SegmentMedians,
  threshold: number = DEFAULT_THRESHOLD,
): boolean {
  const med = medians.medianMM.get(segmentKey(finger, from, to))
  if (med === undefined || med === 0) return true // nothing to compare against -- don't exclude
  const observed = frame.points[from].distanceTo(frame.points[to])
  return Math.abs(observed - med) / med <= threshold
}
