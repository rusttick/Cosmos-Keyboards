/**
 * Turns one subject's already-fitted InterHand2.6M statistics (`fitBoneLengths.ts`, `fitRom.ts`) into a
 * `PartialHandPriorState` -- a `PriorSource`'s `data`, ready to register and fuse alongside the
 * literature seed or any other subject in `fuseSources.ts`. This never touches `handModelData.ts`;
 * per `docs/thumbs/interhand-2-average.md`'s superseded Stage 4/5, no subject's fit is ever written
 * into the literature seed -- each stays its own separate, permanent source (see `priorSource.ts`).
 *
 * Covers what's been extracted and validated so far, each gated on its own honest check, not on a
 * uniform confidence tier: bone-length ratios (every finger, including the thumb's previously-unsourced
 * `wristToCmc`, and the adjacent-MCP `knuckleRow` spacing -- straight-line 3D distance between real
 * landmarks, the same computation `fitBoneLengths.ts` already uses for every within-finger segment,
 * just between two different fingers' MCPs instead of one finger's own chain); PIP/DIP ROM for the
 * four non-thumb fingers; DIP/PIP coupling (`fitDipPipCoupling.ts`,
 * Stage 3b -- no axis-convention risk, always included); and the MCP ab/ad choke coefficient
 * (`fitMcpChoke.ts`, Stage 3c -- DOES need an assumed axis convention, and is only included per finger
 * when that file's own qualitative shrinkage check actually passed, never forced). Every other field
 * `fitRom.ts` computes (`flex-abd-combined`/`joint-stacked` directness -- the thumb CMC, every finger's
 * true MCP flexExtRom, ring/pinky's base joint) is explicitly NOT a candidate for its target field's
 * mean/SD per `fitRom.ts`'s own doc comment (a safe upper bound on a *combined* quantity, not a clean
 * measurement of either target field alone) -- left out here rather than mapped in loosely. `enslaving`
 * and everything in `wristForearm` are un-attempted (see `TODO.md`'s low-confidence/not-feasible
 * groups) -- fields this source doesn't cover come back genuinely unconstrained when fused, per
 * `fuseSources.ts`, not silently backed by literature.
 */

import type { Finger } from '$lib/hand'
import { FINGERS } from '$lib/hand'
import type { BetaRom, NonThumbFinger, VectorPrior } from '../handModel'
import type { PartialHandPriorState } from '../priorSource'
import type { FittedBoneLengths } from './fitBoneLengths'
import type { FittedDipPipCoupling } from './fitDipPipCoupling'
import type { FittedMcpChoke } from './fitMcpChoke'
import type { FittedJointRom } from './fitRom'

function diagonal(variance: number[]): number[][] {
  return variance.map((v, i) => variance.map((_, j) => (i === j ? v : 0)))
}

function romFrom(subjectLabel: string, r: FittedJointRom): BetaRom {
  return {
    minDeg: r.minDeg,
    maxDeg: r.maxDeg,
    meanDeg: r.meanDeg,
    sdDeg: r.declaredSdDeg,
    source: `${subjectLabel}: within-subject fit, n=${r.n} frames, ${r.excludedByBadSegment} excluded by segment-consistency check (docs/thumbs/interhand-2-average.md Stage 3d)`,
  }
}

export function buildSubjectPrior(
  subjectLabel: string,
  bones: FittedBoneLengths,
  rom: FittedJointRom[],
  dipPip: FittedDipPipCoupling[] = [],
  mcpChoke: FittedMcpChoke[] = [],
): PartialHandPriorState {
  const fingers: NonNullable<NonNullable<PartialHandPriorState['boneLengths']>['fingers']> = Object.fromEntries(
    FINGERS.map((finger: Finger) => {
      const f = bones.fingers[finger]
      return [
        finger,
        {
          segments: f.segments,
          mean: f.mean,
          covariance: diagonal(f.variance),
          source: `${subjectLabel}: within-subject fit, n=[${f.n.join(', ')}] frames per segment, excluded=[${f.excluded.join(', ')}] (docs/thumbs/interhand-2-average.md Stage 3a)`,
        },
      ]
    }),
  )

  const pip: Partial<Record<NonThumbFinger, BetaRom>> = {}
  const dip: Partial<Record<NonThumbFinger, BetaRom>> = {}
  for (const r of rom) {
    if (r.directness !== 'clean-hinge') continue
    if (r.jointName === 'pip') pip[r.finger as NonThumbFinger] = romFrom(subjectLabel, r)
    if (r.jointName === 'dip') dip[r.finger as NonThumbFinger] = romFrom(subjectLabel, r)
  }

  const dipPipCoupling: Partial<Record<NonThumbFinger, VectorPrior>> = {}
  for (const d of dipPip) {
    dipPipCoupling[d.finger] = {
      mean: [d.slope, d.intercept],
      covariance: d.covariance,
      source: `${subjectLabel}: within-subject OLS fit, n=${d.n} frames (${d.excludedByBadSegment} excluded), R^2=${d.r2.toFixed(3)} (docs/thumbs/interhand-2-average.md Stage 3b)`,
    }
  }

  const mcpAxes: Partial<Record<NonThumbFinger, { abAdChokeCoeff: { mean: number; variance: number; source: string } }>> = {}
  for (const m of mcpChoke) {
    if (!m.fitted || m.chokeCoeff === undefined || m.chokeCoeffVariance === undefined) continue
    mcpAxes[m.finger] = {
      abAdChokeCoeff: {
        mean: m.chokeCoeff,
        variance: m.chokeCoeffVariance,
        source: `${subjectLabel}: within-subject fit under an ASSUMED shared axis convention (palmBasisAxes' sagittal-plane deviation, not a per-subject calibrated axis) -- shrinkage correlation ${
          m.shrinkageCorrelation.toFixed(2)
        } across ${m.bins.length} flexion bins (docs/thumbs/interhand-2-average.md Stage 3c). Treat as lower-confidence than bone lengths/ROM/DIP-PIP coupling above.`,
      },
    }
  }

  return {
    boneLengths: {
      handLength: {
        mean: bones.handLengthMM.mean,
        variance: bones.handLengthMM.variance,
        source: `${subjectLabel}: within-subject fit, n=${bones.handLengthMM.n} frames -- this subject's own absolute hand size, not a population average`,
      },
      fingers,
      knuckleRow: {
        mean: bones.knuckleRow.mean,
        covariance: diagonal(bones.knuckleRow.variance),
        source: `${subjectLabel}: within-subject fit, n=${bones.knuckleRow.n} frames, excluded by gap (segment-consistency filter): [${
          bones.knuckleRow.excludedByBadGap.join(', ')
        }] -- straight-line MCP-to-MCP distance (docs/thumbs/interhand-2-average.md Stage 3a's method, applied cross-finger)`,
      },
    },
    pipDipRom: { pip, dip },
    dipPipCoupling,
    mcpAxes,
  }
}
