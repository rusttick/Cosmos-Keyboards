/**
 * A `HandPriorState` belief doesn't have to come from one place. This project treats the literature
 * seed (`handModelData.ts`) and every subject-derived fit (one real InterHand2.6M subject today,
 * eventually one real `/scan3` capture per person) as equally-weighted, independent pieces of evidence
 * about the same underlying quantities -- none of them privileged as "the" prior that others get
 * blended into. `fuseSources.ts` is what actually combines any selected subset; this file is just the
 * registry and the shape each entry's data takes.
 *
 * Critically, `handModelData.ts`'s `HAND_PRIOR_SEED` is never edited by any of this. Every subject's
 * belief -- including the literature one -- is stored as its own separate, permanent `PriorSource`.
 * Combining a subset of them (via `fuseSources.ts`) produces a new in-memory `HandPriorState` snapshot;
 * it never writes back to any source, literature included.
 */

import type { Finger } from '$lib/hand'
import type { BetaRom, NonThumbFinger, ScalarPrior, VectorPrior } from './handModel'
import { HAND_PRIOR_SEED } from './handModelData'

// ---------------------------------------------------------------------------------------------------
// `PartialHandPriorState`: the same shape as `HandPriorState`, but every leaf (and every per-finger
// entry within a group) is optional -- a source only ever claims the fields it actually has data for.
// A `HandPriorState` (every field populated) is structurally a valid `PartialHandPriorState` too, which
// is what lets `HAND_PRIOR_SEED` register below with no cast.

export interface PartialBoneLengthPriors {
  handLength?: ScalarPrior
  fingers?: Partial<Record<Finger, VectorPrior & { segments: string[] }>>
  knuckleRow?: VectorPrior
}

export interface PartialPipDipRomPriors {
  pip?: Partial<Record<NonThumbFinger, BetaRom>>
  dip?: Partial<Record<NonThumbFinger, BetaRom>>
}

export interface PartialMcpAxisPrior {
  flexExtRom?: BetaRom
  abAdRom?: BetaRom
  abAdChokeCoeff?: ScalarPrior
  axialRotationWeight?: ScalarPrior
}

export interface PartialThumbCmcPrior {
  flexExtRom?: BetaRom
  abAdRom?: BetaRom
  conjunctCoupling?: VectorPrior
}

export interface PartialRingPinkyCmcPrior {
  flexionRom?: BetaRom
}

export interface PartialCmcMobilityPriors {
  thumb?: PartialThumbCmcPrior
  ring?: PartialRingPinkyCmcPrior
  pinky?: PartialRingPinkyCmcPrior
}

export interface PartialEnslavingPriors {
  fingerOrder?: NonThumbFinger[]
  coefficients?: VectorPrior
}

export interface PartialWristForearmPriors {
  wristFlexExtRom?: BetaRom
  wristRadialUlnarRom?: BetaRom
  forearmPronationSupinationRom?: BetaRom
  elbowFlexionRom?: BetaRom
  elbowSwivelAngle?: ScalarPrior
  forearmLengthRatio?: ScalarPrior
  tenodesisCoupling?: ScalarPrior
  forearmLengthStatureCoupling?: ScalarPrior
  swivelWristForearmCoupling?: ScalarPrior
}

export interface PartialHandPriorState {
  boneLengths?: PartialBoneLengthPriors
  pipDipRom?: PartialPipDipRomPriors
  mcpAxes?: Partial<Record<NonThumbFinger, PartialMcpAxisPrior>>
  cmcMobility?: PartialCmcMobilityPriors
  dipPipCoupling?: Partial<Record<NonThumbFinger, VectorPrior>>
  enslaving?: PartialEnslavingPriors
  wristForearm?: PartialWristForearmPriors
}

// ---------------------------------------------------------------------------------------------------
// Registry

export type PriorSourceType = 'literature' | 'interhand' | 'scan3-capture'

/** Both hands' data for one source, independently -- never averaged together. A hand-specific source
 * (an InterHand2.6M subject's one real captured hand, a `my-hand` capture) sets only whichever side(s)
 * it actually has data for; the other stays `undefined` and contributes nothing when that side is
 * fused (this project's own capture data found real per-hand asymmetry -- DIP/PIP coupling,
 * `test-results.md` 2026-09-01 -- so silently reusing one hand's numbers for the other isn't a neutral
 * default). A hand-agnostic source (the literature seed: a population average with no individual
 * asymmetry to report) sets the SAME `PartialHandPriorState` under both keys -- it's one independent
 * piece of evidence that contributes identically to both the right-hand and left-hand fusion, not two
 * separate pieces of evidence that happen to agree. */
export interface PriorSourcePair {
  Right?: PartialHandPriorState
  Left?: PartialHandPriorState
}

export interface PriorSource {
  id: string
  label: string
  sourceType: PriorSourceType
  /** Free-text: how many frames/subjects, when computed, any known caveat -- shown next to the
   * checkbox in multi-view so a reader isn't guessing what a source actually represents. */
  description: string
  data: PriorSourcePair
}

/** The literature seed, registered as one ordinary peer -- see this file's own doc comment. It happens
 * to cover every field (a real `HandPriorState`), but nothing downstream treats that as special; a
 * subject source that eventually covers just as much would be handled identically. Registered under
 * both `Right` and `Left` (the same object, not a copy) -- see `PriorSourcePair`'s own doc comment for
 * why that's the correct representation of "no individual asymmetry claim," not a special case. */
export const LITERATURE_SOURCE: PriorSource = {
  id: 'literature',
  label: 'Anatomical research priors',
  sourceType: 'literature',
  description: 'Buryanov & Kotiuk 2010 bone lengths; round-number working ROM figures; see handModelData.ts for per-field sourcing.',
  data: { Right: HAND_PRIOR_SEED, Left: HAND_PRIOR_SEED },
}
