/**
 * Forward kinematics for a 2-key joint, per key-arrangement-in-3d.md section 6.
 *
 * Layer 1 (this file's `forwardKinematics`): the abstract 3-bone chain (a fixed root bone plus
 * two independently-jointed bones), in terms of bone lengths/baseline angles and the two free
 * joint angles phi1, phi2.
 *
 * Layer 2 (`buildConvexBones`/`buildConcaveBones`): those bone lengths/angles/joint-limits,
 * derived from the key dimensions (keyDims.ts), separately for the convex (pivots v1 then v10)
 * and concave (pivots v6 then v5) bend directions.
 *
 * All angles in this file are radians. The doc works in degrees; conversions happen only where
 * a formula is transcribed 1:1 from the doc.
 *
 * The FK plane is the doc's (x, z) bend plane: x = row direction, z = height above the plate.
 * Verified against a direct step-by-step rotation (not just re-derived) for both directions --
 * see the chat history around this file's creation for the numeric cross-check.
 */

import { B, h1, h2, hf, hs, m, w1, w2 } from './keyDims'

export type BendDirection = 'convex' | 'concave'

export interface BoneSet {
  L0: number
  psi0: number
  L1: number
  psi1: number
  L2: number
  psi2: number
  /** phi1's natural upper limit (`alpha`, from the relevant contact condition). */
  phi1Max: number
  /** phi2's natural upper limit (`90deg - alpha`). */
  phi2Max: number
}

function buildConvexBones(): BoneSet {
  // pivot 1 = key2's own v1, fixed at (B+m, 0) in key1's frame (the Flat Case placement).
  const A = { x: B + m, y: 0 }
  const v10 = { x: (B - w2) / 2, y: -h2 } // relative to key2's own v1 (=origin)
  const V9 = { x: (B + w2) / 2, y: -h2 } // key1's v9, fixed, in key1's frame
  const V9rel = { x: V9.x - A.x, y: V9.y - A.y } // from pivot1 to key1's v9

  // alpha_cvx: the coterminal-direction condition (v9/v10), closed form per section 6.4.
  const angV10 = Math.atan2(v10.y, v10.x)
  const angV9rel = Math.atan2(V9rel.y, V9rel.x)
  const alpha = normalizeAngle(angV10 - angV9rel)

  const L1 = Math.hypot(v10.x, v10.y)
  const psi1 = angV10

  return {
    L0: B + m,
    psi0: 0,
    L1,
    psi1,
    L2: L1, // same segment (v1<->v10), opposite direction
    psi2: psi1 + Math.PI,
    phi1Max: alpha,
    phi2Max: Math.PI / 2 - alpha,
  }
}

function buildConcaveBones(): BoneSet {
  const A = { x: B + m, y: 0 } // key2's own v1, Flat Case placement
  const v6 = { x: 0, y: hs }
  const v5 = { x: (B - w1) / 2, y: h1 }
  const v1 = { x: 0, y: 0 }

  const bone0 = { x: A.x + v6.x, y: A.y + v6.y } // key1's v1 -> key2's v6 (flat)
  const L0 = Math.hypot(bone0.x, bone0.y)
  const psi0 = Math.atan2(bone0.y, bone0.x)

  const bone1 = { x: v5.x - v6.x, y: v5.y - v6.y } // v6 -> v5
  const L1 = Math.hypot(bone1.x, bone1.y)
  const psi1 = Math.atan2(bone1.y, bone1.x)

  const bone2 = { x: v1.x - v5.x, y: v1.y - v5.y } // v5 -> v1
  const L2 = Math.hypot(bone2.x, bone2.y)
  const psi2 = Math.atan2(bone2.y, bone2.x)

  // alpha_ccv: the distance = m condition (v4/v5), per section 6.4's E/F/G solve.
  const u = { x: (B - w1) / 2, y: hf }
  const D0 = { x: (B - w1) / 2 + m, y: -hf }
  const E = D0.x * u.x + D0.y * u.y
  const F = D0.y * u.x - D0.x * u.y
  const G = (m * m - (D0.x ** 2 + D0.y ** 2) - (u.x ** 2 + u.y ** 2)) / 2
  const R = Math.hypot(E, F)
  const alpha = Math.atan2(F, E) + Math.acos(G / R) // smaller positive root (first crossing)

  return { L0, psi0, L1, psi1, L2, psi2, phi1Max: alpha, phi2Max: Math.PI / 2 - alpha }
}

function normalizeAngle(a: number): number {
  const twoPi = 2 * Math.PI
  return ((a % twoPi) + twoPi) % twoPi
}

export const CONVEX_BONES = buildConvexBones()
export const CONCAVE_BONES = buildConcaveBones()

export function boneSetFor(direction: BendDirection): BoneSet {
  return direction === 'convex' ? CONVEX_BONES : CONCAVE_BONES
}

// Convex bends clockwise (subtract from the standard CCW-positive angle); concave bends
// counter-clockwise (add). See this file's header note on the numeric cross-check.
const SIGN: Record<BendDirection, 1 | -1> = { convex: -1, concave: 1 }

export interface KeyPose {
  x: number
  z: number
  /** radians; rotation of key 2 about the row's bend axis (scene Y), relative to key 1. */
  angle: number
}

/** Layer 1: position and orientation of key 2, relative to key 1, given the joint angles. */
export function forwardKinematics(direction: BendDirection, phi1: number, phi2: number): KeyPose {
  const bones = boneSetFor(direction)
  const sign = SIGN[direction]
  const steps: [number, number, number][] = [
    [bones.L0, bones.psi0, 0],
    [bones.L1, bones.psi1, phi1],
    [bones.L2, bones.psi2, phi2],
  ]
  let cumulative = 0
  let x = 0
  let z = 0
  for (const [length, psi, phi] of steps) {
    cumulative += sign * phi
    const angle = psi + cumulative
    x += length * Math.cos(angle)
    z += length * Math.sin(angle)
  }
  return { x, z, angle: sign * (phi1 + phi2) }
}
