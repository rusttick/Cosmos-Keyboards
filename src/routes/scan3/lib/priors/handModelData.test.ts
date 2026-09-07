/**
 * Sanity checks on the seed data: every length prior is positive, every range-of-motion prior's mean
 * and bounds are internally consistent, and every covariance matrix is symmetric and positive
 * semi-definite (a mathematically valid uncertainty description, not e.g. a negative variance).
 */

import { FINGERS } from '$lib/hand'
import { describe, expect, test } from 'bun:test'
import type { BetaRom, ScalarPrior, VectorPrior } from './handModel'
import { HAND_PRIOR_SEED } from './handModelData'

/** Cholesky decomposition with a pivot tolerance -- succeeds (no negative-under-sqrt) iff `m` is
 * positive semi-definite. Simple and correct for the small matrices this module produces; not
 * intended as production numerics. */
function isPositiveSemiDefinite(m: number[][], eps = 1e-9): boolean {
  const n = m.length
  const L: number[][] = Array.from({ length: n }, () => new Array(n).fill(0))
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = m[i][j]
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k]
      if (i === j) {
        if (sum < -eps) return false
        L[i][j] = Math.sqrt(Math.max(sum, 0))
      } else {
        L[i][j] = L[j][j] > eps ? sum / L[j][j] : 0
      }
    }
  }
  return true
}

function isSymmetric(m: number[][]): boolean {
  return m.every((row, i) => row.every((v, j) => v === m[j][i]))
}

describe('HAND_PRIOR_SEED: Group A bone lengths', () => {
  test('hand length is positive', () => {
    expect(HAND_PRIOR_SEED.boneLengths.handLength.mean).toBeGreaterThan(0)
    expect(HAND_PRIOR_SEED.boneLengths.handLength.variance).toBeGreaterThan(0)
  })

  for (const finger of FINGERS) {
    const prior = HAND_PRIOR_SEED.boneLengths.fingers[finger]

    test(`${finger}: every segment ratio is positive`, () => {
      for (const ratio of prior.mean) expect(ratio).toBeGreaterThan(0)
    })

    test(`${finger}: segments/mean/covariance are consistently sized`, () => {
      expect(prior.segments.length).toBe(prior.mean.length)
      expect(prior.covariance.length).toBe(prior.mean.length)
      for (const row of prior.covariance) expect(row.length).toBe(prior.mean.length)
    })

    test(`${finger}: covariance is symmetric and positive semi-definite`, () => {
      expect(isSymmetric(prior.covariance)).toBe(true)
      expect(isPositiveSemiDefinite(prior.covariance)).toBe(true)
    })

    test(`${finger}: has no 'middle' segment iff thumb`, () => {
      expect(prior.segments.includes('middle')).toBe(finger !== 'thumb')
    })
  }

  test("thumb is the only finger with a 'wristToCmc' segment", () => {
    for (const finger of FINGERS) {
      expect(HAND_PRIOR_SEED.boneLengths.fingers[finger].segments.includes('wristToCmc')).toBe(finger === 'thumb')
    }
  })

  test('knuckleRow: 3 positive adjacent-MCP gaps, symmetric PSD covariance', () => {
    const row = HAND_PRIOR_SEED.boneLengths.knuckleRow
    expect(row.mean.length).toBe(3)
    for (const ratio of row.mean) expect(ratio).toBeGreaterThan(0)
    expect(isSymmetric(row.covariance)).toBe(true)
    expect(isPositiveSemiDefinite(row.covariance)).toBe(true)
  })
})

function expectRomWithinItsOwnBounds(rom: BetaRom) {
  expect(rom.minDeg).toBeLessThanOrEqual(rom.maxDeg)
  expect(rom.meanDeg).toBeGreaterThanOrEqual(rom.minDeg)
  expect(rom.meanDeg).toBeLessThanOrEqual(rom.maxDeg)
  expect(rom.sdDeg).toBeGreaterThan(0)
}

describe('HAND_PRIOR_SEED: ROM priors stay within their own seeded bounds', () => {
  test('Group B: PIP/DIP', () => {
    for (const rom of Object.values(HAND_PRIOR_SEED.pipDipRom.pip)) expectRomWithinItsOwnBounds(rom)
    for (const rom of Object.values(HAND_PRIOR_SEED.pipDipRom.dip)) expectRomWithinItsOwnBounds(rom)
  })

  test('Group C: MCP flex/ext and ab/ad', () => {
    for (const mcp of Object.values(HAND_PRIOR_SEED.mcpAxes)) {
      expectRomWithinItsOwnBounds(mcp.flexExtRom)
      expectRomWithinItsOwnBounds(mcp.abAdRom)
    }
  })

  test('Group D: thumb and ring/pinky CMC', () => {
    expectRomWithinItsOwnBounds(HAND_PRIOR_SEED.cmcMobility.thumb.flexExtRom)
    expectRomWithinItsOwnBounds(HAND_PRIOR_SEED.cmcMobility.thumb.abAdRom)
    expectRomWithinItsOwnBounds(HAND_PRIOR_SEED.cmcMobility.ring.flexionRom)
    expectRomWithinItsOwnBounds(HAND_PRIOR_SEED.cmcMobility.pinky.flexionRom)
  })

  test('Group G: wrist/forearm/elbow', () => {
    expectRomWithinItsOwnBounds(HAND_PRIOR_SEED.wristForearm.wristFlexExtRom)
    expectRomWithinItsOwnBounds(HAND_PRIOR_SEED.wristForearm.wristRadialUlnarRom)
    expectRomWithinItsOwnBounds(HAND_PRIOR_SEED.wristForearm.forearmPronationSupinationRom)
    expectRomWithinItsOwnBounds(HAND_PRIOR_SEED.wristForearm.elbowFlexionRom)
  })
})

function expectValidScalarPrior(p: ScalarPrior) {
  expect(Number.isFinite(p.mean)).toBe(true)
  expect(p.variance).toBeGreaterThan(0)
  expect(p.source.length).toBeGreaterThan(0)
}

function expectValidVectorPrior(p: VectorPrior) {
  expect(p.mean.length).toBeGreaterThan(0)
  expect(p.covariance.length).toBe(p.mean.length)
  expect(isSymmetric(p.covariance)).toBe(true)
  expect(isPositiveSemiDefinite(p.covariance)).toBe(true)
}

describe('HAND_PRIOR_SEED: every other scalar/vector prior is well-formed', () => {
  test('Group C coupling terms', () => {
    for (const mcp of Object.values(HAND_PRIOR_SEED.mcpAxes)) {
      expectValidScalarPrior(mcp.abAdChokeCoeff)
      expectValidScalarPrior(mcp.axialRotationWeight)
    }
  })

  test('Group D thumb conjunct coupling', () => {
    expectValidVectorPrior(HAND_PRIOR_SEED.cmcMobility.thumb.conjunctCoupling)
  })

  test('Group E DIP/PIP coupling', () => {
    for (const coupling of Object.values(HAND_PRIOR_SEED.dipPipCoupling)) expectValidVectorPrior(coupling)
  })

  test('Group F enslaving matrix', () => {
    expectValidVectorPrior(HAND_PRIOR_SEED.enslaving.coefficients)
    expect(HAND_PRIOR_SEED.enslaving.coefficients.mean.length).toBe(HAND_PRIOR_SEED.enslaving.fingerOrder.length ** 2)
  })

  test('Group G scalar priors', () => {
    expectValidScalarPrior(HAND_PRIOR_SEED.wristForearm.elbowSwivelAngle)
    expectValidScalarPrior(HAND_PRIOR_SEED.wristForearm.forearmLengthRatio)
    expect(HAND_PRIOR_SEED.wristForearm.forearmLengthRatio.mean).toBeGreaterThan(0)
    expectValidScalarPrior(HAND_PRIOR_SEED.wristForearm.tenodesisCoupling)
    expectValidScalarPrior(HAND_PRIOR_SEED.wristForearm.forearmLengthStatureCoupling)
    expectValidScalarPrior(HAND_PRIOR_SEED.wristForearm.swivelWristForearmCoupling)
  })
})
