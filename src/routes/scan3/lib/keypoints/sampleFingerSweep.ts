/**
 * Stage 4 of docs/thumbs/representing-keyboard-build-inputs.md: one non-thumb finger's *full* chain
 * (MCP's 2 axes + PIP's 1 axis), generalizing Stage 3's MCP-only sweep (`sampleMcpSweep.ts`). Unlike
 * Stage 3, this is a genuine 3-DOF sample -- the fingertip sweep should fill a 3D region rather than
 * trace a 2D shell, per `goals.md`'s own reasoning (a fingertip position is a function of however many
 * free joint angles feed it; 2 free angles generically trace a surface, 3 fill a volume).
 *
 * DIP is deliberately NOT an independently-sampled dimension: `goals.md`/`key-point-selection.md` both
 * require it be derived from PIP via that finger's own fitted `dipPipCoupling` posterior
 * (`dip ≈ slope·pip + intercept`) rather than sampled freely -- sampling it independently would
 * silently reintroduce a DOF the fitted data says doesn't exist as its own free variable.
 *
 * Ring and pinky get a real 4th free DOF (their own base-of-hand flexion toward the thumb,
 * `cmcMobility.ring/pinky.flexionRom`) that index/middle don't have -- `$lib/hand.ts`'s
 * `degreesFor('ringFinger'|'pinky')` gives them `degree: 1` at joint index 0 (a real hinge), unlike
 * index/middle's fixed `degree: 0` metacarpal. This was missing in an earlier version of this file
 * (joint 0 held at `[0, 0]` for every finger) -- caught live, 2026-09-07, when
 * `docs/thumbs/representing-keyboard-build-inputs.md`'s Stage 7 neutral-pose skeleton (which *does*
 * pose this joint, via `neutralPose.ts`) visibly landed outside ring/pinky's own sweep cloud, since the
 * cloud itself never explored the dimension the neutral pose was using. Per `key-point-selection.md`'s
 * own warning, omitting it "silently reproduces the 'rigid palm' assumption this whole model exists to
 * remove" -- so it's included here for the two fingers that actually have it, not folded into the
 * general case for every finger.
 *
 * Landmark-0 reuses Stage 3's `PLACEHOLDER_LANDMARK0_POSITION` -- still an explicit Step-0 placeholder,
 * not a modeled wrist pose.
 *
 * Stage 8 adds three per-sample costs (posture, manipulability, propagated positional variance) via
 * `postureCost.ts`/`manipulability.ts`/`positionalUncertainty.ts` -- see those files' own doc comments
 * for what each actually measures and which simplifications they make.
 */
import { type Joints, SolvedHand } from '$lib/hand'
import type { Vector3Tuple } from 'three'
import type { BetaRom, HandPriorState, NonThumbFinger } from '../priors/handModel'
import { numericalJacobian, yoshikawaManipulability } from './manipulability'
import { propagatedPositionalVariance } from './positionalUncertainty'
import { totalPostureCost } from './postureCost'
import { PLACEHOLDER_LANDMARK0_POSITION } from './sampleMcpSweep'

const DEG2RAD = Math.PI / 180

/** Ring/pinky's own base-joint flexion ROM (`cmcMobility.ring/pinky.flexionRom`), or `undefined` for
 * index/middle, whose metacarpal is genuinely fixed (`degree: 0`, no DOF to sweep). */
function baseFlexionRom(prior: HandPriorState, finger: NonThumbFinger): BetaRom | undefined {
  if (finger === 'ringFinger') return prior.cmcMobility.ring.flexionRom
  if (finger === 'pinky') return prior.cmcMobility.pinky.flexionRom
  return undefined
}

export interface FingerSweepSample {
  /** Fingertip world position, in mm. */
  position: Vector3Tuple
  /** Ring/pinky's own base-of-hand flexion (`degree: 1` at joint index 0) -- always 0 for index/middle,
   * whose metacarpal has no DOF to move. See this file's top doc comment. */
  baseFlexDeg: number
  mcpFlexDeg: number
  mcpAbAdDeg: number
  pipFlexDeg: number
  /** Derived from `pipFlexDeg` via the finger's fitted `dipPipCoupling` posterior, not independently
   * sampled -- see this file's top doc comment. */
  dipFlexDeg: number
  /** Sum of the free DOF's own Gaussian posture costs (base flexion where it exists, MCP flex/ab-ad,
   * PIP flex) -- DIP is derived, not a free posture variable, so it's excluded, per `postureCost.ts`. */
  postureCost: number
  /** Yoshikawa's manipulability index over the free DOF -- see `manipulability.ts`. */
  manipulability: number
  /** Propagated positional variance (mm²) from the free DOF's own fitted uncertainty -- see
   * `positionalUncertainty.ts`. */
  positionalVariance: number
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function gridT(i: number, steps: number): number {
  return steps === 1 ? 0 : i / (steps - 1)
}

/**
 * Grid-samples one non-thumb finger's full free-DOF list (base flexion where it exists, MCP flex/ab-ad,
 * PIP flex) across each DOF's own `BetaRom` bounds from the fused prior, deriving DIP from PIP via
 * `dipPipCoupling`. `stepsPerAxis` samples per axis for MCP/PIP; the base-flexion axis (ring/pinky
 * only) uses a coarser `BASE_FLEXION_STEPS` to bound the total sample count, since it's an additional
 * dimension on top of the other three, not a replacement for any of them. Returns `stepsPerAxis ** 3`
 * samples for index/middle, `BASE_FLEXION_STEPS * stepsPerAxis ** 3` for ring/pinky.
 */
export function sampleFingerSweep(
  skeleton: Joints,
  finger: NonThumbFinger,
  prior: HandPriorState,
  stepsPerAxis = 8,
): FingerSweepSample[] {
  const mcp = prior.mcpAxes[finger]
  const pipRom = prior.pipDipRom.pip[finger]
  const dipRom = prior.pipDipRom.dip[finger]
  const [slope, intercept] = prior.dipPipCoupling[finger].mean
  const baseRom = baseFlexionRom(prior, finger)
  const BASE_FLEXION_STEPS = 4

  const solved = new SolvedHand(skeleton, PLACEHOLDER_LANDMARK0_POSITION)
  const samples: FingerSweepSample[] = []

  // Shared FK wrapper for both the actual sample and the Jacobian's finite-difference perturbations --
  // DIP is recomputed from (possibly perturbed) PIP each call, so the Jacobian correctly captures the
  // coupling's own effect on fingertip position, not just the directly-driven angles' effect. `angles`
  // is `[baseFlexRad?, mcpFlexRad, mcpAbAdRad, pipFlexRad]` -- the leading base-flexion entry is only
  // present when `baseRom` exists (ring/pinky).
  const positionAt = (angles: number[]): Vector3Tuple => {
    let idx = 0
    const baseFlexRad = baseRom ? angles[idx++] : 0
    const mcpFlexRad = angles[idx++]
    const mcpAbAdRad = angles[idx++]
    const pipFlexRad = angles[idx++]
    const pipFlexDegHere = pipFlexRad / DEG2RAD
    const dipFlexRad = Math.min(
      dipRom.maxDeg * DEG2RAD,
      Math.max(dipRom.minDeg * DEG2RAD, (slope * pipFlexDegHere + intercept) * DEG2RAD),
    )
    solved.fkBy(finger, (jointIndex) => {
      if (jointIndex === 0) return [baseFlexRad, 0]
      if (jointIndex === 1) return [mcpFlexRad, mcpAbAdRad]
      if (jointIndex === 2) return [pipFlexRad, 0]
      if (jointIndex === 3) return [dipFlexRad, 0]
      return [0, 0]
    })
    // scale=1: `buildDefaultSkeleton` bakes joint lengths as already-absolute millimeters -- see
    // `sampleMcpSweep.ts`'s doc comment for the confirmed-live scale bug this avoids repeating.
    return solved.worldPositions(finger, 1)[4].toArray() as Vector3Tuple
  }

  const baseSteps = baseRom ? BASE_FLEXION_STEPS : 1

  for (let b = 0; b < baseSteps; b++) {
    const baseFlexDeg = baseRom ? lerp(baseRom.minDeg, baseRom.maxDeg, gridT(b, baseSteps)) : 0

    for (let i = 0; i < stepsPerAxis; i++) {
      const mcpFlexDeg = lerp(mcp.flexExtRom.minDeg, mcp.flexExtRom.maxDeg, gridT(i, stepsPerAxis))

      for (let j = 0; j < stepsPerAxis; j++) {
        const mcpAbAdDeg = lerp(mcp.abAdRom.minDeg, mcp.abAdRom.maxDeg, gridT(j, stepsPerAxis))

        for (let k = 0; k < stepsPerAxis; k++) {
          const pipFlexDeg = lerp(pipRom.minDeg, pipRom.maxDeg, gridT(k, stepsPerAxis))
          const anglesRad = baseRom
            ? [baseFlexDeg * DEG2RAD, mcpFlexDeg * DEG2RAD, mcpAbAdDeg * DEG2RAD, pipFlexDeg * DEG2RAD]
            : [mcpFlexDeg * DEG2RAD, mcpAbAdDeg * DEG2RAD, pipFlexDeg * DEG2RAD]

          // Clamp the coupling-predicted DIP angle to its own fitted anatomical bounds -- the linear
          // fit is only ever validated within the range it was fit over (`interhand-2-average.md`
          // Stage 3b's own sanity-check discipline), and PIP's ROM sweep can reach angles the linear
          // extrapolation wasn't checked against.
          const dipFlexDeg = Math.min(dipRom.maxDeg, Math.max(dipRom.minDeg, slope * pipFlexDeg + intercept))

          const position = positionAt(anglesRad)
          const jacobian = numericalJacobian(positionAt, anglesRad)

          samples.push({
            position,
            baseFlexDeg,
            mcpFlexDeg,
            mcpAbAdDeg,
            pipFlexDeg,
            dipFlexDeg,
            postureCost: totalPostureCost([
              ...(baseRom ? [{ angleDeg: baseFlexDeg, rom: baseRom }] : []),
              { angleDeg: mcpFlexDeg, rom: mcp.flexExtRom },
              { angleDeg: mcpAbAdDeg, rom: mcp.abAdRom },
              { angleDeg: pipFlexDeg, rom: pipRom },
            ]),
            manipulability: yoshikawaManipulability(jacobian),
            positionalVariance: propagatedPositionalVariance(jacobian, [
              ...(baseRom ? [baseRom.sdDeg] : []),
              mcp.flexExtRom.sdDeg,
              mcp.abAdRom.sdDeg,
              pipRom.sdDeg,
            ]),
          })
        }
      }
    }
  }

  return samples
}

/** Exported for tests only -- lets a test recover the raw (unclamped) coupling prediction without
 * duplicating the slope/intercept-reading logic above. */
export function predictDipDeg(prior: HandPriorState, finger: NonThumbFinger, pipFlexDeg: number): number {
  const [slope, intercept] = prior.dipPipCoupling[finger].mean
  return slope * pipFlexDeg + intercept
}
