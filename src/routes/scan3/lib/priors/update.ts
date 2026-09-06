/**
 * The only place `HandPriorState` is ever written. Everything else in this project (`ikSolve.ts`
 * included) only ever reads it as fixed input for a frame's solve or a render. Writing to it happens
 * exclusively through the functions here, and only ever from a deliberate measurement act -- a
 * capture-session phase's fitted result, a caliper/goniometer reading, or a manual numeric entry --
 * never from ordinary live tracking, no matter how many frames of it accumulate or how consistent they
 * look. That boundary is what stops an impossible movement or a spontaneous tracking glitch from
 * quietly becoming the new "ground truth": nothing calls the functions below except a designated
 * capture action, and this file doesn't know or care where its caller got the observation, only that
 * calling it at all is itself the thing that marks an act as deliberate.
 *
 * The update itself is a standard Bayesian belief update: an observation with its own declared noise
 * gets blended into the current (mean, variance/covariance) belief, moving the mean toward it and
 * shrinking the variance, in proportion to how confident the observation is relative to the belief
 * it's updating. A caliper reading (very low declared noise) can move a belief a lot in one update; a
 * self-reported manual estimate (wide declared noise) barely moves it. This is exactly the same
 * variance-weighted blending `ikSolve.ts` already does for a single frame's pose correction -- applied
 * here to the long-lived, cross-session belief instead of one frame's pose.
 *
 * Two things this file deliberately does NOT implement, named rather than silently skipped:
 * - The "cross-session consistency" half of the promotion gate `average-hand.md` describes (comparing
 *   a new observation against previous ones before trusting it, on top of the exclusion rule below) --
 *   no concrete algorithm or threshold for that exists anywhere in this project's docs yet. What IS
 *   implemented is `evidenceCount` tracking (`handModel.ts`), which is a real piece of "session count"
 *   evidence-reporting `goals.md` asks for, but not itself a consistency check.
 * - Any caller. There's no `ScanSession` capture pipeline built yet (see TODO.md) to call these
 *   functions from -- this is the update mechanism itself, ready for that pipeline to call.
 */

import type { ScalarPrior, VectorPrior } from './handModel'

export type ObservationSource = 'mediapipe' | 'caliper' | 'goniometer' | 'manual-entry'

export interface Observation {
  value: number
  /** This observation's own noise, as a variance in the same units as `value` -- not a fixed property
   * of `source`, since the same source can carry different noise depending on how it was actually
   * obtained (a goniometer reading behaves like a caliper measurement; a self-reported estimate
   * doesn't). The caller declares it; this file just uses whatever it's given. */
  variance: number
  source: ObservationSource
  /** An observation from an excluded capture condition (dorsal orientation, thumb-lateral angle,
   * an implausible manual entry) -- `goals.md`'s exclusion rule. Never blended in, regardless of how
   * many otherwise-good observations have already accumulated: this is what stops the posterior from
   * confidently converging on a wrong value the way unsupervised self-calibration would. */
  excluded?: boolean
}

/** A linear-combination observation of a `VectorPrior`'s state: `value ≈ dot(h, state.mean)`, with its
 * own noise variance. `h = [1, 0, 0, ...]` is an ordinary "observed just the first entry" reading;
 * anything else lets one observation constrain a combination of several entries at once. */
export interface VectorObservation extends Observation {
  h: number[]
}

/** The standard scalar Bayesian conjugate-Gaussian update: blend one noisy observation into a
 * (mean, variance) belief. Moves the mean toward the observation and shrinks the variance, both in
 * proportion to the observation's own precision (1/variance) relative to the belief's current
 * precision -- a low-noise observation (caliper, goniometer) dominates; a high-noise one (a
 * self-reported manual estimate, or an uncorrected MediaPipe reading) barely moves it. */
export function updateScalar(prior: ScalarPrior, obs: Observation): ScalarPrior {
  if (obs.excluded) return prior
  const priorPrecision = 1 / prior.variance
  const obsPrecision = 1 / obs.variance
  const posteriorPrecision = priorPrecision + obsPrecision
  const posteriorVariance = 1 / posteriorPrecision
  const posteriorMean = posteriorVariance * (prior.mean * priorPrecision + obs.value * obsPrecision)
  return {
    mean: posteriorMean,
    variance: posteriorVariance,
    source: prior.source,
    evidenceCount: (prior.evidenceCount ?? 0) + 1,
  }
}

/** The vector analogue: a Kalman scalar-measurement update against a `VectorPrior`'s full covariance.
 * This is the mechanism that makes a confidently-observed entry narrow a *correlated* entry too, not
 * just its own -- the standard multivariate-Gaussian conditioning identity, not a per-entry special
 * case. If `h` picks out just one entry (e.g. `[1, 0]`) and that entry is correlated with others
 * (nonzero off-diagonal covariance), those others narrow too, in proportion to how strongly the prior
 * ties them together. */
export function updateVector(prior: VectorPrior, obs: VectorObservation): VectorPrior {
  if (obs.excluded) return prior
  const { mean, covariance } = prior
  const n = mean.length

  // Sigma * h
  const Sh = covariance.map(row => row.reduce((sum, c, j) => sum + c * obs.h[j], 0))
  // h^T * Sigma * h + R  (the innovation's own variance)
  const innovationVariance = obs.h.reduce((sum, hi, i) => sum + hi * Sh[i], 0) + obs.variance
  const predicted = obs.h.reduce((sum, hi, i) => sum + hi * mean[i], 0)
  const innovation = obs.value - predicted

  const newMean = mean.map((m, i) => m + (Sh[i] / innovationVariance) * innovation)
  const newCovariance = covariance.map((row, i) => row.map((c, j) => c - (Sh[i] * Sh[j]) / innovationVariance))

  return {
    mean: newMean,
    covariance: newCovariance,
    source: prior.source,
    evidenceCount: (prior.evidenceCount ?? 0) + 1,
  }
}

/** The one cross-group correlation this project can actually narrow a Group G quantity with today
 * (`goals.md`'s tenodesis effect): a confidently-known average finger rest-flexion implies a wrist
 * flex/ext (or radial/ulnar) value, `wristAngle ≈ tenodesisCoupling.mean * avgFingerFlexion.mean`, and
 * that implied value is folded in as one more scalar observation of the wrist -- via `updateScalar`,
 * not a second mechanism -- with its noise propagated from how confident the finger reading and the
 * coupling coefficient itself both are. This is the concrete answer to "how does a permanently
 * unobserved quantity still narrow": it's an ordinary `updateScalar` call whose observation happens to
 * be *computed* from another belief instead of measured directly, not a special code path.
 *
 * With today's uninformative `tenodesisCoupling` seed (mean 0, wide variance), this still runs and
 * still narrows the wrist prior a little -- toward "no tenodesis effect assumed" -- which is the
 * correct, honest behavior for an uninformative-but-real coupling term, not a bug to special-case away. */
export function narrowViaTenodesis(
  wristPrior: ScalarPrior,
  avgFingerFlexion: ScalarPrior,
  tenodesisCoupling: ScalarPrior,
): ScalarPrior {
  const impliedValue = tenodesisCoupling.mean * avgFingerFlexion.mean
  // Variance of a product of two uncertain factors, propagated to first order (dropping their
  // covariance, since the two beliefs come from unrelated parts of the model with no cited
  // correlation of their own) -- the same approximation `ikSolve.ts` already uses for its coupling
  // terms.
  const impliedVariance = tenodesisCoupling.mean ** 2 * avgFingerFlexion.variance
    + tenodesisCoupling.variance * avgFingerFlexion.mean ** 2

  if (!Number.isFinite(impliedVariance) || impliedVariance <= 0) return wristPrior

  return updateScalar(wristPrior, { value: impliedValue, variance: impliedVariance, source: 'mediapipe' })
}
