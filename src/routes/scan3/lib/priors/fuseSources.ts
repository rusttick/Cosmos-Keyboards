/**
 * Combines any subset of `PriorSource`s (see `priorSource.ts`) into one `HandPriorState` snapshot, for
 * comparison in `multi-view` -- never for writing back to any source. Every source is an equal,
 * independent peer: the literature seed is not a "base" the others get folded into, just one more
 * entry in the array, and the result is the same `HandPriorState` regardless of which order the array
 * is given in or how it's split into batches.
 *
 * Why order/grouping don't matter: a Bayesian fusion of independent Gaussian estimates of the same
 * quantity is, underneath the mean/variance bookkeeping, just two running sums -- total precision
 * (1/variance) and total precision-weighted value. Addition is associative and commutative, so summing
 * a list of values, in any order, or summing two partial sums of it, gives the same total either way.
 * `fuseScalar`/`fuseVector` below compute those sums directly over every selected source at once
 * (an "information form" fusion) rather than by chaining pairwise updates -- mathematically identical
 * to chaining `update.ts`'s `updateScalar`/`updateVector` in any order, but order-independent by
 * construction instead of by trusting that chaining happens to commute. See `fuseSources.test.ts` for
 * an empirical check of exactly this (several random orderings of the same source set, same result).
 *
 * A field with zero selected sources isn't filled in from literature by default -- that would just be
 * literature quietly acting as a privileged fallback again, the thing this whole design avoids. It's
 * genuinely unconstrained instead: `UNCONSTRAINED_VARIANCE` (effectively infinite, but a large finite
 * number so it can't produce a `0 * Infinity = NaN` when it multiplies through `ikSolve.ts`'s coupling
 * terms) and, for a `BetaRom`, bounds wide enough that its hard clamp never binds. If your selection
 * leaves a field with no coverage, the model will visibly do whatever an unconstrained joint does --
 * that's the honest result of the selection, not a bug to paper over.
 */

import { FINGERS } from '$lib/hand'
import type { BetaRom, HandPriorState, NonThumbFinger, ScalarPrior, VectorPrior } from './handModel'
import type { PartialHandPriorState, PriorSource } from './priorSource'

const NON_THUMB_FINGERS = FINGERS.filter((f): f is NonThumbFinger => f !== 'thumb')

/** Large enough that any real declared variance (every one in this project is O(1)-O(1e3)) dominates
 * it completely; finite so it can't produce `Infinity * 0 = NaN` in a downstream coupling computation
 * (`ikSolve.ts` multiplies coupling variances by squared angles, which can legitimately be 0). */
const UNCONSTRAINED_VARIANCE = 1e12
const UNCONSTRAINED_ROM_DEG = 1e5

interface Entry<T> {
  value: T
  label: string
}

interface SourcePart {
  label: string
  data: PartialHandPriorState
}

function pick<T>(parts: SourcePart[], get: (d: PartialHandPriorState) => T | undefined): Entry<T>[] {
  const entries: Entry<T>[] = []
  for (const p of parts) {
    const value = get(p.data)
    if (value !== undefined) entries.push({ value, label: p.label })
  }
  return entries
}

function describeFusion(entries: Entry<unknown>[]): string {
  if (entries.length === 0) return 'unconstrained: no selected source provides this field'
  return `fused from: ${entries.map(e => e.label).join(', ')}`
}

// ---------------------------------------------------------------------------------------------------
// Scalar fusion: total precision = sum(1/variance); total precision-weighted mean = sum(mean/variance).

export function fuseScalar(entries: Entry<ScalarPrior>[]): ScalarPrior {
  if (entries.length === 0) {
    return { mean: 0, variance: UNCONSTRAINED_VARIANCE, source: describeFusion(entries), evidenceCount: 0 }
  }
  let totalPrecision = 0
  let totalWeightedMean = 0
  for (const { value } of entries) {
    const precision = 1 / value.variance
    totalPrecision += precision
    totalWeightedMean += precision * value.mean
  }
  return {
    mean: totalWeightedMean / totalPrecision,
    variance: 1 / totalPrecision,
    source: describeFusion(entries),
    evidenceCount: entries.length,
  }
}

// ---------------------------------------------------------------------------------------------------
// Vector fusion: information-form addition (Lambda = sum(covariance^-1), eta = sum(Lambda_i * mean_i)),
// the multivariate analogue of the scalar sums above -- see this module's doc comment.

function zeros(n: number): number[] {
  return new Array(n).fill(0)
}

function identityScaled(n: number, scale: number): number[][] {
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? scale : 0)))
}

function matVec(m: number[][], v: number[]): number[] {
  return m.map(row => row.reduce((sum, c, j) => sum + c * v[j], 0))
}

function matAdd(a: number[][], b: number[][]): number[][] {
  return a.map((row, i) => row.map((c, j) => c + b[i][j]))
}

/** Gauss-Jordan inverse. Fine for this project's small matrices (largest is enslaving's 4x4-flattened
 * 16x16); not intended as production numerics, same caveat `handModelData.test.ts`'s own Cholesky
 * helper carries. */
function invert(m: number[][]): number[][] {
  const n = m.length
  const a = m.map(row => row.slice())
  const inv = identityScaled(n, 1)
  for (let col = 0; col < n; col++) {
    let pivotRow = col
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivotRow][col])) pivotRow = r
    ;[a[col], a[pivotRow]] = [a[pivotRow], a[col]]
    ;[inv[col], inv[pivotRow]] = [inv[pivotRow], inv[col]]
    const pivot = a[col][col]
    for (let j = 0; j < n; j++) {
      a[col][j] /= pivot
      inv[col][j] /= pivot
    }
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const factor = a[r][col]
      if (factor === 0) continue
      for (let j = 0; j < n; j++) {
        a[r][j] -= factor * a[col][j]
        inv[r][j] -= factor * inv[col][j]
      }
    }
  }
  return inv
}

export function fuseVector(entries: Entry<VectorPrior>[], dim: number): { mean: number[]; covariance: number[][] } {
  if (entries.length === 0) return { mean: zeros(dim), covariance: identityScaled(dim, UNCONSTRAINED_VARIANCE) }
  if (entries.length === 1) return { mean: entries[0].value.mean, covariance: entries[0].value.covariance }

  let precisionTotal = identityScaled(dim, 0)
  let infoTotal = zeros(dim)
  for (const { value } of entries) {
    const precision = invert(value.covariance)
    precisionTotal = matAdd(precisionTotal, precision)
    const info = matVec(precision, value.mean)
    infoTotal = infoTotal.map((v, i) => v + info[i])
  }
  const covariance = invert(precisionTotal)
  const mean = matVec(covariance, infoTotal)
  return { mean, covariance }
}

// ---------------------------------------------------------------------------------------------------
// BetaRom fusion: mean/sd fuse like a scalar (precision-weighted); the hard min/max bounds take the
// widest range any selected source actually observed -- a real subject's own frame is direct evidence
// that angle is achievable, so narrowing past what was actually seen would be wrong, not conservative.

export function fuseBetaRom(entries: Entry<BetaRom>[]): BetaRom {
  if (entries.length === 0) {
    return {
      minDeg: -UNCONSTRAINED_ROM_DEG,
      maxDeg: UNCONSTRAINED_ROM_DEG,
      meanDeg: 0,
      sdDeg: Math.sqrt(UNCONSTRAINED_VARIANCE),
      source: describeFusion(entries),
    }
  }
  const asScalar = fuseScalar(entries.map(e => ({ value: { mean: e.value.meanDeg, variance: e.value.sdDeg ** 2, source: '' }, label: e.label })))
  return {
    minDeg: Math.min(...entries.map(e => e.value.minDeg)),
    maxDeg: Math.max(...entries.map(e => e.value.maxDeg)),
    meanDeg: asScalar.mean,
    sdDeg: Math.sqrt(asScalar.variance),
    source: describeFusion(entries),
  }
}

// ---------------------------------------------------------------------------------------------------
// Full-state assembly. `HAND_PRIOR_SEED`'s own structure (imported transitively via any registered
// literature source, but really just any complete `HandPriorState`) is never read here for its
// VALUES unless it's among `sources` -- only fixed, non-belief metadata (segment names, finger order)
// ever needs a schema to fall back on, and those come from `handModel.ts`'s own static conventions,
// not from a privileged data source. See `boneLengthSegments`/`ENSLAVING_ORDER` below.

/** `FingerBoneSegment` labels, in project chain order -- a fixed naming convention (`handModel.ts`),
 * not a belief, so it doesn't need fusing; every source that provides bone lengths for a finger is
 * expected to use this same order (`fitBoneLengths.ts` and `handModelData.ts` both already do). */
const BONE_SEGMENTS: Record<string, string[]> = {
  thumb: ['wristToCmc', 'metacarpal', 'proximal', 'distal'],
  indexFinger: ['metacarpal', 'proximal', 'middle', 'distal'],
  middleFinger: ['metacarpal', 'proximal', 'middle', 'distal'],
  ringFinger: ['metacarpal', 'proximal', 'middle', 'distal'],
  pinky: ['metacarpal', 'proximal', 'middle', 'distal'],
}

/** Fuses every selected source's `hand` half into one `HandPriorState` -- see `priorSource.ts`'s
 * `PriorSourcePair` doc comment for why each source carries independent Right/Left data instead of one
 * shared blob. A source with no data for `hand` (e.g. an InterHand2.6M subject fit from only one real
 * hand) simply contributes nothing to this call; call this again with the other `hand` to get that
 * side's own fused snapshot, from the same selection -- the two calls read a different half of each
 * source's `PriorSourcePair`, never mixing the two hands' numbers together. */
export function fuseHandPriorState(sources: PriorSource[], hand: 'Right' | 'Left'): HandPriorState {
  const parts: SourcePart[] = sources
    .map(s => (s.data[hand] ? { label: s.label, data: s.data[hand]! } : undefined))
    .filter((p): p is SourcePart => p !== undefined)

  const knuckleRowEntries = pick(parts, d => d.boneLengths?.knuckleRow)
  const boneLengths: HandPriorState['boneLengths'] = {
    handLength: fuseScalar(pick(parts, d => d.boneLengths?.handLength)),
    fingers: Object.fromEntries(
      FINGERS.map(finger => {
        const entries = pick(parts, d => d.boneLengths?.fingers?.[finger])
        const dim = BONE_SEGMENTS[finger].length
        const fused = fuseVector(entries, dim)
        return [finger, { segments: BONE_SEGMENTS[finger], ...fused, source: describeFusion(entries) }]
      }),
    ) as HandPriorState['boneLengths']['fingers'],
    knuckleRow: { ...fuseVector(knuckleRowEntries, 3), source: describeFusion(knuckleRowEntries) },
  }

  const pipDipRom: HandPriorState['pipDipRom'] = {
    pip: Object.fromEntries(NON_THUMB_FINGERS.map(f => [f, fuseBetaRom(pick(parts, d => d.pipDipRom?.pip?.[f]))])) as HandPriorState['pipDipRom']['pip'],
    dip: Object.fromEntries(NON_THUMB_FINGERS.map(f => [f, fuseBetaRom(pick(parts, d => d.pipDipRom?.dip?.[f]))])) as HandPriorState['pipDipRom']['dip'],
  }

  const mcpAxes: HandPriorState['mcpAxes'] = Object.fromEntries(
    NON_THUMB_FINGERS.map(f => [
      f,
      {
        flexExtRom: fuseBetaRom(pick(parts, d => d.mcpAxes?.[f]?.flexExtRom)),
        abAdRom: fuseBetaRom(pick(parts, d => d.mcpAxes?.[f]?.abAdRom)),
        abAdChokeCoeff: fuseScalar(pick(parts, d => d.mcpAxes?.[f]?.abAdChokeCoeff)),
        axialRotationWeight: fuseScalar(pick(parts, d => d.mcpAxes?.[f]?.axialRotationWeight)),
      },
    ]),
  ) as HandPriorState['mcpAxes']

  const cmcMobility: HandPriorState['cmcMobility'] = {
    thumb: {
      flexExtRom: fuseBetaRom(pick(parts, d => d.cmcMobility?.thumb?.flexExtRom)),
      abAdRom: fuseBetaRom(pick(parts, d => d.cmcMobility?.thumb?.abAdRom)),
      conjunctCoupling: {
        ...fuseVector(pick(parts, d => d.cmcMobility?.thumb?.conjunctCoupling), 2),
        source: describeFusion(pick(parts, d => d.cmcMobility?.thumb?.conjunctCoupling)),
      },
    },
    ring: { flexionRom: fuseBetaRom(pick(parts, d => d.cmcMobility?.ring?.flexionRom)) },
    pinky: { flexionRom: fuseBetaRom(pick(parts, d => d.cmcMobility?.pinky?.flexionRom)) },
  }

  const dipPipCoupling: HandPriorState['dipPipCoupling'] = Object.fromEntries(
    NON_THUMB_FINGERS.map(f => {
      const entries = pick(parts, d => d.dipPipCoupling?.[f])
      return [f, { ...fuseVector(entries, 2), source: describeFusion(entries) }]
    }),
  ) as HandPriorState['dipPipCoupling']

  const enslavingEntries = pick(parts, d => d.enslaving?.coefficients)
  const enslaving: HandPriorState['enslaving'] = {
    fingerOrder: NON_THUMB_FINGERS,
    coefficients: { ...fuseVector(enslavingEntries, NON_THUMB_FINGERS.length ** 2), source: describeFusion(enslavingEntries) },
  }

  const wristForearm: HandPriorState['wristForearm'] = {
    wristFlexExtRom: fuseBetaRom(pick(parts, d => d.wristForearm?.wristFlexExtRom)),
    wristRadialUlnarRom: fuseBetaRom(pick(parts, d => d.wristForearm?.wristRadialUlnarRom)),
    forearmPronationSupinationRom: fuseBetaRom(pick(parts, d => d.wristForearm?.forearmPronationSupinationRom)),
    elbowFlexionRom: fuseBetaRom(pick(parts, d => d.wristForearm?.elbowFlexionRom)),
    elbowSwivelAngle: fuseScalar(pick(parts, d => d.wristForearm?.elbowSwivelAngle)),
    forearmLengthRatio: fuseScalar(pick(parts, d => d.wristForearm?.forearmLengthRatio)),
    tenodesisCoupling: fuseScalar(pick(parts, d => d.wristForearm?.tenodesisCoupling)),
    forearmLengthStatureCoupling: fuseScalar(pick(parts, d => d.wristForearm?.forearmLengthStatureCoupling)),
    swivelWristForearmCoupling: fuseScalar(pick(parts, d => d.wristForearm?.swivelWristForearmCoupling)),
  }

  return { boneLengths, pipDipRom, mcpAxes, cmcMobility, dipPipCoupling, enslaving, wristForearm }
}
