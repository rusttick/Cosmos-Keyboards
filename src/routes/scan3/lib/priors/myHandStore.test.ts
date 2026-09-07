import { describe, expect, test } from 'bun:test'
import { get } from 'svelte/store'
import { mergeFlexionSweepFragment, myHandPrior, resetMyHandPrior } from './myHandStore'

function betaRom(meanDeg: number, sdDeg: number) {
  return { minDeg: meanDeg - 20, maxDeg: meanDeg + 20, meanDeg, sdDeg, source: 'test' }
}

describe('mergeFlexionSweepFragment', () => {
  test('first sweep populates an empty field outright', () => {
    resetMyHandPrior()
    mergeFlexionSweepFragment({ handedness: 'Right', finger: 'indexFinger', pip: betaRom(80, 5) })
    const state = get(myHandPrior)
    expect(state.Right?.pipDipRom?.pip?.indexFinger?.meanDeg).toBeCloseTo(80, 6)
  })

  test('a second sweep of the same finger and hand fuses (narrows), not overwrites', () => {
    resetMyHandPrior()
    mergeFlexionSweepFragment({ handedness: 'Right', finger: 'indexFinger', pip: betaRom(80, 10) })
    mergeFlexionSweepFragment({ handedness: 'Right', finger: 'indexFinger', pip: betaRom(84, 10) })
    const state = get(myHandPrior)
    // precision-weighted mean of two equal-variance observations is the plain average
    expect(state.Right?.pipDipRom?.pip?.indexFinger?.meanDeg).toBeCloseTo(82, 6)
    // fusing two independent observations should narrow the variance below either alone
    expect(state.Right?.pipDipRom?.pip?.indexFinger?.sdDeg).toBeLessThan(10)
  })

  test('sweeping a different finger does not disturb an already-set one', () => {
    resetMyHandPrior()
    mergeFlexionSweepFragment({ handedness: 'Right', finger: 'indexFinger', pip: betaRom(80, 5) })
    mergeFlexionSweepFragment({ handedness: 'Right', finger: 'middleFinger', pip: betaRom(85, 5) })
    const state = get(myHandPrior)
    expect(state.Right?.pipDipRom?.pip?.indexFinger?.meanDeg).toBeCloseTo(80, 6)
    expect(state.Right?.pipDipRom?.pip?.middleFinger?.meanDeg).toBeCloseTo(85, 6)
  })

  test('Right and Left hands are completely independent inside the same pair', () => {
    resetMyHandPrior()
    mergeFlexionSweepFragment({ handedness: 'Right', finger: 'ringFinger', pip: betaRom(90, 5) })
    mergeFlexionSweepFragment({ handedness: 'Left', finger: 'ringFinger', pip: betaRom(60, 5) })
    const state = get(myHandPrior)
    // The two hands' sweeps must NOT have been averaged together (this project's own capture data
    // found real Right/Left asymmetry for exactly this kind of field -- see myHandStore.ts's doc
    // comment) -- each hand keeps its own sweep's value untouched by the other's.
    expect(state.Right?.pipDipRom?.pip?.ringFinger?.meanDeg).toBeCloseTo(90, 6)
    expect(state.Left?.pipDipRom?.pip?.ringFinger?.meanDeg).toBeCloseTo(60, 6)
  })

  test('resetMyHandPrior(handedness) clears only that hand', () => {
    resetMyHandPrior()
    mergeFlexionSweepFragment({ handedness: 'Right', finger: 'indexFinger', pip: betaRom(80, 5) })
    mergeFlexionSweepFragment({ handedness: 'Left', finger: 'indexFinger', pip: betaRom(70, 5) })
    resetMyHandPrior('Right')
    const state = get(myHandPrior)
    expect(state.Right).toBeUndefined()
    expect(state.Left?.pipDipRom?.pip?.indexFinger?.meanDeg).toBeCloseTo(70, 6)
  })

  test('enslaving: only the swept pair narrows, everything else stays unconstrained', () => {
    resetMyHandPrior()
    mergeFlexionSweepFragment({
      handedness: 'Right',
      finger: 'indexFinger',
      enslavingAgainst: { middleFinger: { coefficient: 0.3, variance: 0.01 } },
    })
    const state = get(myHandPrior)
    const coeffs = state.Right?.enslaving?.coefficients!
    const order = state.Right!.enslaving!.fingerOrder!
    const idx = order.length * order.indexOf('indexFinger') + order.indexOf('middleFinger')
    const otherIdx = order.length * order.indexOf('ringFinger') + order.indexOf('pinky')
    expect(coeffs.mean[idx]).toBeCloseTo(0.3, 6)
    expect(coeffs.covariance[idx][idx]).toBeCloseTo(0.01, 6)
    expect(coeffs.covariance[otherIdx][otherIdx]).toBeGreaterThan(1e6)
  })

  test('a later sweep narrows an existing enslaving entry without disturbing others', () => {
    resetMyHandPrior()
    mergeFlexionSweepFragment({
      handedness: 'Right',
      finger: 'indexFinger',
      enslavingAgainst: { middleFinger: { coefficient: 0.2, variance: 0.04 }, ringFinger: { coefficient: 0.1, variance: 0.04 } },
    })
    mergeFlexionSweepFragment({
      handedness: 'Right',
      finger: 'indexFinger',
      enslavingAgainst: { middleFinger: { coefficient: 0.4, variance: 0.04 } },
    })
    const state = get(myHandPrior)
    const coeffs = state.Right?.enslaving?.coefficients!
    const order = state.Right!.enslaving!.fingerOrder!
    const middleIdx = order.length * order.indexOf('indexFinger') + order.indexOf('middleFinger')
    const ringIdx = order.length * order.indexOf('indexFinger') + order.indexOf('ringFinger')
    // middleFinger got two independent 0.2/0.4 (equal variance) observations -> average 0.3
    expect(coeffs.mean[middleIdx]).toBeCloseTo(0.3, 6)
    // ringFinger only got the first sweep's 0.1 -- untouched by the second sweep
    expect(coeffs.mean[ringIdx]).toBeCloseTo(0.1, 6)
  })
})
