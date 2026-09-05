import { describe, expect, test } from 'bun:test'
import { Vector3 } from 'three'
import { lookAtBasis } from './overlay'

function expectOrthonormal(basis: { right: Vector3; up: Vector3; forward: Vector3 }) {
  expect(basis.right.length()).toBeCloseTo(1, 6)
  expect(basis.up.length()).toBeCloseTo(1, 6)
  expect(basis.forward.length()).toBeCloseTo(1, 6)
  expect(basis.right.dot(basis.up)).toBeCloseTo(0, 6)
  expect(basis.right.dot(basis.forward)).toBeCloseTo(0, 6)
  expect(basis.up.dot(basis.forward)).toBeCloseTo(0, 6)
}

describe('lookAtBasis', () => {
  test('always returns an orthonormal basis', () => {
    const dirs = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(1, 1, 1), new Vector3(0, -1, 0)]
    for (const d of dirs) expectOrthonormal(lookAtBasis(d))
  })

  test("up equals the hint exactly when forward is perpendicular to it -- multi-view's core claim for its Front/Top/Right/Rear/Bottom/Left views", () => {
    const hint = new Vector3(0.3, 0.7, -0.2).normalize()
    // Any forward perpendicular to hint (verified via a vector explicitly built that way).
    const arbitrary = new Vector3(1, 0.5, -0.3)
    const forward = arbitrary.clone().sub(hint.clone().multiplyScalar(arbitrary.dot(hint))).normalize()
    expect(forward.dot(hint)).toBeCloseTo(0, 6)

    const basis = lookAtBasis(forward, hint)
    expect(basis.up.x).toBeCloseTo(hint.x, 6)
    expect(basis.up.y).toBeCloseTo(hint.y, 6)
    expect(basis.up.z).toBeCloseTo(hint.z, 6)
  })

  test('falls back to the secondary hint when forward is parallel to the primary one', () => {
    const hint = new Vector3(0, 1, 0)
    const fallback = new Vector3(0, 0, 1)
    const basis = lookAtBasis(new Vector3(0, 1, 0), hint, fallback)
    expectOrthonormal(basis)
    // With forward === hint, the primary hint can't be used (right = cross(hint, forward) = 0) --
    // confirm the fallback actually got used, not a degenerate zero-length basis.
    expect(basis.right.length()).toBeCloseTo(1, 6)
  })
})
