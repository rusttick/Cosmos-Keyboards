import { describe, expect, test } from 'bun:test'
import { HAND_PRIOR_SEED } from '../priors/handModelData'
import { neutralPoseAngleRad } from './neutralPose'

const DEG2RAD = Math.PI / 180

describe('neutralPoseAngleRad', () => {
  test("index finger's MCP uses the fitted meanDeg for both axes", () => {
    const mcp = HAND_PRIOR_SEED.mcpAxes.indexFinger
    const [z, y] = neutralPoseAngleRad(HAND_PRIOR_SEED, 'indexFinger', 1)
    expect(z).toBeCloseTo(mcp.flexExtRom.meanDeg * DEG2RAD, 10)
    expect(y).toBeCloseTo(mcp.abAdRom.meanDeg * DEG2RAD, 10)
  })

  test("index finger's PIP uses its own fitted meanDeg", () => {
    const [pipZ] = neutralPoseAngleRad(HAND_PRIOR_SEED, 'indexFinger', 2)
    expect(pipZ).toBeCloseTo(HAND_PRIOR_SEED.pipDipRom.pip.indexFinger.meanDeg * DEG2RAD, 10)
  })

  test("index finger's DIP is derived from PIP's meanDeg via dipPipCoupling, NOT read from pipDipRom.dip.meanDeg directly", () => {
    // Regression test for a real bug: `sampleFingerSweep.ts` never treats DIP as independently sourced
    // -- it's always `dip = clamp(slope*pip + intercept)`. Using `pipDipRom.dip.meanDeg` directly
    // produced a DIP angle inconsistent with the coupling, which visibly pulled the neutral-pose
    // fingertip off of any pose the sweep itself could actually produce.
    const [dipZ] = neutralPoseAngleRad(HAND_PRIOR_SEED, 'indexFinger', 3)
    const pipMeanDeg = HAND_PRIOR_SEED.pipDipRom.pip.indexFinger.meanDeg
    const dipRom = HAND_PRIOR_SEED.pipDipRom.dip.indexFinger
    const [slope, intercept] = HAND_PRIOR_SEED.dipPipCoupling.indexFinger.mean
    const expectedDeg = Math.min(dipRom.maxDeg, Math.max(dipRom.minDeg, slope * pipMeanDeg + intercept))
    expect(dipZ).toBeCloseTo(expectedDeg * DEG2RAD, 10)
    // And it should NOT match the (wrong) direct-mean approach, confirming this isn't accidentally
    // both-the-same for this particular prior.
    expect(dipZ).not.toBeCloseTo(dipRom.meanDeg * DEG2RAD, 3)
  })

  test("index/middle's fixed metacarpal (joint 0) is always [0, 0] -- no DOF to have a mean", () => {
    expect(neutralPoseAngleRad(HAND_PRIOR_SEED, 'indexFinger', 0)).toEqual([0, 0])
    expect(neutralPoseAngleRad(HAND_PRIOR_SEED, 'middleFinger', 0)).toEqual([0, 0])
  })

  test("ring/pinky's own base-joint flexion (joint 0) uses cmcMobility's fitted meanDeg", () => {
    const [z] = neutralPoseAngleRad(HAND_PRIOR_SEED, 'ringFinger', 0)
    expect(z).toBeCloseTo(HAND_PRIOR_SEED.cmcMobility.ring.flexionRom.meanDeg * DEG2RAD, 10)
    const [pz] = neutralPoseAngleRad(HAND_PRIOR_SEED, 'pinky', 0)
    expect(pz).toBeCloseTo(HAND_PRIOR_SEED.cmcMobility.pinky.flexionRom.meanDeg * DEG2RAD, 10)
  })

  test("thumb's CMC (joint 1) uses cmcMobility.thumb's fitted meanDeg", () => {
    const cmc = HAND_PRIOR_SEED.cmcMobility.thumb
    const [z, y] = neutralPoseAngleRad(HAND_PRIOR_SEED, 'thumb', 1)
    expect(z).toBeCloseTo(cmc.flexExtRom.meanDeg * DEG2RAD, 10)
    expect(y).toBeCloseTo(cmc.abAdRom.meanDeg * DEG2RAD, 10)
  })

  test("thumb's un-modeled MCP/IP hinges (joints 2/3) fall back to [0, 0] -- no prior exists", () => {
    expect(neutralPoseAngleRad(HAND_PRIOR_SEED, 'thumb', 2)).toEqual([0, 0])
    expect(neutralPoseAngleRad(HAND_PRIOR_SEED, 'thumb', 3)).toEqual([0, 0])
  })
})
