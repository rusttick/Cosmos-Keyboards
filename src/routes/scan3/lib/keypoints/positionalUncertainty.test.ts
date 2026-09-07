import { describe, expect, test } from 'bun:test'
import { propagatedPositionalVariance } from './positionalUncertainty'

describe('propagatedPositionalVariance', () => {
  test('zero variance in every DOF propagates to zero positional variance', () => {
    const J = [
      [1, 2],
      [3, 4],
      [5, 6],
    ]
    expect(propagatedPositionalVariance(J, [0, 0])).toBe(0)
  })

  test('a single-DOF identity-like Jacobian recovers the DOF variance directly (in rad^2)', () => {
    // J maps DOF 0 purely to x with unit gain -- Var(x) should equal Var(angle) exactly.
    const J = [[1], [0], [0]]
    const sdDeg = 10
    const DEG2RAD = Math.PI / 180
    const expected = (sdDeg * DEG2RAD) ** 2
    expect(propagatedPositionalVariance(J, [sdDeg])).toBeCloseTo(expected, 10)
  })

  test('more uncertain joints (larger sdDeg) propagate to more positional variance', () => {
    const J = [
      [1, 1],
      [1, 1],
      [1, 1],
    ]
    const narrow = propagatedPositionalVariance(J, [2, 2])
    const wide = propagatedPositionalVariance(J, [20, 20])
    expect(wide).toBeGreaterThan(narrow)
  })

  test('a Jacobian column of all zeros (a DOF with no positional effect) contributes nothing regardless of its variance', () => {
    const J = [
      [1, 0],
      [1, 0],
      [1, 0],
    ]
    const withZeroCol = propagatedPositionalVariance(J, [5, 1000])
    const withoutCol = propagatedPositionalVariance([[1], [1], [1]], [5])
    expect(withZeroCol).toBeCloseTo(withoutCol, 10)
  })
})
