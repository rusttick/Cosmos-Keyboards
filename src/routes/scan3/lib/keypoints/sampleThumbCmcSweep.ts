/**
 * Stage 6 of docs/thumbs/representing-keyboard-build-inputs.md: the thumb's saddle joint (CMC),
 * isolated as its own sampler rather than folded into `sampleFingerSweep`'s non-thumb loop -- this
 * joint's structure is genuinely different (`degree: 3`, an emergent conjunct-rotation twist rather
 * than an independently-driven third axis), and this project's own test history
 * (`docs/thumbs/test-results.md`) found more ways to get the thumb wrong than any other joint.
 *
 * Deliberately samples ONLY the CMC's 2 driven axes (flexion, abduction) -- the twist (`angleX`) falls
 * out automatically via `fkBy`'s own `conjunctCoupling` handling, not sampled directly. The thumb's
 * remaining two joints (its "MCP"/"IP" hinges, `$lib/hand.ts`'s `degreesFor('thumb')` indices 2/3) are
 * held straight (`[0, 0]`), NOT swept -- `HandPriorState` currently has no prior for them at all
 * (`docs/thumbs/TODO.md`'s own "identified, not started" schema gap: real fitted candidate numbers
 * exist from InterHand2.6M but have nowhere in the schema to land yet). This makes the thumb's sweep a
 * 2-DOF shell, like Stage 3's MCP-only slice, not a Stage 4/5-style filled volume -- an honest
 * reflection of what this project currently models for the thumb, not a simplification chosen for its
 * own sake.
 *
 * Landmark-0 reuses `sampleMcpSweep.ts`'s `PLACEHOLDER_LANDMARK0_POSITION`.
 *
 * Stage 8 adds the same three per-sample costs `sampleFingerSweep.ts` does. `manipulability` is
 * expected to come out exactly 0 for every sample here -- see `manipulability.ts`'s own doc comment:
 * a genuinely correct result for a 2-DOF sweep, not a bug.
 */
import { type Joints, SolvedHand } from '$lib/hand'
import type { Vector3Tuple } from 'three'
import type { HandPriorState } from '../priors/handModel'
import { numericalJacobian, yoshikawaManipulability } from './manipulability'
import { propagatedPositionalVariance } from './positionalUncertainty'
import { totalPostureCost } from './postureCost'
import { PLACEHOLDER_LANDMARK0_POSITION } from './sampleMcpSweep'

const DEG2RAD = Math.PI / 180

export interface ThumbCmcSweepSample {
  /** Thumb-tip world position, in mm. */
  position: Vector3Tuple
  cmcFlexDeg: number
  cmcAbAdDeg: number
  postureCost: number
  /** Always 0 for this sweep -- see this file's top doc comment. */
  manipulability: number
  positionalVariance: number
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function gridT(i: number, steps: number): number {
  return steps === 1 ? 0 : i / (steps - 1)
}

/**
 * Grid-samples the thumb CMC's flexion and abduction axes across their own `BetaRom` bounds from the
 * fused prior, holding the thumb's other two joints straight. `stepsPerAxis` samples per axis, so this
 * returns `stepsPerAxis ** 2` samples.
 */
export function sampleThumbCmcSweep(
  skeleton: Joints,
  prior: HandPriorState,
  stepsPerAxis = 16,
): ThumbCmcSweepSample[] {
  const cmc = prior.cmcMobility.thumb
  const solved = new SolvedHand(skeleton, PLACEHOLDER_LANDMARK0_POSITION)
  const samples: ThumbCmcSweepSample[] = []

  const positionAt = ([cmcFlexRad, cmcAbAdRad]: number[]): Vector3Tuple => {
    // Joint index 1 is the CMC saddle (degree: 3) -- fkBy derives its own twist (angleX) from
    // (angleZ, angleY) via conjunctCoupling, so only these two need driving here. Indices 2/3 (the
    // thumb's un-modeled MCP/IP hinges) are held straight, per this file's top doc comment.
    solved.fkBy('thumb', (jointIndex) => (jointIndex === 1 ? [cmcFlexRad, cmcAbAdRad] : [0, 0]))
    // scale=1: `buildDefaultSkeleton` bakes joint lengths as already-absolute millimeters -- see
    // `sampleMcpSweep.ts`'s doc comment for the confirmed-live scale bug this avoids repeating.
    return solved.worldPositions('thumb', 1)[4].toArray() as Vector3Tuple
  }

  for (let i = 0; i < stepsPerAxis; i++) {
    const cmcFlexDeg = lerp(cmc.flexExtRom.minDeg, cmc.flexExtRom.maxDeg, gridT(i, stepsPerAxis))

    for (let j = 0; j < stepsPerAxis; j++) {
      const cmcAbAdDeg = lerp(cmc.abAdRom.minDeg, cmc.abAdRom.maxDeg, gridT(j, stepsPerAxis))
      const anglesRad = [cmcFlexDeg * DEG2RAD, cmcAbAdDeg * DEG2RAD]

      const position = positionAt(anglesRad)
      const jacobian = numericalJacobian(positionAt, anglesRad)

      samples.push({
        position,
        cmcFlexDeg,
        cmcAbAdDeg,
        postureCost: totalPostureCost([
          { angleDeg: cmcFlexDeg, rom: cmc.flexExtRom },
          { angleDeg: cmcAbAdDeg, rom: cmc.abAdRom },
        ]),
        manipulability: yoshikawaManipulability(jacobian),
        positionalVariance: propagatedPositionalVariance(jacobian, [cmc.flexExtRom.sdDeg, cmc.abAdRom.sdDeg]),
      })
    }
  }

  return samples
}
