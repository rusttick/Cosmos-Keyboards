import { describe, expect, test } from 'bun:test'
import { clampToDomain, insideDomain, obbGap, overlapObb } from './sat2d'

describe('overlapObb, axis-aligned (theta=0)', () => {
  test('separated squares do not overlap', () => {
    expect(overlapObb({ x: 0, y: 0, halfSize: 5, theta: 0 }, { x: 20, y: 0, halfSize: 5, theta: 0 })).toBeNull()
  })

  test('exactly touching squares do not count as overlapping', () => {
    expect(overlapObb({ x: 0, y: 0, halfSize: 5, theta: 0 }, { x: 10, y: 0, halfSize: 5, theta: 0 })).toBeNull()
  })

  test('overlapping squares resolve along the smaller-overlap axis', () => {
    // Centers 4 apart on x (overlap 6), 1 apart on y (overlap 9) -- x has the smaller overlap.
    const overlap = overlapObb({ x: 0, y: 0, halfSize: 5, theta: 0 }, { x: 4, y: 1, halfSize: 5, theta: 0 })
    expect(overlap).not.toBeNull()
    expect(overlap!.mtv[1]).toBeCloseTo(0, 5)
    expect(overlap!.mtv[0]).toBeCloseTo(-6, 5)
  })

  test('applying the MTV clears the overlap', () => {
    const a = { x: 0, y: 0, halfSize: 5, theta: 0 }
    const b = { x: 4, y: 1, halfSize: 5, theta: 0 }
    const overlap = overlapObb(a, b)!
    const corrected = { ...a, x: a.x + overlap.mtv[0], y: a.y + overlap.mtv[1] }
    expect(overlapObb(corrected, b)).toBeNull()
  })
})

describe('overlapObb, rotated squares', () => {
  test('a 45-degree-rotated square overlaps a neighbor an axis-aligned test would clear', () => {
    // Two squares whose axis-aligned footprints don't overlap on x (centers 12 apart, halfSize 5 each
    // -> would clear an AABB test by 2), but a's own 45-degree rotation extends its diagonal reach
    // (halfSize*sqrt(2) ~= 7.07) into b.
    const a = { x: 0, y: 0, halfSize: 5, theta: Math.PI / 4 }
    const b = { x: 12, y: 0, halfSize: 5, theta: 0 }
    expect(overlapObb(a, b)).not.toBeNull()
  })

  test('two identically-rotated squares behave exactly like the axis-aligned case, just rotated', () => {
    const theta = 0.7
    const a = { x: 0, y: 0, halfSize: 5, theta }
    const b = { x: 4, y: 1, halfSize: 5, theta }
    // Rotate the axis-aligned reference case's centers by the same theta.
    const cos = Math.cos(theta)
    const sin = Math.sin(theta)
    const rb = { x: 4 * cos - 1 * sin, y: 4 * sin + 1 * cos, halfSize: 5, theta }
    const overlap = overlapObb(a, { x: rb.x, y: rb.y, halfSize: 5, theta })
    expect(overlap).not.toBeNull()
  })
})

describe('overlapObb with minGap', () => {
  test('exactly-touching squares now count as overlapping once a minGap is required', () => {
    const a = { x: 0, y: 0, halfSize: 5, theta: 0 }
    const b = { x: 10, y: 0, halfSize: 5, theta: 0 }
    expect(overlapObb(a, b)).toBeNull() // fine with no gap required
    expect(overlapObb(a, b, 2)).not.toBeNull() // 2mm required, currently 0mm apart
  })

  test('applying the MTV leaves the pair exactly minGap apart, not just non-overlapping', () => {
    const a = { x: 0, y: 0, halfSize: 5, theta: 0 }
    const b = { x: 10, y: 0, halfSize: 5, theta: 0 }
    const overlap = overlapObb(a, b, 2)!
    const corrected = { ...a, x: a.x + overlap.mtv[0], y: a.y + overlap.mtv[1] }
    expect(overlapObb(corrected, b, 2)).toBeNull()
    expect(Math.abs(corrected.x - b.x) - (a.halfSize + b.halfSize)).toBeCloseTo(2, 5)
  })

  test('a pair already separated by more than minGap is left alone', () => {
    const a = { x: 0, y: 0, halfSize: 5, theta: 0 }
    const b = { x: 30, y: 0, halfSize: 5, theta: 0 }
    expect(overlapObb(a, b, 2)).toBeNull()
  })
})

describe('obbGap', () => {
  test('zero for overlapping squares', () => {
    expect(obbGap({ x: 0, y: 0, halfSize: 5, theta: 0 }, { x: 4, y: 0, halfSize: 5, theta: 0 })).toBe(0)
  })

  test('zero for exactly-touching squares', () => {
    expect(obbGap({ x: 0, y: 0, halfSize: 5, theta: 0 }, { x: 10, y: 0, halfSize: 5, theta: 0 })).toBeCloseTo(0, 5)
  })

  test('positive for separated squares, matching the real gap when both are axis-aligned', () => {
    expect(obbGap({ x: 0, y: 0, halfSize: 5, theta: 0 }, { x: 20, y: 0, halfSize: 5, theta: 0 })).toBeCloseTo(10, 5)
  })
})

describe('insideDomain / clampToDomain', () => {
  test('a centered square is inside a large domain', () => {
    expect(insideDomain({ x: 0, y: 0, halfSize: 5, theta: 0 }, 100, 100)).toBe(true)
  })

  test('a square hanging off the edge is not inside', () => {
    expect(insideDomain({ x: 48, y: 0, halfSize: 5, theta: 0 }, 100, 100)).toBe(false)
  })

  test('clampToDomain pulls a square fully back inside', () => {
    const clamped = clampToDomain({ x: 60, y: 60, halfSize: 5, theta: 0 }, 100, 100)
    expect(insideDomain(clamped, 100, 100)).toBe(true)
  })
})
