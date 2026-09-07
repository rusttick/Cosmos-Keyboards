/**
 * Stage 8 of docs/thumbs/representing-keyboard-build-inputs.md: posture cost -- how typical a sampled
 * joint-angle vector is under the current posterior, per `key-point-selection.md`'s Step 2 ("negative
 * log-density of this joint-angle vector under the current posterior... replaces the old separate
 * 'neutral-pose deviation' and 'comfortable-vs-full ROM tier' mechanisms").
 *
 * Implemented as a Gaussian penalty (`((angleDeg - meanDeg) / sdDeg) ** 2`, i.e. squared z-score, the
 * negative-log-density of a Gaussian up to an additive/multiplicative constant that doesn't affect
 * relative comparisons) rather than `average-hand.md`'s specified Beta soft-limit density -- this
 * matches `ikSolve.ts`'s own ROM term, which `docs/thumbs/TODO.md` already flags as "a Gaussian penalty
 * plus a hard clamp, not... the Beta soft-limit density" the spec calls for. Reusing that existing
 * simplification here keeps this file consistent with the rest of the codebase rather than introducing
 * a third convention; fixing it properly (a real Beta log-density) is `ikSolve.ts`'s own open item, not
 * something to solve differently just for this visualization.
 *
 * Cross-joint correlations (the full posterior covariance) are also not used here -- each joint's cost
 * is summed independently, the same per-DOF-independent simplification `pairedSweep.ts`'s enslaving fit
 * and `ikSolve.ts`'s own dipPipCoupling variance term already make elsewhere in this codebase.
 */
import type { BetaRom } from '../priors/handModel'

/** Squared z-score of `angleDeg` under `rom`'s Gaussian (meanDeg, sdDeg) -- 0 at the mean, growing
 * quadratically away from it. */
export function gaussianPostureCost(angleDeg: number, rom: Pick<BetaRom, 'meanDeg' | 'sdDeg'>): number {
  const z = (angleDeg - rom.meanDeg) / rom.sdDeg
  return z * z
}

/** Sum of each joint's own `gaussianPostureCost`, over however many (angle, rom) pairs the caller's
 * sampler tracks as free DOF for one sample. */
export function totalPostureCost(joints: { angleDeg: number; rom: Pick<BetaRom, 'meanDeg' | 'sdDeg'> }[]): number {
  return joints.reduce((sum, { angleDeg, rom }) => sum + gaussianPostureCost(angleDeg, rom), 0)
}
