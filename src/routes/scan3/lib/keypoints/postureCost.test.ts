import { describe, expect, test } from 'bun:test'
import { gaussianPostureCost, totalPostureCost } from './postureCost'

describe('gaussianPostureCost', () => {
  test('is exactly 0 at the mean', () => {
    expect(gaussianPostureCost(35, { meanDeg: 35, sdDeg: 8 })).toBe(0)
  })

  test('is exactly 1 at one standard deviation away', () => {
    expect(gaussianPostureCost(43, { meanDeg: 35, sdDeg: 8 })).toBeCloseTo(1, 6)
    expect(gaussianPostureCost(27, { meanDeg: 35, sdDeg: 8 })).toBeCloseTo(1, 6)
  })

  test('grows quadratically, not linearly', () => {
    const at1sd = gaussianPostureCost(43, { meanDeg: 35, sdDeg: 8 })
    const at2sd = gaussianPostureCost(51, { meanDeg: 35, sdDeg: 8 })
    expect(at2sd).toBeCloseTo(4 * at1sd, 6)
  })

  test('a tighter (more confident) sdDeg penalizes the same deviation harder', () => {
    const wide = gaussianPostureCost(50, { meanDeg: 35, sdDeg: 20 })
    const narrow = gaussianPostureCost(50, { meanDeg: 35, sdDeg: 5 })
    expect(narrow).toBeGreaterThan(wide)
  })
})

describe('totalPostureCost', () => {
  test('sums each joint independently', () => {
    const total = totalPostureCost([
      { angleDeg: 43, rom: { meanDeg: 35, sdDeg: 8 } }, // z=1 -> cost 1
      { angleDeg: 27, rom: { meanDeg: 35, sdDeg: 8 } }, // z=-1 -> cost 1
    ])
    expect(total).toBeCloseTo(2, 6)
  })

  test('an empty joint list costs 0', () => {
    expect(totalPostureCost([])).toBe(0)
  })
})
