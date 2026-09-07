/**
 * Resolves a pair of MediaPipe landmark indices (0-20) to the specific `boneLengths.fingers[finger]`
 * segments they span, for the `/bones` caliper-measurement page. Scoped deliberately to single-finger
 * chains: two landmarks on the SAME finger's chain (landmark 0, the wrist, counts as being on every
 * finger's chain, since every `CONNECTIONS[finger]` starts there). A cross-finger span (thumb tip to
 * pinky tip, "hand breadth") would need real 3D pose geometry this project doesn't model as a
 * bone-length quantity at all -- correctly rejected here, not silently misinterpreted.
 */

import { CONNECTIONS, type Finger, FINGERS } from '$lib/hand'

export interface BoneSpan {
  finger: Finger
  /** Indices into `CONNECTIONS[finger]` / `FingerBoneLengths.segments` (they share one order) -- every
   * segment strictly between the two landmarks, in chain order. */
  segmentIndices: number[]
}

/** `[landmark0, landmark1, ...]` for one finger's chain, wrist first -- e.g. index finger:
 * `[0, 5, 6, 7, 8]`. Segment `i` (`CONNECTIONS[finger][i]`) runs from `chain[i]` to `chain[i+1]`. */
function chainFor(finger: Finger): number[] {
  const pairs = CONNECTIONS[finger]
  return [pairs[0][0], ...pairs.map(([, to]) => to)]
}

export function landmarkFinger(landmark: number): Finger | undefined {
  if (landmark === 0) return undefined // wrist belongs to every chain, not one specific finger
  for (const finger of FINGERS) {
    if (chainFor(finger).includes(landmark)) return finger
  }
  return undefined
}

/** `undefined` if the two landmarks aren't both on one finger's chain, or aren't in wrist-to-fingertip
 * order (A must come before B along the chain -- a caliper measurement has no direction otherwise). */
export function resolveBoneSpan(landmarkA: number, landmarkB: number): BoneSpan | undefined {
  if (landmarkA === landmarkB) return undefined

  // landmark 0 (wrist) needs the OTHER landmark to say which finger's chain is meant; otherwise both
  // landmarks must individually resolve to the same finger.
  const fingerB = landmarkFinger(landmarkB)
  const fingerA = landmarkFinger(landmarkA)
  let finger: Finger | undefined
  if (landmarkA === 0) finger = fingerB
  else if (landmarkB === 0) finger = fingerA
  else if (fingerA !== undefined && fingerA === fingerB) finger = fingerA
  if (!finger) return undefined

  const chain = chainFor(finger)
  const indexA = chain.indexOf(landmarkA)
  const indexB = chain.indexOf(landmarkB)
  if (indexA === -1 || indexB === -1 || indexA >= indexB) return undefined

  const segmentIndices = Array.from({ length: indexB - indexA }, (_, i) => indexA + i)
  return { finger, segmentIndices }
}

/** The four non-thumb MCPs, wrist-row order -- `boneLengths.knuckleRow`'s own chain (see that field's
 * doc comment in `handModel.ts`). `KNUCKLE_ROW_PAIRS[i]` is the gap between `KNUCKLE_ROW_CHAIN[i]` and
 * `KNUCKLE_ROW_CHAIN[i+1]`. */
export const KNUCKLE_ROW_CHAIN = [5, 9, 13, 17]

export interface KnuckleSpan {
  /** Indices into `boneLengths.knuckleRow.mean`/`KNUCKLE_ROW_PAIRS` -- every adjacent gap strictly
   * between the two landmarks. */
  gapIndices: number[]
}

/** `undefined` unless both landmarks are non-thumb MCPs (5, 9, 13, or 17) in index-to-pinky order --
 * the only span this project models a real adjacent-knuckle "bone" for (see `KNUCKLE_ROW_CHAIN`). Any
 * other landmark pairing that reaches this function has already failed `resolveBoneSpan`, so a caller
 * should try that first and fall back to this for the MCP-to-MCP case. */
export function resolveKnuckleSpan(landmarkA: number, landmarkB: number): KnuckleSpan | undefined {
  const indexA = KNUCKLE_ROW_CHAIN.indexOf(landmarkA)
  const indexB = KNUCKLE_ROW_CHAIN.indexOf(landmarkB)
  if (indexA === -1 || indexB === -1 || indexA >= indexB) return undefined
  const gapIndices = Array.from({ length: indexB - indexA }, (_, i) => indexA + i)
  return { gapIndices }
}
