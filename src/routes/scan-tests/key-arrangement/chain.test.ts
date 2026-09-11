import { describe, expect, test } from 'bun:test'
import { chainHandlePoses, chainPoses, type JointState, worldToLocal } from './chain'
import { coupledPose, offsetPose } from './fkSolve'

describe('chainPoses', () => {
  test('a single joint reproduces coupledPose directly (poses[0] is the fixed origin)', () => {
    const joints: JointState[] = [{ direction: 'convex', theta: 0.3 }]
    const poses = chainPoses(joints)
    expect(poses).toHaveLength(2)
    expect(poses[0]).toEqual({ x: 0, z: 0, angle: 0 })
    const expected = coupledPose('convex', 0.3).pose
    expect(poses[1].x).toBeCloseTo(expected.x, 9)
    expect(poses[1].z).toBeCloseTo(expected.z, 9)
    expect(poses[1].angle).toBeCloseTo(expected.angle, 9)
  })

  test('a straight (theta=0) chain of N keys lays out collinearly, one Flat Case gap apart', () => {
    const joints: JointState[] = [
      { direction: 'convex', theta: 0 },
      { direction: 'convex', theta: 0 },
      { direction: 'convex', theta: 0 },
    ]
    const poses = chainPoses(joints)
    expect(poses).toHaveLength(4)
    const gap = poses[1].x - poses[0].x
    for (let i = 1; i < poses.length; i++) {
      expect(poses[i].z).toBeCloseTo(0, 9)
      expect(poses[i].angle).toBeCloseTo(0, 9)
      expect(poses[i].x - poses[i - 1].x).toBeCloseTo(gap, 9)
    }
  })

  test('a bent joint rotates every downstream key, not just its own', () => {
    const joints: JointState[] = [
      { direction: 'convex', theta: 0.3 },
      { direction: 'convex', theta: 0 },
    ]
    const poses = chainPoses(joints)
    // key 2's own joint is theta=0 (no local bend), but it should still inherit key 1's rotation.
    expect(poses[2].angle).toBeCloseTo(poses[1].angle, 9)
    expect(poses[1].angle).not.toBeCloseTo(0, 3)
  })

  test('empty joint list returns just the origin', () => {
    expect(chainPoses([])).toEqual([{ x: 0, z: 0, angle: 0 }])
  })
})

describe('chainHandlePoses', () => {
  const offset = { x: 9.1, z: 16 }

  test("a zero offset reproduces chainPoses' own positions", () => {
    const joints: JointState[] = [
      { direction: 'convex', theta: 0.3 },
      { direction: 'concave', theta: 0.2 },
    ]
    const keyPoses = chainPoses(joints)
    const handlePoses = chainHandlePoses(joints, { x: 0, z: 0 })
    expect(handlePoses).toHaveLength(joints.length)
    for (let i = 0; i < joints.length; i++) {
      expect(handlePoses[i].x).toBeCloseTo(keyPoses[i + 1].x, 9)
      expect(handlePoses[i].z).toBeCloseTo(keyPoses[i + 1].z, 9)
    }
  })

  test('for the first joint, matches offsetPose directly (no ancestor rotation to compose)', () => {
    const joints: JointState[] = [{ direction: 'convex', theta: 0.3 }]
    const handlePoses = chainHandlePoses(joints, offset)
    const expected = offsetPose('convex', 0.3, offset)
    expect(handlePoses[0].x).toBeCloseTo(expected.x, 9)
    expect(handlePoses[0].z).toBeCloseTo(expected.z, 9)
  })

  test("a downstream handle also picks up the upstream joint's rotation", () => {
    const joints: JointState[] = [
      { direction: 'convex', theta: 0.3 },
      { direction: 'convex', theta: 0 },
    ]
    const handles = chainHandlePoses(joints, offset)
    const key2Handle = handles[1] // belongs to key 2, placed by joints[1]
    // key 2's own joint has theta=0 (no local bend beyond the Flat Case bone), so its handle
    // should be key 2's own position, offset by key 2's accumulated rotation (which, with no
    // local bend, equals key 1's) -- i.e. rotate(offset, keyPoses[2].angle) added to keyPoses[2].
    const keyPoses = chainPoses(joints)
    expect(keyPoses[2].angle).toBeCloseTo(keyPoses[1].angle, 9) // sanity: no extra local rotation
    const c = Math.cos(keyPoses[2].angle)
    const s = Math.sin(keyPoses[2].angle)
    const expectedX = keyPoses[2].x + (c * offset.x - s * offset.z)
    const expectedZ = keyPoses[2].z + (s * offset.x + c * offset.z)
    expect(key2Handle.x).toBeCloseTo(expectedX, 9)
    expect(key2Handle.z).toBeCloseTo(expectedZ, 9)
  })
})

describe('worldToLocal', () => {
  test('is the exact inverse of the rotation+translation chainPoses composes with', () => {
    const parent = { x: 12, z: -5, angle: 0.7 }
    const cos = Math.cos(parent.angle)
    const sin = Math.sin(parent.angle)
    const local = { x: 3, z: -8 }
    // world = parent + R(parent.angle) * local, matching chain.ts's composeLocal
    const world = {
      x: parent.x + cos * local.x - sin * local.z,
      z: parent.z + sin * local.x + cos * local.z,
    }
    const recovered = worldToLocal(parent, world)
    expect(recovered.x).toBeCloseTo(local.x, 9)
    expect(recovered.z).toBeCloseTo(local.z, 9)
  })

  test('identity parent (origin, angle 0) is a no-op', () => {
    const world = { x: 4.2, z: -1.1 }
    const local = worldToLocal({ x: 0, z: 0, angle: 0 }, world)
    expect(local.x).toBeCloseTo(world.x, 9)
    expect(local.z).toBeCloseTo(world.z, 9)
  })
})
