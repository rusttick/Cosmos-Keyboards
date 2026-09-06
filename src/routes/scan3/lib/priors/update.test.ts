import { describe, expect, test } from 'bun:test'
import type { ScalarPrior, VectorPrior } from './handModel'
import { narrowViaTenodesis, updateScalar, updateVector } from './update'

function scalar(mean: number, variance: number): ScalarPrior {
  return { mean, variance, source: 'test' }
}

describe('updateScalar', () => {
  test('moves the mean toward the observation and shrinks the variance', () => {
    const prior = scalar(0, 100)
    const posterior = updateScalar(prior, { value: 50, variance: 25, source: 'caliper' })

    expect(posterior.mean).toBeGreaterThan(prior.mean)
    expect(posterior.mean).toBeLessThan(50)
    expect(posterior.variance).toBeLessThan(prior.variance)
    expect(posterior.evidenceCount).toBe(1)
  })

  test('an excluded observation never enters the update at all', () => {
    const prior = scalar(0, 100)
    const posterior = updateScalar(prior, { value: 999, variance: 0.001, source: 'manual-entry', excluded: true })
    expect(posterior).toEqual(prior)
  })

  test('a low-noise (caliper) observation dominates a high-noise (mediapipe) one of the same raw value', () => {
    const prior = scalar(0, 100)
    const viaCaliper = updateScalar(prior, { value: 10, variance: 1, source: 'caliper' })
    const viaMediapipe = updateScalar(prior, { value: 10, variance: 100, source: 'mediapipe' })
    expect(Math.abs(viaCaliper.mean)).toBeGreaterThan(Math.abs(viaMediapipe.mean))
  })

  test('a self-reported manual entry (wide declared noise) moves the posterior less than a goniometer reading of the same value', () => {
    const prior = scalar(0, 100)
    const viaGoniometer = updateScalar(prior, { value: 10, variance: 4, source: 'goniometer' })
    const viaSelfReport = updateScalar(prior, { value: 10, variance: 400, source: 'manual-entry' })
    expect(Math.abs(viaGoniometer.mean)).toBeGreaterThan(Math.abs(viaSelfReport.mean))
  })

  test('evidenceCount accumulates across repeated updates', () => {
    let prior = scalar(0, 100)
    prior = updateScalar(prior, { value: 1, variance: 10, source: 'mediapipe' })
    prior = updateScalar(prior, { value: 2, variance: 10, source: 'mediapipe' })
    expect(prior.evidenceCount).toBe(2)
  })
})

describe('updateVector', () => {
  function correlatedPair(): VectorPrior {
    // Two entries with a strong positive correlation (covariance close to the geometric mean of the
    // variances) -- observing one should visibly narrow the other.
    return { mean: [0, 0], covariance: [[100, 90], [90, 100]], source: 'test' }
  }

  test('observing one entry moves both the observed and the correlated entry, and shrinks both variances', () => {
    const prior = correlatedPair()
    const posterior = updateVector(prior, { h: [1, 0], value: 50, variance: 1, source: 'caliper' })

    expect(posterior.mean[0]).toBeGreaterThan(0)
    expect(posterior.mean[1]).toBeGreaterThan(0) // pulled along by the correlation, not directly observed
    expect(posterior.covariance[0][0]).toBeLessThan(prior.covariance[0][0])
    expect(posterior.covariance[1][1]).toBeLessThan(prior.covariance[1][1]) // the unobserved dimension narrows too
  })

  test('an uncorrelated entry does not move when another entry is observed', () => {
    const prior: VectorPrior = { mean: [0, 0], covariance: [[100, 0], [0, 100]], source: 'test' }
    const posterior = updateVector(prior, { h: [1, 0], value: 50, variance: 1, source: 'caliper' })
    expect(posterior.mean[1]).toBeCloseTo(0, 5)
    expect(posterior.covariance[1][1]).toBeCloseTo(prior.covariance[1][1], 5)
  })

  test('an excluded vector observation never enters the update', () => {
    const prior = correlatedPair()
    const posterior = updateVector(prior, { h: [1, 0], value: 999, variance: 0.001, source: 'manual-entry', excluded: true })
    expect(posterior).toEqual(prior)
  })

  test('evidenceCount accumulates', () => {
    const prior = correlatedPair()
    const posterior = updateVector(prior, { h: [1, 0], value: 10, variance: 5, source: 'mediapipe' })
    expect(posterior.evidenceCount).toBe(1)
  })
})

describe('narrowViaTenodesis', () => {
  test('a confident finger-flexion reading narrows the wrist prior even though the wrist itself is never directly observed', () => {
    const wristPrior = scalar(0, 400) // wide literature prior, sd = 20deg
    const confidentFingerFlexion = scalar(60, 4) // sd = 2deg -- a confident session reading
    const coupling = scalar(0.3, 0.01)

    const posterior = narrowViaTenodesis(wristPrior, confidentFingerFlexion, coupling)

    expect(posterior.variance).toBeLessThan(wristPrior.variance)
    expect(posterior.mean).toBeGreaterThan(0) // pulled toward coupling.mean * confidentFingerFlexion.mean = 18
  })

  test('an uninformative coupling coefficient still narrows the wrist a little, toward "no effect assumed" -- not a special case', () => {
    const wristPrior = scalar(10, 400)
    const confidentFingerFlexion = scalar(60, 4)
    const uninformativeCoupling = scalar(0, 1) // this project's actual current seed for this coefficient

    const posterior = narrowViaTenodesis(wristPrior, confidentFingerFlexion, uninformativeCoupling)

    expect(posterior.variance).toBeLessThan(wristPrior.variance)
    expect(posterior.mean).toBeLessThan(wristPrior.mean) // pulled toward the implied value of 0
  })

  test('a wildly uncertain finger reading barely moves the wrist prior at all', () => {
    const wristPrior = scalar(0, 400)
    const noisyFingerFlexion = scalar(60, 1e8)
    const coupling = scalar(0.3, 0.01)

    const posterior = narrowViaTenodesis(wristPrior, noisyFingerFlexion, coupling)
    expect(posterior.variance).toBeCloseTo(wristPrior.variance, 1)
  })
})
