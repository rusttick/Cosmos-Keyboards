# TODO

Maintained by hand, not claude.

## Known gaps, named but not yet closed

- [ ] Groups E (DIP/PIP coupling) and F (enslaving) have no population-literature source — currently
      uninformative/interim priors. Real coverage requires this project's own capture sessions to
      accumulate; not blocking, but day-one users get no coupling-based correction for these two.
- [ ] No temporal smoothness / warm-start between frames in `ikSolve.ts` v1 (named simplification,
      `average-hand.md` stage 3). Worth revisiting if the multi-view page shows visible jitter under
      corrupted input rather than a clean degrade.
- [ ] Solver cold-start / local-minima robustness is an open question inherited from
      `ik-solve-research.md`, not resolved by `average-hand.md`.
- [ ] `scan3-architecture.md` predates `HandPriorState`/`ikSolve.ts` — needs a pass once stage 1/2
      land to reconcile `Joint.quality`/`JointQuality` against the new prior/confidence model.

- [ ] **Group A literature seed** (`average-hand.md` stage 2) — pick one named anthropometric
      study, transcribe its per-segment bone-length mean/SD table into `handModelData.ts`. Nothing
      else in `average-hand.md`'s "prior beats bad data" story is testable until this exists.

- [ ] Decide de-duplication of `$lib/hand.ts` vs `src/routes/scan/lib/hand.ts` before extending
      either further (`scan3-architecture.md` already resolved this for `/scan3` itself — building on
      `$lib/hand.ts` — but the old `/scan` fork is still live).

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
