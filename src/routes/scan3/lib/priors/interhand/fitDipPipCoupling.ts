/**
 * DIP/PIP coupling (`dipPipCoupling`) from real InterHand2.6M frames -- `docs/thumbs/interhand-2-average.md`
 * Stage 3b. Like `fitRom.ts`'s clean-hinge angles, this needs no per-subject axis calibration: PIP and
 * DIP are both simple one-axis hinges, so each is just the bend angle between its two adjacent bone
 * vectors (`fitRom.ts`'s own `bendAngleDeg`), directly computable from raw 3D positions.
 *
 * Currently a pure uninformative placeholder in `handModelData.ts` (`mean: [1, 0]`, wide covariance,
 * "no usable published measurement found") -- any real signal from this data is a strict improvement.
 */

import { CONNECTIONS, FINGERS } from '$lib/hand'
import type { NonThumbFinger } from '../handModel'
import { bendAngleDeg } from './fitRom'
import type { InterhandFrame } from './loadFrames'
import { computeSegmentMedians, DEFAULT_THRESHOLD, isSegmentTrustworthy } from './segmentConsistency'

const NON_THUMB_FINGERS = FINGERS.filter((f): f is NonThumbFinger => f !== 'thumb')

export interface FittedDipPipCoupling {
  finger: NonThumbFinger
  slope: number
  intercept: number
  r2: number
  /** OLS coefficient covariance: [[var(slope), cov], [cov, var(intercept)]] -- the same shape
   * `dipPipCoupling[finger].covariance` expects, propagated from residual variance the standard way. */
  covariance: [[number, number], [number, number]]
  n: number
  excludedByBadSegment: number
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

/** Ordinary least squares, `y ~ slope*x + intercept`, plus the standard OLS coefficient-covariance
 * formula (assumes homoscedastic residual noise -- the same simplifying assumption `fitRom.ts`'s
 * declared-variance treatment already makes elsewhere in this pipeline, not a new one). */
function ols(x: number[], y: number[]): { slope: number; intercept: number; r2: number; covariance: [[number, number], [number, number]] } {
  const n = x.length
  const xBar = mean(x)
  const yBar = mean(y)
  const sxx = x.reduce((s, xi) => s + (xi - xBar) ** 2, 0)
  const sxy = x.reduce((s, xi, i) => s + (xi - xBar) * (y[i] - yBar), 0)
  const slope = sxx === 0 ? 0 : sxy / sxx
  const intercept = yBar - slope * xBar

  const residuals = x.map((xi, i) => y[i] - (slope * xi + intercept))
  const ssRes = residuals.reduce((s, r) => s + r ** 2, 0)
  const ssTot = y.reduce((s, yi) => s + (yi - yBar) ** 2, 0)
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot

  // Residual variance with the usual n-2 correction (two fitted parameters); degenerate (n<=2 or
  // sxx===0) cases fall back to a very wide covariance rather than dividing by zero.
  const sigma2 = n > 2 && sxx > 0 ? ssRes / (n - 2) : Infinity
  const varSlope = sxx > 0 ? sigma2 / sxx : Infinity
  const varIntercept = sxx > 0 ? sigma2 * (1 / n + xBar ** 2 / sxx) : Infinity
  const covSlopeIntercept = sxx > 0 ? (-sigma2 * xBar) / sxx : 0

  return { slope, intercept, r2, covariance: [[varSlope, covSlopeIntercept], [covSlopeIntercept, varIntercept]] }
}

export function fitDipPipCoupling(frames: InterhandFrame[], threshold: number = DEFAULT_THRESHOLD): FittedDipPipCoupling[] {
  if (frames.length === 0) throw new Error('fitDipPipCoupling: no frames given')
  const medians = computeSegmentMedians(frames)

  return NON_THUMB_FINGERS.map(finger => {
    const pairs = CONNECTIONS[finger]
    const landmarks = [pairs[0][0], ...pairs.map(([, to]) => to)] // [wrist, mcp, pip, dip, tip]
    const [, mcp, pip, dip, tip] = landmarks

    const trustworthy = frames.filter(f =>
      isSegmentTrustworthy(f, finger, mcp, pip, medians, threshold)
      && isSegmentTrustworthy(f, finger, pip, dip, medians, threshold)
      && isSegmentTrustworthy(f, finger, dip, tip, medians, threshold)
    )

    const pipAngles = trustworthy.map(f => bendAngleDeg(f.points[mcp], f.points[pip], f.points[dip]))
    const dipAngles = trustworthy.map(f => bendAngleDeg(f.points[pip], f.points[dip], f.points[tip]))
    const fit = ols(pipAngles, dipAngles)

    return {
      finger,
      ...fit,
      n: trustworthy.length,
      excludedByBadSegment: frames.length - trustworthy.length,
    }
  })
}
