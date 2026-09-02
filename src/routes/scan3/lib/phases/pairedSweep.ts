/**
 * Phase 5: enslaving coefficient fit — Test 9, docs/thumbs/scan_tests.md.
 *
 * scan_procedure.md: "Enslaving coefficient E[i][j] ≈ Δθ_j/Δθ_i, fit by regression over whichever
 * sub-segments of the trajectory have i's excursion dominating j's — the 'mostly one, relaxed other'
 * portions of the freeform motion satisfy this without a separately-instructed condition, following
 * the standard enslaving-matrix method [...], ported here from isometric force to unloaded kinematic
 * angle." No dedicated "move only finger i" instruction is needed — a freeform two-finger sweep
 * naturally passes through segments where one finger dominates, and this fit only uses those.
 */

import type { Finger } from '$lib/hand'

export interface Enslaving {
  coefficient: number
  r2: number
} // E[i][j] ≈ Δθ_j/Δθ_i

export interface EnslavingOptions {
  /** A frame-pair only counts toward the fit if |Δθ_i| exceeds this many degrees — otherwise both
   * fingers reading as "still" (the common case at the start/end of every stroke) would swamp the
   * regression with near-zero-signal points that are mostly sensor noise, not motion. */
  minDominantDelta: number
  /** A frame-pair counts as "i dominates" only if |Δθ_i| is at least this many times |Δθ_j| —
   * the freeform-sweep equivalent of the literature's "move only finger i" instruction. */
  dominanceRatio: number
}

const DEFAULT_OPTIONS: EnslavingOptions = { minDominantDelta: 3, dominanceRatio: 2 }

/** Fits E[i][j] from two simultaneously-recorded per-frame angle series (same finger-pair trajectory,
 * one flexion or abduction angle per finger per frame). Regression is forced through the origin
 * (Δθ_j = coefficient·Δθ_i, no intercept) since the quantity being fit is a ratio, matching
 * `scan3.md`'s `Enslaving` shape (coefficient + r2, no intercept field). */
export function fitEnslaving(angleI: number[], angleJ: number[], options: Partial<EnslavingOptions> = {}): Enslaving {
  if (angleI.length !== angleJ.length) {
    throw new Error('fitEnslaving needs paired, equal-length angle series')
  }
  if (angleI.length < 3) {
    throw new Error('fitEnslaving needs at least 3 frames (2 frame-to-frame deltas)')
  }
  const { minDominantDelta, dominanceRatio } = { ...DEFAULT_OPTIONS, ...options }

  const dominantDeltaI: number[] = []
  const dominantDeltaJ: number[] = []
  for (let t = 1; t < angleI.length; t++) {
    const dI = angleI[t] - angleI[t - 1]
    const dJ = angleJ[t] - angleJ[t - 1]
    if (Math.abs(dI) >= minDominantDelta && Math.abs(dI) >= dominanceRatio * Math.abs(dJ)) {
      dominantDeltaI.push(dI)
      dominantDeltaJ.push(dJ)
    }
  }

  if (dominantDeltaI.length < 2) {
    throw new Error(
      'fitEnslaving found fewer than 2 i-dominant frame-pairs -- the trial needs a segment where finger i clearly moves more than finger j',
    )
  }

  // Least squares through the origin: coefficient = sum(dI*dJ) / sum(dI^2).
  const sumIJ = sum(dominantDeltaI.map((dI, k) => dI * dominantDeltaJ[k]))
  const sumII = sum(dominantDeltaI.map((dI) => dI * dI))
  const coefficient = sumII === 0 ? 0 : sumIJ / sumII

  // R^2 for a through-origin fit is conventionally 1 - SSres/SS(y), using uncentered sum of squares
  // for the denominator (no mean-subtraction), since there's no intercept term absorbing the mean.
  const ssRes = sum(dominantDeltaJ.map((dJ, k) => (dJ - coefficient * dominantDeltaI[k]) ** 2))
  const ssY = sum(dominantDeltaJ.map((dJ) => dJ * dJ))
  const r2 = ssY === 0 ? 1 : 1 - ssRes / ssY

  return { coefficient, r2 }
}

function sum(xs: number[]) {
  return xs.reduce((a, b) => a + b, 0)
}

export type FingerPairKey = `${Finger}:${Finger}`

export function fingerPairKey(i: Finger, j: Finger): FingerPairKey {
  return `${i}:${j}`
}

/** Fits E[i][j] against every other tracked finger from one recording, rather than requiring a
 * separate two-finger session per pair. This is actually closer to the literature's own method than
 * a pairwise session is: the classic protocol instructs "move only finger i" and records the response
 * on every finger at once, then repeats per i — this is that, minus the explicit instruction (the
 * dominance filter inside fitEnslaving() finds the "i moved, others didn't" segments on its own).
 *
 * Each finger is fit independently against `angleI` — a segment can be i-dominant with respect to one
 * other finger while a different finger was also moving involuntarily that same frame, so there's no
 * shared "the segment" to reuse across fingers; fitEnslaving()'s own per-pair dominance filter handles
 * that correctly already. A finger with no i-dominant segment of its own is simply omitted from the
 * result rather than failing the whole batch. */
export function fitEnslavingAll(
  fingerI: Finger,
  angles: Partial<Record<Finger, number[]>>,
  options: Partial<EnslavingOptions> = {},
): Partial<Record<Finger, Enslaving>> {
  const angleI = angles[fingerI]
  if (!angleI) throw new Error(`fitEnslavingAll needs angle history for the active finger (${fingerI})`)

  const result: Partial<Record<Finger, Enslaving>> = {}
  for (const [finger, angleJ] of Object.entries(angles) as [Finger, number[]][]) {
    if (finger === fingerI || !angleJ) continue
    try {
      result[finger] = fitEnslaving(angleI, angleJ, options)
    } catch {
      // No i-dominant segment for this particular pair yet -- omit rather than fail the batch.
    }
  }
  return result
}
