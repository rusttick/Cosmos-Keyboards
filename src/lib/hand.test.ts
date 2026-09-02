import { describe, expect, test } from 'bun:test'
import { Matrix4, Vector3 } from 'three'
import { type ConjunctCoupling, type Finger, type Hand, type Joint, type Joints, objectFromFingers, signedJointAngle, SolvedHand } from './hand'

function makeJoint(degree: 0 | 1 | 2): Joint {
  if (degree === 0) {
    return { length: 1, degree: 0, position: new Vector3(1, 0, 0), V: new Matrix4(), Vinv: new Matrix4() }
  }
  return { length: 1, degree, V: new Matrix4(), Vinv: new Matrix4() }
}

// A finger's 4-joint chain: fixed metacarpal, then a degree-2 MCP and two degree-1 joints (PIP, DIP),
// matching hand.ts's own DOF model (see the module doc comment at the top of hand.ts).
const joints: Joints = objectFromFingers(() => [makeJoint(0), makeJoint(2), makeJoint(1), makeJoint(1)])

describe('SolvedHand.deg1Angles', () => {
  test('recovers the signed angleZ fkBy was built from, including negative (hyperextension) values', () => {
    const solved = new SolvedHand(joints, new Matrix4())
    const testAngleZ = [0.9, 0.5, -0.3, 0.2] // index 0 is degree 0 -- fkBy forces it to 0 regardless
    solved.fkBy('indexFinger', (i) => [testAngleZ[i], 0])

    const result = solved.deg1Angles('indexFinger')
    expect(result[0]).toBeCloseTo(0, 5)
    expect(result[1]).toBeCloseTo(0.5, 5)
    // Negative -- a hyperextended joint. Before this fix, deg1Angles used an unsigned angleTo() and
    // this would have come back as +0.3, indistinguishable from ordinary flexion.
    expect(result[2]).toBeCloseTo(-0.3, 5)
    expect(result[3]).toBeCloseTo(0.2, 5)
  })
})

describe('SolvedHand.approximateCurl', () => {
  test('a hyperextended joint partially cancels flexed joints instead of adding to their magnitude', () => {
    const flexedOnly = new SolvedHand(joints, new Matrix4())
    flexedOnly.fkBy('indexFinger', () => [0.3, 0])
    for (const f of ['middleFinger', 'ringFinger', 'pinky'] as const) {
      flexedOnly.fkBy(f, () => [0.3, 0])
    }

    const oneHyperextended = new SolvedHand(joints, new Matrix4())
    oneHyperextended.fkBy('indexFinger', () => [-0.3, 0]) // hyperextended instead of flexed
    for (const f of ['middleFinger', 'ringFinger', 'pinky'] as const) {
      oneHyperextended.fkBy(f, () => [0.3, 0])
    }

    expect(oneHyperextended.approximateCurl()).toBeLessThan(flexedOnly.approximateCurl())
  })
})

function makeThumbCmcJoint(conjunctCoupling: ConjunctCoupling): Joint {
  return { length: 1, degree: 3, V: new Matrix4(), Vinv: new Matrix4(), conjunctCoupling }
}

/** Extracts the pure-rotation part of joint `jointIndex`'s matrix for `finger`, as built by the most
 * recent fkBy()/fromLimbs() call -- avoids decomposeAngles() here deliberately: it decomposes via a
 * 'ZYX' Euler order, but fkBy() composes via 'XYZ', and those two only invert each other when at most
 * one axis is nonzero at a time. In real app usage decomposeAngles is only ever paired with
 * fromLimbs()-built matrices (see PoseResults.svelte), which aren't built via Euler composition in the
 * first place, so that mismatch never surfaces there -- but it would corrupt a test that round-trips
 * through fkBy(). Comparing the raw rotation matrix directly sidesteps the issue entirely. */
function jointRotation(solved: SolvedHand, finger: Finger, jointIndex: number): Matrix4 {
  return new Matrix4().extractRotation(solved.localTransforms()[finger][jointIndex])
}

describe('SolvedHand.fkBy — thumb CMC (degree 3)', () => {
  test('builds the conjunct twist as an additional rotation about the driven-angle axis', () => {
    const angleZ = 0.3 // flexion
    const angleY = 0.15 // abduction
    const aCoeff = 0.4
    const bCoeff = -0.2

    const uncoupled = new SolvedHand(joints, new Matrix4()) // ordinary degree-2 MCP, no twist concept
    uncoupled.fkBy('indexFinger', (i) => (i === 1 ? [angleZ, angleY] : [0, 0]))
    const uncoupledRotation = jointRotation(uncoupled, 'indexFinger', 1)

    const thumbJoints: Joint[] = [makeThumbCmcJoint({ aCoeff, bCoeff, r2: 1 }), makeJoint(1), makeJoint(1), makeJoint(1)]
    const coupled = new SolvedHand({ ...joints, thumb: thumbJoints }, new Matrix4())
    coupled.fkBy('thumb', (i) => (i === 0 ? [angleZ, angleY] : [0, 0]))
    const coupledRotation = jointRotation(coupled, 'thumb', 0)

    const expectedTwist = aCoeff * angleZ + bCoeff * angleY
    expect(Math.abs(expectedTwist)).toBeGreaterThan(0.01) // sanity: not a degenerate test case

    // fkBy builds Euler(angleX, angleY, angleZ, 'XYZ') -- with angleX forced to 0 for any non-degree-3
    // joint, "uncoupled" above is exactly what "coupled" would be with expectedTwist forced to 0.
    // Applying that same twist as an X-axis rotation on top should land on the coupled result.
    const probe = new Vector3(0.2, 0.6, -0.4).normalize()
    const uncoupledThenTwisted = probe.clone().applyMatrix4(uncoupledRotation).applyAxisAngle(new Vector3(1, 0, 0), expectedTwist)
    const coupledResult = probe.clone().applyMatrix4(coupledRotation)
    expect(coupledResult.x).toBeCloseTo(uncoupledThenTwisted.x, 4)
    expect(coupledResult.y).toBeCloseTo(uncoupledThenTwisted.y, 4)
    expect(coupledResult.z).toBeCloseTo(uncoupledThenTwisted.z, 4)
  })

  test('zero conjunct coupling produces exactly the ordinary (untwisted) rotation', () => {
    const angleZ = 0.3
    const angleY = 0.15

    const uncoupled = new SolvedHand(joints, new Matrix4())
    uncoupled.fkBy('indexFinger', (i) => (i === 1 ? [angleZ, angleY] : [0, 0]))
    const uncoupledRotation = jointRotation(uncoupled, 'indexFinger', 1)

    const thumbJoints: Joint[] = [makeThumbCmcJoint({ aCoeff: 0, bCoeff: 0, r2: 0 }), makeJoint(1), makeJoint(1), makeJoint(1)]
    const zeroCoupled = new SolvedHand({ ...joints, thumb: thumbJoints }, new Matrix4())
    zeroCoupled.fkBy('thumb', (i) => (i === 0 ? [angleZ, angleY] : [0, 0]))
    const zeroCoupledRotation = jointRotation(zeroCoupled, 'thumb', 0)

    const probe = new Vector3(0.2, 0.6, -0.4).normalize()
    const a = probe.clone().applyMatrix4(uncoupledRotation)
    const b = probe.clone().applyMatrix4(zeroCoupledRotation)
    expect(b.x).toBeCloseTo(a.x, 5)
    expect(b.y).toBeCloseTo(a.y, 5)
    expect(b.z).toBeCloseTo(a.z, 5)
  })
})

describe('SolvedHand.fromLimbs — thumb CMC (degree 3)', () => {
  test('twist rotates y/z about the observed bone direction by the conjunct-coupling-predicted angle', () => {
    const zAngle = 0.3
    const yAngle = 0.15
    // Unit vector whose Y/Z components encode [zAngle, yAngle] via the same asin-based recovery
    // fromLimbs's degree-3 branch uses -- see flexionAbduction() in phases/thumbCmc.ts for the
    // matching forward direction.
    const bone0 = new Vector3(
      Math.cos(zAngle) * Math.cos(yAngle),
      Math.sin(zAngle),
      -Math.cos(zAngle) * Math.sin(yAngle),
    )
    const otherLimbs = [new Vector3(0, 0, 1), new Vector3(0, 0, 1), new Vector3(0, 0, 1)]

    const uncoupledJoints: Joint[] = [makeJoint(1), makeJoint(1), makeJoint(1), makeJoint(1)]
    const uncoupled = new SolvedHand({ ...joints, thumb: uncoupledJoints }, new Matrix4())
    uncoupled.fromLimbs('thumb', [bone0, ...otherLimbs], false)
    const uncoupledRotation = jointRotation(uncoupled, 'thumb', 0)

    const aCoeff = 0.4
    const bCoeff = -0.2
    const coupledJoints: Joint[] = [makeThumbCmcJoint({ aCoeff, bCoeff, r2: 1 }), makeJoint(1), makeJoint(1), makeJoint(1)]
    const coupled = new SolvedHand({ ...joints, thumb: coupledJoints }, new Matrix4())
    coupled.fromLimbs('thumb', [bone0, ...otherLimbs], false)
    const coupledRotation = jointRotation(coupled, 'thumb', 0)

    const expectedTwist = aCoeff * zAngle + bCoeff * yAngle
    expect(Math.abs(expectedTwist)).toBeGreaterThan(0.01)

    const probe = new Vector3(0, 1, 0)
    const rotatedUncoupled = probe.clone().applyMatrix4(uncoupledRotation).applyAxisAngle(bone0.clone().normalize(), expectedTwist)
    const coupledResult = probe.clone().applyMatrix4(coupledRotation)
    expect(coupledResult.x).toBeCloseTo(rotatedUncoupled.x, 4)
    expect(coupledResult.y).toBeCloseTo(rotatedUncoupled.y, 4)
    expect(coupledResult.z).toBeCloseTo(rotatedUncoupled.z, 4)

    // Zero coupling should exactly match the ordinary generic-path (untwisted) result.
    const zeroCoupledJoints: Joint[] = [
      makeThumbCmcJoint({ aCoeff: 0, bCoeff: 0, r2: 0 }),
      makeJoint(1),
      makeJoint(1),
      makeJoint(1),
    ]
    const zeroCoupled = new SolvedHand({ ...joints, thumb: zeroCoupledJoints }, new Matrix4())
    zeroCoupled.fromLimbs('thumb', [bone0, ...otherLimbs], false)
    const zeroCoupledRotation = jointRotation(zeroCoupled, 'thumb', 0)
    const zeroCoupledResult = probe.clone().applyMatrix4(zeroCoupledRotation)
    const uncoupledResult = probe.clone().applyMatrix4(uncoupledRotation)
    expect(zeroCoupledResult.x).toBeCloseTo(uncoupledResult.x, 5)
    expect(zeroCoupledResult.y).toBeCloseTo(uncoupledResult.y, 5)
    expect(zeroCoupledResult.z).toBeCloseTo(uncoupledResult.z, 5)
  })
})

/** A minimal synthetic Hand: identity basis, indexMcp/pinkyMcp placed so the knuckle axis is a known
 * unit vector, and boneB built by rotating boneA about that same axis by a known signed angle -- so
 * the recovered sign/magnitude can be checked against ground truth without needing a real capture
 * (the sign *convention* itself -- which physical direction reads positive -- is a best-guess per
 * signedJointAngle's own doc comment and isn't what this file is verifying). */
function syntheticHand(thetaRad: number, handedness: 'Left' | 'Right' = 'Left'): Hand {
  const vectors = new Array(21).fill(0).map(() => new Vector3())
  vectors[5] = new Vector3(1, 0, 0) // index MCP
  vectors[17] = new Vector3(-1, 0, 0) // pinky MCP -- knuckle axis (pinky - index) = (-2,0,0)

  const boneA = new Vector3(0, 1, 0)
  const axis = new Vector3(-1, 0, 0) // unit vector along the knuckle axis direction above
  const boneB = boneA.clone().applyAxisAngle(axis, thetaRad)

  return {
    handedness,
    score: 1,
    hand: undefined as any,
    vectors,
    limbs: { indexFinger: [new Vector3(), boneA, boneB, new Vector3()] },
    basis: new Matrix4(), // identity
  }
}

describe('signedJointAngle', () => {
  test('a zero bend reads as ~0 degrees', () => {
    expect(signedJointAngle(syntheticHand(0), 'indexFinger', 1)).toBeCloseTo(0, 5)
  })

  test('opposite-signed bends produce opposite-signed results of the same magnitude', () => {
    const thetaDeg = 35
    const positive = signedJointAngle(syntheticHand((thetaDeg * Math.PI) / 180), 'indexFinger', 1)
    const negative = signedJointAngle(syntheticHand((-thetaDeg * Math.PI) / 180), 'indexFinger', 1)

    expect(positive).toBeCloseTo(thetaDeg, 3)
    expect(negative).toBeCloseTo(-thetaDeg, 3)
    // Both directions produce the same magnitude -- neither is silently clamped to [0, 180] the way
    // Vector3.angleTo() alone would (that would make `negative` read as +35 too).
    expect(Math.abs(positive)).toBeCloseTo(Math.abs(negative), 5)
  })

  test('handedness mirrors the sign for otherwise-identical geometry', () => {
    const thetaRad = (20 * Math.PI) / 180
    const left = signedJointAngle(syntheticHand(thetaRad, 'Left'), 'indexFinger', 1)
    const right = signedJointAngle(syntheticHand(thetaRad, 'Right'), 'indexFinger', 1)
    expect(Math.sign(left)).toBe(-Math.sign(right))
    expect(Math.abs(left)).toBeCloseTo(Math.abs(right), 5)
  })
})
