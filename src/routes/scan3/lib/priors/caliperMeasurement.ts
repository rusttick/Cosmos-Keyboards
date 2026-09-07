/**
 * Applies one caliper measurement (two landmarks, a millimeter reading, its own declared uncertainty)
 * to the active hand's `myHandPrior` -- the `/bones` page's whole reason to exist. See that page's own
 * doc comment (and the conversation that designed this, `docs/thumbs/test-results.md`) for the full
 * reasoning; summarized here:
 *
 * A caliper reading is a joint statement about BOTH the ratio(s) it spans (`boneLengths.fingers` for a
 * within-finger span, `boneLengths.knuckleRow` for an adjacent-MCP span) and the shared absolute scale
 * (`boneLengths.handLength`) at once -- both are stored as a ratio to `handLength`, so "this segment is
 * 30mm" is only meaningful relative to how big the whole hand is currently believed to be. Two updates
 * happen per measurement, both via `update.ts`'s existing Bayesian machinery (nothing new invented):
 *
 * 1. **The spanned ratio(s)** (`updateVector`): convert the mm reading to ratio-space using the
 *    CURRENTLY FUSED `handLength` estimate (`ratio = mm / handLength.mean` -- "best current belief,"
 *    the same snapshot the page is showing), propagate variance by the standard delta-method formula
 *    for a ratio of two uncertain quantities (the same approximation `narrowViaTenodesis` already uses
 *    for a product elsewhere in this project), and set `h` to a one-hot vector over exactly the spanned
 *    entries (`boneSpan.ts`). Kalman conditioning does the "coherent" part for free: with the prior's
 *    existing per-entry variance (the covariance's diagonal), the update redistributes across the
 *    individual entries in proportion to each one's own uncertainty -- no invented correlation needed,
 *    since none is measured yet (same honesty `handModelData.ts` already practices: diagonal covariance
 *    because there's nothing to base a stronger correlation on).
 * 2. **`handLength` itself** (`updateScalar`), via an IMPLIED observation:
 *    `impliedHandLength = mm / (pre-update ratio-sum for the spanned entries)`. This is the one
 *    legitimate cross-finger channel: every caliper measurement, on any finger OR knuckle gap, narrows
 *    the shared scale a little, so measuring one thing makes the model slightly more confident about
 *    every other finger's ABSOLUTE size too -- even though that other finger's own ratio stays wherever
 *    it was (literature, InterHand, or unmeasured) until measured directly. Uses the pre-update ratio
 *    (not the post-step-1 one) so the same evidence isn't counted twice within one call.
 *
 * Bootstrapping: the first time something is measured for a hand that has no prior `myHandPrior` belief
 * for it yet, that belief is seeded from whatever's CURRENTLY FUSED AND DISPLAYED (the same
 * `fusedSnapshot` passed in) rather than from nothing -- refining a sensible starting shape, not
 * updating an undefined one.
 */

import { resolveBoneSpan, resolveKnuckleSpan } from './boneSpan'
import type { HandPriorState, ScalarPrior, VectorPrior } from './handModel'
import { type Handedness, mergeCaliperFragment, mergeKnuckleCaliperFragment } from './myHandStore'
import { updateScalar, updateVector } from './update'

export interface CaliperMeasurementInput {
  handedness: Handedness
  landmarkA: number
  landmarkB: number
  mm: number
  uncertaintyMm: number
  /** The snapshot currently fused and shown on screen (whatever sources are checked) -- used both as
   * the "current handLength" reference for the mm->ratio conversion and as the bootstrap source for a
   * ratio/handLength `myHandPrior` has no belief for yet. */
  fusedSnapshot: HandPriorState
}

export type CaliperMeasurementResult = { ok: true } | { ok: false; error: string }

function cloneVectorPrior(p: VectorPrior): VectorPrior {
  return { mean: [...p.mean], covariance: p.covariance.map(row => [...row]), source: p.source, evidenceCount: p.evidenceCount }
}

/** Steps 1+2 from this file's own doc comment, generic over "which ratio-space vector this measurement
 * spans" -- a finger's bone-length segments and the knuckle row are both just a `VectorPrior` plus a
 * set of one-hot indices as far as this math cares. */
function fuseCaliperObservation(
  existingVector: VectorPrior,
  existingHandLength: ScalarPrior,
  spanIndices: number[],
  mm: number,
  uncertaintyMm: number,
  fusedHandLengthMean: number,
  fusedHandLengthVariance: number,
  label: string,
): { vector: VectorPrior; handLength: ScalarPrior } {
  const mmVariance = uncertaintyMm ** 2

  const observedRatioSum = mm / fusedHandLengthMean
  const ratioVariance = mmVariance / fusedHandLengthMean ** 2
    + (mm ** 2 * fusedHandLengthVariance) / fusedHandLengthMean ** 4
  const h = existingVector.mean.map((_, i) => (spanIndices.includes(i) ? 1 : 0))
  const updatedVector = updateVector(existingVector, { value: observedRatioSum, variance: ratioVariance, h, source: 'caliper' })

  const priorRatioSum = spanIndices.reduce((sum, i) => sum + existingVector.mean[i], 0)
  const priorRatioSumVariance = spanIndices.reduce((sum, i) => sum + existingVector.covariance[i][i], 0)
  let updatedHandLength = existingHandLength
  if (priorRatioSum > 0) {
    const impliedHandLength = mm / priorRatioSum
    const impliedVariance = mmVariance / priorRatioSum ** 2
      + (mm ** 2 * priorRatioSumVariance) / priorRatioSum ** 4
    updatedHandLength = updateScalar(existingHandLength, { value: impliedHandLength, variance: impliedVariance, source: 'caliper' })
  }

  return { vector: { ...updatedVector, source: label }, handLength: { ...updatedHandLength, source: label } }
}

export function applyCaliperMeasurement(input: CaliperMeasurementInput): CaliperMeasurementResult {
  const { handedness, landmarkA, landmarkB, mm, uncertaintyMm, fusedSnapshot } = input
  if (!(mm > 0)) return { ok: false, error: 'Measurement must be a positive number of millimeters.' }
  if (!(uncertaintyMm > 0)) return { ok: false, error: 'Uncertainty must be a positive number of millimeters.' }

  const label = `caliper: landmark ${landmarkA}→${landmarkB} = ${mm}mm ± ${uncertaintyMm}mm`
  const fusedHandLengthMean = fusedSnapshot.boneLengths.handLength.mean
  const fusedHandLengthVariance = fusedSnapshot.boneLengths.handLength.variance

  const fingerSpan = resolveBoneSpan(landmarkA, landmarkB)
  if (fingerSpan) {
    const { finger, segmentIndices } = fingerSpan
    const existingFingerPrior = cloneVectorPrior(fusedSnapshot.boneLengths.fingers[finger])
    const existingHandLength: ScalarPrior = { ...fusedSnapshot.boneLengths.handLength }
    const { vector, handLength } = fuseCaliperObservation(
      existingFingerPrior,
      existingHandLength,
      segmentIndices,
      mm,
      uncertaintyMm,
      fusedHandLengthMean,
      fusedHandLengthVariance,
      label,
    )
    mergeCaliperFragment(handedness, {
      finger,
      segments: fusedSnapshot.boneLengths.fingers[finger].segments,
      fingerVector: vector,
      handLength,
    })
    return { ok: true }
  }

  const knuckleSpan = resolveKnuckleSpan(landmarkA, landmarkB)
  if (knuckleSpan) {
    const existingKnuckleRow = cloneVectorPrior(fusedSnapshot.boneLengths.knuckleRow)
    const existingHandLength: ScalarPrior = { ...fusedSnapshot.boneLengths.handLength }
    const { vector, handLength } = fuseCaliperObservation(
      existingKnuckleRow,
      existingHandLength,
      knuckleSpan.gapIndices,
      mm,
      uncertaintyMm,
      fusedHandLengthMean,
      fusedHandLengthVariance,
      label,
    )
    mergeKnuckleCaliperFragment(handedness, { knuckleRowVector: vector, handLength })
    return { ok: true }
  }

  return {
    ok: false,
    error:
      "These two landmarks aren't a supported span -- either the same finger's chain in wrist-to-fingertip order, or two non-thumb MCPs (5, 9, 13, 17) in index-to-pinky order. Other cross-finger spans (e.g. hand breadth) aren't supported yet.",
  }
}
