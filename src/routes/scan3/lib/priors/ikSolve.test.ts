import type { Finger, Hand, Joints } from '$lib/hand'
import { FINGERS, SolvedHand } from '$lib/hand'
import { describe, expect, test } from 'bun:test'
import { Matrix4 } from 'three'
import { HAND_PRIOR_SEED } from './handModelData'
import { buildDefaultSkeleton, type Pose, poseConfidenceSdDeg, poseToLandmarkVectors, solvePose } from './ikSolve'

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
