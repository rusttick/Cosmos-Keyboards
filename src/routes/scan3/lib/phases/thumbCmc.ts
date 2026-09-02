/**
 * Phase 6a/6b: thumb CMC axis fit, conjunct-rotation coupling, and the false-plateau occlusion guard
 * — Tests 10 and 11, docs/thumbs/scan_tests.md.
 */

import { type ConjunctCoupling, fitNorms, type Hand, type Joint, signedJointAngle } from '$lib/hand'
import { Matrix4, Vector3 } from 'three'
import { PlateauDetector, type PlateauOptions } from '../completion/plateau'

/** Phase 6a: fit the thumb CMC's flexion-extension/abduction-adduction axis from a rigid outer-CMC
 * sweep (thumb held straight, only the CMC moving). No new algorithm — this is `fitNorms`, already
 * used to fit every finger's MCP frame, applied to the thumb's own metacarpal direction data for the
 * first time (see scan3.md, "Why this is a smaller change than it looks").
 *
 * Fits on `limbs.thumb[1]` (the CMC-landmark-to-MCP-landmark segment, the actual first metacarpal —
 * the rigid body that pivots *at* the CMC), not `limbs.thumb[0]` (wrist-to-CMC-landmark). MediaPipe
 * models the wrist as a zero-width single point, so `thumb[0]` sits too close to the CMC's own pivot
 * to carry much real rotation — confirmed live (a real ~15-40° sweep read as ~4-5° on `thumb[0]` but
 * ~30-38° on `thumb[1]`) and independently by a published single-camera thumb motion capture study
 * (docs/thumbs/test_results.md, 2026-09-01), which explicitly avoids using the wrist as a CMC pivot
 * reference for the same reason. */
export function fitThumbCmcAxis(history: Hand[], length: number, matrix: Matrix4): Joint {
  const vecs = history.map((h) => h.limbs.thumb[1])
  return fitNorms(vecs, true, length, matrix)
}

/** Flexion/abduction (degrees) of the thumb's metacarpal (limb 1) relative to the fitted CMC joint
 * frame — the same observed-x → YZ-Euler recovery `SolvedHand.ik()` already uses for this exact
 * problem (an observed direction has two degrees of freedom, matching a Y/Z Euler pair). */
function flexionAbduction(metacarpal: Vector3, cmcJoint: Joint): [flexion: number, abduction: number] {
  const x = metacarpal.clone().normalize().applyMatrix4(cmcJoint.V)
  const zAngle = Math.asin(clamp(x.y, -1, 1))
  const yAngle = Math.asin(clamp(x.z / -Math.cos(zAngle), -1, 1))
  return [(zAngle * 180) / Math.PI, (yAngle * 180) / Math.PI]
}

/** Signed axial twist (degrees) of bone2 (the thumb's IP segment) about bone1 (the metacarpal, the
 * CMC's own rotating segment), relative to a reference bone2 direction. Standard way to measure a
 * segment's own roll: project the downstream segment onto the plane perpendicular to the roll axis and
 * measure its rotation there relative to a known reference — here, the mean bone2 direction from the
 * rigid Phase 6a sweep, where by construction there was no CMC-driven twist to speak of (the thumb was
 * held straight throughout). */
function twistAngle(metacarpal: Vector3, bone2: Vector3, referenceBone2: Vector3): number {
  const axis = metacarpal.clone().normalize()
  const projectOut = (v: Vector3) => v.clone().addScaledVector(axis, -v.dot(axis)).normalize()
  const a = projectOut(referenceBone2)
  const b = projectOut(bone2)
  const unsignedAngle = a.angleTo(b)
  const sign = new Vector3().crossVectors(a, b).dot(axis) < 0 ? -1 : 1
  return (sign * unsignedAngle * 180) / Math.PI
}

/** Phase 6b: regress the freeform sweep's observed axial twist against the two driven CMC rotations
 * (flexion, abduction) to produce `conjunctCoupling` — the CMC analogue of `fitEnslaving`, fit within
 * one joint's three rotations rather than across two fingers, and not elicited as its own instruction
 * since it isn't independently controllable (scan_procedure.md). Through-origin least squares (no
 * intercept), matching `ConjunctCoupling`'s shape and the `twist ≈ aCoeff·flexion + bCoeff·abduction`
 * formula. Requires `cmcJoint` (Phase 6a's fitted axis) and `referenceBone2` (its mean bone2 direction)
 * to already exist — Phase 6b's angles are only meaningful relative to Phase 6a's fitted frame. */
export function fitConjunctCoupling(
  history: Hand[],
  cmcJoint: Joint,
  referenceBone2: Vector3,
): ConjunctCoupling {
  if (history.length < 3) {
    throw new Error('fitConjunctCoupling needs at least 3 frames')
  }

  const samples = history.map((hand) => {
    const [flexion, abduction] = flexionAbduction(hand.limbs.thumb[1], cmcJoint)
    const twist = twistAngle(hand.limbs.thumb[1], hand.limbs.thumb[2], referenceBone2)
    return { flexion, abduction, twist }
  })

  // Normal equations for twist = a*flexion + b*abduction, fit through the origin:
  //   a*sum(F^2) + b*sum(F*A) = sum(F*twist)
  //   a*sum(F*A) + b*sum(A^2) = sum(A*twist)
  const sumFF = sum(samples.map((s) => s.flexion * s.flexion))
  const sumAA = sum(samples.map((s) => s.abduction * s.abduction))
  const sumFA = sum(samples.map((s) => s.flexion * s.abduction))
  const sumFT = sum(samples.map((s) => s.flexion * s.twist))
  const sumAT = sum(samples.map((s) => s.abduction * s.twist))

  const det = sumFF * sumAA - sumFA * sumFA
  const [aCoeff, bCoeff] = det === 0
    ? [0, 0]
    : [
      (sumFT * sumAA - sumAT * sumFA) / det,
      (sumAT * sumFF - sumFT * sumFA) / det,
    ]

  const ssRes = sum(samples.map((s) => (s.twist - aCoeff * s.flexion - bCoeff * s.abduction) ** 2))
  const ssTwist = sum(samples.map((s) => s.twist * s.twist))
  const r2 = ssTwist === 0 ? 1 : 1 - ssRes / ssTwist

  return { aCoeff, bCoeff, r2 }
}

/** Phase 6b byproduct: thumb MCP/IP flexion, read the same signed way every other finger's flexion is
 * (limb boundary 1 = MCP-equivalent, 2 = IP-equivalent — see the labeling caveat already documented
 * for the thumb in flexion-sweep's methodology notes). No dedicated fit here — per scan_procedure.md
 * this is meant to fall out of the same freeform trajectory as a byproduct, with the caller tracking
 * ROM the same way any other phase does (e.g. feeding these into a PlateauDetector), not a new
 * algorithm in its own right. */
export function thumbMcpIpAngles(hand: Hand): [mcp: number, ip: number] {
  return [signedJointAngle(hand, 'thumb', 1), signedJointAngle(hand, 'thumb', 2)]
}

export interface OcclusionGuardOptions extends PlateauOptions {
  /** Per-frame confidence threshold for a frame to count as "healthy yield" — matches the product's
   * existing 0.7 confidence-acceptance convention used elsewhere in this test suite. */
  confidenceThreshold: number
  /** A rep's fraction of frames clearing confidenceThreshold must stay at or above this for that rep
   * to count as healthy. A rep where yield collapses — even if the pushed angles still look plateaued
   * — means occlusion is a live possibility, not necessarily a true limit. */
  minHealthyYield: number
}

export type ThumbSweepStatus = 'in-progress' | 'converged' | 'possibly-occluded'

/** Phase 6a's false-plateau guard: scan_procedure.md's requirement that the occlusion guard "only
 * accept convergence if confidence/yield stayed healthy through the last k cycles, not just the
 * angles." Wraps `PlateauDetector` by composition (not modification — plateau.ts is unchanged) with a
 * parallel per-rep confidence-yield track, so a sweep that plateaus because the thumb went out of view
 * (angles stop growing because MediaPipe stopped seeing the true extreme, not because the person
 * stopped moving) is distinguished from a genuine limit. */
export class OcclusionGuardedPlateau {
  private detector: PlateauDetector
  private repFrames = 0
  private repHealthyFrames = 0
  private repYields: number[] = []

  constructor(private options: OcclusionGuardOptions) {
    this.detector = new PlateauDetector(options)
  }

  push(angles: number[], confidence: number) {
    const repsBefore = this.detector.repCount
    this.detector.push(angles)

    this.repFrames++
    if (confidence >= this.options.confidenceThreshold) this.repHealthyFrames++

    if (this.detector.repCount > repsBefore) {
      this.repYields.push(this.repFrames === 0 ? 0 : this.repHealthyFrames / this.repFrames)
      this.repFrames = 0
      this.repHealthyFrames = 0
    }
  }

  get repCount(): number {
    return this.detector.repCount
  }

  get ranges() {
    return this.detector.ranges
  }

  /** Per-rep yield (fraction of confidence-passing frames), most recent last — exposed mainly so a
   * live UI can show why a sweep was flagged 'possibly-occluded' rather than 'converged'. */
  get yields(): number[] {
    return [...this.repYields]
  }

  status(): ThumbSweepStatus {
    if (!this.detector.isConverged()) return 'in-progress'
    const n = this.options.requiredStableReps ?? 2
    const recent = this.repYields.slice(-n)
    const healthy = recent.length === n && recent.every((y) => y >= this.options.minHealthyYield)
    return healthy ? 'converged' : 'possibly-occluded'
  }
}

export interface GrowthPlateauOptions {
  /** Trailing window, in seconds, to check for growth. */
  windowSeconds: number
  /** If the running max hasn't grown by more than this (same units as pushed values) over the
   * trailing window, the sweep is considered plateaued. */
  convergenceThreshold: number
  confidenceThreshold: number
  /** Fraction of frames in the trailing window that must clear confidenceThreshold for a plateau to
   * be accepted as genuine rather than flagged as possibly-occluded. */
  minHealthyYield: number
  /** The running max must reach at least this before convergence is allowed at all, regardless of how
   * flat its growth curve looks. A live-tuning finding, not part of the original design: growth
   * plateauing is necessary but not sufficient for "this is a real limit" -- a person deciding where to
   * move next, or moving within an already-explored sub-range for a few seconds, can look identical to
   * genuine convergence at a small max, well below any physically plausible joint range. Optional and
   * defaults to 0 (disabled) so callers with a signal whose plausible range isn't known in advance (or
   * tests exercising the growth logic in isolation) aren't forced to supply one. */
  minPlausibleMax?: number
}

/** Phase 6a's false-plateau guard, magnitude/growth-based rather than rep-based.
 *
 * `OcclusionGuardedPlateau` (above) assumes a signal with a clean single-axis "flex to max, then
 * extend" shape — true for finger flexion (Tests 6/7), but not for the thumb CMC's outer sweep, which
 * explores two independent DOFs (flexion-extension and abduction-adduction) at once and has no fitted
 * axis yet to project onto cleanly (fitting that axis is what this very sweep produces). A first
 * attempt reused the finger-flexion knuckle-axis convention as a signed single-axis proxy and hit two
 * live-tuning failures in a row — false reps from a fixed hysteresis threshold unable to both reject
 * noise and trigger on modest motion, then (after smoothing fixed that) still needing far more motion
 * than expected, traced to the proxy axis being anatomically mismatched for the CMC. See
 * docs/thumbs/test_results.md, 2026-09-01, for the full live-tuning history.
 *
 * This guard sidesteps needing an axis, a sign, or discrete rep boundaries entirely: it tracks the
 * running maximum of an unsigned magnitude (e.g. total angular distance from a start reference,
 * direction-agnostic across both CMC axes) and declares convergence once that max hasn't grown by more
 * than `convergenceThreshold` over the trailing `windowSeconds` — the same "has this stopped changing"
 * idea `stillWindow.ts` already uses for stillness, applied to a running maximum instead. */
export class OcclusionGuardedGrowthPlateau {
  private samples: { t: number; magnitude: number; confidence: number }[] = []
  private runningMax = 0

  constructor(private options: GrowthPlateauOptions) {}

  push(t: number, magnitude: number, confidence: number) {
    if (magnitude > this.runningMax) this.runningMax = magnitude
    this.samples.push({ t, magnitude, confidence })
  }

  get max(): number {
    return this.runningMax
  }

  status(): ThumbSweepStatus {
    if (this.samples.length === 0) return 'in-progress'
    const now = this.samples[this.samples.length - 1].t
    const windowStart = now - this.options.windowSeconds

    const before = this.samples.filter((s) => s.t <= windowStart)
    if (before.length === 0) return 'in-progress' // not enough elapsed time yet to evaluate a window

    const maxBeforeWindow = before.reduce((m, s) => Math.max(m, s.magnitude), 0)
    const growth = this.runningMax - maxBeforeWindow
    if (growth > this.options.convergenceThreshold) return 'in-progress'

    if (this.options.minPlausibleMax !== undefined && this.runningMax < this.options.minPlausibleMax) {
      return 'in-progress'
    }

    const windowSamples = this.samples.filter((s) => s.t > windowStart)
    const healthyCount = windowSamples.filter((s) => s.confidence >= this.options.confidenceThreshold).length
    const yieldFraction = windowSamples.length === 0 ? 0 : healthyCount / windowSamples.length
    return yieldFraction >= this.options.minHealthyYield ? 'converged' : 'possibly-occluded'
  }
}

function sum(xs: number[]) {
  return xs.reduce((a, b) => a + b, 0)
}

function clamp(x: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, x))
}
