import type { Hand, Joint } from '$lib/hand'
import { describe, expect, test } from 'bun:test'
import { Matrix4, Vector3 } from 'three'
import { fitConjunctCoupling, fitThumbCmcAxis, OcclusionGuardedGrowthPlateau, OcclusionGuardedPlateau, thumbMcpIpAngles } from './thumbCmc'

const IDENTITY_JOINT: Joint = { length: 1, degree: 1, V: new Matrix4(), Vinv: new Matrix4() }

/** A synthetic Hand whose thumb metacarpal (limb 1 -- the CMC-landmark-to-MCP-landmark segment, the
 * segment that actually rotates with the CMC; see fitThumbCmcAxis's doc comment for why limb 0 isn't
 * used) encodes known [flexion, abduction] angles via the same asin-based convention
 * `flexionAbduction()` uses against an identity joint frame, and whose limb 2 direction encodes a
 * known twist relative to `referenceBone2` -- so fitConjunctCoupling's regression can be checked
 * against ground truth. Limb 0 is populated with an arbitrary fixed vector since nothing reads it. */
function syntheticThumbHand(flexionRad: number, abductionRad: number, twistRad: number, referenceBone2: Vector3): Hand {
  const metacarpal = new Vector3(
    Math.cos(flexionRad) * Math.cos(abductionRad),
    Math.sin(flexionRad),
    -Math.cos(flexionRad) * Math.sin(abductionRad),
  )
  const axis = metacarpal.clone().normalize()
  const bone2 = referenceBone2.clone().applyAxisAngle(axis, twistRad)

  return {
    handedness: 'Right',
    score: 1,
    hand: undefined as any,
    vectors: [],
    limbs: { thumb: [new Vector3(1, 0, 0), metacarpal, bone2, new Vector3()] },
    basis: new Matrix4(),
  }
}

describe('fitThumbCmcAxis', () => {
  test('returns a fitted axis with an axisConfidence field, reusing fitNorms', () => {
    const history: Hand[] = []
    for (let i = 0; i < 30; i++) {
      const t = (i / 29) * 0.6 - 0.3
      history.push(syntheticThumbHand(t, 0, 0, new Vector3(0, 0, 1)))
    }
    const joint = fitThumbCmcAxis(history, 1, new Matrix4())
    expect(joint.degree).toBe(1)
    expect('axisConfidence' in joint && joint.axisConfidence).toBeGreaterThan(0)
  })
})

describe('fitConjunctCoupling', () => {
  test('recovers exact aCoeff/bCoeff from synthetic data with r2 = 1', () => {
    const aCoeff = 0.4
    const bCoeff = -0.25
    const referenceBone2 = new Vector3(0, 0, 1)
    const cmcJoint: Joint = { length: 1, degree: 1, V: new Matrix4(), Vinv: new Matrix4() }

    const history: Hand[] = []
    for (let f = -0.3; f <= 0.3; f += 0.05) {
      for (let a = -0.2; a <= 0.2; a += 0.1) {
        const twist = aCoeff * f + bCoeff * a
        history.push(syntheticThumbHand(f, a, twist, referenceBone2))
      }
    }

    const fit = fitConjunctCoupling(history, cmcJoint, referenceBone2)
    expect(fit.aCoeff).toBeCloseTo(aCoeff, 2)
    expect(fit.bCoeff).toBeCloseTo(bCoeff, 2)
    expect(fit.r2).toBeGreaterThan(0.99)
  })

  test('throws with fewer than 3 frames', () => {
    const referenceBone2 = new Vector3(0, 0, 1)
    const cmcJoint: Joint = { length: 1, degree: 1, V: new Matrix4(), Vinv: new Matrix4() }
    const history = [syntheticThumbHand(0, 0, 0, referenceBone2), syntheticThumbHand(0.1, 0, 0.04, referenceBone2)]
    expect(() => fitConjunctCoupling(history, cmcJoint, referenceBone2)).toThrow()
  })
})

describe('thumbMcpIpAngles', () => {
  test('reads the same boneIndex-1/2 signed-angle convention as every other finger', () => {
    // Reuses signedJointAngle under the hood -- a light smoke test that it's wired to the right
    // boneIndex values (1 for MCP-equivalent, 2 for IP-equivalent) rather than a full re-verification
    // of signedJointAngle itself (already covered in $lib/hand.test.ts).
    const hand: Hand = {
      handedness: 'Right',
      score: 1,
      hand: undefined as any,
      vectors: new Array(21).fill(0).map(() => new Vector3()),
      limbs: {
        thumb: [new Vector3(1, 0, 0), new Vector3(1, 0, 0), new Vector3(1, 0, 0), new Vector3(1, 0, 0)],
      },
      basis: new Matrix4(),
    }
    const [mcp, ip] = thumbMcpIpAngles(hand)
    expect(mcp).toBeCloseTo(0, 5) // all bones parallel -- no bend anywhere
    expect(ip).toBeCloseTo(0, 5)
  })
})

describe('OcclusionGuardedPlateau', () => {
  const baseOptions = {
    jointCount: 1,
    convergenceThreshold: 2,
    peakHysteresis: 10,
    requiredStableReps: 2,
    confidenceThreshold: 0.7,
    minHealthyYield: 0.8,
  }

  test('a genuine plateau held at high confidence throughout converges', () => {
    const guard = new OcclusionGuardedPlateau(baseOptions)
    // 4 clean flex/extend cycles, amplitude growing then flat (matches PlateauDetector's own
    // synthetic verification pattern), all high confidence.
    const amplitudes = [30, 30, 45, 45, 50, 50, 50, 50]
    for (const amp of amplitudes) {
      for (const angle of [0, amp]) guard.push([angle], 0.95)
    }
    expect(guard.status()).toBe('converged')
  })

  test('angles plateauing while confidence collapses in the final reps reads as possibly-occluded, not converged', () => {
    const guard = new OcclusionGuardedPlateau(baseOptions)
    const amplitudes = [30, 30, 45, 45, 50, 50, 50, 50]
    for (let repIdx = 0; repIdx < amplitudes.length; repIdx++) {
      // Confidence collapses for the final two reps -- exactly the "thumb went out of view right as
      // it reached its apparent extreme" scenario Test 10 is meant to catch.
      const confidence = repIdx >= amplitudes.length - 2 ? 0.3 : 0.95
      for (const angle of [0, amplitudes[repIdx]]) guard.push([angle], confidence)
    }
    expect(guard.status()).toBe('possibly-occluded')
  })

  test('not yet plateaued reads as in-progress regardless of confidence', () => {
    const guard = new OcclusionGuardedPlateau(baseOptions)
    const amplitudes = [10, 20, 30, 40, 50, 60] // still growing -- never plateaus
    for (const amp of amplitudes) {
      for (const angle of [0, amp]) guard.push([angle], 0.95)
    }
    expect(guard.status()).toBe('in-progress')
  })
})

describe('OcclusionGuardedGrowthPlateau', () => {
  const baseOptions = {
    windowSeconds: 2,
    convergenceThreshold: 2,
    confidenceThreshold: 0.7,
    minHealthyYield: 0.8,
  }

  test('a max that keeps growing reads in-progress', () => {
    const guard = new OcclusionGuardedGrowthPlateau(baseOptions)
    for (let t = 0; t <= 10; t += 0.1) {
      guard.push(t, t * 3, 0.95) // magnitude keeps climbing throughout
    }
    expect(guard.status()).toBe('in-progress')
  })

  test('a max that stops growing, with healthy confidence throughout, converges', () => {
    const guard = new OcclusionGuardedGrowthPlateau(baseOptions)
    for (let t = 0; t <= 5; t += 0.1) {
      guard.push(t, Math.min(t, 3) * 10, 0.95) // grows to 30, flat after t=3
    }
    expect(guard.status()).toBe('converged')
    expect(guard.max).toBeCloseTo(30, 0)
  })

  test('a max that stops growing while confidence collapses reads possibly-occluded, not converged', () => {
    const guard = new OcclusionGuardedGrowthPlateau(baseOptions)
    for (let t = 0; t <= 5; t += 0.1) {
      // Same magnitude trajectory as the converged case, but confidence craters right as it flattens --
      // the "thumb went out of view right as it reached its apparent extreme" scenario.
      const confidence = t > 3 ? 0.2 : 0.95
      guard.push(t, Math.min(t, 3) * 10, confidence)
    }
    expect(guard.status()).toBe('possibly-occluded')
  })

  test('not enough elapsed time yet reads in-progress even with a flat signal', () => {
    const guard = new OcclusionGuardedGrowthPlateau(baseOptions)
    for (let t = 0; t <= 1; t += 0.1) {
      guard.push(t, 30, 0.95) // flat from the start, but under windowSeconds=2 of history so far
    }
    expect(guard.status()).toBe('in-progress')
  })

  test('minPlausibleMax blocks convergence at an implausibly small plateau, even with otherwise-flat growth', () => {
    const guard = new OcclusionGuardedGrowthPlateau({ ...baseOptions, minPlausibleMax: 20 })
    for (let t = 0; t <= 5; t += 0.1) {
      guard.push(t, Math.min(t, 3) * 3, 0.95) // plateaus at 9 -- flat, but well under the 20 floor
    }
    expect(guard.status()).toBe('in-progress')
    expect(guard.max).toBeCloseTo(9, 0)
  })

  test('minPlausibleMax allows convergence once the max actually clears it', () => {
    const guard = new OcclusionGuardedGrowthPlateau({ ...baseOptions, minPlausibleMax: 20 })
    for (let t = 0; t <= 5; t += 0.1) {
      guard.push(t, Math.min(t, 3) * 10, 0.95) // plateaus at 30, clears the 20 floor
    }
    expect(guard.status()).toBe('converged')
  })

  test('omitting minPlausibleMax preserves the original behavior (no floor)', () => {
    const guard = new OcclusionGuardedGrowthPlateau(baseOptions)
    for (let t = 0; t <= 5; t += 0.1) {
      guard.push(t, Math.min(t, 3) * 1, 0.95) // plateaus at 3 -- tiny, but no floor configured
    }
    expect(guard.status()).toBe('converged')
  })

  test('does not require a signed or single-axis signal -- an unsigned magnitude that wanders and settles still converges', () => {
    const guard = new OcclusionGuardedGrowthPlateau(baseOptions)
    // Simulates exploring two independent axes at once (the actual thumb CMC outer-sweep case): the
    // unsigned magnitude rises and dips as the sweep changes direction, but never regresses past its
    // own running max, and eventually settles.
    const trajectory = [0, 10, 25, 15, 28, 20, 29, 29, 29, 29, 29, 29, 29, 29, 29, 29, 29]
    let t = 0
    for (const magnitude of trajectory) {
      guard.push(t, magnitude, 0.95)
      t += 0.3
    }
    expect(guard.status()).toBe('converged')
  })
})
