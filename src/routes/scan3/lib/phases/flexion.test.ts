import type { Hand } from '$lib/hand'
import { describe, expect, test } from 'bun:test'
import { Matrix4, Vector3 } from 'three'
import { fitDipPipCoupling } from './flexion'

/** Builds a fake indexFinger-only Hand whose signed PIP/DIP bend angles (in degrees) are exactly the
 * requested values (negative values represent hyperextension), so fitDipPipCoupling's regression can
 * be checked against known ground truth. `signedJointAngle` reads its sign off rotation direction
 * around the knuckle axis (pinky MCP -> index MCP), so index/pinky MCP are placed to put that axis
 * along +Z with an identity basis -- then bone1->bone2->bone3 are just consecutive rotations about +Z
 * by pipDeg then dipDeg, matching the sign convention exactly. */
function syntheticHand(pipDeg: number, dipDeg: number): Hand {
  const vectors = new Array(21).fill(0).map(() => new Vector3())
  vectors[5] = new Vector3(0, 0, 0) // index MCP
  vectors[17] = new Vector3(0, 0, 1) // pinky MCP -- knuckle axis (pinky - index) = +Z

  const bone0 = new Vector3(1, 0, 0)
  const bone1 = new Vector3(1, 0, 0)
  const pipRad = (pipDeg * Math.PI) / 180
  const bone2 = new Vector3(Math.cos(pipRad), Math.sin(pipRad), 0) // bone1 rotated about +Z by pipRad
  const totalRad = ((pipDeg + dipDeg) * Math.PI) / 180
  const bone3 = new Vector3(Math.cos(totalRad), Math.sin(totalRad), 0) // further rotated by dipRad

  return {
    handedness: 'Left',
    score: 1,
    hand: undefined as any,
    vectors,
    limbs: { indexFinger: [bone0, bone1, bone2, bone3] },
    basis: new Matrix4(), // identity
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

  test('a sweep spanning hyperextension (negative pip) still fits correctly', () => {
    const slope = 0.5
    const intercept = 2
    const history = []
    for (let pip = -30; pip <= 50; pip += 5) {
      history.push(syntheticHand(pip, slope * pip + intercept))
    }

    const fit = fitDipPipCoupling(history, 'indexFinger')
    expect(fit.slope).toBeCloseTo(slope, 5)
    expect(fit.intercept).toBeCloseTo(intercept, 5)
    expect(fit.r2).toBeCloseTo(1, 5)
    // Confirm the hyperextended samples actually came back negative rather than being folded into
    // a positive magnitude -- this is the whole point of the switch away from Vector3.angleTo().
    expect(fit.samples.some((s) => s.pip < 0)).toBe(true)
  })

  test('a degenerate sweep (no PIP variation) falls back to slope 0 instead of NaN', () => {
    const history = [syntheticHand(30, 40), syntheticHand(30, 42), syntheticHand(30, 38)]
    const fit = fitDipPipCoupling(history, 'indexFinger')
    expect(fit.slope).toBe(0)
    expect(Number.isFinite(fit.intercept)).toBe(true)
  })
})
