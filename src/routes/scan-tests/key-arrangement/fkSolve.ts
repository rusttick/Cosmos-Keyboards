/**
 * "Solve backward": given a target point the user dragged key 2 toward (in the FK's (x,z) bend
 * plane), find the point on the drawn assembly sequence (key-arrangement-in-3d.md section 6.2)
 * closest to it.
 *
 * fk.ts's (phi1, phi2) are independent in general (see fk.ts's header), but independence covers a
 * full 2D patch of positions, and only one curve through that patch -- phi1 maxed out at alpha
 * before phi2 engages at all -- keeps the two keys adjacent (gap m) the way every diagram this
 * session drew does. So the drag is restricted to that single-parameter curve (theta, the total
 * bend angle from the Flat Case): phi1 = min(theta, alpha), phi2 = max(theta - alpha, 0). Off that
 * curve, phi2 pivoting about a "contact" point that isn't actually in contact yet just moves the
 * keys apart -- which is exactly the bug this restriction fixes.
 *
 * The curve itself is defined in terms of the FK-tracked pivot (v1), but the drag HANDLE a user
 * grabs doesn't have to be at v1 -- `offsetPose`/the `offset` param let the solve instead track
 * any point rigidly attached to the key (e.g. its keycap's top center, offset by (B/2, h1) in the
 * key's own frame), by rotating that local offset along with the curve's own pose.angle at each
 * candidate theta before measuring distance to the drag target.
 */

import { type BendDirection, boneSetFor, forwardKinematics, type KeyPose } from './fk'

export interface SolveResult {
  direction: BendDirection
  theta: number // radians, 0..pi/2
  phi1: number
  phi2: number
  pose: KeyPose
  distance: number
}

export interface Point2 {
  x: number
  z: number
}

function distSq(a: Point2, b: Point2): number {
  const dx = a.x - b.x
  const dz = a.z - b.z
  return dx * dx + dz * dz
}

const ZERO_OFFSET: Point2 = { x: 0, z: 0 }

/** Rotate a local 2D vector by a pose's math-convention angle -- the same rotation
 * chain.ts's composeLocal applies when composing one joint's local pose into its parent's frame. */
function rotate(v: Point2, angle: number): Point2 {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return { x: c * v.x - s * v.z, z: s * v.x + c * v.z }
}

/** The point a marker rigidly attached to the key at local `offset` (in the key's own frame, e.g.
 * its keycap's top center) traces as theta varies along the coupled curve -- lets a drag handle
 * sit away from the FK-tracked pivot (v1) without changing what point the curve is defined over. */
export function offsetPose(direction: BendDirection, theta: number, offset: Point2): Point2 {
  const { pose } = coupledPose(direction, theta)
  const rotated = rotate(offset, pose.angle)
  return { x: pose.x + rotated.x, z: pose.z + rotated.z }
}

/** The single-parameter (theta) curve a joint moves along -- exported for chain.ts, which needs
 * it to place every key in a chain, not just the one being dragged. */
export function coupledPose(direction: BendDirection, theta: number): { phi1: number; phi2: number; pose: KeyPose } {
  const bones = boneSetFor(direction)
  const phi1 = Math.min(theta, bones.phi1Max)
  const phi2 = Math.max(theta - bones.phi1Max, 0)
  return { phi1, phi2, pose: forwardKinematics(direction, phi1, phi2) }
}

function bestThetaOnCurve(direction: BendDirection, target: Point2, steps: number, offset: Point2) {
  const thetaMax = Math.PI / 2
  const pointAt = (theta: number) => offsetPose(direction, theta, offset)
  let best = { theta: 0, d: Infinity }
  for (let i = 0; i <= steps; i++) {
    const theta = (i / steps) * thetaMax
    const d = distSq(pointAt(theta), target)
    if (d < best.d) best = { theta, d }
  }
  // refine around the best grid point with a shrinking 1D step
  let { theta } = best
  let step = thetaMax / steps
  let bestD = best.d
  for (let iter = 0; iter < 40 && step > 1e-7; iter++) {
    let improved = false
    for (const delta of [step, -step]) {
      const t = Math.min(thetaMax, Math.max(0, theta + delta))
      const d = distSq(pointAt(t), target)
      if (d < bestD) {
        bestD = d
        theta = t
        improved = true
      }
    }
    if (!improved) step /= 2
  }
  return { theta, d: bestD }
}

/** `offset` (default the pivot itself, i.e. no offset) is the local point on the key -- in the
 * key's own frame -- whose distance to `target` is actually minimized; see this file's header. */
export function solveTowardTarget(target: Point2, offset: Point2 = ZERO_OFFSET): SolveResult {
  const candidates = (['convex', 'concave'] as BendDirection[]).map((direction) => {
    const { theta, d } = bestThetaOnCurve(direction, target, 180, offset)
    const { phi1, phi2, pose } = coupledPose(direction, theta)
    return { direction, theta, phi1, phi2, pose, distance: Math.sqrt(d) }
  })
  candidates.sort((a, b) => a.distance - b.distance)
  return candidates[0]
}
