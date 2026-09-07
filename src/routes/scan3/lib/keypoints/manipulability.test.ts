import { describe, expect, test } from 'bun:test'
import type { Vector3Tuple } from 'three'
import { numericalJacobian, yoshikawaManipulability } from './manipulability'

describe('numericalJacobian', () => {
  test('recovers an exact linear map (constant Jacobian everywhere)', () => {
    // position = [2*a, 3*b, -1*c] -- Jacobian should be exactly [[2,0,0],[0,3,0],[0,0,-1]] regardless
    // of where it's evaluated.
    const positionAt = ([a, b, c]: number[]): Vector3Tuple => [2 * a, 3 * b, -1 * c]
    const J = numericalJacobian(positionAt, [1.3, -0.7, 2.2])
    expect(J[0][0]).toBeCloseTo(2, 5)
    expect(J[1][1]).toBeCloseTo(3, 5)
    expect(J[2][2]).toBeCloseTo(-1, 5)
    expect(J[0][1]).toBeCloseTo(0, 5)
    expect(J[1][2]).toBeCloseTo(0, 5)
  })

  test('supports any number of free angles, including 2', () => {
    const positionAt = ([a, b]: number[]): Vector3Tuple => [Math.cos(a), Math.sin(a), b]
    const J = numericalJacobian(positionAt, [0, 0])
    expect(J.length).toBe(3)
    expect(J[0].length).toBe(2)
  })
})

describe('yoshikawaManipulability', () => {
  test('an orthonormal 3x3 Jacobian (identity) has manipulability exactly 1', () => {
    const J = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]
    expect(yoshikawaManipulability(J)).toBeCloseTo(1, 6)
  })

  test('scaling every row by k scales manipulability by k^3 (3x3 case)', () => {
    const k = 2
    const J = [
      [k, 0, 0],
      [0, k, 0],
      [0, 0, k],
    ]
    expect(yoshikawaManipulability(J)).toBeCloseTo(k ** 3, 6)
  })

  test('a rank-deficient (2-column) Jacobian returns exactly 0 -- a real degenerate case, not a bug', () => {
    // Fewer than 3 free angles: J*J^T is necessarily rank <= 2 in a 3x3 matrix, so det = 0.
    const J = [
      [1, 0],
      [0, 1],
      [0, 0],
    ]
    expect(yoshikawaManipulability(J)).toBe(0)
  })

  test('a genuinely singular 3-column Jacobian (two dependent columns) also returns 0', () => {
    const J = [
      [1, 2, 3],
      [0, 0, 0],
      [1, 2, 3],
    ]
    expect(yoshikawaManipulability(J)).toBeCloseTo(0, 6)
  })
})
