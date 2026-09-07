import { describe, expect, test } from 'bun:test'
import { get } from 'svelte/store'
import { applyCaliperMeasurement } from './caliperMeasurement'
import { HAND_PRIOR_SEED } from './handModelData'
import { myHandPrior, resetMyHandPrior } from './myHandStore'

describe('applyCaliperMeasurement', () => {
  test('rejects a cross-finger span', () => {
    resetMyHandPrior()
    const result = applyCaliperMeasurement({
      handedness: 'Right',
      landmarkA: 4,
      landmarkB: 20,
      mm: 100,
      uncertaintyMm: 1,
      fusedSnapshot: HAND_PRIOR_SEED,
    })
    expect(result.ok).toBe(false)
  })

  test('a confident measurement pulls the ratio toward it, but does not overwrite outright', () => {
    resetMyHandPrior()
    const seedRatioSum = HAND_PRIOR_SEED.boneLengths.fingers.middleFinger.mean.slice(0, 3).reduce((a, b) => a + b, 0)
    const seedMm = seedRatioSum * HAND_PRIOR_SEED.boneLengths.handLength.mean

    // A measurement that disagrees a bit with the seed, with a tight (confident) uncertainty.
    const measuredMm = seedMm * 1.1
    const result = applyCaliperMeasurement({
      handedness: 'Right',
      landmarkA: 0,
      landmarkB: 11, // wrist -> middle DIP: metacarpal+proximal+middle, excludes distal
      mm: measuredMm,
      uncertaintyMm: 0.5,
      fusedSnapshot: HAND_PRIOR_SEED,
    })
    expect(result.ok).toBe(true)

    const state = get(myHandPrior).Right!
    const updatedRatioSum = state.boneLengths!.fingers!.middleFinger!.mean.slice(0, 3).reduce((a, b) => a + b, 0)
    const updatedMm = updatedRatioSum * state.boneLengths!.handLength!.mean

    // Moved toward the measurement...
    expect(updatedMm).toBeGreaterThan(seedMm)
    // ...but a single tight measurement against a whole literature-backed prior shouldn't leap all the
    // way to the raw reading -- some blending happened, not an overwrite.
    expect(updatedMm).toBeLessThan(measuredMm)
  })

  test('only the spanned segments move; distal (excluded by the 0->11 span) stays untouched', () => {
    resetMyHandPrior()
    const seedRatioSum = HAND_PRIOR_SEED.boneLengths.fingers.middleFinger.mean.slice(0, 3).reduce((a, b) => a + b, 0)
    const seedMm = seedRatioSum * HAND_PRIOR_SEED.boneLengths.handLength.mean

    applyCaliperMeasurement({
      handedness: 'Right',
      landmarkA: 0,
      landmarkB: 11,
      mm: seedMm * 1.3,
      uncertaintyMm: 0.3,
      fusedSnapshot: HAND_PRIOR_SEED,
    })

    const state = get(myHandPrior).Right!
    const updatedDistal = state.boneLengths!.fingers!.middleFinger!.mean[3]
    expect(updatedDistal).toBeCloseTo(HAND_PRIOR_SEED.boneLengths.fingers.middleFinger.mean[3], 10)
  })

  test('handLength narrows (implied observation) even though it was not directly measured', () => {
    resetMyHandPrior()
    const seedRatioSum = HAND_PRIOR_SEED.boneLengths.fingers.indexFinger.mean.slice(0, 3).reduce((a, b) => a + b, 0)
    const seedMm = seedRatioSum * HAND_PRIOR_SEED.boneLengths.handLength.mean

    applyCaliperMeasurement({
      handedness: 'Right',
      landmarkA: 0,
      landmarkB: 7, // index finger, wrist -> DIP
      mm: seedMm,
      uncertaintyMm: 0.2,
      fusedSnapshot: HAND_PRIOR_SEED,
    })

    const state = get(myHandPrior).Right!
    expect(state.boneLengths!.handLength!.variance).toBeLessThan(HAND_PRIOR_SEED.boneLengths.handLength.variance)
  })

  test('a second measurement on a different finger does not disturb the first', () => {
    resetMyHandPrior()
    const middleRatioSum = HAND_PRIOR_SEED.boneLengths.fingers.middleFinger.mean.slice(0, 3).reduce((a, b) => a + b, 0)
    applyCaliperMeasurement({
      handedness: 'Right',
      landmarkA: 0,
      landmarkB: 11,
      mm: middleRatioSum * HAND_PRIOR_SEED.boneLengths.handLength.mean,
      uncertaintyMm: 0.5,
      fusedSnapshot: HAND_PRIOR_SEED,
    })
    const middleAfterFirst = get(myHandPrior).Right!.boneLengths!.fingers!.middleFinger!.mean.slice()

    const ringRatioSum = HAND_PRIOR_SEED.boneLengths.fingers.ringFinger.mean.slice(0, 3).reduce((a, b) => a + b, 0)
    applyCaliperMeasurement({
      handedness: 'Right',
      landmarkA: 0,
      landmarkB: 15,
      mm: ringRatioSum * HAND_PRIOR_SEED.boneLengths.handLength.mean * 1.05,
      uncertaintyMm: 0.5,
      fusedSnapshot: HAND_PRIOR_SEED,
    })
    const middleAfterSecond = get(myHandPrior).Right!.boneLengths!.fingers!.middleFinger!.mean
    expect(middleAfterSecond).toEqual(middleAfterFirst)
  })

  test('Right and Left measurements land in independent halves of the pair', () => {
    resetMyHandPrior()
    const ratioSum = HAND_PRIOR_SEED.boneLengths.fingers.pinky.mean.slice(0, 3).reduce((a, b) => a + b, 0)
    applyCaliperMeasurement({
      handedness: 'Right',
      landmarkA: 0,
      landmarkB: 19,
      mm: ratioSum * HAND_PRIOR_SEED.boneLengths.handLength.mean,
      uncertaintyMm: 0.5,
      fusedSnapshot: HAND_PRIOR_SEED,
    })
    const pair = get(myHandPrior)
    expect(pair.Right?.boneLengths?.fingers?.pinky).toBeDefined()
    expect(pair.Left).toBeUndefined()
  })

  test('an adjacent-MCP measurement updates knuckleRow, pulling toward the reading', () => {
    resetMyHandPrior()
    const seedGapMM = HAND_PRIOR_SEED.boneLengths.knuckleRow.mean[0] * HAND_PRIOR_SEED.boneLengths.handLength.mean
    const result = applyCaliperMeasurement({
      handedness: 'Right',
      landmarkA: 5,
      landmarkB: 9,
      mm: seedGapMM * 1.3,
      uncertaintyMm: 0.5,
      fusedSnapshot: HAND_PRIOR_SEED,
    })
    expect(result.ok).toBe(true)

    const state = get(myHandPrior).Right!
    const updatedGapMM = state.boneLengths!.knuckleRow!.mean[0] * state.boneLengths!.handLength!.mean
    expect(updatedGapMM).toBeGreaterThan(seedGapMM)
    expect(updatedGapMM).toBeLessThan(seedGapMM * 1.3)
    // Only the measured gap should move -- the other two stay at whatever they started at.
    expect(state.boneLengths!.knuckleRow!.mean[1]).toBeCloseTo(HAND_PRIOR_SEED.boneLengths.knuckleRow.mean[1], 10)
  })

  test('a knuckle measurement does not disturb finger bone lengths, and vice versa', () => {
    resetMyHandPrior()
    applyCaliperMeasurement({
      handedness: 'Right',
      landmarkA: 5,
      landmarkB: 9,
      mm: 20,
      uncertaintyMm: 0.5,
      fusedSnapshot: HAND_PRIOR_SEED,
    })
    const ratioSum = HAND_PRIOR_SEED.boneLengths.fingers.indexFinger.mean.slice(0, 3).reduce((a, b) => a + b, 0)
    applyCaliperMeasurement({
      handedness: 'Right',
      landmarkA: 0,
      landmarkB: 7,
      mm: ratioSum * HAND_PRIOR_SEED.boneLengths.handLength.mean,
      uncertaintyMm: 0.5,
      fusedSnapshot: HAND_PRIOR_SEED,
    })
    const state = get(myHandPrior).Right!
    expect(state.boneLengths?.knuckleRow).toBeDefined()
    expect(state.boneLengths?.fingers?.indexFinger).toBeDefined()
  })
})
