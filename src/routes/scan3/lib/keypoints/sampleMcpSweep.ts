/**
 * Stage 3 of docs/thumbs/representing-keyboard-build-inputs.md: the first real capability-sample
 * path -- fused prior -> grid-sampled MCP joint angles -> `fkBy` -> world positions -- on the smallest
 * possible slice (one non-thumb finger's MCP only, every other joint held straight) before Stage 4
 * generalizes to that finger's full chain.
 *
 * Landmark-0's position is fixed here -- an explicit Step-0 placeholder, not a modeled wrist pose; per
 * the plan doc's design principle, this must never be read as a finished statement about where the
 * wrist belongs. It is NOT plain identity, though (unlike `ikSolve.ts`'s own `poseToLandmarkVectors`,
 * which uses identity for a different purpose -- producing landmark vectors in this project's existing
 * MediaPipe-relative convention, not a scene laid out against an external ground plane). Confirmed
 * live: `$lib/hand.ts`'s `fkBy` treats local Z as the flexion axis (sweeps the local XY-plane) and
 * local Y as the abduction axis (sweeps the local XZ-plane) -- meaning local Y is this convention's
 * palm normal. Plain identity puts that normal along world Y, making the palm plane world XZ --
 * perpendicular to this viewer's ground grid (world XY, z-up). `PLACEHOLDER_LANDMARK0_POSITION` rotates
 * that normal onto world Z instead, so the rest pose lies flat in the grid plane and abduction fans
 * sideways within it -- still an arbitrary fixed pose (no real Step-0 sampling), just one that reads as
 * "a hand resting on the grid" instead of a directionless jumble at 90 degrees. The sign
 * (`-Math.PI/2`, not `+Math.PI/2`) was picked live: the first sign put every finger's flexion sweep
 * curling in a direction that read as the whole hand upside down; a further 180-degree turn about the
 * same (red/x) axis the scale labels sit on fixed it, confirmed against the rendered scene, not derived
 * from first principles -- the same "live-verify signs, don't guess" practice
 * `docs/thumbs/test-results.md` establishes for `thumbDepthSign`/`signedJointAngle` elsewhere.
 */
import { FINGERS, type Joints, SolvedHand } from '$lib/hand'
import { Matrix4, type Vector3Tuple } from 'three'
import type { HandPriorState, NonThumbFinger } from '../priors/handModel'

const DEG2RAD = Math.PI / 180

/** See this file's top doc comment -- maps `$lib/hand.ts`'s palm-normal axis (local Y) onto world Z
 * (this viewer's "up", matching its ground grid), so the placeholder rest pose reads as a hand lying
 * flat on the grid rather than standing perpendicular to it, right-side up rather than upside down. */
export const PLACEHOLDER_LANDMARK0_POSITION = new Matrix4().makeRotationX(-Math.PI / 2)

export interface McpSweepSample {
  /** Fingertip world position, in mm. */
  position: Vector3Tuple
  flexZDeg: number
  abAdYDeg: number
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/**
 * Grid-samples one non-thumb finger's MCP joint (both axes) across its own `BetaRom` bounds from the
 * fused prior, holding every other joint (PIP, DIP) straight -- the smallest real slice of
 * `key-point-selection.md`'s Step 1 candidate space. `stepsPerAxis` samples per axis, so this returns
 * `stepsPerAxis ** 2` samples.
 */
export function sampleMcpSweep(
  skeleton: Joints,
  finger: NonThumbFinger,
  prior: HandPriorState,
  stepsPerAxis = 12,
): McpSweepSample[] {
  const rom = prior.mcpAxes[finger]
  const solved = new SolvedHand(skeleton, PLACEHOLDER_LANDMARK0_POSITION)
  const samples: McpSweepSample[] = []

  for (let i = 0; i < stepsPerAxis; i++) {
    const flexT = stepsPerAxis === 1 ? 0 : i / (stepsPerAxis - 1)
    const flexZDeg = lerp(rom.flexExtRom.minDeg, rom.flexExtRom.maxDeg, flexT)

    for (let j = 0; j < stepsPerAxis; j++) {
      const abAdT = stepsPerAxis === 1 ? 0 : j / (stepsPerAxis - 1)
      const abAdYDeg = lerp(rom.abAdRom.minDeg, rom.abAdRom.maxDeg, abAdT)

      solved.fkBy(finger, (jointIndex) => (jointIndex === 1 ? [flexZDeg * DEG2RAD, abAdYDeg * DEG2RAD] : [0, 0]))
      // scale=1, not `worldPositions`' own scale=100 default: `buildDefaultSkeleton` (`ikSolve.ts`)
      // bakes joint lengths as already-absolute millimeters (`bones.mean[i] * handLength`, where
      // `handLength` is real mm), unlike `calculateJoints`'s live-tracking fit path, where `length` is
      // a plain unitless ratio and `scale=100` is what converts it to mm. Using the default here
      // double-applies that conversion -- confirmed live (positions ~100x too large, ~15,000mm instead
      // of ~150mm) before this fix.
      const fingertip = solved.worldPositions(finger, 1)[4]
      samples.push({ position: fingertip.toArray() as Vector3Tuple, flexZDeg, abAdYDeg })
    }
  }

  return samples
}

/** Sanity guard: `finger` must be one of the four non-thumb fingers this sampler supports (the thumb's
 * saddle-joint sampling is Stage 6's own, separate concern). */
export function isNonThumbFinger(finger: string): finger is NonThumbFinger {
  return (FINGERS as readonly string[]).includes(finger) && finger !== 'thumb'
}
