/**
 * MCP ab/ad choke coefficient (`mcpAxes.*.abAdChokeCoeff`) from real InterHand2.6M frames --
 * `docs/thumbs/interhand-2-average.md` Stage 3c. Unlike bone lengths or PIP/DIP (Stages 3a/3b), this
 * genuinely needs an ab/ad-vs-flexion axis split, and this project has no per-subject calibrated axis
 * for InterHand2.6M's subjects -- so this uses one fixed, explicitly-declared convention applied
 * identically to every subject: `$lib/hand.ts`'s own `palmBasisAxes` (the project-wide canonical palm
 * frame, built from landmarks `[0, 5, 17]` -- the same convention `buildDefaultSkeleton`'s splay and
 * every multi-view tile already read from, not a new one invented for this). The result is flagged
 * plainly as computed under an assumed shared convention, not per-subject anatomical truth -- same
 * epistemic status this project already gives `thumbDepthSign`/`signedJointAngle` elsewhere.
 *
 * Per Stage 3c: bin frames by flexion and check, BEFORE fitting anything, that the raw ab/ad half-range
 * visibly shrinks as flexion increases. Only fit a slope if that qualitative shrinkage is actually
 * there -- if it isn't, `fitMcpChoke` reports that honestly (`fitted: false`) rather than forcing a
 * number out of noise.
 */

import { CONNECTIONS, FINGERS, palmBasisAxes } from '$lib/hand'
import { Vector3 } from 'three'
import type { NonThumbFinger } from '../handModel'
import { bendAngleDeg } from './fitRom'
import type { InterhandFrame } from './loadFrames'
import { computeSegmentMedians, DEFAULT_THRESHOLD, isSegmentTrustworthy } from './segmentConsistency'

const NON_THUMB_FINGERS = FINGERS.filter((f): f is NonThumbFinger => f !== 'thumb')
const NUM_BINS = 8

interface Sample {
  flexionDeg: number
  abAdDeg: number
}

/** Signed ab/ad angle (degrees): how far the MCP-to-PIP direction deviates from the palm's own sagittal
 * ("flexion") plane (spanned by `up`/`normal`), i.e. `asin(dir . left)` -- NOT `atan2(left, up)` against
 * the palm frame, which was this file's first attempt and had a real bug: at high flexion the direction
 * rotates out of the up/left plane entirely (toward `normal`), so both `upComp` and `leftComp` shrink
 * toward zero and `atan2` becomes noise-dominated, wrapping across +-180deg for a tiny real ab/ad angle
 * -- confirmed directly against subject 0's data, where `atan2`'s reported half-range exploded to
 * 150-170deg specifically in the highest-flexion bins (fist poses), an angle-convention artifact, not
 * real ab/ad spread. `asin(dir . left)` has no such blind spot: it's well-defined for any direction
 * (a unit vector's dot product with `left` is always in [-1, 1]) regardless of how far into flexion the
 * finger has rotated, since it only asks "how far out of the sagittal plane," never referencing `up`.
 * Baseline (finger-specific splay at zero flexion) is NOT removed, since only the within-bin SPREAD is
 * used below, and a constant per-finger offset cancels out of a spread measure. */
function abAdDeg(mcp: Vector3, pip: Vector3, axes: { left: Vector3 }): number {
  const dir = pip.clone().sub(mcp).normalize()
  const leftComp = Math.max(-1, Math.min(1, dir.dot(axes.left)))
  return (Math.asin(leftComp) * 180) / Math.PI
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

function pearson(x: number[], y: number[]): number {
  const xBar = mean(x)
  const yBar = mean(y)
  const sxy = x.reduce((s, xi, i) => s + (xi - xBar) * (y[i] - yBar), 0)
  const sxx = x.reduce((s, xi) => s + (xi - xBar) ** 2, 0)
  const syy = y.reduce((s, yi) => s + (yi - yBar) ** 2, 0)
  if (sxx === 0 || syy === 0) return 0
  return sxy / Math.sqrt(sxx * syy)
}

export interface McpChokeBin {
  flexionMidDeg: number
  halfRangeDeg: number
  n: number
}

export interface FittedMcpChoke {
  finger: NonThumbFinger
  bins: McpChokeBin[]
  /** Pearson correlation between bin-midpoint flexion and bin half-range, across populated bins --
   * the qualitative check itself, reported even when `fitted` is false. */
  shrinkageCorrelation: number
  /** Only true if `shrinkageCorrelation` is negative enough to trust (see `MIN_SHRINKAGE_CORRELATION`
   * below) -- per Stage 3c, no slope is fit otherwise. */
  fitted: boolean
  /** Degrees of half-range lost per degree of flexion (this file's convention matches
   * `ikSolve.ts`'s `abAdChokeCoeff` directly: `effectiveHalfRange = halfRange - chokeCoeff * flexDeg`).
   * `undefined` when `fitted` is false. */
  chokeCoeff?: number
  chokeCoeffVariance?: number
}

const MIN_SHRINKAGE_CORRELATION = -0.3
const MIN_FRAMES_PER_BIN = 5

export function fitMcpChoke(frames: InterhandFrame[], handedness: 'Right' | 'Left' = 'Right', threshold: number = DEFAULT_THRESHOLD): FittedMcpChoke[] {
  if (frames.length === 0) throw new Error('fitMcpChoke: no frames given')
  const medians = computeSegmentMedians(frames)

  return NON_THUMB_FINGERS.map(finger => {
    const pairs = CONNECTIONS[finger]
    const landmarks = [pairs[0][0], ...pairs.map(([, to]) => to)] // [wrist, mcp, pip, dip, tip]
    const [wrist, mcp, pip] = landmarks

    // Same segment-consistency filter fitRom.ts/fitDipPipCoupling.ts already use -- a frame where the
    // mcp->pip segment itself is badly triangulated (self-occlusion, typically at high flexion/fist
    // poses) produces a garbage direction vector, which would otherwise show up as spurious ab/ad
    // spread that grows with flexion for the wrong reason (occlusion, not a real anatomical widening).
    const trustworthy = frames.filter(f => isSegmentTrustworthy(f, finger, mcp, pip, medians, threshold))

    const samples: Sample[] = trustworthy.map(f => {
      const axes = palmBasisAxes(f.points, handedness)
      return {
        flexionDeg: bendAngleDeg(f.points[wrist], f.points[mcp], f.points[pip]),
        abAdDeg: abAdDeg(f.points[mcp], f.points[pip], axes),
      }
    })

    const minFlex = Math.min(...samples.map(s => s.flexionDeg))
    const maxFlex = Math.max(...samples.map(s => s.flexionDeg))
    const width = (maxFlex - minFlex) / NUM_BINS

    const bins: McpChokeBin[] = []
    for (let b = 0; b < NUM_BINS; b++) {
      const lo = minFlex + b * width
      const hi = b === NUM_BINS - 1 ? maxFlex + 1e-9 : lo + width
      const inBin = samples.filter(s => s.flexionDeg >= lo && s.flexionDeg < hi)
      if (inBin.length < MIN_FRAMES_PER_BIN) continue
      const abAds = inBin.map(s => s.abAdDeg)
      bins.push({
        flexionMidDeg: (lo + hi) / 2,
        halfRangeDeg: (Math.max(...abAds) - Math.min(...abAds)) / 2,
        n: inBin.length,
      })
    }

    const shrinkageCorrelation = bins.length >= 3 ? pearson(bins.map(b => b.flexionMidDeg), bins.map(b => b.halfRangeDeg)) : 0
    const fitted = bins.length >= 3 && shrinkageCorrelation <= MIN_SHRINKAGE_CORRELATION

    if (!fitted) return { finger, bins, shrinkageCorrelation, fitted }

    // OLS of halfRange ~ a + slope*flexionMid; chokeCoeff is -slope (positive when half-range shrinks
    // as flexion increases), matching ikSolve.ts's sign convention (see this file's doc comment).
    const x = bins.map(b => b.flexionMidDeg)
    const y = bins.map(b => b.halfRangeDeg)
    const xBar = mean(x)
    const yBar = mean(y)
    const sxx = x.reduce((s, xi) => s + (xi - xBar) ** 2, 0)
    const sxy = x.reduce((s, xi, i) => s + (xi - xBar) * (y[i] - yBar), 0)
    const slope = sxx === 0 ? 0 : sxy / sxx
    const intercept = yBar - slope * xBar
    const residuals = x.map((xi, i) => y[i] - (slope * xi + intercept))
    const ssRes = residuals.reduce((s, r) => s + r ** 2, 0)
    const sigma2 = bins.length > 2 && sxx > 0 ? ssRes / (bins.length - 2) : Infinity
    const varSlope = sxx > 0 ? sigma2 / sxx : Infinity

    return { finger, bins, shrinkageCorrelation, fitted, chokeCoeff: -slope, chokeCoeffVariance: varSlope }
  })
}
