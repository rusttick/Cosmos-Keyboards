import { describe, expect, test } from 'bun:test'
import { LandmarkFilter, OneEuroFilter } from './landmarkFilter'

describe('OneEuroFilter', () => {
  test('smooths high-frequency jitter on a still signal', () => {
    const filter = new OneEuroFilter()
    let out = 0
    for (let i = 0; i < 200; i++) {
      const t = i / 30
      const noisy = 10 + (i % 2 === 0 ? 1 : -1) * 2 // +-2 jitter around a still value of 10
      out = filter.filter(noisy, t)
    }
    expect(Math.abs(out - 10)).toBeLessThan(0.5)
  })

  test('tracks a slow ramp with small lag', () => {
    const filter = new OneEuroFilter()
    let out = 0
    let target = 0
    for (let i = 0; i < 300; i++) {
      const t = i / 30
      target = t * 5 // 5 units/sec, a slow ramp
      out = filter.filter(target, t)
    }
    expect(Math.abs(out - target)).toBeLessThan(3)
  })

  test('a long gap does not corrupt the next value once reset', () => {
    const filter = new OneEuroFilter()
    filter.filter(0, 0)
    filter.filter(0, 0.03)
    filter.reset()
    const out = filter.filter(100, 10)
    expect(out).toBe(100)
  })
})

describe('LandmarkFilter', () => {
  function pt(x: number, y: number, z: number) {
    return { x, y, z }
  }

  test('rejects a single-frame spike on one landmark', () => {
    const filter = new LandmarkFilter()
    const base = [pt(0, 0, 0), pt(1, 1, 1)]
    let out = base
    for (let i = 0; i < 5; i++) out = filter.filter(base, i / 30)
    // Spike landmark 0 for a single frame.
    out = filter.filter([pt(50, 50, 50), pt(1, 1, 1)], 5 / 30)
    expect(out[0].x).toBeLessThan(5)
    // Recovers to the true value after the spike passes.
    for (let i = 0; i < 5; i++) out = filter.filter(base, (6 + i) / 30)
    expect(Math.abs(out[0].x)).toBeLessThan(0.5)
  })

  test('a gap resets state so the resumed value is not despiked against stale history', () => {
    const filter = new LandmarkFilter({ maxGapSeconds: 0.1 })
    const a = [pt(0, 0, 0)]
    filter.filter(a, 0)
    filter.filter(a, 1 / 30)
    filter.filter(a, 2 / 30)
    // Big gap, then a genuinely different resumed value -- should not be treated as an outlier
    // against the stale pre-gap history.
    const out = filter.filter([pt(20, 0, 0)], 5)
    expect(out[0].x).toBe(20)
  })

  test('grows to accommodate more landmarks than first seen', () => {
    const filter = new LandmarkFilter()
    filter.filter([pt(0, 0, 0)], 0)
    const out = filter.filter([pt(0, 0, 0), pt(5, 5, 5)], 1 / 30)
    expect(out.length).toBe(2)
  })
})
