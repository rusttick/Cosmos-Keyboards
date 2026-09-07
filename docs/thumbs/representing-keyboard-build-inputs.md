# Representing keyboard-build inputs: a staged 3D visualization plan

> **Status:** Completed, 2026-09-07 · Depends on: `key-point-selection.md`, `average-hand.md`, `goals.md`,
> `scan-utility-evaluation.md` · Supersedes (for this purpose): `archive/sweep_region_preview.md` · See
> `test-results.md`'s 2026-09-07 entry for what was built, bugs found, and lessons learned. Stages 0-8
> are all implemented at `src/routes/scan-tests/capability-field/` and `src/routes/scan3/lib/keypoints/`.
> The "Explicitly out of scope" section below remains genuinely out of scope — Step 0's real landmark-0
> sampling, Step 3's packing, Step 5's cross-finger effects, and keyboard-shape rendering are all real
> next steps, not done here.

`key-point-selection.md` describes an algorithm that turns the hand-model posterior into key
placements, but nothing in this project can currently _look at_ any part of that pipeline in 3D —
every existing scan-tests page (`static-hold`, `flexion-sweep`, `multi-view`, `thumb-cmc`) renders via
HTML5 Canvas 2D, not the real 3D stack (`three` + `@threlte/core`/`@threlte/extras`) that `/beta`
itself uses. This doc plans a small, staged sequence of 3D viewer builds — starting from an empty
scene and ending at a real, cost-colored per-finger capability field driven by the fused
literature + InterHand2.6M subject-0 prior — so the hand model's ability to generate keyboard-design
inputs becomes something you can actually see, well before `key-point-selection.md`'s packing/placement
steps exist.

This is visualization-only. No key placement, no packing, no keyboard-shape rendering happens in any
stage below — see "Explicitly out of scope" at the end.

## Naming: what is actually being visualized

`key-point-selection.md` never names its own output — Step 2 calls it "the cost field," its result an
"unstructured cloud of `(position, joint-angles, posture cost, manipulability cost, positional uncertainty)` tuples." That's accurate but not a name anyone can say out loud. The closest named
concept in the literature this project already cites (`key-point-selection.md`'s own sources list) is
the robotics **capability map** — a workspace representation scoring reachable points by how well a
manipulator can act at them, exactly the "how good is this kinematic chain, on its own terms" framing
`scan-utility-evaluation.md` already adopts wholesale from robot-manipulator analysis.

**Adopted terminology for this doc and the code it produces:**

- **Capability sample** — one `(position, joint-angles, posture cost, manipulability cost, positional uncertainty)` tuple, Step 2's atomic unit.
- **Capability field** — the full collection of samples for one finger (or, later, one hand): the
  visualized object itself.
- **Capability cloud** — the same thing, used interchangeably where "cloud" reads more naturally (e.g.
  describing the point-cloud rendering technique specifically, vs. the conceptual object).

Not adopted: "keypress space" or "keypress surface" (implies a 2D/press-plane structure the model
doesn't have yet — Step 2's output is a 3D point cloud, not a surface, and nothing here should imply a
surface exists until an actual fitted one does); "reachability" alone (already a distinct, narrower,
existing concept in this codebase — `viewer3dHelpers.ts`'s `computeReachability`, a binary
max-reach-sphere check against a _specific keyboard's_ keys, which is exactly the layout-dependent
thing `scan-utility-evaluation.md` and this doc are both explicitly trying not to be).

## Design principle: no keyboard-shape assumptions

`goals.md` states the project's reason for existing as replacing "a small set of hand-shape parameters
tuned to fit the existing dactyl-style parametric solver" — not producing "a better dactyl config."
`key-point-selection.md` operationalizes that as generating key datums "without assuming any layout
topology (no column, no dish, no fixed thumb cluster)," explicitly excluding published
split-angle/gable-angle/slope-angle recommendations as inputs ("using them as an input would silently
reintroduce a layout-topology assumption") and leaving key count, resulting shape, and keyboard
tilt/split/slope all as _emergent outputs_, never targets imported from prior ergonomic-keyboard
studies. `scan-utility-evaluation.md` applies the same discipline to measurement: every metric it
proposes is "computed purely from `Joints`/`SolvedHand`, with no reference to any `Cuttleform` config or
`c.keys`," specifically so a bad scan and a bad-fit layout never get conflated.

This visualization work inherits that discipline directly. Concrete rules for every stage below:

- **Never import from, or reference, any existing keyboard-shape code or config.** No `Cuttleform`
  type, no `c.keys`, no `/beta` viewer helpers that bake in row/column/curvature assumptions
  (`viewer3dHelpers.ts`'s `keyReachable`/`reachability` included — that's the layout-_dependent_ check
  this whole project exists to move past, not a component to reuse here).
- **Never render a column/row/curvature/stagger guide, or a fixed thumb-cluster region, as a visual
  reference.** If a capability field happens to look columnar or dish-shaped once real data drives it,
  that's a finding to report, not a shape to draw toward.
- **Never draw a published "ideal" split/tenting/slope angle as a target or overlay.** If a future
  stage needs to show _a_ candidate keyboard orientation for context, it must come from the model's own
  cost terms (Step 0's landmark-0 posture cost), never a number lifted from ergonomic-keyboard
  literature.
- **Treat any temporarily-fixed landmark-0 pose as a flagged placeholder, not a design decision.**
  Stages 3–7 below fix landmark-0 for engineering convenience before Step 0's own sampling exists —
  this must be visually distinguishable (see "Open questions" below) so a screenshot from this phase is
  never mistaken for a finished answer about where the wrist "should" sit.
- **Use only generic kinematics/statistics vocabulary in code and UI** — "capability field,"
  "manipulability," "posture cost," "positional uncertainty" — never ergonomic-keyboard-specific terms
  like "the column" or "the dish" that presuppose a topology this project is trying not to assume.

## What already exists to build on

- **The 3D stack itself** (already in `package.json`, see prior research this session): `three`,
  `@threlte/core`, `@threlte/extras` (`InstancedMesh`/`Instance` for cheap many-marker rendering,
  `OrbitControls`-equivalent camera control).
- **`Viewer.svelte`** (`src/routes/beta/lib/viewers/Viewer.svelte`) — a reusable Canvas/camera/controls
  shell: `<T.PerspectiveCamera>` + orbit controls + camera-fit-to-bounds, with a bare `<slot/>` and no
  opinion about scene content. Exactly the shell to mount for every stage below — no new camera/canvas
  plumbing needs writing.
- **`HandModel.svelte`** (`src/lib/3d/HandModel.svelte`) — renders a posed hand by calling
  `hand.localTransforms(baseMatrix, scale)` onto a rigged GLB's armature nodes. Useful for later
  full-hand context (Stage 7), with a caveat noted there.
- **`Pose.svelte`** (`src/routes/scan/lib/Pose.svelte`) — the closest existing precedent for turning
  `fkBy` samples into a renderable cloud: sweeps one synthetic parameter across a finger's joints,
  collects fingertip positions, and (separately) builds a point cloud via merged `SphereGeometry`
  instances. Superseded in intent by this plan (it uses an arbitrary hardcoded `extent`, not the real
  prior), but the sampling-loop shape is directly reusable.
- **`SolvedHand.fkBy`/`worldPositions`** (`$lib/hand.ts`) — the actual "set joint angles, get
  positions" primitive every sampling stage below calls.
- **`ikSolve.ts`**: `buildDefaultSkeleton(prior, handedness)` (population-prior skeleton, including the
  ring/pinky CMC and thumb saddle joints `key-point-selection.md` requires), `buildRestExtensionPose`/
  `buildRestExtensionSkeleton` (a static rest-pose renderer built for exactly the "show the prior alone,
  isolated from live-tracking noise" purpose Stage 7 needs).
- **`fuseHandPriorState(sources, hand)`** (`fuseSources.ts`) + **`ALL_PRIOR_SOURCES`** (`registry.ts`,
  currently `[LITERATURE_SOURCE, INTERHAND_0_SOURCE]`) — the already-agreed mechanism for getting the
  fused prior this whole plan samples from.
- **`scan-utility-evaluation.md`'s manipulability/Jacobian construction** — a numerical
  finite-difference Jacobian over `fkBy`/`worldPositions` (perturb one free angle, re-run FK, take the
  derivative), feeding Yoshikawa's index `w(q) = √det(J·Jᵀ)`. `key-point-selection.md` names this doc as
  the source of that machinery for its own Step 2 — reuse the same construction here rather than
  re-deriving it.
- **`archive/sweep_region_preview.md`** (superseded, but instructive) — an earlier, narrower version of
  this exact idea: grid-sample a finger's free angles, render fingertip positions as a point cloud, no
  placement logic. It used a placeholder hardcoded angle range instead of the real posterior and predates
  the `HandPriorState`/`ikSolve.ts` architecture entirely — this plan supersedes it by driving from the
  real fused prior from Stage 3 onward, but its route-shell/point-cloud approach is the right shape to
  start from.

## Where this lives in the repo

- **Sampling and cost math**: `src/routes/scan3/lib/keypoints/` — real, reusable, unit-tested (`bun:test`)
  TypeScript, mirroring the `priors/` directory's convention (one small file per concern, a `.test.ts`
  next to each). The viewer page should be a thin renderer over this, not where the math lives — the
  same separation `geometry.ts`/`model.ts` enforce elsewhere in this codebase, and what lets Steps 1–2's
  actual logic be verified against synthetic data before any rendering exists.
- **The viewer page**: `src/routes/scan-tests/capability-field/+page.svelte` — under `scan-tests/` to
  match this project's existing convention for a read-only evaluation view over real pipeline code
  (`multi-view` plays the identical role for `ikSolve.ts`'s per-frame solve). Not under `/beta` — this
  has nothing to do with a specific keyboard config, per the design principle above.

## Staged build-up

Each stage is a small, independently-mergeable step (per this project's own branch-per-change
convention). Every stage after Stage 2 replaces exactly one placeholder from the previous stage with
real data or a real dimension — nothing is rebuilt from scratch partway through.

### Stage 0 — Empty, lit, navigable scene

**Goal:** confirm the Threlte stack renders in a brand-new route before any hand-specific content
exists to debug alongside plumbing issues.
**Build:** mount `Viewer.svelte` with a ground grid/axes helper, ambient + directional light, orbit
controls. No hand, no sampled data, no prior.
**Exit:** the route loads; the empty scene can be orbited, panned, and zoomed.

### Stage 1 — One primitive, at the right scale

**Goal:** fix the unit/scale convention for this whole viewer before any real geometry depends on it.
`SolvedHand.worldPositions(finger, scale=100)` returns positions in a `scale`d unit (100 → millimeters);
get this right once, here, rather than discovering a 100x error later the way `multi-view`'s first
`projectCorrectedOntoKeypoints` version did (`test-results.md`, 2026-09-06).
**Build:** a single small sphere placed at the origin using the same `scale=100` convention.
**Exit:** the sphere's size/position reads as anatomically plausible (e.g., roughly fingertip-sized at
roughly hand-scale distance from origin) — confirms the convention to standardize on before Stage 3
introduces real sampled positions.

### Stage 2 — Placeholder capability field (synthetic, no real math)

**Goal:** settle the visual language — marker type, size, density, and colormap — independently of
whether the underlying sampling/cost math is correct yet. Decouples "does this look readable" from
"is this number right."
**Build:** a synthetic point cloud (e.g., points scattered across a sphere shell at a plausible
fingertip-reach radius from the Stage-1 origin), rendered via `@threlte/extras`'s `InstancedMesh`,
colored by a fake scalar (e.g., distance from an arbitrary synthetic reference point) through a
sequential colormap (see "Open questions" on why sequential, not the tiered green/red scheme used
elsewhere in this codebase).
**Exit:** a component with a settled API — `points: Vector3[]`, `scalar: number[]`, a colormap
function — that every later stage feeds real data into unchanged.

### Stage 3 — Real single-joint sweep: index finger, MCP only

**Goal:** get one real data path working end to end — `fuseHandPriorState` → sample joint angles →
`fkBy` → `worldPositions` → Stage 2's cloud component — on the smallest possible slice, before
generalizing.
**Build:** sample only the index finger's MCP (both axes) from the fused
`[LITERATURE_SOURCE, INTERHAND_0_SOURCE]` prior; landmark-0 fixed at a hardcoded origin/identity
orientation, explicitly commented as a Step-0 placeholder per the design principle above; uniform
per-sample color (no cost yet — that's Stage 8).
**Exit:** a real, prior-driven point cloud for one joint of one finger, replacing Stage 2's synthetic
sphere.

### Stage 4 — Full index-finger chain (MCP + PIP + DIP, with coupling)

**Goal:** verify multi-DOF sampling and the DIP-given-PIP coupling posterior integrate correctly before
generalizing across fingers — `goals.md` requires DIP not be sampled as an independent dimension where
the fitted coupling says it's effectively determined by PIP.
**Build:** extend Stage 3's sampler to the index finger's full free-DOF list per
`key-point-selection.md`'s "Candidate space per finger, per joint type."
**Exit:** one finger's full-chain capability cloud, still uniformly colored, landmark-0 still fixed.

### Stage 5 — All non-thumb fingers

**Goal:** generalize Stage 4 across fingers before tackling the thumb's structurally different joint
model separately.
**Build:** loop Stage 4's sampler over the four non-thumb fingers, each reading its own entry from the
same fused prior, each rendered in a distinct color.
**Exit:** four-finger capability cloud in one scene.

### Stage 6 — Thumb (saddle joint + conjunct rotation)

**Goal:** isolate the thumb's `degree: 3`/`ConjunctCoupling` sampling as its own stage rather than
folding it silently into Stage 5's loop and discovering a bug there later — this is the joint this
whole project's test history (`test-results.md`) found the most ways to get wrong.
**Build:** thumb-specific sampling reading `cmcMobility.thumb`'s flex/ab-ad ROM and conjunct-coupling
coefficients.
**Exit:** full five-finger capability cloud, one color per finger, no cost weighting yet, landmark-0
still fixed.

### Stage 7 — Full-hand context

**Goal:** ground the floating capability clouds against an actual hand pose, so a viewer can sanity-check
"does this cloud sit where a real fingertip sweep should be" by eye.
**Build:** render a simplified skeleton (joints as small spheres, bones as lines) posed via
`buildRestExtensionPose`/`buildRestExtensionSkeleton` at the population-mean rest pose, alongside the
five capability clouds. **Deliberately not `HandModel.svelte`'s rigged GLB mesh** for this — a specific
fleshed-out hand mesh is itself a visual assumption about hand shape that this project is trying to stay
independent of; a skeleton makes clear that only the measured/prior joint geometry is being shown.
**Exit:** one scene with a skeletal rest-pose hand and five real capability clouds.

### Stage 8 — Real costs (posture, manipulability, positional uncertainty)

**Goal:** replace uniform per-finger coloring with `key-point-selection.md`'s actual Step 2 scoring.
**Build:** for each retained sample, compute:

- **posture cost** — negative log-density under the current posterior (reuse `handModel.ts`'s
  Beta/Gaussian machinery already used by `ikSolve.ts`'s prior term);
- **manipulability cost** — the finite-difference Jacobian construction from
  `scan-utility-evaluation.md`;
- **positional uncertainty** — the posterior covariance propagated through the same Jacobian.

Expose all three as selectable color channels (a toggle), not one fixed choice — they measure different
things and `key-point-selection.md`'s packing step needs all three later. Per the landmark-0-independence
result from earlier design discussion, all three are computable in the wrist-local frame, so this stage
still doesn't need Step 0's landmark-0 sampling to be real.
**Exit:** a per-finger capability field, colorable by any of the three real Step 2 costs, still
landmark-0-independent.

## Explicitly out of scope for this doc

Named so nobody mistakes "the viewer exists" for "the pipeline is done":

- Step 0's landmark-0 sampling and its posture/injury-risk-vs-force-availability cost.
- Step 3's cost-weighted, spacing-constrained greedy packing into actual key candidates.
- Step 5's cross-finger effects (physical clearance, kinematic blocking, accidental-activation risk via
  the enslaving matrix).
- Any keyboard-shape rendering at all, in any stage.

Each is a real next step once Stage 8 lands, substantial enough to deserve its own plan rather than
being folded in here.

## Verification

Every numeric stage (3–6, 8) gets its sampling/cost logic unit-tested against synthetic data before
being trusted with real prior data, per this project's established practice (`test-results.md`'s
repeated "verify synthetic, then live" pattern) — living in `scan3/lib/keypoints/*.test.ts`, run via
`bun test`. Visual-only judgments (marker size, colormap readability, whether the Stage-7 skeleton
"looks right" next to the clouds) are explicitly not automated, the same distinction
`average-hand.md`'s own Testing section draws between unit-testable math and "a human judgment call, the
same role live capture pages already play."

## Open questions

- **Performance ceiling.** Five fingers × up to ~4 free DOF each, at what grid/sampling resolution
  before `InstancedMesh` count gets unwieldy? Likely fine into the low thousands of instances per
  finger; not measured yet.
- **Marking placeholder landmark-0 as a placeholder.** Stages 3–7 fix the wrist pose for engineering
  convenience before Step 0 exists. Per the design principle above, this needs to be visually obvious —
  e.g. a persistent on-screen label or a distinct border color — so a screenshot from this phase is never
  read as a finished statement about where the wrist belongs. Not designed yet, just flagged.
- **Colormap choice.** Recommend a sequential, perceptually-uniform scale (cost/manipulability/uncertainty
  are continuous, ordered quantities) rather than this codebase's existing tiered green/red
  comfortable-vs-dangerous scheme (`ContactSpherePreview`'s deviation coloring) — a discrete "good/bad"
  split would itself be an unearned assumption about what counts as good, before the packing step (out
  of scope here) actually defines that. Worth deciding deliberately, not copying the nearest existing
  convention.
