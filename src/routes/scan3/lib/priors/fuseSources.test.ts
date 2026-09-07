/**
 * `fuseSources.ts`'s central claim is that combining any subset of sources is order-independent -- see
 * that file's own doc comment for why. This checks that claim directly (several shuffled orderings of
 * the same source set produce the identical fused result), plus the scalar/vector fusion math against
 * hand-computed expectations, and the zero-coverage "genuinely unconstrained" behavior.
 */

import { describe, expect, test } from 'bun:test'
import { fuseHandPriorState, fuseScalar, fuseVector } from './fuseSources'
import type { HandPriorState, ScalarPrior, VectorPrior } from './handModel'
import { HAND_PRIOR_SEED } from './handModelData'
import type { PriorSource } from './priorSource'

function scalar(mean: number, variance: number): ScalarPrior {
  return { mean, variance, source: 'test' }
}

function vector(mean: number[], covariance: number[][]): VectorPrior {
  return { mean, covariance, source: 'test' }
}

function shuffled<T>(xs: T[], seed: number): T[] {
  const arr = xs.slice()
  let s = seed
  for (let i = arr.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    const j = s % (i + 1)
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

describe('fuseScalar', () => {
  test('single source returns it unchanged (mean/variance)', () => {
    const fused = fuseScalar([{ value: scalar(10, 4), label: 'a' }])
    expect(fused.mean).toBe(10)
    expect(fused.variance).toBe(4)
  })

  test('two sources: precision-weighted mean matches hand computation', () => {
    // precisions 1/4 and 1/1 -> total 1.25; mean = (10*0.25 + 20*1)/1.25 = 18
    const fused = fuseScalar([{ value: scalar(10, 4), label: 'a' }, { value: scalar(20, 1), label: 'b' }])
    expect(fused.mean).toBeCloseTo(18, 10)
    expect(fused.variance).toBeCloseTo(1 / 1.25, 10)
  })

  test('zero sources: unconstrained (huge variance), not literature fallback', () => {
    const fused = fuseScalar([])
    expect(fused.variance).toBeGreaterThan(1e6)
    expect(fused.source).toContain('unconstrained')
  })

  test('order independence across many random shufflings', () => {
    const entries = [
      { value: scalar(5, 2), label: 'a' },
      { value: scalar(-3, 7), label: 'b' },
      { value: scalar(12, 0.5), label: 'c' },
      { value: scalar(0, 100), label: 'd' },
    ]
    const base = fuseScalar(entries)
    for (let seed = 1; seed <= 8; seed++) {
      const fused = fuseScalar(shuffled(entries, seed))
      expect(fused.mean).toBeCloseTo(base.mean, 9)
      expect(fused.variance).toBeCloseTo(base.variance, 9)
    }
  })
})

describe('fuseVector', () => {
  test('single source returns it unchanged', () => {
    const v = vector([1, 2], [[1, 0], [0, 1]])
    const fused = fuseVector([{ value: v, label: 'a' }], 2)
    expect(fused.mean).toEqual([1, 2])
  })

  test('two independent-diagonal sources match scalar fusion per component', () => {
    const a = vector([10, 0], [[4, 0], [0, 9]])
    const b = vector([20, 0], [[1, 0], [0, 9]])
    const fused = fuseVector([{ value: a, label: 'a' }, { value: b, label: 'b' }], 2)
    // component 0 should match the same 10/4,20/1 computation as the scalar test above
    expect(fused.mean[0]).toBeCloseTo(18, 8)
    expect(fused.covariance[0][0]).toBeCloseTo(1 / 1.25, 8)
  })

  test('zero sources: unconstrained diagonal', () => {
    const fused = fuseVector([], 3)
    expect(fused.mean).toEqual([0, 0, 0])
    expect(fused.covariance[0][0]).toBeGreaterThan(1e6)
    expect(fused.covariance[0][1]).toBe(0)
  })

  test('order independence with correlated (non-diagonal) covariance', () => {
    const entries = [
      { value: vector([3, -1], [[2, 0.5], [0.5, 3]]), label: 'a' },
      { value: vector([-2, 4], [[5, -1], [-1, 2]]), label: 'b' },
      { value: vector([0, 0], [[10, 0], [0, 10]]), label: 'c' },
    ]
    const base = fuseVector(entries, 2)
    for (let seed = 1; seed <= 6; seed++) {
      const fused = fuseVector(shuffled(entries, seed), 2)
      fused.mean.forEach((m, i) => expect(m).toBeCloseTo(base.mean[i], 6))
      fused.covariance.forEach((row, i) => row.forEach((c, j) => expect(c).toBeCloseTo(base.covariance[i][j], 6)))
    }
  })
})

describe('fuseHandPriorState', () => {
  const literature: PriorSource = {
    id: 'literature',
    label: 'lit',
    sourceType: 'literature',
    description: '',
    data: { Right: HAND_PRIOR_SEED, Left: HAND_PRIOR_SEED },
  }
  const partial: PriorSource = {
    id: 'subject-x',
    label: 'subject-x',
    sourceType: 'interhand',
    description: '',
    data: {
      Right: {
        boneLengths: {
          handLength: scalar(160, 25),
        },
      },
    },
  }

  test('literature alone reproduces HAND_PRIOR_SEED exactly for every field it fully covers', () => {
    const fused = fuseHandPriorState([literature], 'Right')
    expect(fused.boneLengths.handLength.mean).toBeCloseTo(HAND_PRIOR_SEED.boneLengths.handLength.mean, 8)
    expect(fused.pipDipRom.pip.indexFinger.meanDeg).toBeCloseTo(HAND_PRIOR_SEED.pipDipRom.pip.indexFinger.meanDeg, 8)
  })

  test('literature contributes to both hands from the same single object', () => {
    const right = fuseHandPriorState([literature], 'Right')
    const left = fuseHandPriorState([literature], 'Left')
    expect(left.boneLengths.handLength.mean).toBeCloseTo(right.boneLengths.handLength.mean, 8)
  })

  test('a field with zero selected coverage is unconstrained, not silently literature', () => {
    const fused = fuseHandPriorState([partial], 'Right')
    // partial only provides handLength -- everything else, including every finger's bone-length
    // ratios, must come back unconstrained rather than quietly reusing literature's numbers.
    expect(fused.boneLengths.fingers.indexFinger.covariance[0][0]).toBeGreaterThan(1e6)
    expect(fused.wristForearm.wristFlexExtRom.sdDeg).toBeGreaterThan(1e3)
    expect(fused.wristForearm.wristFlexExtRom.minDeg).toBeLessThan(-1000)
  })

  test("a source with no data for a hand contributes nothing to that hand's fusion", () => {
    // `partial` only has a `Right` half -- fusing for 'Left' should behave as if it weren't selected
    // at all for every field, including handLength.
    const fused = fuseHandPriorState([partial], 'Left')
    expect(fused.boneLengths.handLength.variance).toBeGreaterThan(1e6)
  })

  test('order independence at the full HandPriorState level', () => {
    const sources = [literature, partial]
    const a = fuseHandPriorState(sources, 'Right')
    const b = fuseHandPriorState([...sources].reverse(), 'Right')
    expect(a.boneLengths.handLength.mean).toBeCloseTo(b.boneLengths.handLength.mean, 8)
    expect(a.boneLengths.handLength.variance).toBeCloseTo(b.boneLengths.handLength.variance, 8)
    expect(a.pipDipRom.pip.pinky.meanDeg).toBeCloseTo(b.pipDipRom.pip.pinky.meanDeg, 8)
  })

  test('result is a well-formed HandPriorState: every ROM stays internally consistent', () => {
    const fused: HandPriorState = fuseHandPriorState([literature, partial], 'Right')
    for (
      const rom of [
        ...Object.values(fused.pipDipRom.pip),
        ...Object.values(fused.pipDipRom.dip),
        fused.wristForearm.wristFlexExtRom,
      ]
    ) {
      expect(rom.minDeg).toBeLessThanOrEqual(rom.maxDeg)
      expect(rom.meanDeg).toBeGreaterThanOrEqual(rom.minDeg)
      expect(rom.meanDeg).toBeLessThanOrEqual(rom.maxDeg)
      expect(rom.sdDeg).toBeGreaterThan(0)
    }
  })
})
