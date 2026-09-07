import { describe, expect, test } from 'bun:test'
import { HAND_PRIOR_SEED } from '../priors/handModelData'
import { buildDefaultSkeleton } from '../priors/ikSolve'
import { predictDipDeg, sampleFingerSweep } from './sampleFingerSweep'

describe('sampleFingerSweep', () => {
  const skeleton = buildDefaultSkeleton(HAND_PRIOR_SEED, 'Right')

  test('returns stepsPerAxis^3 samples', () => {
    const samples = sampleFingerSweep(skeleton, 'indexFinger', HAND_PRIOR_SEED, 4)
    expect(samples.length).toBe(64)
  })

  test('DIP is derived from PIP, not independently varied -- two samples with the same pipFlexDeg get the same dipFlexDeg', () => {
    const samples = sampleFingerSweep(skeleton, 'indexFinger', HAND_PRIOR_SEED, 4)
    const byPip = new Map<number, Set<number>>()
    for (const s of samples) {
      if (!byPip.has(s.pipFlexDeg)) byPip.set(s.pipFlexDeg, new Set())
      byPip.get(s.pipFlexDeg)!.add(s.dipFlexDeg)
    }
    for (const dipValues of byPip.values()) expect(dipValues.size).toBe(1)
  })

  test('the derived (pre-clamp) DIP angle matches the fitted slope/intercept', () => {
    const predicted = predictDipDeg(HAND_PRIOR_SEED, 'indexFinger', 30)
    const [slope, intercept] = HAND_PRIOR_SEED.dipPipCoupling.indexFinger.mean
    expect(predicted).toBeCloseTo(slope * 30 + intercept, 6)
  })

  test('samples fill a genuine 3D volume, not a 2D shell -- position varies substantially along all three axes', () => {
    // Stage 3's MCP-only sweep (2 free angles) traces a surface; this stage's 3 free angles (MCP
    // flex/ab-ad, PIP flex) should span all three world axes by a real amount, not collapse to two.
    const samples = sampleFingerSweep(skeleton, 'indexFinger', HAND_PRIOR_SEED, 5)
    const positions = samples.map((s) => s.position)
    for (let axis = 0; axis < 3; axis++) {
      const values = positions.map((p) => p[axis])
      const spread = Math.max(...values) - Math.min(...values)
      expect(spread).toBeGreaterThan(10)
    }
  })

  test('DIP stays within its own fitted ROM bounds even when the linear coupling would overshoot', () => {
    const samples = sampleFingerSweep(skeleton, 'indexFinger', HAND_PRIOR_SEED, 6)
    const { minDeg, maxDeg } = HAND_PRIOR_SEED.pipDipRom.dip.indexFinger
    for (const s of samples) {
      expect(s.dipFlexDeg).toBeGreaterThanOrEqual(minDeg)
      expect(s.dipFlexDeg).toBeLessThanOrEqual(maxDeg)
    }
  })

  test('postureCost is 0 at the joint means and positive everywhere else', () => {
    const mcp = HAND_PRIOR_SEED.mcpAxes.indexFinger
    const pip = HAND_PRIOR_SEED.pipDipRom.pip.indexFinger
    const samples = sampleFingerSweep(skeleton, 'indexFinger', HAND_PRIOR_SEED, 9)
    const nearMean = samples.reduce((best, s) => {
      const dist = Math.abs(s.mcpFlexDeg - mcp.flexExtRom.meanDeg)
        + Math.abs(s.mcpAbAdDeg - mcp.abAdRom.meanDeg)
        + Math.abs(s.pipFlexDeg - pip.meanDeg)
      const bestDist = Math.abs(best.mcpFlexDeg - mcp.flexExtRom.meanDeg)
        + Math.abs(best.mcpAbAdDeg - mcp.abAdRom.meanDeg)
        + Math.abs(best.pipFlexDeg - pip.meanDeg)
      return dist < bestDist ? s : best
    })
    for (const s of samples) expect(s.postureCost).toBeGreaterThanOrEqual(0)
    // The closest-to-mean sample should be among the cheapest, not the priciest.
    const sorted = [...samples].sort((a, b) => a.postureCost - b.postureCost)
    expect(sorted.indexOf(nearMean)).toBeLessThan(samples.length / 2)
  })

  test('manipulability is non-negative and not identically zero across a real 3-DOF sweep', () => {
    const samples = sampleFingerSweep(skeleton, 'indexFinger', HAND_PRIOR_SEED, 5)
    for (const s of samples) expect(s.manipulability).toBeGreaterThanOrEqual(0)
    expect(samples.some((s) => s.manipulability > 0)).toBe(true)
  })

  test('positionalVariance is non-negative and scales with the fitted ROM uncertainty (sdDeg)', () => {
    const samples = sampleFingerSweep(skeleton, 'indexFinger', HAND_PRIOR_SEED, 4)
    for (const s of samples) expect(s.positionalVariance).toBeGreaterThanOrEqual(0)

    const widerPrior = structuredClone(HAND_PRIOR_SEED)
    widerPrior.mcpAxes.indexFinger.flexExtRom.sdDeg *= 5
    widerPrior.mcpAxes.indexFinger.abAdRom.sdDeg *= 5
    widerPrior.pipDipRom.pip.indexFinger.sdDeg *= 5
    const widerSamples = sampleFingerSweep(skeleton, 'indexFinger', widerPrior, 4)

    const totalNarrow = samples.reduce((sum, s) => sum + s.positionalVariance, 0)
    const totalWider = widerSamples.reduce((sum, s) => sum + s.positionalVariance, 0)
    expect(totalWider).toBeGreaterThan(totalNarrow)
  })

  test("index/middle's baseFlexDeg is always 0 -- their metacarpal is genuinely fixed", () => {
    const samples = sampleFingerSweep(skeleton, 'indexFinger', HAND_PRIOR_SEED, 3)
    for (const s of samples) expect(s.baseFlexDeg).toBe(0)
  })

  test("ring/pinky sweep their own base-of-hand flexion (joint 0) -- a real 4th DOF index/middle don't have", () => {
    // Regression test for a real bug: this DOF used to be held at 0 for every finger, even though
    // ring/pinky have a real degree:1 hinge there (`cmcMobility.ring/pinky.flexionRom`) -- the neutral
    // pose (which does pose this joint) landed outside a cloud that never explored it.
    const ringSamples = sampleFingerSweep(skeleton, 'ringFinger', HAND_PRIOR_SEED, 4)
    const distinctBaseFlex = new Set(ringSamples.map((s) => s.baseFlexDeg))
    expect(distinctBaseFlex.size).toBeGreaterThan(1)

    const rom = HAND_PRIOR_SEED.cmcMobility.ring.flexionRom
    for (const s of ringSamples) {
      expect(s.baseFlexDeg).toBeGreaterThanOrEqual(rom.minDeg)
      expect(s.baseFlexDeg).toBeLessThanOrEqual(rom.maxDeg)
    }

    // Varying only baseFlexDeg (same MCP/PIP) should move the fingertip -- it's a real DOF, not inert.
    const bucketed = new Map<string, typeof ringSamples>()
    for (const s of ringSamples) {
      const key = `${s.mcpFlexDeg}|${s.mcpAbAdDeg}|${s.pipFlexDeg}`
      if (!bucketed.has(key)) bucketed.set(key, [])
      bucketed.get(key)!.push(s)
    }
    const [oneBucket] = bucketed.values()
    const positions = oneBucket.map((s) => s.position)
    const allEqual = positions.every(
      (p) => p[0] === positions[0][0] && p[1] === positions[0][1] && p[2] === positions[0][2],
    )
    expect(allEqual).toBe(false)
  })

  test('pinky also sweeps its own base flexion, independently from ring', () => {
    const pinkySamples = sampleFingerSweep(skeleton, 'pinky', HAND_PRIOR_SEED, 4)
    const distinctBaseFlex = new Set(pinkySamples.map((s) => s.baseFlexDeg))
    expect(distinctBaseFlex.size).toBeGreaterThan(1)
  })
})
