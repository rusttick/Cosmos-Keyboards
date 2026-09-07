import { CONNECTIONS, FINGERS } from '$lib/hand'
import { describe, expect, test } from 'bun:test'
import { Vector3 } from 'three'
import { fitMcpChoke } from './fitMcpChoke'
import type { InterhandFrame } from './loadFrames'

/** Builds a synthetic frame with a known palm basis (wrist=(0,0,0), indexMcp(5)=(0,1,0),
 * pinkyMcp(17)=(-1,0,0) -- with `handedness: 'Left'` this makes `palmBasisAxes` return exactly
 * `normal=(0,0,1)`, `up=(0,1,0)`, `left=(-1,0,0)`, worked out directly from `makeBasis`'s own
 * construction) and one finger's MCP-to-PIP direction set to an EXACT (flexionDeg, abAdDeg) pair via
 * closed-form spherical placement in that basis. Every other finger gets a harmless placeholder chain
 * (not inspected by these tests) so `fitMcpChoke`'s per-finger loop has no zero-vectors to choke on. */
function syntheticFrame(finger: 'ringFinger' | 'pinky', flexionDeg: number, abAdDeg: number): InterhandFrame {
  const points: Vector3[] = FINGERS.flatMap(f => CONNECTIONS[f].map(([, to]) => to)).reduce(
    (acc, i) => {
      acc[i] = new Vector3(0, 6, 3) // placeholder, overwritten for landmarks set below
      return acc
    },
    new Array(21).fill(null).map(() => new Vector3(0, 6, 3)) as Vector3[],
  )
  points[0] = new Vector3(0, 0, 0) // wrist
  points[5] = new Vector3(0, 1, 0) // index MCP -- defines `up`
  points[17] = new Vector3(-1, 0, 0) // pinky MCP -- defines `normal` (with pinky's own MCP below)

  const up = new Vector3(0, 1, 0)
  const left = new Vector3(-1, 0, 0)
  const normal = new Vector3(0, 0, 1)

  const psi = (abAdDeg * Math.PI) / 180
  const phi = (flexionDeg * Math.PI) / 180
  const leftComp = Math.sin(psi)
  const theta = Math.acos(Math.max(-1, Math.min(1, Math.cos(phi) / Math.cos(psi))))
  const dir = left.clone().multiplyScalar(leftComp)
    .addScaledVector(up, Math.cos(psi) * Math.cos(theta))
    .addScaledVector(normal, Math.cos(psi) * Math.sin(theta))
    .normalize()

  const pairs = CONNECTIONS[finger]
  const landmarks = [pairs[0][0], ...pairs.map(([, to]) => to)]
  const [, mcp, pip] = landmarks
  points[mcp] = new Vector3(0, 1, 0)
  points[pip] = points[mcp].clone().addScaledVector(dir, 20)

  return { frameId: 'f', seq: 's', points }
}

describe('fitMcpChoke', () => {
  test('recovers a positive chokeCoeff when ab/ad half-range genuinely shrinks with flexion', () => {
    // Two ab/ad extremes (+-spread) at each of several flexion levels, spread shrinking as flexion grows.
    const flexLevels = [10, 25, 40, 55, 70]
    const spreadAtLevel = (flex: number) => 20 - flex * 0.2 // shrinks from ~18deg to ~6deg
    const frames: InterhandFrame[] = []
    for (const flex of flexLevels) {
      const spread = spreadAtLevel(flex)
      for (let k = 0; k < 8; k++) {
        const abAd = -spread + (2 * spread * k) / 7
        frames.push(syntheticFrame('ringFinger', flex, abAd))
      }
    }
    const results = fitMcpChoke(frames, 'Left')
    const ring = results.find(r => r.finger === 'ringFinger')!
    expect(ring.shrinkageCorrelation).toBeLessThan(-0.3)
    expect(ring.fitted).toBe(true)
    expect(ring.chokeCoeff).toBeGreaterThan(0)
  })

  test('does not fit when ab/ad half-range does not shrink with flexion', () => {
    const flexLevels = [10, 25, 40, 55, 70]
    const frames: InterhandFrame[] = []
    for (const flex of flexLevels) {
      for (let k = 0; k < 8; k++) {
        const abAd = -10 + (20 * k) / 7 // constant +-10deg spread regardless of flexion
        frames.push(syntheticFrame('pinky', flex, abAd))
      }
    }
    const results = fitMcpChoke(frames, 'Left')
    const pinky = results.find(r => r.finger === 'pinky')!
    expect(pinky.fitted).toBe(false)
    expect(pinky.chokeCoeff).toBeUndefined()
  })
})
