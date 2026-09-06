import type { Hand } from '$lib/hand'
import { describe, expect, test } from 'bun:test'
import { Matrix4, Vector3 } from 'three'
import { lookAtBasis, projectCorrectedOntoKeypoints } from './overlay'

function expectOrthonormal(basis: { right: Vector3; up: Vector3; forward: Vector3 }) {
  expect(basis.right.length()).toBeCloseTo(1, 6)
  expect(basis.up.length()).toBeCloseTo(1, 6)
  expect(basis.forward.length()).toBeCloseTo(1, 6)
  expect(basis.right.dot(basis.up)).toBeCloseTo(0, 6)
  expect(basis.right.dot(basis.forward)).toBeCloseTo(0, 6)
  expect(basis.up.dot(basis.forward)).toBeCloseTo(0, 6)
}

describe('lookAtBasis', () => {
  test('always returns an orthonormal basis', () => {
    const dirs = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(1, 1, 1), new Vector3(0, -1, 0)]
    for (const d of dirs) expectOrthonormal(lookAtBasis(d))
  })

  test("up equals the hint exactly when forward is perpendicular to it -- multi-view's core claim for its Front/Top/Right/Rear/Bottom/Left views", () => {
    const hint = new Vector3(0.3, 0.7, -0.2).normalize()
    // Any forward perpendicular to hint (verified via a vector explicitly built that way).
    const arbitrary = new Vector3(1, 0.5, -0.3)
    const forward = arbitrary.clone().sub(hint.clone().multiplyScalar(arbitrary.dot(hint))).normalize()
    expect(forward.dot(hint)).toBeCloseTo(0, 6)

    const basis = lookAtBasis(forward, hint)
    expect(basis.up.x).toBeCloseTo(hint.x, 6)
    expect(basis.up.y).toBeCloseTo(hint.y, 6)
    expect(basis.up.z).toBeCloseTo(hint.z, 6)
  })

  test('falls back to the secondary hint when forward is parallel to the primary one', () => {
    const hint = new Vector3(0, 1, 0)
    const fallback = new Vector3(0, 0, 1)
    const basis = lookAtBasis(new Vector3(0, 1, 0), hint, fallback)
    expectOrthonormal(basis)
    // With forward === hint, the primary hint can't be used (right = cross(hint, forward) = 0) --
    // confirm the fallback actually got used, not a degenerate zero-length basis.
    expect(basis.right.length()).toBeCloseTo(1, 6)
  })
})

function fakeHand(opts: {
  keypoints: { x: number; y: number }[]
  vectors: Vector3[]
  basis: Matrix4
}): Hand {
  return {
    handedness: 'Right',
    score: 1,
    hand: { keypoints: opts.keypoints, keypoints3D: [], handedness: 'Right', score: 1 } as unknown as Hand['hand'],
    vectors: opts.vectors,
    limbs: {},
    basis: opts.basis,
  }
}

describe('projectCorrectedOntoKeypoints', () => {
  const canvasSize = 100
  // Normalized keypoints: wrist at image center, landmark 9 (middle MCP) 0.2 to the right -- 20px at
  // this canvas size, along +x only, so the round-trip below isn't ambiguous about which axis moved.
  const keypoints = Object.assign(new Array(21).fill({ x: 0, y: 0 }), { 0: { x: 0.5, y: 0.5 }, 9: { x: 0.7, y: 0.5 } })
  // The real tracked bone (wrist -> middle MCP) this normalized-keypoint distance is calibrated
  // against: 2 world units, matching the same +x-only direction as the keypoints above.
  const vectors = Object.assign(new Array(21).fill(new Vector3()), { 0: new Vector3(0, 0, 0), 9: new Vector3(2, 0, 0) })

  test('landmark 0 always anchors exactly to the real tracked wrist position', () => {
    const hand = fakeHand({ keypoints, vectors, basis: new Matrix4() })
    // The corrected model's own shape is irrelevant to where landmark 0 lands -- it's always the
    // subtraction pivot, so it always maps back to keypoints[0] exactly, however the rest is shaped.
    const corrected = Object.assign(new Array(21).fill(new Vector3()), { 0: new Vector3(5, -3, 1) })
    const result = projectCorrectedOntoKeypoints(hand, corrected, canvasSize, canvasSize)
    expect(result[0].x).toBeCloseTo(0.5, 6)
    expect(result[0].y).toBeCloseTo(0.5, 6)
  })

  test('an identity basis and a corrected shape matching the raw one round-trips back to the same keypoint', () => {
    const hand = fakeHand({ keypoints, vectors, basis: new Matrix4() })
    // correctedVectors mimicking hand.limbs' own orientation exactly (identity basis, so that's just
    // hand.vectors unchanged) should reproduce the same normalized keypoint it was calibrated against.
    const result = projectCorrectedOntoKeypoints(hand, vectors, canvasSize, canvasSize)
    expect(result[9].x).toBeCloseTo(0.7, 6)
    expect(result[9].y).toBeCloseTo(0.5, 6)
  })

  test('a non-identity basis is undone before projecting -- the corrected shape is expressed in the basis-rotated frame, not raw camera space', () => {
    // basis rotates the raw +x bone direction onto +y (a 90deg turn about Z) -- hand.limbs would be
    // `rawBone.applyMatrix4(basis)`, so a correctedVectors shape meant to mimic that raw (2,0,0) bone
    // must itself be expressed as (0,2,0) here, in the basis-rotated frame.
    const basis = new Matrix4().makeRotationZ(Math.PI / 2)
    const hand = fakeHand({ keypoints, vectors, basis })
    const corrected = Object.assign(new Array(21).fill(new Vector3()), { 0: new Vector3(0, 0, 0), 9: new Vector3(0, 2, 0) })
    const result = projectCorrectedOntoKeypoints(hand, corrected, canvasSize, canvasSize)
    // Undoing the basis rotation recovers the raw (+x) direction, landing back on the same keypoint
    // the raw +x-direction bone was calibrated against -- not wherever the un-rotated (0,2,0) shape
    // would naively project to.
    expect(result[9].x).toBeCloseTo(0.7, 6)
    expect(result[9].y).toBeCloseTo(0.5, 6)
  })

  test('correctedVectors in a wildly different absolute unit than hand.vectors still projects correctly -- regression for the 100,000x-off-screen bug', () => {
    // hand.vectors mimics MediaPipe's real *world* landmarks (meters, ~0.08 hand length); correctedVectors
    // mimics SolvedHand.worldPositions()'s own default scale=100 CAD-style units on top of millimeters --
    // a ~100,000x difference in absolute magnitude for physically the same bone.
    const meterScaleVectors = Object.assign(new Array(21).fill(new Vector3()), {
      0: new Vector3(0, 0, 0),
      9: new Vector3(0.08, 0, 0),
    })
    const hand = fakeHand({ keypoints, vectors: meterScaleVectors, basis: new Matrix4() })
    const millimeterCadScaleCorrected = Object.assign(new Array(21).fill(new Vector3()), {
      0: new Vector3(0, 0, 0),
      9: new Vector3(8000, 0, 0),
    })
    const result = projectCorrectedOntoKeypoints(hand, millimeterCadScaleCorrected, canvasSize, canvasSize)
    // Must still land on the calibrated keypoint -- scaling is derived from correctedVectors' own
    // reference bone, never hand.vectors', so the absolute-unit mismatch is irrelevant.
    expect(result[9].x).toBeCloseTo(0.7, 6)
    expect(result[9].y).toBeCloseTo(0.5, 6)
  })
})
