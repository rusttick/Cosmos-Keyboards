import { describe, expect, test } from 'bun:test'
import { chainPoses, type JointState } from './chain'
import { B, m } from './keyDims'

/**
 * Regression test for a real bug found live in +page.svelte: the left (leftward-growing) chain
 * is computed with the same unmirrored fk.ts/chain.ts machinery as the right chain, then rendered
 * inside a Three.js `<T.Group position={[B,0,0]} scale={[-1,1,1]}>` wrapper to mirror it into
 * place. The first version of that wrapper used `scale={[-1,1,1]}` alone (mirroring about x=0,
 * key 0's own v1/trailing-edge corner) -- which left a full B+m gap between key 0 and the first
 * left key instead of the intended m, because key 0's real body spans [0,B], not [-B,0]. Key 0's
 * body is bilaterally symmetric about its own center (x=B/2), so the wrapper must mirror THERE
 * (`position={[B,0,0]}`) for key 0's real span to reflect back onto itself.
 *
 * This file re-derives the exact Three.js transform composition (position/rotation convention
 * already established and tested in fk.test.ts/chain.test.ts) in plain TS, since the actual
 * wrapper lives in a .svelte file with Threlte components and isn't independently unit-testable.
 */

interface Point {
  x: number
  z: number
}

// Same Three.js Y-rotation convention `+page.svelte` uses for every key's own T.Group
// (position=[pose.x,0,pose.z], rotation=[0,-pose.angle,0]) -- see fk.test.ts's header note.
function childWorldPoint(local: Point, pose: { x: number; z: number; angle: number }): Point {
  const c = Math.cos(-pose.angle)
  const s = Math.sin(-pose.angle)
  return { x: pose.x + (local.x * c + local.z * s), z: pose.z + (-local.x * s + local.z * c) }
}

// The wrapper: <T.Group position={[B,0,0]} scale={[-1,1,1]}>
function mirrorAboutKey0Center(p: Point): Point {
  return { x: B - p.x, z: p.z }
}

// The (rejected) first attempt: <T.Group scale={[-1,1,1]}> -- mirrors about x=0 instead.
function mirrorAboutOrigin(p: Point): Point {
  return { x: -p.x, z: p.z }
}

function firstLeftKeyEdges(theta: number) {
  const joints: JointState[] = [{ direction: 'convex', theta }]
  const pose = chainPoses(joints)[1]
  const v1 = childWorldPoint({ x: 0, z: 0 }, pose) // local v1 = key's own T.Group origin
  const v2 = childWorldPoint({ x: B, z: 0 }, pose) // local v2 = the key's own far edge
  return { v1, v2 }
}

describe('left chain mirror axis', () => {
  test("mirroring about key 0's own center (x=B/2) leaves an m gap, at rest (theta=0)", () => {
    const { v1, v2 } = firstLeftKeyEdges(0)
    const v1World = mirrorAboutKey0Center(v1)
    const v2World = mirrorAboutKey0Center(v2)
    const nearestEdge = Math.max(v1World.x, v2World.x) // closer to key 0's own v1 at x=0
    expect(0 - nearestEdge).toBeCloseTo(m, 6)
  })

  test("mirroring about key 0's own center still leaves an m gap once bent (theta > 0)", () => {
    const { v1, v2 } = firstLeftKeyEdges(0.3)
    const v1World = mirrorAboutKey0Center(v1)
    const v2World = mirrorAboutKey0Center(v2)
    const nearestEdge = Math.max(v1World.x, v2World.x)
    expect(0 - nearestEdge).toBeCloseTo(m, 6)
  })

  test('regression: mirroring about x=0 instead leaves a B+m gap, not m (the bug this test guards against)', () => {
    const { v1, v2 } = firstLeftKeyEdges(0)
    const v1World = mirrorAboutOrigin(v1)
    const v2World = mirrorAboutOrigin(v2)
    const nearestEdge = Math.max(v1World.x, v2World.x)
    const gap = 0 - nearestEdge
    expect(gap).toBeCloseTo(B + m, 6)
    expect(gap).not.toBeCloseTo(m, 3)
  })
})
