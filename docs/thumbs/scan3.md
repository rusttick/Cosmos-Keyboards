# `/scan3` architecture: implementing `scan_procedure.md`

This is the implementation architecture for `scan_procedure.md`'s capture protocol: data structures, module boundaries, file layout, and state ownership for the `/scan3` route, close enough to code that filling in the bodies should be mechanical.

## Foundation: one kinematic engine

`/scan3` is built directly on `$lib/hand.ts` and `$lib/handhelpers.ts` — the kinematic engine (`Hand`, `Joint`, `Joints`, `SolvedHand`, `calculateJoints`) and the `HandData` persistence contract (`readHands()`, the `cosmosHands` `localStorage` record) already shared by every consumer that reasons about a scanned hand: `/beta`'s hand-fit view and reachability overlay, `handoptim.ts`'s IK refinement, and eventually whatever key-placement and manual-tweaking UI ends up consuming `scan_procedure.md`'s Phase 6 thumb data. There is exactly one FK/IK implementation; `/scan3` extends it rather than carrying its own copy. `/scan`'s route (`src/routes/scan/`) is reused only for its capture-UI patterns and display components — `detector.ts`, `Stage.svelte`, `Pose.svelte`, `HandModel.svelte` — none of which encode protocol-specific logic, so they're imported as-is rather than copied.

Extending the shared engine means `/scan3` work sometimes lands outside `src/routes/scan3/` — most notably `SolvedHand.fkBy` gaining a case for the thumb's third rotational degree of freedom (§4). This is intentional: the thumb's opposition behavior needs to be identical whether it's being scanned, evaluated, or used to place and adjust a key, so it belongs in the one place all of those already read from.

## Directory layout

```
src/routes/scan3/
  +page.svelte                  # phase-engine host: renders the current phase's component, session controls
  store.ts                      # Svelte-reactive session mirror (see "Runtime state")
  RestingPostureFlow.svelte     # standalone entry point for the repeatable resting-posture capture
  ContactSpherePreview.svelte   # read-only live camera overlay of ContactSpheres — see "Contact-sphere preview"
  lib/
    detector.ts                  # re-export of src/routes/scan/lib/detector.ts
    phaseEngine.ts                # phase state machine: advances phases, dispatches to completion detectors, commits results
    session.ts                   # IndexedDB-backed session persistence (see "Persistence")
    completion/
      plateau.ts                   # running-extremum convergence (Phases 3, 4, 6a)
      coverageGrid.ts               # grid/region-visitation convergence (Phases 5, 6b)
      stillWindow.ts                # low-variance-window extraction (Phase 2, Phase 3 comfortable tier)
    calibration/
      caliper.ts                    # caliper scale-factor computation, recomputed incrementally as bone-length estimates update
      cameraFrame.ts                 # three-finger orthogonal-gesture detection and the foreshortening basis it produces
    phases/
      boneLength.ts                  # Phase 1
      neutral.ts                     # Phase 2
      flexion.ts                     # Phase 3
      abduction.ts                   # Phase 4
      pairedSweep.ts                  # Phase 5
      thumbCmc.ts                     # Phase 6a/6b
  phases/
    Phase1BoneLength.svelte
    Phase2Neutral.svelte           # shared by the inline session and RestingPostureFlow.svelte
    Phase3Flexion.svelte
    Phase4Abduction.svelte
    Phase5PairedSweep.svelte
    Phase6aCmcSweep.svelte
    Phase6bCmcFreeform.svelte
    CaliperInput.svelte
    CameraCalibrationGesture.svelte
```

## Data structures

### Joints: quality alongside geometry

`$lib/hand.ts`'s `Joint` union already carries the geometry FK needs (`length`, `V`/`Vinv`, `degree`). `/scan3` adds an optional `quality` block so every joint can also carry what the capture session learned about how well-supported that geometry is, without disturbing existing callers that never populate it:

```ts
interface JointQuality {
  axisFitConfidence: number // SVD singular-value ratio from fitNorms — already computed, just never surfaced
  neutralAngle?: number // radians; Phase 2's inline capture (not the labeled restingPostures mini-flow)
  comfortableMin?: number // radians; Phase 3 tier 1 / Phase 4
  comfortableMax?: number
  fullMin?: number // Phase 3 tier 2 / Phase 4
  fullMax?: number
}
```

`neutralAngle` is the one field here that comes from Phase 2 rather than Phase 3/4 — the main session's single inline neutral capture, as distinct from the standalone, repeatable, differently-shaped `restingPostures` (§ `HandData` below), which stores angles directly rather than through `Joint.quality` since it isn't tied to one specific scan.

### Per-finger and cross-finger coupling

The DIP-vs-PIP relationship is a property of a finger, not of a single joint, so it lives beside `Joints` rather than inside a `Joint`:

```ts
interface DipPipCoupling {
  slope: number
  intercept: number
  r2: number
}
```

Phase 5's paired sweep produces an enslaving coefficient and a coverage-grid-derived prohibited-region map per finger pair, per plane (flexion, abduction — a hand can couple very differently in each):

```ts
interface Enslaving {
  coefficient: number
  r2: number
} // E[i][j] ≈ Δθ_j/Δθ_i

interface CoverageGrid {
  visited: boolean[][] // cells marked true once a confidence-passing sample lands in them
  bounds: [[number, number], [number, number]] // the (θ_i, θ_j) extent, from each finger's established ROM
}

interface PairedSweepResult {
  flexion: Record<`${Finger}:${Finger}`, { enslaving: Enslaving; coverage: CoverageGrid }>
  abduction: Record<`${Finger}:${Finger}`, { enslaving: Enslaving; coverage: CoverageGrid }>
}
```

### The thumb CMC

The CMC has two independently driven rotations (flexion-extension, abduction-adduction) and a third, conjunct axial rotation that falls out of the saddle joint's geometry as a function of the other two rather than being independently controlled. `Joint` gains a fourth variant to represent that directly, distinguished by `degree: 3`:

```ts
interface ThumbCmcJoint {
  length: number
  degree: 3
  V: Matrix4
  Vinv: Matrix4
  conjunctCoupling: { aCoeff: number; bCoeff: number; r2: number } // twist ≈ aCoeff·flexion + bCoeff·abduction
  quality?: JointQuality
}
```

`SolvedHand.fkBy` treats `degree: 3` the way it treats `degree: 2` for the two driven rotations, then applies a third rotation about the joint's remaining axis computed from `conjunctCoupling` rather than supplied by the caller — the same computed-not-supplied handling `fkBy` already gives `degree: 0`'s fixed axis, just fed by the fitted function instead of a constant. `localTransforms` and `worldPositions` need no changes beyond that, since they already just walk whatever `fkBy` produces. Every existing caller of `fkBy` (`/beta`'s hand-fit view, `viewer3dHelpers.ts`) keeps working unmodified for every joint that isn't this one.

### Contact spheres: the fingertip is not a point

`SolvedHand.worldPositions(finger)[4]` gives a zero-radius skeletal point at the tip of the FK chain, but a real key press happens somewhere on the volume of the fingertip, not at that exact point, and not always with the same part of the finger — the pad, the underside of the nail, the side of the finger, and (for the thumb especially) the area nearer the IP joint are all real, distinct ways a key gets pressed. Rather than picking one fixed offset or a small set of named contact "modes" (which would quantize what's actually a continuous choice of approach direction), each pressable point on the hand is modeled as a sphere: a press can land anywhere on its surface, approaching along that point's local normal.

Each sphere is anchored to one of MediaPipe's own landmark numbers (0–20) rather than to an internal chain index — landmark numbers are already globally unambiguous per finger and per joint (landmark 6 is always index PIP, landmark 3 is always thumb IP), whereas an internal "position `k` in the 4-segment chain" convention isn't, since the thumb's chain shifts by one segment relative to the other fingers' naming. The landmark number is purely a lookup key; the sphere's actual world position still comes from `worldPositions(finger)[k]` for whichever chain index that landmark maps to (a fixed table, already implicit in `CONNECTIONS`):

```ts
interface ContactSphere {
  landmark: number // MediaPipe's own 0–20 index — e.g. 8 = index tip, 3 = thumb IP
  offset: Vector3Tuple // local-frame offset from that landmark's FK-fitted position — (0,0,0) placeholder
  radius: number // mm — 2 placeholder, user-overridable
}

type ContactSpheres = ContactSphere[]
```

The placeholder default set is the five fingertip landmarks (`4, 8, 12, 16, 20`) plus one extra for the thumb (`3`, its IP joint) — six spheres, all `offset: [0, 0, 0]` and `radius: 2`, matching the value already hardcoded as `HAND_RADIUS` in `viewer3dHelpers.ts` today, just made explicit, per-landmark, and adjustable instead of one silent global constant. Any finger can gain further entries later (a PIP-knuckle press, for instance, is just another `ContactSphere` with `landmark: 6` for the index finger) without a shape change.

Getting the offset right — where the sphere center actually sits relative to the tracked landmark, and what its true radius is — is deliberately left unsolved here. MediaPipe's landmarks (fingertip or otherwise) are all produced the same way — visually annotated skin-surface points, not skeletal measurements — so no landmark can be used as a trusted reference to calibrate another; whatever eventually replaces the `(0,0,0)`/`2mm` placeholder needs a ground truth outside MediaPipe entirely, not a calibration chained off another uncalibrated point on the same hand.

### `HandData`

`readHands()` already versions its stored record (`parsed.version >= 2` triggers a unit conversion) — `/scan3` continues that pattern rather than introducing a separate migration mechanism. Version 3 adds the fields Phases 1–6 produce that don't live inside `Joints` itself:

```ts
export interface HandData {
  version: number // 3
  left: Joints
  right: Joints
  time: string
  dipCoupling: { left: Partial<Record<Finger, DipPipCoupling>>; right: Partial<Record<Finger, DipPipCoupling>> }
  pairedSweep: { left: PairedSweepResult; right: PairedSweepResult }
  caliperScaleFactor: number
  cameraFrame: { sightline: Vector3Tuple; perp1: Vector3Tuple; perp2: Vector3Tuple }
  restingPostures: Record<string, RestingPosture> // user-chosen label -> capture
  contactSpheres: ContactSpheres // shared across left/right — the placeholder set is finger-generic, not scan-derived
}

interface RestingPosture {
  left: { neutralAngles: Record<Finger, number[]> }
  right: { neutralAngles: Record<Finger, number[]> }
  relativeTransform: { separation: number; rotation: Quaternion }
  capturedAt: string
}
```

`cameraFrame` and `restingPostures` are session/bilateral-level rather than per-hand, but are stored once on the shared record since both hands are scanned under the same immobilized camera.

## Runtime state

A session is a straightforward walk through `scan_procedure.md`'s phase list, one hand at a time (with Phase 2 the bilateral exception). The engine's state is small and entirely numeric — everything bulky is scoped to the phase currently in progress and never needs to leave memory.

```ts
interface ScanSession {
  id: string
  hand: 'Left' | 'Right'
  phase: PhaseId // '1' | '2' | '3' | '4' | '5' | '6a' | '6b'
  phaseSubIndex: number // which finger / finger-pair within the phase
  result: Partial<HandData> // accumulates one phase's contribution at a time
}
```

The frames a phase is actively working with (`Hand[]` history for a still-window search, the running plateau extrema, the in-progress coverage grid) live as local state inside that phase's Svelte component and its `phases/*.ts` extraction module — never in `ScanSession`, never written to storage. When a phase's completion criterion is met, its extraction function reduces that in-memory history down to the small numeric result shown above (a few `Joint.quality` fields, one `DipPipCoupling`, one pair's `Enslaving` + `CoverageGrid`), merges it into `session.result`, and the raw frames are simply dropped — nothing frees them explicitly, they just fall out of scope once the component moves to the next finger or phase.

`store.ts` mirrors the current `ScanSession` in a Svelte store for the UI (`session`), plus a `liveFeedback` store for what the in-progress phase wants to show (unvisited coverage cells, plateau convergence, current frame yield) — this is presentational state, redundant with what the phase component already tracks, not a second source of truth.

### Persistence

`session.ts` writes `ScanSession` to IndexedDB after each phase completes. This is the save unit: **one per-hand phase (1, 3, 4, 5, 6a, 6b) is one save point, and the bilateral neutral capture (Phase 2) is another** — a session resumed after a reload restarts at the beginning of whichever phase was in progress, not mid-phase, which costs at most one phase's worth of re-capture and needs no snapshotting finer than "commit on phase completion." IndexedDB is used instead of `localStorage` for this even though the data is small, because it's asynchronous — a write on phase completion doesn't block the capture loop the way a synchronous `localStorage.setItem` would — and it stores structured objects (nested records, arrays of numbers) directly via structured clone rather than requiring manual `JSON.stringify`/`parse`. No new dependency is needed for this: a small wrapper around the native `indexedDB` API (open a database, one object store keyed by session id) is all `session.ts` needs. Once the full session (all phases, both hands) completes, its accumulated `HandData` is written through the existing `readHands()`/`cosmosHands` `localStorage` contract unchanged — that record has always been small, and stays small, since none of the new per-phase fields carry raw frame data.

The standalone resting-posture flow (`RestingPostureFlow.svelte`) doesn't use `ScanSession` or IndexedDB at all: it loads the existing `HandData` via `readHands()`, runs Phase 2's still-window extraction once, and writes the single resulting `RestingPosture` back into `handData.restingPostures[label]` through the same `localStorage` write `/scan` already does today.

## Completion detection

Three pure functions, shared across phases, taking frame or sample history in and a convergence boolean out — no camera, no DOM, no Svelte:

```ts
// completion/plateau.ts
interface PlateauState {
  runningMin: number[]
  runningMax: number[]
  cyclesSinceGrowth: number[]
}
function updatePlateau(state: PlateauState, observedAngles: number[], threshold: number): PlateauState
function isPlateaued(state: PlateauState, k: number): boolean
// Phase 6a's false-plateau guard wraps this: only accept convergence if confidence/yield
// stayed healthy through the last k cycles, not just the angles.

// completion/coverageGrid.ts
interface CoverageGridState {
  visited: boolean[][]
  bounds: [[number, number], [number, number]]
}
function updateCoverageGrid(state: CoverageGridState, sample: [number, number], confidence: number): CoverageGridState
function coverageFraction(state: CoverageGridState): number

// completion/stillWindow.ts
function findStillWindow(history: Hand[], minDurationFrames: number, velocityThreshold: number): { window: Hand[] } | null
```

`phaseEngine.ts` is the only module that knows which pattern each phase uses; the `phases/*.ts` extraction modules just receive the frames a completed segment collected.

## Phases

- **Phase 1 (`boneLength.ts`)** — perpendicularity-weighted mean bone length across a rotation arc; plateau-style completion on accepted-frame count and swept angle rather than a converging value.
- **Phase 2 (`neutral.ts`)** — `stillWindow` over the bilateral hold; computes per-hand neutral joint angles and the relative transform between the two hands' `makeBasis` frames within that window.
- **Phase 3 (`flexion.ts`)** — tier 1 (comfortable) uses `stillWindow`; tier 2 (full) uses `plateau` across MCP/PIP/DIP simultaneously, and regresses the retained DIP-Z series against PIP-Z to produce `DipPipCoupling`.
- **Phase 4 (`abduction.ts`)** — the target finger is swept side to side through repeated cycles while the other four rest lightly on the desk; the desk contact is bracing only, not a segmentation signal. `plateau` runs continuously on the abduction angle across the whole sweep, identical in shape to Phase 3's full-ROM tier — min/max simply stop growing once the true range has been covered a couple of times.
- **Phase 5 (`pairedSweep.ts`)** — a freeform paired sweep feeds both `Enslaving` regression (over sub-segments where one finger's excursion dominates the other's) and `CoverageGrid` tracking of the `(θ_i, θ_j)` space, run once per plane per pair of interest.
- **Phase 6a (`thumbCmc.ts`, outer sweep)** — thumb held rigid, swept from the CMC only; `fitNorms`'s existing PCA/SVD machinery is applied to joint 0 for the first time to get the CMC's flexion-extension and abduction-adduction axes, with `plateau` (false-plateau-guarded) for completion.
- **Phase 6b (`thumbCmc.ts`, freeform sweep)** — unconstrained thumb motion; regresses the observed axial twist against the two driven CMC rotations to produce `conjunctCoupling`, and separately regresses thumb MCP/IP flexion as a byproduct of the same trajectory. Completion uses `coverageGrid`'s named-region variant (near each fingertip, etc.) rather than a fixed numeric grid.

## Calibration

`CaliperInput.svelte` collects the one manual measurement the protocol needs; `caliper.ts` recomputes `caliperScaleFactor` continuously as the pooled bone-length estimate updates, the same incremental pattern `Recording.svelte` already uses for its running means.

`CameraCalibrationGesture.svelte` drives the three-finger orthogonal pose detection in `cameraFrame.ts`, reusing the same bone-direction/`makeBasis` math the rest of the engine already has. The resulting frame is stored once per session and consulted by any phase whose completion criterion is foreshortening-sensitive (Phase 1's rotation coverage, Phase 6a's false-plateau guard).

## Contact-sphere preview

A read-only sanity check for `ContactSpheres`, separate from the capture protocol entirely — nothing here is a phase, and nothing it does is recorded. `ContactSpherePreview.svelte` loads the existing `HandData` via `readHands()`, starts the same live camera + detector loop `/scan`'s `+page.svelte` already runs (no `Recording`/statistics accumulation, just raw per-frame `Hands`), and renders each `ContactSphere` as a circle on top of the live video — the same 2D-canvas-overlay technique `Display.svelte` already uses for keypoints (`drawKeypoints`), just drawing a circle at each sphere's `landmark` position instead of a dot at every landmark. Both hands move freely and unconstrained in view; there's no pose to hold and nothing being scored.

To size each circle so it visually reads as the right physical radius rather than a fixed-pixel dot, the preview compares a live reference bone's on-screen pixel length that frame against that same bone's known real length (already present in the fitted `Joints`) to get a live pixels-per-millimeter conversion, recomputed every frame as the hand moves closer to or farther from the camera, and uses it to scale `ContactSphere.radius` into a correctly-sized screen circle.

Each sphere is also colored by how far the live pose is from what the scan actually established as comfortable. This needs one more piece of live computation beyond projecting a static point: a `SolvedHand` built from the scanned `Joints`, fed the current frame's limb vectors via `fromAllLimbs(liveLimbs, true)`, then `decomposeAngles(finger)` (already present on `$lib/hand.ts`'s canonical `SolvedHand`) to get every joint's live angle for that frame. A sphere sits at one landmark, but that landmark's position depends on every joint between the wrist and it, so its color reflects the worst joint along that chain, not just the nearest one — a finger maxed out at the MCP but relaxed at the DIP still reads as "at an extreme." For each joint, compare its live angle against `neutralAngle`, `comfortableMin/Max`, and `fullMin/Max` to get a normalized deviation (`0` at neutral, `1` at the comfortable-range edge, continuing toward the full-ROM edge, flagged separately beyond it), take the max across the chain, and map to a tier: green near neutral, yellow past comfortable, orange past full ROM but still within what the scan observed, red beyond anything the scan ever measured for that joint — the least trustworthy region, since nothing in the fit constrains what happens there. A joint missing quality data (Phase 3/4 skipped or failed for that finger) just leaves the sphere at its default color rather than implying a status the scan never established.

A "Done" button tears down the camera stream the same way `/scan`'s `teardown()` already does. No `ScanSession`, no `IndexedDB`, no write to `HandData` — this reads the existing record and displays it, nothing more. Because it only depends on `HandData` already existing, it's reachable any time, not just immediately after a scan — including right after manually adjusting a sphere's radius, to see the effect immediately.

## Sources / related docs

- `docs/thumbs/scan_procedure.md` — the protocol this architecture implements, phase by phase.
- `docs/thumbs/scan_utility_evaluation.md` — consumes `Joint.quality`, `DipPipCoupling.r2`, and `Enslaving.r2` as trustworthiness metrics.
- `docs/thumbs/pre-development-work.md` §1 — the schema groundwork this extends.
- `src/lib/hand.ts`, `src/lib/handhelpers.ts` — the kinematic engine and persistence contract this builds on.
- `src/routes/scan/` — the capture-UI patterns and display components `/scan3` reuses.
- `src/routes/beta/lib/viewers/viewer3dHelpers.ts` — `HAND_RADIUS`, the hardcoded global constant `ContactSpheres` replaces.
