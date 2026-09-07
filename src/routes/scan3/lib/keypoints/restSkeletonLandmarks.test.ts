import { describe, expect, test } from 'bun:test'
import { Matrix4 } from 'three'
import { HAND_PRIOR_SEED } from '../priors/handModelData'
import { buildDefaultSkeleton } from '../priors/ikSolve'
import { neutralPoseAngleRad } from './neutralPose'
import { restSkeletonBoneChains, restSkeletonLandmarks } from './restSkeletonLandmarks'
import { PLACEHOLDER_LANDMARK0_POSITION } from './sampleMcpSweep'

describe('restSkeletonLandmarks', () => {
  const skeleton = buildDefaultSkeleton(HAND_PRIOR_SEED, 'Right')

  test('returns exactly 21 landmarks, all defined', () => {
    const landmarks = restSkeletonLandmarks(skeleton, PLACEHOLDER_LANDMARK0_POSITION)
    expect(landmarks.length).toBe(21)
    for (const p of landmarks) expect(p).toBeDefined()
  })

  test('landmark 0 (wrist) sits at the origin regardless of position matrix', () => {
    const landmarks = restSkeletonLandmarks(skeleton, PLACEHOLDER_LANDMARK0_POSITION)
    expect(landmarks[0][0]).toBeCloseTo(0, 6)
    expect(landmarks[0][1]).toBeCloseTo(0, 6)
    expect(landmarks[0][2]).toBeCloseTo(0, 6)
  })

  test('every fingertip is a plausible real hand distance from the wrist', () => {
    const landmarks = restSkeletonLandmarks(skeleton, PLACEHOLDER_LANDMARK0_POSITION)
    for (const tipIndex of [4, 8, 12, 16, 20]) {
      const dist = Math.hypot(...landmarks[tipIndex])
      expect(dist).toBeGreaterThan(20)
      expect(dist).toBeLessThan(300)
    }
  })

  test('different position matrices produce different (non-wrist) landmark positions', () => {
    const identity = restSkeletonLandmarks(skeleton, new Matrix4())
    const rotated = restSkeletonLandmarks(skeleton, PLACEHOLDER_LANDMARK0_POSITION)
    expect(identity[8]).not.toEqual(rotated[8])
  })

  test('a non-default poseAngleFn (neutralPoseAngleRad) produces a different pose than all-zero', () => {
    const straight = restSkeletonLandmarks(skeleton, PLACEHOLDER_LANDMARK0_POSITION)
    const neutral = restSkeletonLandmarks(
      skeleton,
      PLACEHOLDER_LANDMARK0_POSITION,
      (finger, jointIndex) => neutralPoseAngleRad(HAND_PRIOR_SEED, finger, jointIndex),
    )
    // Index fingertip (landmark 8) should move once MCP/PIP/DIP are posed at their fitted means
    // instead of held straight.
    expect(neutral[8]).not.toEqual(straight[8])
    // The wrist itself is unaffected by pose (only landmark-0 position/orientation moves it).
    expect(neutral[0]).toEqual(straight[0])
  })

  test('restSkeletonBoneChains groups landmarks per finger, wrist-first', () => {
    const landmarks = restSkeletonLandmarks(skeleton, PLACEHOLDER_LANDMARK0_POSITION)
    const chains = restSkeletonBoneChains(landmarks)
    expect(Object.keys(chains).sort()).toEqual(
      ['indexFinger', 'middleFinger', 'pinky', 'ringFinger', 'thumb'].sort(),
    )
    for (const chain of Object.values(chains)) {
      expect(chain.length).toBe(5) // wrist + 4 joints
      expect(chain[0]).toEqual(landmarks[0]) // every chain starts at the wrist
    }
  })
})
