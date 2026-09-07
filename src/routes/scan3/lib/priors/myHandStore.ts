/**
 * The running "my hand" belief -- unlike InterHand2.6M subjects (one committed file per subject,
 * generated offline by a Bun script), a real person's own capture happens incrementally in the browser
 * across many separate sweeps (one per finger/handedness combination, possibly across several sessions).
 * `flexion-sweep` folds each completed sweep's contribution in via `fuseSources.ts`'s own
 * precision-weighted fusion (the same math used everywhere else in this project, just applied here to
 * merge "what I already believed about my hand" with "what this one sweep just measured" instead of
 * merging two already-complete sources), never by overwriting a field outright -- a repeated sweep of
 * the same finger genuinely narrows the belief further, exactly like any other independent evidence.
 *
 * **One source, both hands independent inside it.** This is a single `PriorSourcePair` (`priorSource.ts`)
 * -- one entry in multi-view's checklist, matching every other source -- but internally its `Right` and
 * `Left` halves are fused completely separately and never averaged together. `HandPriorState`'s own
 * geometry (`ikSolve.ts`'s `buildDefaultSkeleton`) treats left/right as a pure mirror of one shape, but
 * that's a rendering simplification, not a claim that the underlying ROM/coupling/enslaving *numbers*
 * are identical between a person's two hands -- and this project's own capture data already disproved
 * that for at least DIP/PIP coupling (`test-results.md`, 2026-09-01: ring finger's coupling R² came
 * back decisively different per hand, Right ~0.76 vs Left ~0.22, non-overlapping ranges at n=4/n=3;
 * middle showed a smaller but consistent gap too). Averaging a Right-hand sweep and a Left-hand sweep
 * together as if they were two independent observations of the *same* quantity would actively destroy
 * exactly that kind of real, already-confirmed asymmetry.
 *
 * Persisted to `localStorage` (not IndexedDB -- this is still `scan-tests` throwaway-tool territory, not
 * a real `/scan3` session store) so it survives a reload while working through combinations. Never
 * written to `handModelData.ts` or any other source -- same permanent boundary as every other prior.
 */

import type { Finger } from '$lib/hand'
import { FINGERS } from '$lib/hand'
import { type Writable, writable } from 'svelte/store'
import { fuseBetaRom, fuseVector } from './fuseSources'
import type { BetaRom, NonThumbFinger, ScalarPrior, VectorPrior } from './handModel'
import type { PartialHandPriorState, PriorSourcePair } from './priorSource'

// Not importing scan-tests/lib/orientation's `Handedness` here -- scan3/lib is the library layer,
// scan-tests pages consume it, not the other way around. Same local union `ikSolve.ts` itself uses.
export type Handedness = 'Left' | 'Right'
export const HANDEDNESSES: Handedness[] = ['Right', 'Left']

const NON_THUMB_FINGERS = FINGERS.filter((f): f is NonThumbFinger => f !== 'thumb')
const STORAGE_KEY = 'cosmos-scan3-my-hand-prior-v2'
export const MY_HAND_SOURCE_ID = 'my-hand'

/** Same sentinel every zero-coverage field in `fuseSources.ts` uses -- large but finite, so an
 * enslaving-matrix entry this sweep didn't touch contributes ~0 weight when fused rather than an
 * `Infinity * 0 = NaN`. Not exported from `fuseSources.ts`, so re-declared here rather than reaching
 * into that module's internals for a constant. */
const UNCONSTRAINED_VARIANCE = 1e12

function load(): PriorSourcePair {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

/** One store, both hands inside it -- see this file's own doc comment for why they're never merged
 * with each other even though they live in the same `PriorSourcePair` object. */
export const myHandPrior: Writable<PriorSourcePair> = writable(load())

myHandPrior.subscribe(state => {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Storage full/disabled -- the in-memory store still works for the rest of this session.
  }
})

export function resetMyHandPrior(handedness?: Handedness) {
  if (handedness === undefined) {
    myHandPrior.set({})
    return
  }
  myHandPrior.update(current => ({ ...current, [handedness]: undefined }))
}

/** One completed sweep's own contribution, in the same partial shape one hand's half of `myHandPrior`
 * uses -- everything optional, since a thumb sweep (no `pipDipRom`/`dipPipCoupling`/`enslaving`
 * destination field exists for it yet) or a low-confidence run may only fill some of these.
 * `handedness` picks which half of the pair this sweep's fragment gets fused into. */
export interface FlexionSweepFragment {
  handedness: Handedness
  finger: NonThumbFinger
  mcpFlexExt?: BetaRom
  pip?: BetaRom
  dip?: BetaRom
  dipPipCoupling?: VectorPrior
  /** Keyed by the OTHER finger `j` -- this sweep's active finger is always the fragment's own
   * `finger`, so there's no `i` key to carry. */
  enslavingAgainst?: Partial<Record<NonThumbFinger, { coefficient: number; variance: number }>>
}

function enslavingFlatIndex(i: NonThumbFinger, j: NonThumbFinger): number {
  return NON_THUMB_FINGERS.length * NON_THUMB_FINGERS.indexOf(i) + NON_THUMB_FINGERS.indexOf(j)
}

/** Builds a full-size (n^2-flat) `VectorPrior` fragment for one sweep's enslaving row -- every entry
 * this sweep didn't measure (every pair not `(finger, j)` for the swept finger, including the whole
 * diagonal -- a sweep never measures a finger's coefficient against itself, that's definitional, not
 * observed) gets the same unconstrained placeholder every other zero-coverage field gets, so fusing
 * this against the running belief only ever narrows the entries this sweep actually touched. */
function enslavingRowVector(finger: NonThumbFinger, against: FlexionSweepFragment['enslavingAgainst']): VectorPrior {
  const n = NON_THUMB_FINGERS.length
  const mean = new Array(n * n).fill(0)
  const covariance = Array.from({ length: n * n }, () => new Array(n * n).fill(0))
  for (let k = 0; k < n * n; k++) covariance[k][k] = UNCONSTRAINED_VARIANCE
  for (const j of NON_THUMB_FINGERS) {
    const fit = against?.[j]
    if (!fit) continue
    const idx = enslavingFlatIndex(finger, j)
    mean[idx] = fit.coefficient
    covariance[idx][idx] = fit.variance
  }
  return { mean, covariance, source: `my-hand sweep (${finger} active)` }
}

/** Folds one completed sweep into the running `myHandPrior`, into the half matching
 * `fragment.handedness` only -- via the exact same precision-weighted fusion `fuseSources.ts` uses to
 * combine any other two sources. See this file's own doc comment for why the other hand's half is
 * never touched by this call. */
export function mergeFlexionSweepFragment(fragment: FlexionSweepFragment) {
  const label = `my-hand-${fragment.handedness.toLowerCase()} (this sweep)`
  const prevLabel = `my-hand-${fragment.handedness.toLowerCase()} (previous)`

  myHandPrior.update(pair => {
    const current: PartialHandPriorState = pair[fragment.handedness] ?? {}
    const next: PartialHandPriorState = { ...current }

    if (fragment.mcpFlexExt) {
      const existing = current.mcpAxes?.[fragment.finger]?.flexExtRom
      const fused = fuseBetaRom(
        existing
          ? [{ value: existing, label: prevLabel }, { value: fragment.mcpFlexExt, label }]
          : [{ value: fragment.mcpFlexExt, label }],
      )
      next.mcpAxes = { ...current.mcpAxes, [fragment.finger]: { ...current.mcpAxes?.[fragment.finger], flexExtRom: fused } }
    }

    if (fragment.pip || fragment.dip) {
      next.pipDipRom = { pip: { ...current.pipDipRom?.pip }, dip: { ...current.pipDipRom?.dip } }
      if (fragment.pip) {
        const existing = current.pipDipRom?.pip?.[fragment.finger]
        next.pipDipRom.pip![fragment.finger] = fuseBetaRom(
          existing ? [{ value: existing, label: prevLabel }, { value: fragment.pip, label }] : [{ value: fragment.pip, label }],
        )
      }
      if (fragment.dip) {
        const existing = current.pipDipRom?.dip?.[fragment.finger]
        next.pipDipRom.dip![fragment.finger] = fuseBetaRom(
          existing ? [{ value: existing, label: prevLabel }, { value: fragment.dip, label }] : [{ value: fragment.dip, label }],
        )
      }
    }

    if (fragment.dipPipCoupling) {
      const existing = current.dipPipCoupling?.[fragment.finger]
      const fused = fuseVector(
        existing
          ? [{ value: existing, label: prevLabel }, { value: fragment.dipPipCoupling, label }]
          : [{ value: fragment.dipPipCoupling, label }],
        2,
      )
      next.dipPipCoupling = { ...current.dipPipCoupling, [fragment.finger]: { ...fused, source: `${label}: fused across sweeps` } }
    }

    if (fragment.enslavingAgainst && Object.keys(fragment.enslavingAgainst).length > 0) {
      const n = NON_THUMB_FINGERS.length
      const thisSweep = enslavingRowVector(fragment.finger, fragment.enslavingAgainst)
      const existing = current.enslaving?.coefficients
      const fused = fuseVector(
        existing ? [{ value: existing, label: prevLabel }, { value: thisSweep, label }] : [{ value: thisSweep, label }],
        n * n,
      )
      next.enslaving = { fingerOrder: NON_THUMB_FINGERS, coefficients: { ...fused, source: `${label}: fused across sweeps` } }
    }

    return { ...pair, [fragment.handedness]: next }
  })
}

/** One caliper measurement's already-computed result -- `caliperMeasurement.ts` does the actual
 * Bayesian update math (it needs the currently-fused snapshot to convert mm to ratio-space, which this
 * store doesn't have access to); this function's only job is writing the two resulting posteriors
 * (one finger's bone-length ratios, and `handLength`) into the correct hand's half of the pair. */
export interface CaliperFragment {
  finger: Finger
  segments: string[]
  fingerVector: VectorPrior
  handLength: ScalarPrior
}

export function mergeCaliperFragment(handedness: Handedness, fragment: CaliperFragment) {
  myHandPrior.update(pair => {
    const current: PartialHandPriorState = pair[handedness] ?? {}
    const next: PartialHandPriorState = {
      ...current,
      boneLengths: {
        ...current.boneLengths,
        handLength: fragment.handLength,
        fingers: {
          ...current.boneLengths?.fingers,
          [fragment.finger]: { segments: fragment.segments, ...fragment.fingerVector },
        },
      },
    }
    return { ...pair, [handedness]: next }
  })
}

/** Same idea as `mergeCaliperFragment`, for an adjacent-MCP (`boneLengths.knuckleRow`) measurement
 * instead of a within-finger one -- kept as a separate function rather than a union parameter since the
 * two write to structurally different parts of `PartialHandPriorState`. */
export interface KnuckleCaliperFragment {
  knuckleRowVector: VectorPrior
  handLength: ScalarPrior
}

export function mergeKnuckleCaliperFragment(handedness: Handedness, fragment: KnuckleCaliperFragment) {
  myHandPrior.update(pair => {
    const current: PartialHandPriorState = pair[handedness] ?? {}
    const next: PartialHandPriorState = {
      ...current,
      boneLengths: {
        ...current.boneLengths,
        handLength: fragment.handLength,
        knuckleRow: fragment.knuckleRowVector,
      },
    }
    return { ...pair, [handedness]: next }
  })
}

/** Serializes the current `myHandPrior` pair (both hands, whichever are populated) into the same
 * committed-`.ts`-module shape `generateFittedSubject.ts` writes for an InterHand2.6M subject, for a
 * browser download -- a page has no filesystem access, so "save to the repo" is necessarily a
 * two-step, human-in-the-loop process: download here, then drop the file into
 * `scan3/lib/priors/fitted/` and add one line to `registry.ts`. */
export function serializeMyHandPriorModule(pair: PriorSourcePair): string {
  const generatedAt = new Date().toISOString().slice(0, 10)
  const summary = (['Right', 'Left'] as const)
    .map(h => (pair[h] ? `${h}: captured` : `${h}: not swept yet`))
    .join(', ')
  const dataEntries = (['Right', 'Left'] as const)
    .filter(h => pair[h])
    .map(h => `  ${h}: ${JSON.stringify(pair[h], null, 2).split('\n').join('\n  ')},`)
    .join('\n')

  return `/**
 * Downloaded from the live '/scan-tests/flexion-sweep' page on ${generatedAt} -- a real personal
 * capture, not derived from InterHand2.6M or any literature source. ${summary}. Hand-review before
 * committing: check which fields are actually populated (some finger combinations may not have been
 * swept yet) and that each field's declared confidence looks reasonable.
 */

import type { PriorSource } from '../priorSource'

export const MY_HAND_SOURCE: PriorSource = {
  id: 'my-hand',
  label: 'My hand (captured)',
  sourceType: 'scan3-capture',
  description: 'Personal capture via flexion-sweep, downloaded ${generatedAt}. ${summary}. See buildSubjectPrior.ts-style caveats per field in its own source strings.',
  data: {
${dataEntries}
  },
}
`
}
