import { CONNECTIONS, FINGERS } from '$lib/hand'
import { describe, expect, test } from 'bun:test'
import { Vector3 } from 'three'
import { fitDipPipCoupling } from './fitDipPipCoupling'
import type { InterhandFrame } from './loadFrames'

/** Builds a synthetic frame where every finger's PIP/DIP bend angle is controlled directly, by placing
 * each finger's 5 landmarks (wrist, mcp, pip, dip, tip) along a simple bent chain -- exact geometry, no
 * tracking noise, so the fitted slope/intercept/R² can be checked against a known-exact relationship. */
function syntheticFrame(pipDeg: number, dipDeg: (pip: number) => number): InterhandFrame {
  const points: Vector3[] = new Array(21).fill(null).map(() => new Vector3())
  points[0] = new Vector3(0, 0, 0)
  for (const finger of FINGERS) {
    const pairs = CONNECTIONS[finger]
    const landmarks = [pairs[0][0], ...pairs.map(([, to]) => to)]
    const [wrist, mcp, pip, dip, tip] = landmarks
    points[wrist] = new Vector3(0, 0, 0)
    points[mcp] = new Vector3(0, 50, 0)
    // Bend at `pip` by pipDeg (in the XY plane), then at `dip` by dipDeg(pipDeg).
    const pipRad = (pipDeg * Math.PI) / 180
    const dir1 = new Vector3(0, 1, 0)
    points[pip] = points[mcp].clone().add(dir1.clone().multiplyScalar(30))
    const dir2 = new Vector3(Math.sin(pipRad), Math.cos(pipRad), 0)
    points[dip] = points[pip].clone().add(dir2.clone().multiplyScalar(20))
    const dipRad = (dipDeg(pipDeg) * Math.PI) / 180
    // Compose the second bend relative to dir2's own direction (rotate dir2 by dipRad about Z).
    const dir3 = new Vector3(
      dir2.x * Math.cos(dipRad) + dir2.y * Math.sin(dipRad),
      -dir2.x * Math.sin(dipRad) + dir2.y * Math.cos(dipRad),
      0,
    )
    points[tip] = points[dip].clone().add(dir3.clone().multiplyScalar(15))
  }
  return { frameId: 'f', seq: 's', points }
}

describe('fitDipPipCoupling', () => {
  test('recovers an exact linear coupling with R^2 = 1', () => {
    const pips = [5, 10, 20, 30, 40, 50, 60, 70]
    const frames = pips.map(p => syntheticFrame(p, pip => 0.5 * pip + 3))
    const results = fitDipPipCoupling(frames, 1) // threshold=1 (100%): synthetic geometry has no segment-length noise to filter
    const index = results.find(r => r.finger === 'indexFinger')!
    expect(index.slope).toBeCloseTo(0.5, 3)
    expect(index.intercept).toBeCloseTo(3, 2)
    expect(index.r2).toBeGreaterThan(0.999)
  })

  test('a weaker/noisier relationship still fits, with a lower R^2', () => {
    const pips = [5, 15, 25, 35, 45, 55, 65, 75]
    let toggle = 1
    const frames = pips.map(p =>
      syntheticFrame(p, pip => {
        toggle = -toggle
        return 0.2 * pip + toggle * 8 // alternating noise around a real trend
      })
    )
    const results = fitDipPipCoupling(frames, 1)
    const index = results.find(r => r.finger === 'indexFinger')!
    expect(index.slope).toBeGreaterThan(0)
    expect(index.r2).toBeLessThan(0.999)
    expect(index.r2).toBeGreaterThan(0)
  })

  test('every non-thumb finger gets a result, thumb is excluded', () => {
    const frames = [syntheticFrame(10, p => 0.5 * p), syntheticFrame(40, p => 0.5 * p)]
    const results = fitDipPipCoupling(frames, 1)
    expect(results.map(r => r.finger).sort()).toEqual(['indexFinger', 'middleFinger', 'pinky', 'ringFinger'].sort() as typeof results[number]['finger'][])
  })
})
