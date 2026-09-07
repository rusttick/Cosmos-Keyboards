import { SolvedHand } from '$lib/hand'
import { describe, expect, test } from 'bun:test'
import { HAND_PRIOR_SEED } from '../priors/handModelData'
import { buildDefaultSkeleton } from '../priors/ikSolve'
import { isNonThumbFinger, PLACEHOLDER_LANDMARK0_POSITION, sampleMcpSweep } from './sampleMcpSweep'

describe('sampleMcpSweep', () => {
  const skeleton = buildDefaultSkeleton(HAND_PRIOR_SEED, 'Right')

  test('returns stepsPerAxis^2 samples', () => {
    const samples = sampleMcpSweep(skeleton, 'indexFinger', HAND_PRIOR_SEED, 5)
    expect(samples.length).toBe(25)
  })

  test('sweeping flexion actually moves the fingertip', () => {
    const samples = sampleMcpSweep(skeleton, 'indexFinger', HAND_PRIOR_SEED, 5)
    const positions = samples.map((s) => s.position)
    const allEqual = positions.every(
      (p) => p[0] === positions[0][0] && p[1] === positions[0][1] && p[2] === positions[0][2],
    )
    expect(allEqual).toBe(false)
  })

  test('extremes of the flexion sweep are further apart than adjacent samples', () => {
    const samples = sampleMcpSweep(skeleton, 'indexFinger', HAND_PRIOR_SEED, 5)
    const first = samples[0].position
    const last = samples[samples.length - 1].position
    const dist = (a: typeof first, b: typeof first) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
    expect(dist(first, last)).toBeGreaterThan(0)
  })

  test('fingertip distance from the wrist is a plausible real hand size, not off by 100x', () => {
    // Regression test for a real bug: `buildDefaultSkeleton` bakes joint lengths as already-absolute
    // millimeters, unlike `calculateJoints`'s ratio-based joints -- calling `worldPositions` with its
    // default `scale=100` (calibrated for the ratio convention) silently double-applies the
    // conversion, producing fingertip positions around 15,000mm instead of ~150mm. A real adult index
    // finger's wrist-to-fingertip distance is on the order of 150-200mm; 100x that (15,000-20,000mm)
    // or 100x under (1.5-2mm) would both indicate this scale bug has come back.
    const samples = sampleMcpSweep(skeleton, 'indexFinger', HAND_PRIOR_SEED, 3)
    for (const { position } of samples) {
      const distFromWrist = Math.hypot(...position)
      expect(distFromWrist).toBeGreaterThan(50)
      expect(distFromWrist).toBeLessThan(400)
    }
  })

  test('placeholder landmark-0 orientation: rest lies flat (z~=0), abduction stays flat, flexion lifts out of plane', () => {
    // Regression test for a real bug: a plain-identity landmark-0 placeholder put the palm plane at 90
    // degrees to this viewer's ground grid (`$lib/hand.ts`'s `fkBy` treats local Y as the palm normal;
    // identity maps that to world Y, not world Z/"up" -- confirmed live). Driving fkBy directly with
    // exact angles (rather than sampleMcpSweep's ROM-bound grid, which rarely lands exactly on 0) to
    // check the orientation itself, independent of any particular finger's fitted ROM bounds.
    const solved = new SolvedHand(skeleton, PLACEHOLDER_LANDMARK0_POSITION)
    const tipZ = (flexRad: number, abAdRad: number) => {
      solved.fkBy('indexFinger', (i) => (i === 1 ? [flexRad, abAdRad] : [0, 0]))
      return solved.worldPositions('indexFinger', 1)[4].z
    }

    const restZ = tipZ(0, 0)
    expect(Math.abs(restZ)).toBeLessThan(5)
    expect(Math.abs(tipZ(0, 0.5) - restZ)).toBeLessThan(5) // pure abduction: stays in-plane
    expect(Math.abs(tipZ(0.5, 0) - restZ)).toBeGreaterThan(20) // pure flexion: lifts out of plane
  })

  test('isNonThumbFinger rejects the thumb and unknown names', () => {
    expect(isNonThumbFinger('indexFinger')).toBe(true)
    expect(isNonThumbFinger('thumb')).toBe(false)
    expect(isNonThumbFinger('notAFinger')).toBe(false)
  })
})
