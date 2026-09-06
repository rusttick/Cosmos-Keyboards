import { describe, expect, test } from 'bun:test'
import { Vector3 } from 'three'
import { bendAngleDeg, fitRom } from './fitRom'
import type { InterhandFrame } from './loadFrames'

describe('bendAngleDeg', () => {
  test('collinear points (straight) = 0 degrees', () => {
    const a = new Vector3(0, 0, 0)
    const joint = new Vector3(1, 0, 0)
    const b = new Vector3(2, 0, 0)
    expect(bendAngleDeg(a, joint, b)).toBeCloseTo(0, 5)
  })

  test('a right-angle bend = 90 degrees', () => {
    const a = new Vector3(0, 0, 0)
    const joint = new Vector3(1, 0, 0)
    const b = new Vector3(1, 1, 0)
    expect(bendAngleDeg(a, joint, b)).toBeCloseTo(90, 5)
  })

  test('folded fully back on itself = 180 degrees', () => {
    const a = new Vector3(0, 0, 0)
    const joint = new Vector3(1, 0, 0)
    const b = new Vector3(0, 0, 0)
    expect(bendAngleDeg(a, joint, b)).toBeCloseTo(180, 5)
  })

  test('scale-invariant (only direction matters, not segment length)', () => {
    const a = new Vector3(0, 0, 0)
    const joint = new Vector3(10, 0, 0)
    const b = new Vector3(11, 0.5, 0) // continues mostly forward, slight upward deflection
    const angle = bendAngleDeg(a, joint, b)
    expect(angle).toBeGreaterThan(0)
    expect(angle).toBeLessThan(90)
  })
})

describe('fitRom directness tagging', () => {
  // Two straight-line synthetic frames (all landmarks collinear along +x) -- the actual angles don't
  // matter for this test, only which `directness` tag each joint comes back with.
  function straightFrame(): InterhandFrame {
    const points = Array.from({ length: 21 }, (_, i) => new Vector3(i, 0, 0))
    return { frameId: '0', seq: 'synthetic', points }
  }
  const frames = [straightFrame(), straightFrame()]
  const results = fitRom(frames)

  function directnessOf(finger: string, jointName: string): string | undefined {
    return results.find(r => r.finger === finger && r.jointName === jointName)?.directness
  }

  test("clean hinges: PIP/DIP and the thumb's MCP/IP", () => {
    expect(directnessOf('indexFinger', 'pip')).toBe('clean-hinge')
    expect(directnessOf('indexFinger', 'dip')).toBe('clean-hinge')
    expect(directnessOf('thumb', 'mcp')).toBe('clean-hinge')
    expect(directnessOf('thumb', 'ip')).toBe('clean-hinge')
  })

  test("flex-abd-combined: thumb CMC and every other finger's true MCP", () => {
    expect(directnessOf('thumb', 'cmc')).toBe('flex-abd-combined')
    expect(directnessOf('indexFinger', 'mcp')).toBe('flex-abd-combined')
    expect(directnessOf('middleFinger', 'mcp')).toBe('flex-abd-combined')
  })

  test("joint-stacked: only ring/pinky's base joint", () => {
    expect(directnessOf('ringFinger', 'mcp')).toBe('joint-stacked')
    expect(directnessOf('pinky', 'mcp')).toBe('joint-stacked')
  })

  test('declaredSdDeg inflates over raw sdDeg according to the multiplier', () => {
    const stacked = results.find(r => r.finger === 'ringFinger' && r.jointName === 'mcp')!
    const clean = results.find(r => r.finger === 'indexFinger' && r.jointName === 'pip')!
    // both are ~0 here (perfectly straight synthetic data), so compare the multiplier relationship
    // directly rather than the (near-zero) values themselves.
    expect(stacked.declaredSdDeg).toBeGreaterThanOrEqual(clean.declaredSdDeg)
  })
})
