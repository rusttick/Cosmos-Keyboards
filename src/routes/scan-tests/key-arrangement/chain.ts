/**
 * A row of N keys as a chain of joints: key[0] is fixed (the global frame); key[i] (i>=1) is
 * placed by joints[i-1], a single (direction, theta) pair evaluated via fkSolve.ts's
 * `coupledPose` -- the same constrained curve verified against the diagrams for 2 keys, applied
 * once per joint so the framework extends to any N without changing per-joint behavior.
 *
 * Every key's local FK (fk.ts) is computed relative to its OWN parent's frame (x=row direction,
 * z=height, y=0 always -- so the whole chain stays in one 2D plane, per that constraint). This
 * file composes those per-joint local poses into one set of global poses by walking the chain,
 * same idea as composing per-joint transforms in a robot arm.
 */

import type { BendDirection } from './fk'
import { coupledPose, offsetPose, type Point2 } from './fkSolve'

export interface JointState {
  direction: BendDirection
  theta: number // radians, 0..pi/2
}

export interface GlobalPose {
  x: number
  z: number
  angle: number // radians
}

const ORIGIN: GlobalPose = { x: 0, z: 0, angle: 0 }

export function composeLocal(parent: GlobalPose, local: { x: number; z: number; angle: number }): GlobalPose {
  const cos = Math.cos(parent.angle)
  const sin = Math.sin(parent.angle)
  return {
    x: parent.x + cos * local.x - sin * local.z,
    z: parent.z + sin * local.x + cos * local.z,
    angle: parent.angle + local.angle,
  }
}

/** Global pose of every key in the chain: poses[0] is always ORIGIN (key 0), poses[i] is placed
 * by joints[i-1] relative to poses[i-1]. */
export function chainPoses(joints: JointState[]): GlobalPose[] {
  const poses: GlobalPose[] = [ORIGIN]
  let parent = ORIGIN
  for (const joint of joints) {
    const { pose } = coupledPose(joint.direction, joint.theta)
    parent = composeLocal(parent, pose)
    poses.push(parent)
  }
  return poses
}

/** Inverse of composeLocal: express a world-space (x,z) point in `parent`'s local frame, for
 * feeding a drag target into fkSolve.ts's `solveTowardTarget`. */
export function worldToLocal(parent: GlobalPose, world: { x: number; z: number }): { x: number; z: number } {
  const dx = world.x - parent.x
  const dz = world.z - parent.z
  const cos = Math.cos(parent.angle)
  const sin = Math.sin(parent.angle)
  return { x: cos * dx + sin * dz, z: -sin * dx + cos * dz }
}

/** Global position of a marker rigidly attached to each key at local `offset` (e.g. a keycap's
 * top center) -- one entry per joint (handlePoses[i] belongs to key i+1, placed by joints[i]).
 * Pair with fkSolve.ts's `solveTowardTarget(target, offset)` using the SAME offset, so dragging
 * this marker solves for the theta that puts the marker (not the pivot) under the cursor. */
export function chainHandlePoses(joints: JointState[], offset: Point2): Point2[] {
  const keyPoses = chainPoses(joints)
  return joints.map((joint, i) => {
    const local = offsetPose(joint.direction, joint.theta, offset)
    return composeLocal(keyPoses[i], { x: local.x, z: local.z, angle: 0 })
  })
}
