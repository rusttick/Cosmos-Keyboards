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

interface Point2 {
  x: number
  z: number
}

function distSq(a: Point2, b: Point2): number {
  const dx = a.x - b.x
  const dz = a.z - b.z
  return dx * dx + dz * dz
}

/** The single-parameter (theta) curve a joint moves along -- exported for chain.ts, which needs
 * it to place every key in a chain, not just the one being dragged. */
export function coupledPose(direction: BendDirection, theta: number): { phi1: number; phi2: number; pose: KeyPose } {
  const bones = boneSetFor(direction)
  const phi1 = Math.min(theta, bones.phi1Max)
  const phi2 = Math.max(theta - bones.phi1Max, 0)
  return { phi1, phi2, pose: forwardKinematics(direction, phi1, phi2) }
}

function bestThetaOnCurve(direction: BendDirection, target: Point2, steps: number) {
  const thetaMax = Math.PI / 2
  let best = { theta: 0, d: Infinity }
  for (let i = 0; i <= steps; i++) {
    const theta = (i / steps) * thetaMax
    const d = distSq(coupledPose(direction, theta).pose, target)
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
      const d = distSq(coupledPose(direction, t).pose, target)
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

export function solveTowardTarget(target: Point2): SolveResult {
  const candidates = (['convex', 'concave'] as BendDirection[]).map((direction) => {
    const { theta, d } = bestThetaOnCurve(direction, target, 180)
    const { phi1, phi2, pose } = coupledPose(direction, theta)
    return { direction, theta, phi1, phi2, pose, distance: Math.sqrt(d) }
  })
  candidates.sort((a, b) => a.distance - b.distance)
  return candidates[0]
}
