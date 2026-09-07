import type { Finger, Hand, Joints } from '$lib/hand'
import { CONNECTIONS, FINGERS, SolvedHand } from '$lib/hand'
import { describe, expect, test } from 'bun:test'
import { Matrix4 } from 'three'
import { HAND_PRIOR_SEED } from './handModelData'
import { buildDefaultSkeleton, buildRestExtensionPose, buildRestExtensionSkeleton, type Pose, poseConfidenceSdDeg, poseToLandmarkVectors, solvePose } from './ikSolve'

/** Builds a synthetic tracked frame from a known pose, by running it through this project's own
 * forward kinematics -- the round-trip this file's solver is meant to be checked against. */
function frameFromPose(skeleton: Joints, pose: Pose): Hand {
  const solved = new SolvedHand(skeleton, new Matrix4())
  for (const finger of FINGERS) {
    solved.fkBy(finger, i => [pose[finger][i].angleZ, pose[finger][i].angleY])
  }
  const limbs = Object.fromEntries(
    FINGERS.map(finger => {
      const positions = solved.worldPositions(finger)
      const bones = positions.slice(1).map((p, i) => p.clone().sub(positions[i]))
      return [finger, bones]
    }),
  ) as Record<Finger, ReturnType<typeof solved.worldPositions>>
  return { handedness: 'Right', score: 1, hand: {} as Hand['hand'], vectors: [], limbs, basis: new Matrix4() }
}

function emptyPose(): Pose {
  return Object.fromEntries(FINGERS.map(f => [f, [0, 1, 2, 3].map(() => ({ angleZ: 0, angleY: 0 }))])) as Pose
}

const skeleton = buildDefaultSkeleton(HAND_PRIOR_SEED)
const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI

describe('solvePose', () => {
  test("recovers a clean pose close to each joint's own prior mean", () => {
    const pose = emptyPose()
    pose.indexFinger[1] = { angleZ: HAND_PRIOR_SEED.mcpAxes.indexFinger.flexExtRom.meanDeg * DEG2RAD, angleY: 0 }
    pose.indexFinger[2] = { angleZ: HAND_PRIOR_SEED.pipDipRom.pip.indexFinger.meanDeg * DEG2RAD, angleY: 0 }
    pose.indexFinger[3] = { angleZ: HAND_PRIOR_SEED.pipDipRom.dip.indexFinger.meanDeg * DEG2RAD, angleY: 0 }

    const hand = frameFromPose(skeleton, pose)
    const result = solvePose(skeleton, HAND_PRIOR_SEED, hand)

    expect(result.pose.indexFinger[1].angleZ * 180 / Math.PI).toBeCloseTo(HAND_PRIOR_SEED.mcpAxes.indexFinger.flexExtRom.meanDeg, 0)
    expect(result.pose.indexFinger[2].angleZ * 180 / Math.PI).toBeCloseTo(HAND_PRIOR_SEED.pipDipRom.pip.indexFinger.meanDeg, 0)
  })

  test('a confident prior pulls a wildly corrupted joint back toward the prior mean, not the corrupted reading', () => {
    const pose = emptyPose()
    const meanDeg = HAND_PRIOR_SEED.pipDipRom.pip.indexFinger.meanDeg
    pose.indexFinger[2] = { angleZ: meanDeg * DEG2RAD, angleY: 0 }
    const hand = frameFromPose(skeleton, pose)

    // Corrupt the tracked PIP bone direction after the fact -- simulating a bad frame, not a bad pose.
    // `limbs[finger][i]` is the bone whose direction determines joint `i`'s own recovered angle, so
    // corrupting the PIP joint (index 2) means corrupting limb index 2.
    hand.limbs.indexFinger[2] = hand.limbs.indexFinger[2].clone().applyAxisAngle({ x: 0, y: 0, z: 1 } as any, 90 * DEG2RAD)

    const confidentPrior = structuredClone(HAND_PRIOR_SEED)
    confidentPrior.pipDipRom.pip.indexFinger = { ...confidentPrior.pipDipRom.pip.indexFinger, sdDeg: 0.5 }

    const result = solvePose(skeleton, confidentPrior, hand)
    const solvedDeg = result.pose.indexFinger[2].angleZ * 180 / Math.PI
    expect(Math.abs(solvedDeg - meanDeg)).toBeLessThan(10)
  })

  test('regularization strength scales with confidence: the same corrupted reading moves less under a tighter prior', () => {
    const pose = emptyPose()
    const meanDeg = HAND_PRIOR_SEED.pipDipRom.dip.ringFinger.meanDeg
    pose.ringFinger[3] = { angleZ: meanDeg * DEG2RAD, angleY: 0 }
    const hand = frameFromPose(skeleton, pose)
    // DIP is joint index 3, so its own tracked reading comes from limb index 3.
    hand.limbs.ringFinger[3] = hand.limbs.ringFinger[3].clone().applyAxisAngle({ x: 0, y: 0, z: 1 } as any, 60 * DEG2RAD)

    const tight = structuredClone(HAND_PRIOR_SEED)
    tight.pipDipRom.dip.ringFinger = { ...tight.pipDipRom.dip.ringFinger, sdDeg: 1 }
    const wide = structuredClone(HAND_PRIOR_SEED)
    wide.pipDipRom.dip.ringFinger = { ...wide.pipDipRom.dip.ringFinger, sdDeg: 40 }

    const tightResult = solvePose(skeleton, tight, hand).pose.ringFinger[3].angleZ
    const wideResult = solvePose(skeleton, wide, hand).pose.ringFinger[3].angleZ

    expect(Math.abs(tightResult - meanDeg * DEG2RAD)).toBeLessThan(Math.abs(wideResult - meanDeg * DEG2RAD))
  })

  test('a confident DIP/PIP coupling pulls a corrupted DIP reading toward what PIP predicts', () => {
    const pose = emptyPose()
    const pipDeg = 40
    pose.middleFinger[2] = { angleZ: pipDeg * DEG2RAD, angleY: 0 }
    pose.middleFinger[3] = { angleZ: pipDeg * DEG2RAD, angleY: 0 } // slope 1, intercept 0 -- matches this project's own seed
    const hand = frameFromPose(skeleton, pose)
    // Corrupt DIP's own tracked reading (limb index 3), leaving PIP's (limb index 2) clean, so the
    // pull toward PIP's prediction is the only thing that can be fixing this.
    hand.limbs.middleFinger[3] = hand.limbs.middleFinger[3].clone().applyAxisAngle({ x: 0, y: 0, z: 1 } as any, 40 * DEG2RAD)

    const confidentCoupling = structuredClone(HAND_PRIOR_SEED)
    confidentCoupling.dipPipCoupling.middleFinger = { mean: [1, 0], covariance: [[0.00001, 0], [0, 0.005]], source: 'test' }
    // Make both joints' own range-of-motion priors effectively weightless here, so the coupling term
    // is the only thing pulling DIP back into line -- not a competing pull on either joint toward some
    // unrelated ROM mean (PIP's own ROM mean isn't 40 degrees either, so without this, PIP itself
    // would drift away from the clean value DIP is supposed to be pulled toward).
    confidentCoupling.pipDipRom.dip.middleFinger = { ...confidentCoupling.pipDipRom.dip.middleFinger, sdDeg: 1000 }
    confidentCoupling.pipDipRom.pip.middleFinger = { ...confidentCoupling.pipDipRom.pip.middleFinger, sdDeg: 1000 }

    const result = solvePose(skeleton, confidentCoupling, hand)
    const solvedDeg = result.pose.middleFinger[3].angleZ * 180 / Math.PI
    expect(Math.abs(solvedDeg - pipDeg)).toBeLessThan(10)
  })

  test('residual is near zero when every joint already matches its own prior mean', () => {
    // A single untouched joint defaults to 0, which usually isn't that joint's prior mean -- so this
    // sets every joint that has a modeled prior to it, rather than leaving the rest at a mismatched
    // default and mistaking that mismatch for "corruption." DIP is set from the coupling prediction,
    // not from Group B's own (currently uncorrelated, roughly-guessed) DIP mean, and its own ROM prior
    // is replaced here with the coupling-implied value, and the enslaving term is zeroed out, so
    // nothing pulls against the single value each joint is being set to -- this test checks the
    // solver adds no residual of its own, not that this project's seed data is internally
    // self-consistent yet (it isn't -- see handModelData.ts's own notes on Groups B and E).
    const prior = structuredClone(HAND_PRIOR_SEED)
    const nonThumbFingers = FINGERS.filter((f): f is Exclude<Finger, 'thumb'> => f !== 'thumb')
    for (const f of nonThumbFingers) {
      const [slope, intercept] = prior.dipPipCoupling[f].mean
      prior.pipDipRom.dip[f] = { ...prior.pipDipRom.dip[f], meanDeg: slope * prior.pipDipRom.pip[f].meanDeg + intercept }
    }
    prior.enslaving.coefficients.covariance = prior.enslaving.coefficients.covariance.map(row => row.map(() => 0))
    // The thumb CMC's side-to-side angle doesn't round-trip exactly through this project's own
    // fkBy/decomposeAngles pair once a nonzero conjunct twist is involved (a pre-existing property of
    // that pair's Euler-order convention, not something this file changes) -- loosen its prior here so
    // that harmless several-degree discrepancy doesn't register as a residual this test cares about.
    prior.cmcMobility.thumb.abAdRom = { ...prior.cmcMobility.thumb.abAdRom, sdDeg: 1000 }

    const pose = emptyPose()
    for (const f of nonThumbFingers) {
      const pipDeg = prior.pipDipRom.pip[f].meanDeg
      const [slope, intercept] = prior.dipPipCoupling[f].mean
      pose[f][1] = { angleZ: prior.mcpAxes[f].flexExtRom.meanDeg * DEG2RAD, angleY: 0 }
      pose[f][2] = { angleZ: pipDeg * DEG2RAD, angleY: 0 }
      pose[f][3] = { angleZ: (slope * pipDeg + intercept) * DEG2RAD, angleY: 0 }
    }
    // Ring and pinky each have their own base-of-hand flexion belief too, on top of the shared MCP/
    // PIP/DIP setup above.
    pose.ringFinger[0] = { angleZ: prior.cmcMobility.ring.flexionRom.meanDeg * DEG2RAD, angleY: 0 }
    pose.pinky[0] = { angleZ: prior.cmcMobility.pinky.flexionRom.meanDeg * DEG2RAD, angleY: 0 }
    pose.thumb[1] = {
      angleZ: prior.cmcMobility.thumb.flexExtRom.meanDeg * DEG2RAD,
      angleY: prior.cmcMobility.thumb.abAdRom.meanDeg * DEG2RAD,
    }

    const hand = frameFromPose(skeleton, pose)
    const result = solvePose(skeleton, prior, hand)
    expect(result.residual).toBeLessThan(0.05)
  })

  test('an MCP flexed to exactly the gimbal-lock angle (90deg) does not recover a phantom ab/ad angle', () => {
    // Regression: buildDefaultSkeleton's joint-0 splay (added 2026-09-06) perturbs the tracked bone
    // direction's z-component away from the exact 0 that used to mask this -- at angleZ=90deg exactly,
    // trackedPose's angleY formula divides by cos(90deg)=~0, turning that tiny perturbation into a
    // large spurious angleY. A flexion a hair off 90deg doesn't hit the singularity and stays clean.
    const pose = emptyPose()
    pose.ringFinger[0] = { angleZ: 20 * DEG2RAD, angleY: 0 }
    pose.ringFinger[1] = { angleZ: 90 * DEG2RAD, angleY: 0 }
    const hand = frameFromPose(skeleton, pose)
    const result = solvePose(skeleton, HAND_PRIOR_SEED, hand)
    expect(Math.abs(result.pose.ringFinger[1].angleY * RAD2DEG)).toBeLessThan(1)
  })

  test("ring and pinky's own base-of-hand flexion is a real, fittable DOF, distinct from a fixed metacarpal", () => {
    const pose = emptyPose()
    const flexionDeg = 20
    pose.ringFinger[0] = { angleZ: flexionDeg * DEG2RAD, angleY: 0 }
    const hand = frameFromPose(skeleton, pose)

    const result = solvePose(skeleton, HAND_PRIOR_SEED, hand)
    // Not an exact match (the prior mean isn't exactly 20deg, so there's some legitimate shrinkage),
    // but nowhere near 0 either -- confirming this joint's own tracked reading actually reaches the
    // solved pose, unlike index/middle's rigid base segment (which has no free angle here at all).
    expect(result.pose.ringFinger[0].angleZ * RAD2DEG).toBeGreaterThan(10)
    expect(result.pose.indexFinger[0].angleZ).toBe(0) // still rigid -- no prior, no free angle
  })

  test('a confidently flexed set of fingers pulls the wrist toward the tenodesis-implied posture, even with no direct wrist observation', () => {
    const pose = emptyPose()
    const flexionDeg = 60
    for (const f of ['indexFinger', 'middleFinger', 'ringFinger', 'pinky'] as const) {
      pose[f][1] = { angleZ: flexionDeg * DEG2RAD, angleY: 0 }
      pose[f][2] = { angleZ: flexionDeg * DEG2RAD, angleY: 0 }
      pose[f][3] = { angleZ: flexionDeg * DEG2RAD, angleY: 0 }
    }
    const hand = frameFromPose(skeleton, pose)

    const prior = structuredClone(HAND_PRIOR_SEED)
    prior.wristForearm.tenodesisCoupling = { mean: 0.5, variance: 0.0001, source: 'test' }
    // Loosen the wrist's own ROM prior so the tenodesis pull is what's actually moving it, not a
    // coincidental overlap with its unrelated population-mean posture (which defaults to 0).
    prior.wristForearm.wristFlexExtRom = { ...prior.wristForearm.wristFlexExtRom, sdDeg: 1000 }

    const withoutTenodesis = structuredClone(prior)
    withoutTenodesis.wristForearm.tenodesisCoupling = { mean: 0, variance: 0.0001, source: 'test' }

    const result = solvePose(skeleton, prior, hand)
    const baseline = solvePose(skeleton, withoutTenodesis, hand)

    // With no direct or composed observation of the wrist at all, the only thing that can move it off
    // its neutral starting point is this cross-group correlation -- confirming Group G isn't frozen at
    // the population prior just because it has no tracked channel of its own.
    expect(Math.abs(result.wristForearm.wristFlexExt)).toBeGreaterThan(Math.abs(baseline.wristForearm.wristFlexExt))
    expect(baseline.wristForearm.wristFlexExt).toBe(0)
  })

  test("an excluded finger's corrupted tracked reading never enters the objective, however wide its own prior", () => {
    // Starting pose and corruption angle are fixed literals, deliberately NOT read from
    // HAND_PRIOR_SEED (its meanDeg values are tuned constants that can legitimately change for
    // unrelated reasons -- this test's own corruption-detection logic shouldn't be coupled to them).
    const pose = emptyPose()
    const meanDeg = HAND_PRIOR_SEED.pipDipRom.pip.middleFinger.meanDeg
    pose.middleFinger[2] = { angleZ: 0, angleY: 0 }
    const hand = frameFromPose(skeleton, pose)
    hand.limbs.middleFinger[2] = hand.limbs.middleFinger[2].clone().applyAxisAngle({ x: 0, y: 0, z: 1 } as any, 90 * DEG2RAD)

    // Wide enough that, absent exclusion, this prior barely resists the corrupted reading at all.
    const wide = structuredClone(HAND_PRIOR_SEED)
    wide.pipDipRom.pip.middleFinger = { ...wide.pipDipRom.pip.middleFinger, sdDeg: 1000 }

    const notExcluded = solvePose(skeleton, wide, hand)
    const excludedResult = solvePose(skeleton, wide, hand, new Set(['middleFinger']))

    // Without exclusion, the wide prior lets the corrupted reading through nearly unchanged.
    expect(Math.abs(notExcluded.pose.middleFinger[2].angleZ * RAD2DEG - meanDeg)).toBeGreaterThan(30)
    // With exclusion, the same corrupted reading never enters the objective -- the joint settles at
    // its prior mean instead, the same as a frame that tracked nothing for this finger at all.
    expect(excludedResult.pose.middleFinger[2].angleZ * RAD2DEG).toBeCloseTo(wide.pipDipRom.pip.middleFinger.meanDeg, 0)
  })

  test("'all' excludes every finger's data term at once, e.g. for a dorsal-facing frame", () => {
    const pose = emptyPose()
    pose.indexFinger[1] = { angleZ: 45 * DEG2RAD, angleY: 0 }
    const hand = frameFromPose(skeleton, pose)

    const result = solvePose(skeleton, HAND_PRIOR_SEED, hand, 'all')
    expect(result.pose.indexFinger[1].angleZ * RAD2DEG).toBeCloseTo(HAND_PRIOR_SEED.mcpAxes.indexFinger.flexExtRom.meanDeg, 0)
  })

  test('MCP ab/ad range chokes down as flexion increases, per abAdChokeCoeff', () => {
    const prior = structuredClone(HAND_PRIOR_SEED)
    prior.mcpAxes.indexFinger.abAdChokeCoeff = { mean: 0.3, variance: 0.0001, source: 'test' }

    const flexed = emptyPose()
    flexed.indexFinger[1] = { angleZ: 80 * DEG2RAD, angleY: 15 * DEG2RAD }
    const extended = emptyPose()
    extended.indexFinger[1] = { angleZ: 0, angleY: 15 * DEG2RAD }

    const flexedResult = solvePose(skeleton, prior, frameFromPose(skeleton, flexed))
    const extendedResult = solvePose(skeleton, prior, frameFromPose(skeleton, extended))

    // Same tracked ab/ad reading (15deg) in both frames -- only the flexed one should get pulled back
    // toward straight by the choked (narrower, more confident) ab/ad prior.
    expect(Math.abs(flexedResult.pose.indexFinger[1].angleY * RAD2DEG))
      .toBeLessThan(Math.abs(extendedResult.pose.indexFinger[1].angleY * RAD2DEG))
  })

  test('with no chokeCoeff seeded, ab/ad range does not change with flexion', () => {
    const flexed = emptyPose()
    flexed.indexFinger[1] = { angleZ: 80 * DEG2RAD, angleY: 15 * DEG2RAD }
    const extended = emptyPose()
    extended.indexFinger[1] = { angleZ: 0, angleY: 15 * DEG2RAD }

    const flexedResult = solvePose(skeleton, HAND_PRIOR_SEED, frameFromPose(skeleton, flexed))
    const extendedResult = solvePose(skeleton, HAND_PRIOR_SEED, frameFromPose(skeleton, extended))

    expect(flexedResult.pose.indexFinger[1].angleY * RAD2DEG)
      .toBeCloseTo(extendedResult.pose.indexFinger[1].angleY * RAD2DEG, 0)
  })

  test('MCP carries a flexion-phase-dependent axial twist when axialRotationWeight is nonzero', () => {
    const prior = structuredClone(HAND_PRIOR_SEED)
    prior.mcpAxes.indexFinger.axialRotationWeight = { mean: 0.2, variance: 0.0001, source: 'test' }
    const twistSkeleton = buildDefaultSkeleton(prior)
    const joint = twistSkeleton.indexFinger[1]
    expect(joint.degree).toBe(3)
    if (joint.degree === 3) {
      expect(joint.conjunctCoupling.aCoeff).toBeCloseTo(0.2)
      expect(joint.conjunctCoupling.bCoeff).toBe(0)
    }
  })

  test('elbow flexion and forearm pronation never move from their prior mean -- no observation and no coupling implemented for them yet', () => {
    const pose = emptyPose()
    for (const f of ['indexFinger', 'middleFinger', 'ringFinger', 'pinky'] as const) {
      pose[f][1] = { angleZ: 80 * DEG2RAD, angleY: 0 }
      pose[f][2] = { angleZ: 80 * DEG2RAD, angleY: 0 }
      pose[f][3] = { angleZ: 80 * DEG2RAD, angleY: 0 }
    }
    const hand = frameFromPose(skeleton, pose)
    const result = solvePose(skeleton, HAND_PRIOR_SEED, hand)

    expect(result.wristForearm.elbowFlexion * RAD2DEG).toBeCloseTo(HAND_PRIOR_SEED.wristForearm.elbowFlexionRom.meanDeg, 5)
    expect(result.wristForearm.forearmPronationSupination * RAD2DEG).toBeCloseTo(
      HAND_PRIOR_SEED.wristForearm.forearmPronationSupinationRom.meanDeg,
      5,
    )
  })
})

describe('poseToLandmarkVectors', () => {
  test('produces 21 landmark positions, with the wrist shared across every finger', () => {
    const pose = emptyPose()
    pose.indexFinger[1] = { angleZ: 30 * DEG2RAD, angleY: 0 }
    const vectors = poseToLandmarkVectors(skeleton, pose)

    expect(vectors.length).toBe(21)
    for (const v of vectors) expect(v).toBeDefined()
    // Landmark 0 (wrist) is the same physical point in every finger's chain.
    expect(vectors[0].x).toBeCloseTo(0, 5)
    expect(vectors[0].y).toBeCloseTo(0, 5)
    expect(vectors[0].z).toBeCloseTo(0, 5)
  })

  test('a flexed knuckle moves its downstream landmarks away from the straight-finger position', () => {
    const straight = poseToLandmarkVectors(skeleton, emptyPose())
    const bent = emptyPose()
    bent.indexFinger[1] = { angleZ: 60 * DEG2RAD, angleY: 0 }
    const flexed = poseToLandmarkVectors(skeleton, bent)

    // Landmark 8 is the index fingertip -- downstream of the flexed MCP (joint 1).
    expect(flexed[8].distanceTo(straight[8])).toBeGreaterThan(0.01)
  })
})

describe('poseConfidenceSdDeg', () => {
  test('a landmark downstream of a modeled joint gets a defined confidence', () => {
    const sdDeg = poseConfidenceSdDeg(skeleton, HAND_PRIOR_SEED)
    expect(sdDeg.length).toBe(21)
    expect(sdDeg[8]).toBe(HAND_PRIOR_SEED.pipDipRom.dip.indexFinger.sdDeg) // index fingertip, worst joint is DIP
  })

  test('a landmark downstream only of an unmodeled joint (thumb MCP/IP) is undefined, not falsely confident', () => {
    const sdDeg = poseConfidenceSdDeg(skeleton, HAND_PRIOR_SEED)
    // Landmark 4 (thumb tip) is downstream of thumb's own un-modeled "MCP"/"IP" hinges (joints 2, 3) --
    // but joint 1 (the real CMC) IS modeled, so the worst-so-far should still reflect that, not be
    // undefined outright.
    expect(sdDeg[4]).toBeDefined()
  })

  test("tightening a joint's prior lowers the confidence number (sdDeg) for its downstream landmarks", () => {
    const wide = poseConfidenceSdDeg(skeleton, HAND_PRIOR_SEED)
    const tightened = structuredClone(HAND_PRIOR_SEED)
    tightened.pipDipRom.dip.indexFinger = { ...tightened.pipDipRom.dip.indexFinger, sdDeg: 0.5 }
    const tight = poseConfidenceSdDeg(skeleton, tightened)
    expect(tight[8]!).toBeLessThan(wide[8]!)
  })
})

describe('buildDefaultSkeleton', () => {
  // Regression for a real bug: an earlier version had no handedness parameter at all, assuming
  // hand.limbs' own chirality-reversal correction made one fixed splay convention agree with real
  // tracked data for both real-world hands. Confirmed wrong against a live capture, 2026-09-06: with
  // no parameter (equivalent to the 'Left' default), a real Right hand's corrected model put the thumb
  // on the pinky side. This locks in that 'Left'/'Right' actually produce mirror-image skeletons.
  test("'Left' (the default) and 'Right' produce mirror-image knuckle/thumb splay", () => {
    const left = buildDefaultSkeleton(HAND_PRIOR_SEED, 'Left')
    const right = buildDefaultSkeleton(HAND_PRIOR_SEED, 'Right')
    const pose = buildRestExtensionPose(HAND_PRIOR_SEED, 'Left') // any pose; only joint-0 frames matter here
    const leftVectors = poseToLandmarkVectors(left, pose)
    const rightVectors = poseToLandmarkVectors(right, pose)
    // indexFinger's own knuckle-row landmark (5) flips side between the two.
    expect(Math.sign(leftVectors[5].z)).toBe(-Math.sign(rightVectors[5].z))
    expect(Math.sign(leftVectors[5].z)).not.toBe(0)
  })

  test('the default (no explicit handedness) matches Left, not Right', () => {
    const withDefault = buildDefaultSkeleton(HAND_PRIOR_SEED)
    const left = buildDefaultSkeleton(HAND_PRIOR_SEED, 'Left')
    const pose = buildRestExtensionPose(HAND_PRIOR_SEED, 'Left')
    const defaultVectors = poseToLandmarkVectors(withDefault, pose)
    const leftVectors = poseToLandmarkVectors(left, pose)
    expect(defaultVectors[5].z).toBeCloseTo(leftVectors[5].z, 6)
  })

  test('thumb lands on the same side as the index finger for both handednesses -- not an anatomically impossible hand', () => {
    for (const handedness of ['Left', 'Right'] as const) {
      const skel = buildDefaultSkeleton(HAND_PRIOR_SEED, handedness)
      const pose = buildRestExtensionPose(HAND_PRIOR_SEED, handedness)
      const vectors = poseToLandmarkVectors(skel, pose)
      const sideOf = (landmark: number) => Math.sign(vectors[landmark].z - vectors[0].z)
      expect(sideOf(4)).toBe(sideOf(5)) // thumb tip vs. index MCP
      expect(sideOf(4)).toBe(-sideOf(17)) // opposite the pinky MCP
    }
  })
})

describe('buildRestExtensionPose', () => {
  // 'Right' is this file's base/unmirrored sign convention (mirror=1 -- see buildRestExtensionSkeleton's
  // doc comment on the video-mirroring convention) -- tests below that assume a specific sign (rather
  // than checking mirror-invariant properties) are written against this convention.
  const restPose = buildRestExtensionPose(HAND_PRIOR_SEED, 'Right')

  test('every non-thumb PIP/DIP sits at its own minDeg (straight, not flexed)', () => {
    const nonThumbFingers = FINGERS.filter((f): f is Exclude<Finger, 'thumb'> => f !== 'thumb')
    for (const f of nonThumbFingers) {
      expect(restPose[f][2].angleZ * RAD2DEG).toBeCloseTo(HAND_PRIOR_SEED.pipDipRom.pip[f].minDeg, 6)
      expect(restPose[f][3].angleZ * RAD2DEG).toBeCloseTo(HAND_PRIOR_SEED.pipDipRom.dip[f].minDeg, 6)
    }
  })

  test('no joint angle exceeds its own modeled ROM bounds -- no impossible joint angle', () => {
    const nonThumbFingers = FINGERS.filter((f): f is Exclude<Finger, 'thumb'> => f !== 'thumb')
    for (const f of nonThumbFingers) {
      const mcp = HAND_PRIOR_SEED.mcpAxes[f]
      const flexDeg = restPose[f][1].angleZ * RAD2DEG
      const abAdDeg = restPose[f][1].angleY * RAD2DEG
      expect(flexDeg).toBeGreaterThanOrEqual(mcp.flexExtRom.minDeg)
      expect(flexDeg).toBeLessThanOrEqual(mcp.flexExtRom.maxDeg)
      expect(Math.abs(abAdDeg)).toBeLessThanOrEqual(mcp.abAdRom.maxDeg)
      const pipDeg = restPose[f][2].angleZ * RAD2DEG
      expect(pipDeg).toBeGreaterThanOrEqual(HAND_PRIOR_SEED.pipDipRom.pip[f].minDeg)
      expect(pipDeg).toBeLessThanOrEqual(HAND_PRIOR_SEED.pipDipRom.pip[f].maxDeg)
    }
    const thumbFlexDeg = restPose.thumb[1].angleZ * RAD2DEG
    expect(thumbFlexDeg).toBeGreaterThanOrEqual(HAND_PRIOR_SEED.cmcMobility.thumb.flexExtRom.minDeg)
    expect(thumbFlexDeg).toBeLessThanOrEqual(HAND_PRIOR_SEED.cmcMobility.thumb.flexExtRom.maxDeg)
    const thumbAbAdDeg = restPose.thumb[1].angleY * RAD2DEG
    expect(thumbAbAdDeg).toBeGreaterThanOrEqual(HAND_PRIOR_SEED.cmcMobility.thumb.abAdRom.minDeg)
    expect(thumbAbAdDeg).toBeLessThanOrEqual(HAND_PRIOR_SEED.cmcMobility.thumb.abAdRom.maxDeg)
  })

  test('MCP ab/ad fans the four fingers apart (not collapsed onto the same line)', () => {
    const abAd = (f: Finger) => restPose[f][1].angleY * RAD2DEG
    // Monotonic across the natural finger row, centered near zero at the middle finger -- confirms
    // the fingers actually spread apart in this static reference instead of all sitting at 0 (which
    // would reproduce buildDefaultSkeleton's degenerate collinear splay in this diagnostic tile too).
    expect(abAd('indexFinger')).toBeGreaterThan(abAd('middleFinger'))
    expect(abAd('middleFinger')).toBeGreaterThan(abAd('ringFinger'))
    expect(abAd('ringFinger')).toBeGreaterThan(abAd('pinky'))
    expect(abAd('middleFinger')).toBeCloseTo(0, 6)
  })

  test('produces plausible, positive bone-segment lengths with no impossibly short or long segments', () => {
    const vectors = poseToLandmarkVectors(buildRestExtensionSkeleton(HAND_PRIOR_SEED, 'Right'), restPose)
    // Every consecutive pair along each finger's chain should be a real, positive-length, finite
    // segment -- not collapsed to zero (fingers on top of each other) and not exploding to some
    // absurd multiple of hand length (a units/scale bug, e.g. the one already found and fixed in
    // projectCorrectedOntoKeypoints).
    const handLenScale = HAND_PRIOR_SEED.boneLengths.handLength.mean * 100 // worldPositions' own scale=100
    for (const finger of FINGERS) {
      const chain = [vectors[0], ...CONNECTIONS[finger].map(([, to]) => vectors[to])]
      for (let i = 1; i < chain.length; i++) {
        const segLen = chain[i].distanceTo(chain[i - 1])
        expect(segLen).toBeGreaterThan(0)
        expect(Number.isFinite(segLen)).toBe(true)
        // No single segment should be longer than a whole hand -- a generous upper bound, just
        // ruling out gross unit/scale errors, not asserting a tight anatomical figure.
        expect(segLen).toBeLessThan(handLenScale)
      }
    }
  })

  test('fingers are not all collinear when paired with buildRestExtensionSkeleton (a real spread, not the degenerate identity-splay line)', () => {
    const vectors = poseToLandmarkVectors(buildRestExtensionSkeleton(HAND_PRIOR_SEED, 'Right'), restPose)
    // Landmarks 5 (index MCP) and 17 (pinky MCP) must not sit on the same ray from the wrist --
    // otherwise the palm normal computed from this static reference would be degenerate too (the
    // exact bug multi-view's live tiles have today).
    const wristToIndex = vectors[5].clone().sub(vectors[0]).normalize()
    const wristToPinky = vectors[17].clone().sub(vectors[0]).normalize()
    expect(wristToIndex.dot(wristToPinky)).toBeLessThan(0.999)
  })

  test('buildDefaultSkeleton alone now also spreads the knuckle row -- it carries a real joint-0 splay itself, not just buildRestExtensionSkeleton', () => {
    // Was exactly collinear (dot == 1) before buildDefaultSkeleton gained its own knuckle-row splay --
    // this pins down that the fix now lives in buildDefaultSkeleton itself, not only in the display-only
    // wrapper on top of it.
    const vectors = poseToLandmarkVectors(skeleton, restPose)
    const wristToIndex = vectors[5].clone().sub(vectors[0]).normalize()
    const wristToPinky = vectors[17].clone().sub(vectors[0]).normalize()
    expect(wristToIndex.dot(wristToPinky)).toBeLessThan(0.999)
  })
})

describe('buildRestExtensionSkeleton', () => {
  test('spreads the knuckle row (5, 9, 13, 17) into a real fan, monotonic across the finger order', () => {
    const restSkeleton = buildRestExtensionSkeleton(HAND_PRIOR_SEED, 'Right')
    const restPose = buildRestExtensionPose(HAND_PRIOR_SEED, 'Right')
    const vectors = poseToLandmarkVectors(restSkeleton, restPose)
    const angleFromWrist = (landmark: number) => Math.atan2(vectors[landmark].z, vectors[landmark].x)
    const index = angleFromWrist(5)
    const middle = angleFromWrist(9)
    const ring = angleFromWrist(13)
    const pinky = angleFromWrist(17)
    // Monotonic across the row -- which physical direction is "positive" is an arbitrary rotation-sign
    // convention (not itself a claim about real handedness), so check consistent ordering rather than
    // hardcoding a sign: consecutive differences must all point the same way, and be real (nonzero).
    const d1 = middle - index
    const d2 = ring - middle
    const d3 = pinky - ring
    expect(Math.sign(d1)).toBe(Math.sign(d2))
    expect(Math.sign(d2)).toBe(Math.sign(d3))
    expect(Math.abs(d1)).toBeGreaterThan(0.01)
    expect(Math.abs(d2)).toBeGreaterThan(0.01)
    expect(Math.abs(d3)).toBeGreaterThan(0.01)
  })

  test("doesn't change any bone length -- splay is an orientation-only change", () => {
    const defaultVectors = poseToLandmarkVectors(skeleton, buildRestExtensionPose(HAND_PRIOR_SEED, 'Right'))
    const restSkeleton = buildRestExtensionSkeleton(HAND_PRIOR_SEED, 'Right')
    const restVectors = poseToLandmarkVectors(restSkeleton, buildRestExtensionPose(HAND_PRIOR_SEED, 'Right'))
    for (const finger of FINGERS) {
      const defaultLen = defaultVectors[CONNECTIONS[finger][0][1]].distanceTo(defaultVectors[0])
      const restLen = restVectors[CONNECTIONS[finger][0][1]].distanceTo(restVectors[0])
      expect(restLen).toBeCloseTo(defaultLen, 6)
    }
  })

  test('the thumb lands on the same side as the index finger, opposite the pinky -- an anatomically impossible hand otherwise', () => {
    // Regression for a real bug: the thumb's initial joint-0 splay and its own driven ab/ad rotation
    // (joint 1) compose onto each other (the second is expressed in a frame already rotated by the
    // first) -- picking the wrong relative sign between the two made them nearly cancel, snapping the
    // thumb back to point almost parallel with the other fingers, on the *pinky's* side of the fan
    // instead of the index's. Checked for both handednesses, since the mirror sign could reintroduce
    // this for just one of the two.
    for (const handedness of ['Left', 'Right'] as const) {
      const restSkeleton = buildRestExtensionSkeleton(HAND_PRIOR_SEED, handedness)
      const vectors = poseToLandmarkVectors(restSkeleton, buildRestExtensionPose(HAND_PRIOR_SEED, handedness))
      const sideOf = (landmark: number) => Math.sign(vectors[landmark].z - vectors[0].z)
      const indexSide = sideOf(5)
      const pinkySide = sideOf(17)
      const thumbTipSide = sideOf(4)
      expect(indexSide).not.toBe(0)
      expect(indexSide).toBe(-pinkySide) // sanity: the fan itself must actually spread both ways
      expect(thumbTipSide).toBe(indexSide)
    }
  })

  test('handedness mirrors the whole rest hand (not just the axis triad) -- thumb screen side flips', () => {
    // The bug this guards: handedness affected only the displayed axis triad, leaving the rendered
    // hand shape (including which side the thumb points) identical for Left and Right.
    const rightVectors = poseToLandmarkVectors(
      buildRestExtensionSkeleton(HAND_PRIOR_SEED, 'Right'),
      buildRestExtensionPose(HAND_PRIOR_SEED, 'Right'),
    )
    const leftVectors = poseToLandmarkVectors(
      buildRestExtensionSkeleton(HAND_PRIOR_SEED, 'Left'),
      buildRestExtensionPose(HAND_PRIOR_SEED, 'Left'),
    )
    // multi-view's REST_VIEW_BASIS maps screen-x to world z, so "which side of the display the thumb
    // is on" is exactly the sign of the thumb tip's z coordinate.
    expect(Math.sign(rightVectors[4].z)).toBe(-Math.sign(leftVectors[4].z))
    expect(Math.sign(rightVectors[4].z)).not.toBe(0)
  })

  test('knuckleRow drives real MCP-to-MCP spacing (law of cosines), not a fixed fan angle', () => {
    // Set an exact, easy-to-check spacing for each gap and confirm the rendered rest skeleton actually
    // reproduces it -- the whole point of measuring a real span instead of assuming a fixed angle.
    const prior = structuredClone(HAND_PRIOR_SEED)
    const handLengthMM = prior.boneLengths.handLength.mean
    const targetGapsMM = [18, 16, 14]
    prior.boneLengths.knuckleRow.mean = targetGapsMM.map(mm => mm / handLengthMM)

    const restSkeleton = buildRestExtensionSkeleton(prior, 'Right')
    const restPose = buildRestExtensionPose(prior, 'Right')
    const vectors = poseToLandmarkVectors(restSkeleton, restPose)
    const UNITS_PER_MM = 100

    expect(vectors[5].distanceTo(vectors[9]) / UNITS_PER_MM).toBeCloseTo(targetGapsMM[0], 5)
    expect(vectors[9].distanceTo(vectors[13]) / UNITS_PER_MM).toBeCloseTo(targetGapsMM[1], 5)
    expect(vectors[13].distanceTo(vectors[17]) / UNITS_PER_MM).toBeCloseTo(targetGapsMM[2], 5)
  })

  test('a wider knuckleRow measurement widens the rendered splay, all else equal', () => {
    const narrow = structuredClone(HAND_PRIOR_SEED)
    const wide = structuredClone(HAND_PRIOR_SEED)
    wide.boneLengths.knuckleRow.mean = narrow.boneLengths.knuckleRow.mean.map(r => r * 2)

    const narrowVectors = poseToLandmarkVectors(buildRestExtensionSkeleton(narrow, 'Right'), buildRestExtensionPose(narrow, 'Right'))
    const wideVectors = poseToLandmarkVectors(buildRestExtensionSkeleton(wide, 'Right'), buildRestExtensionPose(wide, 'Right'))

    expect(wideVectors[5].distanceTo(wideVectors[9])).toBeGreaterThan(narrowVectors[5].distanceTo(narrowVectors[9]))
  })
})
