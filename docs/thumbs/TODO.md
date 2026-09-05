# TODO

Maintained by hand, not claude.

- [x] Decide de-duplication of `$lib/hand.ts` vs `src/routes/scan/lib/hand.ts` before extending
      either further (`scan3-architecture.md` already resolved this for `/scan3` itself — building on
      `$lib/hand.ts` — but the old `/scan` fork is still live).
- [x] No temporal smoothness / warm-start between frames in `ikSolve.ts` v1 (named simplification,
      `average-hand.md` stage 3). Worth revisiting if the multi-view page shows visible jitter under
      corrupted input rather than a clean degrade.
- [x] Solver cold-start / local-minima robustness is an open question inherited from
      `ik-solve-research.md`, not resolved by `average-hand.md`.
- [x] `scan3-architecture.md` predates `HandPriorState`/`ikSolve.ts` — needs a pass once stage 1/2
      land to reconcile `Joint.quality`/`JointQuality` against the new prior/confidence model.

Group A — bone lengths

- [ ] Shortlist candidate anthropometric sources for per-segment hand-length regressions
      (Buchholz, Armstrong & Goldstein 1992 "Anthropometric data for describing the kinematics of the human hand";
      the "Proportions of Hand Segments" scielo paper; others if found) — a scoping pass, not a commitment yet.

- [ ] Fetch/read the leading candidate and confirm it actually publishes a per-segment mean/SD or regression-coefficient table
      (not just a summary R² range) — the R² 0.49–0.99 figure already cited is secondhand;
      verify against the source before committing to it.

- [ ] Reconcile the source's segment definitions against this project's landmark-based bone segments
      (wrist→MCP, MCP→PIP, PIP→DIP, DIP→tip) — clinical/anthropometric studies often measure bone-to-bone or crease-to-crease,
      not MediaPipe's skin-landmark convention; confirm they line up before transcribing anything.

- [ ] Transcribe the chosen table's mean/SD (or regression coefficients) per segment into handModelData.ts,
      each constant carrying a source comment (ConjunctCoupling's doc-comment convention).

- [ ] Verify the transcribed seed against handModelData.test.ts's own stated criteria (every length positive, covariance matrices PSD) once both exist.

Group E/F — DIP/PIP coupling and enslaving

- [ ] Check whether the isometric-force enslaving literature already cited elsewhere in these docs
      (Kilbreath & Gandevia; "Matrix analyses of interaction among fingers in static force production tasks";
      the PMC "origin of finger enslaving" paper) publishes actual numeric finger-pair coefficients
      usable as a wide-covariance seed for Group F — separate from, and weaker than,
      this project's own kinematic fitEnslaving capture.

- [ ] Separately check for DIP/PIP flexion-coupling literature (hand-therapy/biomechanics sources on Landsmeer's-ligament-driven coupling ratios) for Group E —
      a different joint relationship than enslaving, needs its own search, not bundled with the above.

- [ ] For whichever of the two turns up a real source: decide explicitly whether the domain mismatch
      (isometric force vs. kinematic angle; general population vs. this project's typing-specific interest)
      makes it worth using as a wide/uninformative-leaning seed,
      or whether "no usable source" should stand — a judgment call to make once the numbers are in hand, not before.

- [ ] If adopted: transcribe into handModelData.ts with a source comment and an explicit note on the domain-mismatch-driven wide covariance.
      If not adopted for either: leave as currently documented (uninformative prior, honestly flagged) — no further action.

## `average-hand.md` implementation stages

- [ ] Stage 1 — Types: `src/routes/scan3/lib/priors/handModel.ts` (`HandPriorState`)
- [ ] Stage 2 — Seed data: `handModelData.ts` (blocked on the Group A task above)
- [ ] Stage 3 — Solver: `ikSolve.ts` (per-frame constrained solve, Groups A–G unified per the
      elbow-as-occluded-node reframing — see `goals.md`'s "Update mechanism")
- [ ] Stage 4 — Promotion/posterior update: `update.ts`
- [ ] Stage 5 — Render glue (reuses existing `SolvedHand.fkBy`/`worldPositions`, no new code)
- [ ] Stage 6 — Read-only evaluation page: extend `scan-tests/multi-view/+page.svelte`

## Validation (`test-plan.md`) not yet run

- [ ] Bilateral vs. unilateral equivalence
- [ ] Thumb CMC axis fit + occlusion-guard logic
- [ ] Thumb freeform trajectory extraction vs. isolated baseline
- [ ] Coverage-grid resolution tuning
- [ ] Full-session repeatability (two complete sessions, same person)
- [ ] Fast-tapping validation of `E[i][j]` — deferred until the accidental-activation check in
      `key-point-selection.md` actually ships and needs it

## Not started, further out

- [ ] `key-point-selection.md`'s Steps 0–5 (landmark-0 placement, cost-field sampling, packing,
      cross-finger effects) — depends on `average-hand.md` stages 1–5 and on `$lib/hand.ts` gaining
      the ring/pinky CMC and thumb-saddle FK joints it doesn't have today.
- [ ] Canonical `HandPriorState` spec doc (discussed, not yet started) — a single document giving
      the full data structure and cross-correlation table in detail, once `goals.md`/`average-hand.md`
      are far enough along that it's worth freezing.
- [ ] Constraint-based placement UI (was `archive/pre-development-work.md` §3) — needs its own
      design doc; not scoped by anything currently active.
