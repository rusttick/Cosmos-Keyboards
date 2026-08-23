# Pre-development work: what's needed before implementation begins

`problems.md` and `scanning.md` establish _what_ we now believe is worth measuring and _why_ — grounded in the actual limits of MediaPipe Hands, a single fixed camera, and real biomechanics literature.

None of that is implementation-ready yet. This doc is the checklist for closing the gap between "we know what we want to measure" and "we can start writing code" — four distinct gaps, each with its own deliverable, none of which is code.

## 1. Data contract: specify the exact scan output schema

Nothing downstream — placement algorithm, UI, tests — can be built against a moving target. Before any capture-pipeline code changes, the extended output format needs to be nailed down as a reviewable spec, not discovered incrementally while coding.

**What needs specifying**, extending today's `Joints`/`HandData` (`src/lib/hand.ts`, `src/lib/handhelpers.ts`):

- Per-joint ROM, two tiers (comfortable, full) — new fields, units, and whether they live per-`Joint` or as a parallel structure.
- Neutral pose — is this a modification to the existing `Joint.position`/basis fields, or a separate captured reference pose stored alongside them?
- The enslaving coefficient matrix (`E[i][j]`) — new top-level structure, not per-joint.
- Blocked/prohibited joint-angle regions per finger pair (§5 of `scanning.md`) — likely the most awkward to fit into today's schema shape, since it's a relation between two fingers, not a property of one.

**A concrete prerequisite this surfaced:** `src/lib/hand.ts` and `src/routes/scan/lib/hand.ts` are currently two independent copies of the same logic (noted when we compared the v1/v2 scan flows earlier). Extending the schema means deciding whether to de-duplicate these first — extending both copies in parallel and letting them drift is exactly the kind of thing that turns into a maintenance problem later, and it's cheaper to fix before new fields exist in two places than after.

**Versioning:** `readHands()` (`handhelpers.ts`) already branches on a `version` field (v1 = legacy meters/no version field, v2 = mm). The extended format should be an explicit new version rather than a silent reinterpretation of existing fields — this matches how the rest of the project handles compatibility (see §2) and keeps old scans (including the two you already captured this session) loadable without a migration step.

**Deliverable:** a written schema (TS interface + a short doc comment per field explaining units/derivation) circulated for review before any capture code changes — not discovered ad hoc while implementing.

## 2. Fit the existing framework, and give this a real shot at merging upstream

Facts on the ground, gathered this session:

- This clone is a fork (`rusttick/Cosmos-Keyboards`) of an actively maintained upstream (`rianadon/Cosmos-Keyboards`, AGPL-3.0). "Merge back" means convincing that maintainer, not just making the code work.
- `docs/docs/contributing.md` is the only contribution guidance that exists (no `CONTRIBUTING.md`, no PR template) — it explicitly asks contributors to **put each big change in its own branch/PR, discussed independently**, and points to a real past example PR as the model to follow. There's no RFC/design-doc process beyond that.
- CI (`.github/workflows/pr-checks.yaml`) gates every PR on three things: `dprint check` (formatting), `bun test` (all existing `*.test.ts` files, 11 today), and a TypeScript check (`bun src/scripts/check.ts`). Any contribution needs to pass all three, and new functionality should come with its own test in the same style as what's already there — `config.test.ts`'s round-trip-through-serialization pattern and `model.test.ts`'s decode-a-real-config-and-render-it integration pattern are the two closest precedents for what this feature would need.
- Backward compatibility in this codebase is handled by **keeping old formats parseable**, not by a migration system — old `.proto` schemas (`cuttleform.proto`, `manuform.proto`, `lightcycle.proto`) are kept around solely so old serialized URLs keep working. The schema versioning approach in §1 should follow that same pattern rather than inventing a new one.

**What this means concretely, before writing code:**

- Decide, explicitly, whether the goal for this feature is upstream contribution or a personal fork feature — this determines how much process (maintainer discussion first, matching the branch-per-change convention) is worth doing now versus deferring. Given the scope of what's been designed (new scan phases, new schema fields, a new placement UI), this is squarely "big change" territory by the contributing doc's own framing, and probably warrants opening a discussion with the maintainer (GitHub issue or the Discord the README points to) describing the direction _before_ a large PR shows up unannounced — consistent with what the doc asks for, and cheaper than building something that gets rejected on approach rather than execution.
- Whatever the sequencing (see §4) ends up being, each slice needs to map to an independently-reviewable branch/PR, not one large drop.

## 3. Map the constraint-based placement UI, end to end

This is the least-designed piece of everything discussed this session, and the one most likely to go sideways if coded before it's mapped out. The target: replace today's row/column/curvature-driven `/beta` editing (`ShapingSection.svelte`, `ShapingTable.svelte`) with a flow where the user progressively constrains remaining free variables until a fully placed board results — informed by, not dictated by, the scanned hand model.

**What needs to be enumerated before this is buildable:**

- The actual list of "unconstrained variables" the target system exposes: per-finger key count, per-finger ROM-% band (comfortable-range slider), thumb key count/placement, wrist/tenting placement (via the guardrail-feedback manual placement from `problems.md` §4), which ROM tier (comfortable vs. full) governs a given decision.
- The order the user is walked through constraining them, and what's reusable from existing components (`HandFitView.svelte`'s live-fit pattern, `Viewer3D.svelte`'s rendering, the reachability-highlight logic in `viewer3dHelpers.ts`) versus what's net-new.
- What live feedback accompanies each step (3D preview, reachability overlay, the collision/enslaving warnings from `scanning.md` §5, the wrist guardrail from `problems.md` §4).
- What "done" looks like — presumably a fully placed board that flows into the existing config/export pipeline unchanged, so this feature is additive to `/beta`'s editing modes rather than a fork of the whole app.

**Deliverable:** a UI flow doc (can include rough wireframes/sketches) mapping this out before any component code is written — this is a design task, not an implementation task, and should be treated as its own planning artifact separate from this checklist.

## 4. Implementation sequencing — a lock-step breakdown

Given the contributing doc's explicit preference for small, independently-discussable branches, and the CI requirement that every PR carry its own passing tests, the natural sequencing is small vertical slices, each with its own test coverage, each mergeable (or at least reviewable) on its own before the next begins:

1. **Schema-only.** Extend `HandData`/`Joints` per §1's spec, version-bumped, no capture-pipeline behavior change. Add a round-trip test in the style of `config.test.ts`. This validates the data contract in isolation and gives reviewers something small to react to first.
2. **First new capture phase.** Pick the smallest one — likely neutral-pose capture (still-window detection, §2 of `scanning.md`) — and retrofit `/scan` v1's `Recording.svelte`/`stats.ts` to retain per-frame data through one guided segment. Proves the "scripted multi-phase capture" pattern end-to-end before building the rest of it.
3. **Remaining finger-ROM phases** (full/comfortable tiers, per-finger orientation changes) — incremental, same pattern as step 2, now that it's proven.
4. **Paired drag/block trials** (enslaving + collision, `scanning.md` §5) — the most complex capture addition; do this last among capture work, once the simpler guided-phase pattern is solid.
5. **Interactive `SolvedHand.position` placement UI** (`problems.md` §4) — this can run in parallel with steps 2–4 rather than after them, since it only depends on whatever `HandData` already exists, not on the new capture phases. Worth doing early if a demoable result matters, since it doesn't block on the harder capture work.
6. **Thumb key placement algorithm** (Track A, from the now-superseded `plan1.md`, folded in here as the schema and literature-ROM approach it depended on) — depends on step 1's schema and whatever capture data exists by that point (literature ROM is a valid fallback per the original plan, so this doesn't strictly block on steps 3–4 finishing).
7. **Generalized finger key placement** (ROM-% band sliders, replacing curvature) — depends on step 6's placement machinery and step 3's finger data.

Each numbered item is sized to be its own branch/PR, matching what `contributing.md` asks for, and each should carry its own test before being considered done — not deferred to a final integration-testing pass.

## Checklist for next session

- [ ] Write the extended `HandData`/`Joints` schema spec (§1), including the de-duplication decision for the two `hand.ts` copies.
- [ ] Decide upstream-contribution vs. fork-only intent, and if upstream, draft the discussion post for the maintainer (§2).
- [ ] Write the UI flow doc for the constraint-based placement experience (§3) — separate artifact, not a section of this one.
- [ ] Confirm or adjust the phase breakdown in §4 against whatever the schema/UI docs turn up.
- [x] Delete `plan1.md`.
