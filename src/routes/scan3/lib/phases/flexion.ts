/**
 * Phase 3 (tier 2): DIP-vs-PIP coupling fit — Test 8, docs/thumbs/scan_tests.md.
 *
 * Most people can't flex the DIP joint independently of the PIP joint, so scan_procedure.md models
 * DIP as a linear function of PIP rather than driving it separately: `dip ≈ slope*pip + intercept`.
 * This fits that line (ordinary least squares) plus its R² over a full-tier flexion sweep, and
 * returns per-frame residuals so a caller can check whether they're randomly scattered (the linear
 * model is adequate) or curve systematically near the ROM extremes (it isn't, per
 * scan_tests.md's "DIP/PIP coupling fit quality").
 */

import { type Finger, type Hand, signedJointAngle } from '$lib/hand'

export interface DipPipCoupling {
  slope: number
  intercept: number
  r2: number
}

export interface DipPipSample {
  pip: number // degrees
  dip: number // degrees
  residual: number // dip - (slope*pip + intercept)
}

export interface DipPipFit extends DipPipCoupling {
  samples: DipPipSample[]
}

/** PIP = signed angle between bones 1 and 2 of the finger's 4-bone chain; DIP = bones 2 and 3 — the
 * same `signedJointAngle` convention flexion-sweep's live ROM table and `pairedSweep.ts` also use, at
 * boneIndex 1 and 2 respectively. Signed rather than `angleTo`'s unsigned magnitude specifically so a
 * DIP or PIP range that includes hyperextension isn't folded into ordinary flexion's numbers — see
 * `signedJointAngle`'s doc comment in `$lib/hand.ts` for the sign convention and its caveats. */
function pipDipAngles(hand: Hand, finger: Finger): [pip: number, dip: number] {
  const pip = signedJointAngle(hand, finger, 1)
  const dip = signedJointAngle(hand, finger, 2)
  return [pip, dip]
}

/** Ordinary least-squares fit of dip ~ slope*pip + intercept, plus R² and per-frame residuals. */
export function fitDipPipCoupling(history: Hand[], finger: Finger): DipPipFit {
  if (history.length < 2) {
    throw new Error('fitDipPipCoupling needs at least 2 frames')
  }

  const pairs = history.map((hand) => pipDipAngles(hand, finger))

  const n = pairs.length
  const sumPip = sum(pairs.map(([pip]) => pip))
  const sumDip = sum(pairs.map(([, dip]) => dip))
  const meanPip = sumPip / n
  const meanDip = sumDip / n

  const covariance = sum(pairs.map(([pip, dip]) => (pip - meanPip) * (dip - meanDip)))
  const variancePip = sum(pairs.map(([pip]) => (pip - meanPip) ** 2))

  // A degenerate sweep (pip never varies) has no well-defined slope; fall back to a flat line
  // rather than dividing by zero, since callers care about r2 (which will read as 0) more than slope.
  const slope = variancePip === 0 ? 0 : covariance / variancePip
  const intercept = meanDip - slope * meanPip

  const samples: DipPipSample[] = pairs.map(([pip, dip]) => ({
    pip,
    dip,
    residual: dip - (slope * pip + intercept),
  }))

  const ssRes = sum(samples.map((s) => s.residual ** 2))
  const ssTot = sum(pairs.map(([, dip]) => (dip - meanDip) ** 2))
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot

  return { slope, intercept, r2, samples }
}

function sum(xs: number[]) {
  return xs.reduce((a, b) => a + b, 0)
}
