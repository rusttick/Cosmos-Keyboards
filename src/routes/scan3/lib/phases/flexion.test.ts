import type { Hand } from '$lib/hand'
import { describe, expect, test } from 'bun:test'
import { Vector3 } from 'three'
import { fitDipPipCoupling } from './flexion'

/** Builds a fake indexFinger-only Hand whose PIP/DIP bend angles (in degrees) are exactly the
 * requested values, so fitDipPipCoupling's regression can be checked against known ground truth.
 * Only `limbs.indexFinger` is populated — that's all fitDipPipCoupling reads. */
function syntheticHand(pipDeg: number, dipDeg: number): Hand {
  const bone0 = new Vector3(1, 0, 0)
  const bone1 = new Vector3(1, 0, 0)
  const pipRad = (pipDeg * Math.PI) / 180
  const bone2 = new Vector3(Math.cos(pipRad), Math.sin(pipRad), 0)
  const totalRad = ((pipDeg + dipDeg) * Math.PI) / 180
  const bone3 = new Vector3(Math.cos(totalRad), Math.sin(totalRad), 0)
  return {
    handedness: 'Right',
    score: 1,
    hand: undefined as any,
    vectors: [],
    limbs: { indexFinger: [bone0, bone1, bone2, bone3] },
    basis: undefined as any,
  }
}

describe('fitDipPipCoupling', () => {
  test('recovers an exact linear relationship with r2 = 1', () => {
    const slope = 0.6
    const intercept = 5
    const history = []
    for (let pip = 0; pip <= 80; pip += 5) {
      history.push(syntheticHand(pip, slope * pip + intercept))
    }

    const fit = fitDipPipCoupling(history, 'indexFinger')
    expect(fit.slope).toBeCloseTo(slope, 5)
    expect(fit.intercept).toBeCloseTo(intercept, 5)
    expect(fit.r2).toBeCloseTo(1, 5)
    for (const s of fit.samples) expect(Math.abs(s.residual)).toBeLessThan(1e-6)
  })

  test('flags a curved relationship with a lower r2 and residuals that grow near the extremes', () => {
    const history = []
    for (let pip = 0; pip <= 80; pip += 5) {
      // A quadratic relationship isn't well fit by a line -- residuals should be small in the
      // middle of the range and largest at the extremes, matching what the real test is looking for.
      const dip = 0.4 * pip + 0.01 * pip ** 2
      history.push(syntheticHand(pip, dip))
    }

    const fit = fitDipPipCoupling(history, 'indexFinger')
    expect(fit.r2).toBeLessThan(0.999)

    const first = fit.samples[0]
    const last = fit.samples[fit.samples.length - 1]
    const middle = fit.samples[Math.floor(fit.samples.length / 2)]
    expect(Math.abs(last.residual)).toBeGreaterThan(Math.abs(middle.residual))
    expect(Math.abs(first.residual) + Math.abs(last.residual)).toBeGreaterThan(Math.abs(middle.residual))
  })

  test('a degenerate sweep (no PIP variation) falls back to slope 0 instead of NaN', () => {
    const history = [syntheticHand(30, 40), syntheticHand(30, 42), syntheticHand(30, 38)]
    const fit = fitDipPipCoupling(history, 'indexFinger')
    expect(fit.slope).toBe(0)
    expect(Number.isFinite(fit.intercept)).toBe(true)
  })
})
