import { describe, expect, test } from 'bun:test'
import { HAND_PRIOR_SEED } from '../priors/handModelData'
import { buildDefaultSkeleton } from '../priors/ikSolve'
import { sampleThumbCmcSweep } from './sampleThumbCmcSweep'

describe('sampleThumbCmcSweep', () => {
  const skeleton = buildDefaultSkeleton(HAND_PRIOR_SEED, 'Right')

  test('returns stepsPerAxis^2 samples', () => {
    const samples = sampleThumbCmcSweep(skeleton, HAND_PRIOR_SEED, 5)
    expect(samples.length).toBe(25)
  })

  test('sweeping CMC flexion/abduction actually moves the thumb tip', () => {
    const samples = sampleThumbCmcSweep(skeleton, HAND_PRIOR_SEED, 5)
    const positions = samples.map((s) => s.position)
    const allEqual = positions.every(
      (p) => p[0] === positions[0][0] && p[1] === positions[0][1] && p[2] === positions[0][2],
    )
    expect(allEqual).toBe(false)
  })

  test('thumb-tip distance from the wrist is a plausible real hand size, not off by 100x', () => {
    // Same regression class as `sampleMcpSweep.test.ts` -- `buildDefaultSkeleton`'s already-absolute-mm
    // joint lengths need `worldPositions(finger, 1)`, not the ratio-convention default `scale=100`.
    const samples = sampleThumbCmcSweep(skeleton, HAND_PRIOR_SEED, 3)
    for (const { position } of samples) {
      const distFromWrist = Math.hypot(...position)
      expect(distFromWrist).toBeGreaterThan(20)
      expect(distFromWrist).toBeLessThan(300)
    }
  })

  test('postureCost is non-negative and manipulability is near-0 for every sample (a 2-DOF sweep)', () => {
    // Per `manipulability.ts`'s own doc comment: a rank-deficient Jacobian (fewer than 3 free angles)
    // genuinely cannot move in all 3 task-space directions, so this should be ~0, not a bug. Not
    // asserted bit-exact: a *numerically*-differentiated (finite-difference) near-singular 3x3
    // determinant carries some floating-point noise, unlike `manipulability.test.ts`'s exact-analytic-
    // Jacobian case -- the real claim is "much smaller than a genuine 3-DOF value", not exactly 0.
    const samples = sampleThumbCmcSweep(skeleton, HAND_PRIOR_SEED, 5)
    for (const s of samples) {
      expect(s.postureCost).toBeGreaterThanOrEqual(0)
      expect(Math.abs(s.manipulability)).toBeLessThan(0.5)
      expect(s.positionalVariance).toBeGreaterThanOrEqual(0)
    }
  })
})
