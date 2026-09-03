/**
 * A library to help work with hands.
 *
 * I'll briefly explain the theory here. The hand that comes from mediapipe is described as a bunch of keypoints.
 * This doc explains it well: https://github.com/google/mediapipe/blob/master/docs/solutions/hands.md
 *
 * A better representation of the points is as vectors. Each hand is made up of 5 fingers,
 * each represented as a chain of 4 vectors. Each of the 4 vectors correspond to a bone in the hand.
 * This is what makeHand() calculates.
 *
 * This is great at representing a hand in a moment of time, but it fails to capture the kinematics of the hand:
 * what the degrees of freedom are in the hand and which way joints can move.
 *
 * I make the following assumptions about the hand's degrees of freedom:
 * - The metacarpal bones (first of the 4 bones in the chain) are fixed (the carpometacarpal joints have 0 DOF)
 * - The metacarpophalangeal joints have 2 DOF (side-to-side and up-down)
 * - The remaining 2 joints have 1 DOF (up-down).
 * - The up-down motion of the phalanges (last 3 bones) are all in the same plane.
 * - The thumb is slightly different, in that the 2nd joint has 1 DOF and the 3rd joint has 2 DOF.
 *
 * To find the direction of the up-down motion, I gather all joint vectors that have up-down motion and
 * find the principal components via PCA. One of the components is chosen to be the Z axis of the joint's
 * coordinate frame, and the X axis is calculated as the average vector position projected onto the XY plane
 * (might want to revisit this later).
 *
 * The rest of the joints get coordinate frames as well to expess their motion: the up-down motion is about the
 * Z axis, and the side-to-side motion is about the Y axis. The X axis points in the direction of the joint.
 * These coordinate frames are stored in a SolvedHand object. The Vinv transformation matrix goes from the local
 * frame to world space. V goes from world space to local space.
 *
 * If you're unfamiliar with using matrices as transformations, it might be helpful to read linear algebra/robotics
 * resources like https://modernrobotics.northwestern.edu/nu-gm-book-resource/3-3-1-homogeneous-transformation-matrices/
 *
 * With the coordinate frames FK is fairly simple. Perform the up-down and side-to-side rotations in local space,
 * then multiply by the Vinv matrix to get the world space transformation.
 *
 * For IK, I rely on the asumption that all the up-down motions are coplanar. I simplify the 4-bone linkage to 2 joints.
 * The first joint is the MCP joint, which as 2 DOF (second assumption). The second fake joint goes straight from the end
 * of the metacarpal bone to the target position. It has 1 DOF in its length. Altogether, that makes 3 DOF for a target
 * positioned with 3 DOF, which means there is 1 unique solution!
 *
 * After finding the orientation of the MCP joint, I draw a plane containing both the target position and end position
 * of the metacarpal. The plane is oriented normal to the Z axis of the MCP joint. Along the plane I draw a quadrilateral.
 * One edge is that fake joint, while the other 3 are the 3 phalanges. I could choose any type of quadrilateral, but I
 * choose a cyclic quadrilateral, which has maximum area (there's no biological explanation but it produces natural-looking
 * grasps).
 *
 * Altogether it's a lot of math :) But that's what makes it fun.
 *
 * Copyright (C) 2023 rianadon. See the LICENSE file for the license.
 */

import { sum } from '$lib/worker/util'
import type { LandmarkList, NormalizedLandmarkList } from '@mediapipe/hands'
import { SVD } from 'svd-js'
import { Euler, Matrix4, Quaternion, Vector3, type Vector3Tuple } from 'three'

export interface PoseHand {
  keypoints: NormalizedLandmarkList
  keypoints3D: LandmarkList
  handedness: 'Left' | 'Right'
  score: number
}

export interface Hand {
  handedness: string
  score: number
  hand: PoseHand
  vectors: Vector3[]
  limbs: Record<string, Vector3[]>
  /** Rotation matrix used to transform camera points into hand points */
  basis: Matrix4
}

export interface Hands {
  Left?: Hand
  Right?: Hand
}

export const CONNECTIONS = {
  thumb: [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
  ],
  indexFinger: [
    [0, 5],
    [5, 6],
    [6, 7],
    [7, 8],
  ],
  middleFinger: [
    [0, 9],
    [9, 10],
    [10, 11],
    [11, 12],
  ],
  ringFinger: [
    [0, 13],
    [13, 14],
    [14, 15],
    [15, 16],
  ],
  pinky: [
    [0, 17],
    [17, 18],
    [18, 19],
    [19, 20],
  ],
}
export const FINGERS = Object.keys(CONNECTIONS) as Finger[]
export const LIMBS = [0, 1, 2, 3]

const Y_AXIS = new Vector3(0, 1, 0)
const Z_AXIS = new Vector3(0, 0, 1)

function MAX_PAN(finger: Finger) {
  // Pan limits are disabled: the only IK caller (the /beta hand-fit view) needs
  // ik() to always produce a solve rather than reject out-of-pan targets.
  return Infinity
  // Previous per-finger limits, kept for reference:
  // if (finger == 'thumb') return 40 * DEG2RAD
  // return 30 * DEG2RAD
}

/** The thumb CMC's conjunct (axial-twist) rotation, computed rather than independently driven — see
 * `SolvedHand.fkBy`/`fromLimbs`'s `degree: 3` handling and `docs/thumbs/scan3.md`, "The thumb CMC."
 * `twist ≈ aCoeff·flexion + bCoeff·abduction`.
 *
 * Belongs on `joints.thumb[1]` (governing the CMC-landmark-to-MCP-landmark segment, the actual first
 * metacarpal), not `joints.thumb[0]`. MediaPipe models the wrist as a zero-width point, so the
 * wrist-to-CMC-landmark segment (`thumb[0]`) sits too close to the CMC's own pivot to carry much real
 * rotation — confirmed live and independently by published single-camera thumb motion capture research
 * (docs/thumbs/test_results.md, 2026-09-01). `joints.thumb[0]` should stay `degree: 0` (fixed), the
 * same convention every other finger's metacarpal already uses. */
export interface ConjunctCoupling {
  aCoeff: number
  bCoeff: number
  r2: number
}

export type Joint =
  | { length: number; degree: 0; position: Vector3; V: Matrix4; Vinv: Matrix4 }
  | { length: number; degree: 1 | 2; V: Matrix4; Vinv: Matrix4; axisConfidence?: number }
  | {
    length: number
    degree: 3
    V: Matrix4
    Vinv: Matrix4
    conjunctCoupling: ConjunctCoupling
    axisConfidence?: number
  }
export type Finger = keyof typeof CONNECTIONS
export type Joints = Record<Finger, Joint[]>

/** Create a basis to orient the hand in a standard position.
 * This standardizes the orientation of all hands.
 *
 * The palm plane is defined by landmarks [0, 5, 17] (wrist, index MCP, pinky MCP) -- deliberately
 * NOT landmark 1 (thumb CMC), which the previous version of this function used. That was circular
 * for anything measuring thumb motion: the reference frame the thumb's own motion gets expressed in
 * would be partly built from a thumb landmark. Matches `orientation.ts`'s already-validated
 * `palmAngleDeg()` formula (same two vectors, same per-handedness negation), which never had this
 * problem since it was written independently. See docs/thumbs/test_results.md, 2026-09-02.
 */
function makeBasis(vectors: Vector3[], reverse: boolean) {
  const v1 = new Vector3()
    .subVectors(vectors[CONNECTIONS.indexFinger[0][1]], vectors[CONNECTIONS.indexFinger[0][0]])
    .normalize()
  const v2 = new Vector3()
    .subVectors(vectors[CONNECTIONS.pinky[0][1]], vectors[CONNECTIONS.pinky[0][0]])
    .normalize()

  const x = new Vector3().crossVectors(v1, v2).normalize()
  if (reverse) x.negate()

  // Seed "up" from v1 (wrist -> index MCP), then Gram-Schmidt it orthogonal to the palm normal --
  // the same construction the previous version used to orthogonalize its two reference vectors.
  const up = v1.clone()
  up.addScaledVector(x, -x.dot(up)).normalize()

  const left = new Vector3().crossVectors(x, up)

  return new Matrix4().makeBasis(x, up, left)
}

/** Transform a hand's keypoints into a list of vectors for each finger. */
export function makeHand(hand: PoseHand, is2D = false, ptTransform = (pt: Vector3) => pt): Hand {
  const vectors = is2D
    ? hand.keypoints.map(a => ptTransform(new Vector3(1 - a.x, a.y, 0)))
    : hand.keypoints3D.map(a => ptTransform(new Vector3(a.x, -a.y, a.z)))
  const handedness = hand.handedness
  const score = hand.score

  const basis = makeBasis(vectors, handedness === 'Right').invert()
    .premultiply(
      new Matrix4().makeBasis(
        new Vector3(0, -1, 0),
        new Vector3(1, 0, 0),
        new Vector3(0, 0, 1),
      ),
    )
  // const transform = new Matrix4()

  const limbs = Object.fromEntries(
    Object.entries(CONNECTIONS).map(([name, limb]) => [
      name,
      limb.map(([a, b]) =>
        new Vector3()
          .subVectors(vectors[b], vectors[a])
          .applyMatrix4(basis)
      ),
    ]),
  )
  return { hand, vectors, handedness, score, limbs, basis }
}

export function handOrientation(hand: Hand): Quaternion {
  const mat = hand.basis.clone().invert()
  return new Quaternion().setFromRotationMatrix(mat)
}

/** Signed flexion angle (degrees) between two consecutive bones in a finger's 4-bone chain:
 * `boneIndex` 0 = the MCP bend (limb 0 vs. limb 1), 1 = PIP (limb 1 vs. limb 2), 2 = DIP (limb 2 vs.
 * limb 3). Positive is ordinary flexion, negative is hyperextension past straight -- some people's
 * natural ROM genuinely includes hyperextension, and `Vector3.angleTo()` alone (used everywhere in
 * this codebase's live-capture tooling before this) is mathematically restricted to [0, 180] degrees,
 * so it collapses both directions into the same unsigned magnitude and can't represent that.
 *
 * Sign convention (LIKE `thumbDepthSign` in scan-tests/lib/orientation.ts, THIS IS A BEST-GUESS
 * CONVENTION, not yet verified against a real capture with known hyperextension): read off which way
 * the bend rotates around the knuckle-line axis (pinky MCP -> index MCP, raw camera-space, mirrored
 * for chirality the same way `palmAngleDeg` is), transformed into the same basis-standardized space
 * `hand.limbs` already lives in -- the same axis is used for all three joints, since normal finger
 * flexion is a hinge motion about roughly-parallel axes at MCP/PIP/DIP. If a real hyperextension
 * capture comes back with the wrong sign, negate this convention -- it's a single, isolated flip, not
 * a redesign, since every consumer downstream (PlateauDetector, coverageGrid, fitDipPipCoupling,
 * fitEnslaving) already treats the sign as opaque data, not something it interprets. */
export function signedJointAngle(hand: Hand, finger: Finger, boneIndex: 0 | 1 | 2): number {
  const limbs = hand.limbs[finger]
  const boneA = limbs[boneIndex]
  const boneB = limbs[boneIndex + 1]
  const unsignedAngle = boneA.angleTo(boneB)

  const knuckleAxis = new Vector3()
    .subVectors(hand.vectors[17], hand.vectors[5]) // pinky MCP -> index MCP, raw camera space
    .applyMatrix4(hand.basis) // into the same standardized space boneA/boneB already live in
  if (hand.handedness === 'Right') knuckleAxis.negate() // mirrored chirality, same as palmAngleDeg

  const cross = new Vector3().crossVectors(boneA, boneB)
  const sign = cross.dot(knuckleAxis) < 0 ? -1 : 1
  return (sign * unsignedAngle * 180) / Math.PI
}

/** Create a joint by averaging together vectors.
 *
 * The joint's x axis will point in the average vector direction, and the z vector will point in the -z direction. */
export function averageNorms(v: Vector3[], length: number, matrix: Matrix4, degree: 0 | 1 | 2): Joint {
  const position = v
    .reduce((a, h) => a.addScaledVector(h, 1 / h.length()), new Vector3(0, 0, 0))
    .normalize().applyMatrix4(matrix)
  const x = position
  const z = new Vector3(0, 0, -1).addScaledVector(x, x.z).normalize()
  const y = new Vector3().crossVectors(z, x)

  const Vinv = new Matrix4().makeBasis(x, y, z)
  const V = new Matrix4().copy(Vinv).invert()
  return { length, position, V, Vinv, degree }
}

function decompose(v: Vector3) {
  return [v.x, v.y, v.z] as Vector3Tuple
}

function clamp(x: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, x))
}

/** Create a joint by averaging vectors then setting the z direction to be along one of the principal components.
 *
 * The principal component with the largest magnitude in the z direction is chosen.
 */
export function fitNorms(vecs: Vector3[], fit: boolean, length: number, matrix: Matrix4): Joint {
  const normvecs = vecs.map((v) => new Vector3().copy(v).normalize().applyMatrix4(matrix))
  const average = normvecs.reduce((a, h) => a.add(h), new Vector3(0, 0, 0)).normalize()

  const { v, q } = SVD(normvecs.map(decompose), false)
  // The basis elememts for the transformation, in world space
  let vVecs = [
    new Vector3(v[0][0], v[1][0], v[2][0]),
    new Vector3(v[0][1], v[1][1], v[2][1]),
    new Vector3(v[0][2], v[1][2], v[2][2]),
  ]
  const alignDown = vVecs.map((v) => Math.abs(v.z))
  const z = vVecs[alignDown.indexOf(Math.max(...alignDown))]

  const avgProject = new Vector3(average.x, 0, average.y).normalize()
  if (avgProject.x < 0) avgProject.negate()
  const x = avgProject.addScaledVector(z, -z.dot(avgProject)).normalize()
  const y = new Vector3().crossVectors(z, x)

  if (z.z < 0) {
    // z.z should be positive so the axes align
    z.negate()
    y.negate()
  }

  const Vinv = new Matrix4().makeBasis(x, y, z)
  const V = new Matrix4().copy(Vinv).invert()
  // q holds the singular values (not necessarily sorted) — the ratio of the top two expresses how
  // well a single dominant axis explains the observed motion (large ratio: one axis dominates, small/
  // near-1 ratio: the motion isn't well described by a single axis, whether from noise or genuine
  // multi-axis movement). Previously computed and discarded; see docs/thumbs/scan_utility_evaluation.md.
  const sortedQ = [...q].sort((a, b) => b - a)
  const axisConfidence = sortedQ[1] !== 0 ? sortedQ[0] / sortedQ[1] : Infinity
  return { length, V, Vinv, degree: fit ? 1 : 2, axisConfidence }
}

/** Find the interior angle of a cyclic quadrilateral (a quadrilateral whose vertices
 * lie on a cirle. This quadrilateral maximizes the area given the 4 side lengths.
 * a, b, c, and d are the side lengths. */
function cyclicQuadAngle(a: number, b: number, c: number, d: number) {
  return Math.acos((a * a - b * b - c * c + d * d) / (2 * a * d + 2 * b * c))
}

export function objectFromFingers<U>(f: (finger: Finger) => U) {
  return Object.fromEntries(FINGERS.map((l) => [l, f(l)])) as Record<Finger, U>
}

export class SolvedHand {
  private matrices: Record<Finger, Matrix4[]>

  constructor(private joints: Joints, public position: Matrix4) {
    this.matrices = objectFromFingers(() => LIMBS.map(() => new Matrix4()))
  }

  ik(finger: Finger, target: Vector3, scale = 100): Vector3[] | false {
    const joints = this.joints[finger]
    const worldToFirstLimb = new Matrix4()
      .makeTranslation(joints[0].length * scale, 0, 0)
      .premultiply(joints[0].Vinv)
      .premultiply(this.position)
      .invert()

    const targetFromFirstLimb = new Vector3().copy(target).applyMatrix4(worldToFirstLimb)
    const reach = targetFromFirstLimb.length() / scale
    const maxreach = joints[1].length + joints[2].length + joints[3].length
    if (reach > maxreach) return false // The target is out of reach

    const theta1 = cyclicQuadAngle(joints[1].length, joints[2].length, joints[3].length, reach)
    const theta2 = cyclicQuadAngle(joints[2].length, joints[3].length, reach, joints[1].length)
    const theta3 = cyclicQuadAngle(joints[3].length, reach, joints[1].length, joints[2].length)

    const x = new Vector3().copy(targetFromFirstLimb).normalize().applyMatrix4(joints[1].V)

    // The fingers cannot rotate about the X axis.
    // Therefore, treat the transformation as a YZ proper Euler angle.
    // Because the x axis of the new coordinate frame is given,
    // I can solve for the y and z angles. Then find the y and z axes.
    const zAngle = Math.asin(x.y)
    const yAngle = Math.asin(x.z / -Math.cos(zAngle))
    if (Math.abs(yAngle) > MAX_PAN(finger)) return false

    const z = new Vector3(Math.sin(yAngle), 0, Math.cos(yAngle))
    z.addScaledVector(x, -x.dot(z)).normalize()
    const y = new Vector3().crossVectors(z, x)

    const localToParent = new Matrix4().makeBasis(x, y, z)

    this.matrices[finger] = [
      new Matrix4(),
      new Matrix4().makeRotationAxis(Z_AXIS, theta1).premultiply(localToParent),
      new Matrix4().makeRotationAxis(Z_AXIS, -Math.PI + theta2),
      new Matrix4().makeRotationAxis(Z_AXIS, -Math.PI + theta3),
    ]
    return [
      new Vector3(),
      new Vector3(0, yAngle, zAngle + theta1),
      new Vector3(0, 0, -Math.PI + theta2),
      new Vector3(0, 0, -Math.PI + theta3),
    ]
  }

  fkBy(finger: Finger, fn: (i: number) => [number, number]) {
    this.matrices[finger].forEach((m, i) => {
      let [angleZ, angleY] = fn(i)
      const joint = this.joints[finger][i]
      const degree = joint.degree

      if (degree < 1) angleZ = 0
      if (degree < 2) angleY = 0

      // The thumb CMC's third rotation (twist) isn't independently driven -- it falls out of the
      // saddle joint's geometry as a function of the other two. See ConjunctCoupling's doc comment.
      const angleX = degree === 3 ? joint.conjunctCoupling.aCoeff * angleZ + joint.conjunctCoupling.bCoeff * angleY : 0

      m.makeRotationFromEuler(new Euler(angleX, angleY, angleZ, 'XYZ'))
    })
  }

  fromLimbs(finger: Finger, limbs: Vector3[], fit: boolean) {
    let reference = new Matrix4()

    this.matrices[finger].forEach((m, i) => {
      const joint = this.joints[finger][i]
      const refToLocal = new Matrix4().extractRotation(reference).invert().premultiply(joint.V)

      const x = new Vector3().copy(limbs[i]).applyMatrix4(refToLocal)
      if (fit) {
        if (joint.degree == 0) x.set(1, 0, 0)
        if (joint.degree <= 1) x.z = 0
      }
      x.normalize()
      const z = new Vector3(0, 0, 1).addScaledVector(x, -x.z).normalize()
      const y = new Vector3().crossVectors(z, x)

      if (joint.degree === 3) {
        // A direction vector only has two degrees of freedom -- it cannot reveal twist about its own
        // axis -- so the z/y just built are a deterministic but physically arbitrary function of x,
        // not the joint's true frame. Correct by recovering angleZ/angleY from x the same way
        // SolvedHand.ik() already does for exactly this (observed-x -> YZ-Euler) problem, then
        // rotating y/z about x by the conjunct-coupling-predicted twist, mirroring what fkBy() builds
        // this matrix from in the first place.
        const zAngle = Math.asin(clamp(x.y, -1, 1))
        const yAngle = Math.asin(clamp(x.z / -Math.cos(zAngle), -1, 1))
        const angleX = joint.conjunctCoupling.aCoeff * zAngle + joint.conjunctCoupling.bCoeff * yAngle
        y.applyAxisAngle(x, angleX)
        z.applyAxisAngle(x, angleX)
      }

      m.makeBasis(x, y, z)

      reference.multiply(joint.Vinv).multiply(m)
    })
  }

  fromAllLimbs(limbs: Record<Finger, Vector3[]>, fit: boolean) {
    for (const finger of FINGERS) {
      this.fromLimbs(finger, limbs[finger], fit)
    }
  }

  worldPositions(finger: Finger, scale = 100): Vector3[] {
    return this.matrices[finger]
      .reduce<Matrix4[]>(
        (acc, matrix, i) => {
          acc.push(
            new Matrix4()
              .makeTranslation(this.joints[finger][i].length * scale, 0, 0)
              .premultiply(matrix)
              .premultiply(this.joints[finger][i].Vinv)
              .premultiply(acc[acc.length - 1]),
          )
          return acc
        },
        [this.position],
      )
      .map((m) => new Vector3().setFromMatrixPosition(m))
  }

  worldAllPositions(scale = 100): Record<Finger, Vector3[]> {
    return objectFromFingers((finger) => this.worldPositions(finger, scale))
  }

  localTransforms(baseMatrix = new Matrix4(), scale = 100): Record<Finger, Matrix4[]> {
    const baseMatrixI = new Matrix4().copy(baseMatrix).invert()

    return objectFromFingers((finger) => {
      let parentTranslate = new Vector3(0, 0.5, 0)
      return this.matrices[finger].map((matrix, i) => {
        const mat = new Matrix4()
          .multiplyMatrices(baseMatrixI, this.joints[finger][i].Vinv)
          .multiply(matrix)
          .multiply(baseMatrix)
        mat.setPosition(parentTranslate)

        parentTranslate = new Vector3(this.joints[finger][i].length * scale, 0, 0).applyMatrix4(
          baseMatrixI,
        )
        return mat
      })
    })
  }

  /** Signed per-joint flexion angle (radians) for a finger's 4-joint chain: positive for ordinary
   * flexion, negative for hyperextension past straight -- some people's natural ROM genuinely
   * includes hyperextension, so this can't collapse both directions into the same magnitude the way
   * the previous `angleTo()`-based version did. Just the Z-component of each joint's already-signed
   * Euler decomposition (`decomposeAngles`), which is exactly the flexion angle `fkBy`/`fromLimbs`
   * build these matrices from in the first place. */
  deg1Angles(finger: Finger) {
    return this.decomposeAngles(finger).map((angles) => angles[2] as number)
  }

  /** Net curl across the 4 non-thumb fingers, in degrees. Signed per-joint contributions (see
   * deg1Angles) mean a hyperextended joint now partially cancels flexed joints elsewhere in the sum
   * rather than both reading as positive "curl" -- a more accurate net measure, but callers that
   * expect a non-negative progress value (e.g. a 0-1 UI gauge) need to clamp explicitly now, since a
   * hand starting from a hyperextended rest pose can legitimately read as slightly negative. */
  approximateCurl() {
    const nonThumbs = FINGERS.filter(f => f != 'thumb')
    const fingerCurls = nonThumbs.map(f => sum(this.deg1Angles(f)))
    const averageCurl = sum(fingerCurls) / nonThumbs.length
    return averageCurl * 180 / Math.PI
  }

  decomposeAngles(finger: Finger) {
    return this.matrices[finger].map((matrix) => {
      return new Euler().setFromRotationMatrix(matrix, 'ZYX').toArray()
    })
  }

  decomposeAllAngles() {
    return Object.fromEntries(FINGERS.map(f => [f, this.decomposeAngles(f)]))
  }
}

export function calculateJoints(history: Hand[], means: Record<string, number[]>): Joints {
  return Object.fromEntries(
    FINGERS.map((l) => {
      const deg1 = averageNorms(
        history.map((h) => h.limbs[l][0]),
        means[l][0],
        new Matrix4(),
        0,
      )
      const mat = deg1.V

      const rest = history.flatMap((h) => h.limbs[l].slice(1))

      const deg2 = fitNorms(rest, l === 'thumb', means[l][1], mat)
      mat.premultiply(deg2.V)
      const deg3 = fitNorms(rest, l !== 'thumb', means[l][2], mat)
      mat.premultiply(deg3.V)
      const deg4 = fitNorms(rest, true, means[l][3], mat)
      return [l, [deg1, deg2, deg3, deg4]]
    }),
  ) as Joints
}

/** Like calculatejoints, but used when there is no 3d data.
	This gives a hand that at least looks ok in 2d.
	*/
export function calculateJoints2D(history: Hand[], means: Record<string, number[]>): Joints {
  return Object.fromEntries(
    FINGERS.map((l) => {
      const deg1 = fitNorms(
        history.map((h) => h.limbs[l][0]),
        true,
        means[l][0],
        new Matrix4(),
      )
      const mat = deg1.V

      const rest = history.flatMap((h) => h.limbs[l].slice(1))

      const deg2 = fitNorms(rest, l === 'thumb', means[l][1], mat)
      mat.premultiply(deg2.V)
      const deg3 = fitNorms(rest, l !== 'thumb', means[l][2], mat)
      mat.premultiply(deg3.V)
      const deg4 = fitNorms(rest, true, means[l][3], mat)
      return [l, [deg1, deg2, deg3, deg4]]
    }),
  ) as Joints
}
