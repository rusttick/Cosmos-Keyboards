import { describe, expect, test } from 'bun:test'
import { CONCAVE_BONES, CONVEX_BONES, forwardKinematics } from './fk'
import { coupledPose, offsetPose, solveTowardTarget } from './fkSolve'

describe('coupledPose', () => {
  test('theta=0 is the Flat Case (phi1=phi2=0)', () => {
    const { phi1, phi2, pose } = coupledPose('convex', 0)
    expect(phi1).toBe(0)
    expect(phi2).toBe(0)
    expect(pose).toEqual(forwardKinematics('convex', 0, 0))
  })

  test('phi1 alone absorbs theta until phi1Max, then phi2 takes the rest', () => {
    const bones = CONCAVE_BONES
    const halfway = bones.phi1Max / 2
    const before = coupledPose('concave', halfway)
    expect(before.phi1).toBeCloseTo(halfway, 9)
    expect(before.phi2).toBe(0)

    const past = coupledPose('concave', bones.phi1Max + 0.1)
    expect(past.phi1).toBeCloseTo(bones.phi1Max, 9)
    expect(past.phi2).toBeCloseTo(0.1, 9)
  })

  test('matches forwardKinematics directly for a given (phi1, phi2) split', () => {
    const bones = CONVEX_BONES
    const theta = bones.phi1Max + 0.05
    const { pose } = coupledPose('convex', theta)
    const expected = forwardKinematics('convex', bones.phi1Max, 0.05)
    expect(pose.x).toBeCloseTo(expected.x, 9)
    expect(pose.z).toBeCloseTo(expected.z, 9)
    expect(pose.angle).toBeCloseTo(expected.angle, 9)
  })
})

describe('solveTowardTarget', () => {
  test('recovers theta exactly when the target is already on the curve', () => {
    // theta must be past phi1Max: while phi2=0 (theta <= phi1Max), key 2's ORIGIN is the fixed
    // pivot itself, so (x,z) stays constant for the whole segment (only angle changes) -- see
    // the dedicated test below. Position alone can only recover theta once phi2 has engaged.
    const theta = CONVEX_BONES.phi1Max + 0.2
    const target = coupledPose('convex', theta).pose
    const solved = solveTowardTarget(target)
    expect(solved.direction).toBe('convex')
    expect(solved.theta).toBeCloseTo(theta, 3)
    expect(solved.distance).toBeCloseTo(0, 3)
  })

  test('while phi2=0, (x,z) is degenerate: key 2 pivots in place about its own fixed origin', () => {
    // A direct consequence of the geometry, not a bug: with phi2=0, position is fixed at any
    // theta in [0, phi1Max] -- only orientation changes. solveTowardTarget therefore cannot use
    // position alone to recover theta in this regime; it's expected to fall back to theta=0.
    const atZero = coupledPose('convex', 0).pose
    const atHalf = coupledPose('convex', CONVEX_BONES.phi1Max / 2).pose
    const atMax = coupledPose('convex', CONVEX_BONES.phi1Max).pose
    expect(atHalf.x).toBeCloseTo(atZero.x, 9)
    expect(atHalf.z).toBeCloseTo(atZero.z, 9)
    expect(atMax.x).toBeCloseTo(atZero.x, 9)
    expect(atMax.z).toBeCloseTo(atZero.z, 9)
    expect(atHalf.angle).not.toBeCloseTo(atZero.angle, 3)
  })

  test('picks the closer of the two bend directions', () => {
    const concaveTarget = coupledPose('concave', 0.5).pose
    const solved = solveTowardTarget(concaveTarget)
    expect(solved.direction).toBe('concave')
    expect(solved.theta).toBeCloseTo(0.5, 3)
  })

  test('the solved pose never separates the keys further than the curve does at that theta', () => {
    // Regression for the exact bug fkSolve.ts's header describes: dragging off the coupled
    // curve (independent phi1/phi2) can move the keys apart. Solving back onto the curve should
    // never place key 2 farther from the Flat Case gap than any point actually on the curve.
    const target = { x: 5, z: -50 } // an arbitrary, off-curve drag target
    const solved = solveTowardTarget(target)
    const onCurve = coupledPose(solved.direction, solved.theta).pose
    expect(solved.pose.x).toBeCloseTo(onCurve.x, 9)
    expect(solved.pose.z).toBeCloseTo(onCurve.z, 9)
  })

  test('theta stays within [0, pi/2] for an out-of-range target', () => {
    const solved = solveTowardTarget({ x: -1000, z: -1000 })
    expect(solved.theta).toBeGreaterThanOrEqual(0)
    expect(solved.theta).toBeLessThanOrEqual(Math.PI / 2)
  })
})

describe('offsetPose', () => {
  test("a zero offset is exactly coupledPose's own position", () => {
    const theta = 0.4
    const pose = coupledPose('convex', theta).pose
    const offset = offsetPose('convex', theta, { x: 0, z: 0 })
    expect(offset.x).toBeCloseTo(pose.x, 9)
    expect(offset.z).toBeCloseTo(pose.z, 9)
  })

  test('at theta=0 (no rotation), the offset is added directly, unrotated', () => {
    const pose = coupledPose('convex', 0).pose // angle=0 at the Flat Case
    const offset = offsetPose('convex', 0, { x: 5, z: 3 })
    expect(offset.x).toBeCloseTo(pose.x + 5, 9)
    expect(offset.z).toBeCloseTo(pose.z + 3, 9)
  })

  test('a nonzero offset breaks the phi2=0 position degeneracy fkSolve.test.ts documents above', () => {
    // Unlike the raw pivot (which stays fixed for the whole phi2=0 segment, see the dedicated
    // test above), an OFFSET point traces a genuine arc as theta varies in that same regime,
    // since only the orientation (not the position) changes there -- and rotating a nonzero
    // offset by a changing angle does move it.
    const atZero = offsetPose('convex', 0, { x: 5, z: 0 })
    const atHalf = offsetPose('convex', CONVEX_BONES.phi1Max / 2, { x: 5, z: 0 })
    expect(atHalf.x).not.toBeCloseTo(atZero.x, 3)
  })
})

describe('solveTowardTarget with an offset', () => {
  const offset = { x: 9.1, z: 16 } // roughly a keycap top-center-style offset

  test('recovers theta exactly when the OFFSET point is already on its own curve', () => {
    const theta = 0.35
    const target = offsetPose('convex', theta, offset)
    const solved = solveTowardTarget(target, offset)
    expect(solved.direction).toBe('convex')
    expect(solved.theta).toBeCloseTo(theta, 3)
  })

  test('recovers theta inside the phi2=0 (pivot-degenerate) regime, unlike the zero-offset case', () => {
    const theta = CONVEX_BONES.phi1Max / 2
    const target = offsetPose('convex', theta, offset)
    const solved = solveTowardTarget(target, offset)
    expect(solved.theta).toBeCloseTo(theta, 2)
  })

  test('a zero offset reproduces the pivot-only solve exactly', () => {
    const theta = CONVEX_BONES.phi1Max + 0.2
    const target = coupledPose('convex', theta).pose
    const withZeroOffset = solveTowardTarget(target, { x: 0, z: 0 })
    const withoutOffsetArg = solveTowardTarget(target)
    expect(withZeroOffset.theta).toBeCloseTo(withoutOffsetArg.theta, 9)
  })
})
