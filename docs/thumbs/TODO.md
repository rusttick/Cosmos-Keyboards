# TODO

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

## literature search: Group A — bone lengths

- [x] Shortlist candidate anthropometric sources for per-segment hand-length regressions
      (Buchholz, Armstrong & Goldstein 1992 "Anthropometric data for describing the kinematics of the human hand";
      the "Proportions of Hand Segments" scielo paper; others if found) — a scoping pass, not a commitment yet.

- [x] Fetch/read the leading candidate and confirm it actually publishes a per-segment mean/SD or regression-coefficient table
      (not just a summary R² range) — the R² 0.49–0.99 figure already cited is secondhand;
      verify against the source before committing to it.
      Buchholz's own table sits behind a paywall (couldn't fetch it); Buryanov & Kotiuk 2010 does
      publish a full per-segment mean/SD table and was used instead — see handModelData.ts.

- [x] Reconcile the source's segment definitions against this project's landmark-based bone segments
      (wrist→MCP, MCP→PIP, PIP→DIP, DIP→tip) — clinical/anthropometric studies often measure bone-to-bone or crease-to-crease,
      not MediaPipe's skin-landmark convention; confirm they line up before transcribing anything.
      Middle two segments line up cleanly; the distal segment needs bone+soft-tissue summed; the
      metacarpal segment is a documented underestimate (missing the wrist-to-CMC carpal offset) — all
      flagged in handModelData.ts's own comments.

- [x] Transcribe the chosen table's mean/SD (or regression coefficients) per segment into handModelData.ts,
      each constant carrying a source comment (ConjunctCoupling's doc-comment convention).

- [x] Verify the transcribed seed against handModelData.test.ts's own stated criteria (every length positive, covariance matrices PSD) once both exist.

## literature search: Group E/F — DIP/PIP coupling and enslaving

- [x] Check whether the isometric-force enslaving literature already cited elsewhere in these docs
      (Kilbreath & Gandevia; "Matrix analyses of interaction among fingers in static force production tasks";
      the PMC "origin of finger enslaving" paper) publishes actual numeric finger-pair coefficients
      usable as a wide-covariance seed for Group F — separate from, and weaker than,
      this project's own kinematic fitEnslaving capture.
      Zatsiorsky/Li/Latash 2003 does publish real numeric interfinger matrices, but they're an
      isometric-force quantity, not this project's kinematic-angle one, and sit behind a paywall besides.

- [x] Separately check for DIP/PIP flexion-coupling literature (hand-therapy/biomechanics sources on Landsmeer's-ligament-driven coupling ratios) for Group E —
      a different joint relationship than enslaving, needs its own search, not bundled with the above.
      Only qualitative/anatomical descriptions found (Landsmeer's ligament itself), no numeric coupling
      ratio anywhere.

- [x] For whichever of the two turns up a real source: decide explicitly whether the domain mismatch
      (isometric force vs. kinematic angle; general population vs. this project's typing-specific interest)
      makes it worth using as a wide/uninformative-leaning seed,
      or whether "no usable source" should stand — a judgment call to make once the numbers are in hand, not before.
      Judgment call: don't adopt the isometric-force numbers even loosely — different physical quantity,
      not just a different population. See handModelData.ts's Group F comment.

- [x] If adopted: transcribe into handModelData.ts with a source comment and an explicit note on the domain-mismatch-driven wide covariance.
      If not adopted for either: leave as currently documented (uninformative prior, honestly flagged) — no further action.
      Not adopted for either — left as the uninformative/interim priors already documented.

## `average-hand.md` implementation stages

- [x] Stage 1 — Types: `src/routes/scan3/lib/priors/handModel.ts` (`HandPriorState`)
- [x] Stage 2 — Seed data: `handModelData.ts` (blocked on the Group A task above)
- [x] Stage 3 — Solver: `ikSolve.ts` v1 (per-frame constrained solve). Covers Groups A–F and, now that
      `$lib/hand.ts` has the ring/pinky CMC and thumb-saddle joints, Group D in full. Group G
      (wrist/forearm/elbow) is solved as 5 plain scalars with the tenodesis cross-term implemented;
      the forearm-length↔stature and elbow-swivel cross-terms are explicitly NOT implemented yet (the
      first is a cross-session length-estimation concern for Stage 4, not a per-frame pose term; the
      second needs real 3D geometry against the solved wrist pose, not a linear coefficient) — both
      left as named gaps in ikSolve.ts's own doc comment, not invented numbers. No warm start /
      temporal smoothness (see the already-checked item above) and no divergence recovery in this v1.
- [x] Stage 4 — Promotion/posterior update: `update.ts`. Implements the standard scalar and vector
      (Kalman) Bayesian updates, the exclusion gate, and `narrowViaTenodesis` (the one cross-group
      correlation that actually narrows a Group G quantity today). Explicitly NOT implemented: the
      "cross-session consistency" half of the promotion gate (comparing a new observation against
      previous ones before trusting it) — no concrete algorithm for that exists anywhere in these docs
      yet; `evidenceCount` tracking is added instead (a real piece of "session count" evidence
      reporting, not itself a consistency check). No caller exists yet either — there's still no
      `ScanSession` capture pipeline (see the top of this file) to call it from.
- [x] Stage 5 — Render glue: `ikSolve.ts`'s `poseToLandmarkVectors`/`poseConfidenceSdDeg`. No new FK
      math, per the spec — reuses `SolvedHand.fkBy`/`worldPositions` as-is, just maps chain positions
      onto MediaPipe's landmark numbers via `CONNECTIONS`.
- [x] Stage 6 — Read-only evaluation page: `scan-tests/multi-view/+page.svelte` now runs `ikSolve.ts`'s
      solve every frame against a fixed literature-seed `HandPriorState` snapshot and renders the
      corrected pose across the 8 side tiles (never the raw tracked frame) with per-landmark opacity
      for confidence (`overlay.ts`'s `drawSkeletonView` gained a `landmarkOpacity` option for this).
      Verified the route builds and renders with no console/runtime errors; not verified live against
      a real camera feed in this pass.

## `ikSolve.ts` v1 vs. `goals.md` — gaps found on reviewing goals.md against the actual code (2026-09-06)

Stage 3 is marked done above because it runs and is tested, but re-reading `goals.md` against what
`ikSolve.ts` actually does turned up three real, unimplemented requirements — none silently hidden in
code comments the way Group G's other two cross-terms were, so calling them out explicitly here. All
three closed 2026-09-06:

- [x] MCP's ab/ad range is supposed to mechanically choke as flexion increases (`goals.md`: "widest near
      extension, mechanically choked as the joint flexes toward it, per collateral-ligament
      tightening"). `mcpAxes[finger].abAdChokeCoeff` exists in `HandPriorState` and is seed-tested, but
      `ikSolve.ts` never read it — flexZ and abAdY were solved as independent ROM priors with no
      coupling between them at all.
      Fixed: `solvePose` now recomputes the ab/ad joint's effective half-range/sd every sweep from the
      joint's own current flexion angle and `abAdChokeCoeff`, with a floor so it never collapses to
      zero, and feeds the same choked bound into the final hard clamp. `abAdChokeCoeff`'s seed value is
      still 0 (no numeric source found — see the Group A/handModelData.ts notes above), so this has no
      effect on any real prior yet; it's tested with a synthetic nonzero coefficient.
- [x] MCP's "low-weight third axial term" (`goals.md`: "a smaller flexion-phase-dependent axial rotation
      ... never a single pooled axis") has no representation in `$lib/hand.ts`'s FK chain at all. Every
      non-thumb MCP is `degree: 2` (two axes, no third); only `degree: 3` (thumb CMC) carries a derived
      third rotation, via `conjunctCoupling`. Giving MCP the same mechanism (or an equivalent) is a
      `$lib/hand.ts` FK-chain change of the same shape as the ring/pinky CMC fix already done — not
      started.
      Partially fixed: `$lib/hand.ts`'s `fkBy`/`fromLimbs` already handle `degree: 3` generically (not
      thumb-specific), so no FK-chain change was actually needed there. `ikSolve.ts`'s own
      `degreesFor`/`buildDefaultSkeleton` now give every non-thumb MCP `degree: 3`, with
      `conjunctCoupling.aCoeff` read from `mcpAxes[finger].axialRotationWeight` and `bCoeff` hardcoded 0
      (goals.md documents the twist as flexion-phase-dependent only, never ab/ad-coupled). This only
      takes effect for `buildDefaultSkeleton`'s population-prior fallback skeleton — real scans still
      produce `degree: 2` MCP joints via `calculateJoints`/`fitNorms`, which has no path to _fit_ a
      `conjunctCoupling` for MCP the way `thumbCmc.ts` does for the CMC. That per-user fitting is a
      separate, larger task, not started.
- [x] The exclusion rule (`goals.md`: "An observation from an excluded condition (dorsal, thumb-lateral,
      self-occluded) never enters the likelihood for that quantity, regardless of how many accumulate")
      has no representation in `ikSolve.ts` at all — every frame's data term uses whatever `trackedPose`
      recovers, unconditionally, with no notion of "this frame/orientation is excluded." `update.ts`
      does have an `excluded` flag (and is tested for it), but that's the cross-session write path, not
      the per-frame solve. `average-hand.md`'s own `ikSolve.test.ts` spec names this exact behavior ("a
      synthetic excluded-condition observation is confirmed to never enter the objective, not merely
      down-weighted") — untested and unimplemented here.
      Fixed: `solvePose` takes an optional `excluded: ExcludedFingers` (`'all'` or a `Set<Finger>`) —
      an excluded finger's data-term weight is forced to 0 (not merely reduced) and its cold-start value
      comes from the prior mean instead of the tracked reading, exactly as if nothing had been tracked
      for it that frame. No caller wires this to a real dorsal/thumb-lateral/self-occlusion detector
      yet — that detection logic doesn't exist anywhere in this project yet either, so there's nothing
      to call it from until `/scan3`'s capture pipeline (or a live-view orientation guard) exists.

extracting handpriorstate parameters from intrahand data:

High confidence

1. Bone-length ratios, most segments. Already demonstrated clean signal in what we just pulled — 16 of 20 segments held to 4–8% coefficient of variation across 417 real frames.
   Rigid, no axis-convention dependency, directly measurable. The strongest candidate by a clear margin.
2. The thumb's wristToCmc segment specifically. This is the one field handModelData.ts currently flags as a pure guess with no source at all — and it measured cleanly in the
   same run (45.3mm mean, 4.8% CV). Directly fixes a named, explicit gap with real data. Arguably the single best win available here.

Medium confidence

3. [x] ROM mean/SD (the "typical posture" half of BetaRom) — done for PIP/DIP (the clean-hinge case) via
       `fitRom.ts`, feeding `buildSubjectPrior.ts`. Caveat stated in the seed's `source` string as planned:
       InterHand2.6M's frames come from deliberately posed gestures, not passive natural behavior, so this
       is "typical of the poses subjects were asked to perform," not quite "typical of ordinary use."
4. [x] DIP/PIP coupling — `fitDipPipCoupling.ts`, feeding `buildSubjectPrior.ts`'s `dipPipCoupling`.
       Turned out to fit cleanly against subject 0: R² 0.62–0.81 across all four non-thumb fingers, slopes
       0.40–0.55, none of the near-zero/negative-slope warning signs Stage 3b's own sanity check would have
       flagged as a likely remap/sign bug. Better than the discrete-named-pose worry above suggested.

Low confidence

5. [x] MCP ab/ad choke coefficient — `fitMcpChoke.ts`, gated on Stage 3c's own qualitative
       shrinkage-visible-before-fitting check (Pearson correlation between binned flexion and binned ab/ad
       half-range must be ≤ -0.3). Real result, not forced: index/middle showed no visible shrinkage
       (correlation slightly positive) and are honestly reported as `fitted: false`, un-included in
       `buildSubjectPrior.ts`'s output; ring (-0.39, chokeCoeff 0.026) and pinky (-0.78, chokeCoeff 0.233,
       a strikingly clean monotonic shrinkage) passed and are included, each with the axis-convention
       caveat stated in its own `source` string. One real bug found and fixed along the way: the first
       ab/ad-angle convention (`atan2(left, up)` against the palm frame) wrapped across ±180° once flexion
       pushed the direction vector out of the up/left plane entirely, at exactly the high-flexion (fist-pose)
       frames where this mattered most — replaced with `asin(dir · left)` (deviation from the sagittal
       plane), which has no such blind spot at any flexion angle. Caught by checking the raw per-bin numbers
       before trusting the fit, not by any test.
6. [ ] Enslaving-adjacent co-flexion correlation. Not attempted this pass. Numerically computable, but
       likely a worse proxy than even ordinary passive data: named multi-finger gestures (five_count,
       fingerspread) are voluntary, coordinated poses by construction, so whatever correlation comes out
       would be dominated by intentional co-contraction even more than an unstructured natural-motion
       dataset would be. Technically producible, weak claim to being the target quantity.

Not feasible from this data

7. axialRotationWeight / true axial roll. Already established as structurally unrecoverable without an independently known bone-axis convention this dataset doesn't provide.
8. Anything in wristForearm. No forearm or elbow ever appears in InterHand2.6M's captures. Zero chance regardless of method.

Also identified, not yet attempted: the thumb's own MCP/IP hinges (clean-hinge, real candidate numbers
already computed by `fitRom.ts` and printed by `subjectReport.ts`) have no field in `HandPriorState` at
all to map onto — `cmcMobility.thumb` only covers the CMC (base) joint. Filling this in means extending
`handModel.ts`'s schema first (e.g. a sibling `thumbMcpIpRom` group), not just writing another fitter.

Smaller, lower-priority note from the same pass:

- [ ] The ROM term is a Gaussian penalty plus a hard clamp, not `average-hand.md`'s specified Beta
      soft-limit density ("a soft limit, not a clamp"). Functionally similar at both extremes (near-free
      when unconverged, near-hard-limit when confident), but the hard clamp is literally the mechanism
      the spec says not to use. Not corrected here — flagging since it wasn't called out anywhere in
      code comments when it was written.

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
      cross-finger effects) — `average-hand.md` stages 1–6 are now all done, and `$lib/hand.ts` has the
      ring/pinky CMC and thumb-saddle FK joints (`calculateJoints` fits a real axis for ring/pinky's
      base joint; `thumbCmc.ts`'s new `assembleThumbCmcJoint()` combines Phase 6a/6b's fitted pieces
      into a real `degree: 3` joint). Not yet actually started as its own task, and still has its own
      open questions beyond that dependency (no `ScanSession` capture pipeline exists yet to run any of
      this against real per-user data — see the note on Stage 4 above).
- [ ] Canonical `HandPriorState` spec doc (discussed, not yet started) — a single document giving
      the full data structure and cross-correlation table in detail, once `goals.md`/`average-hand.md`
      are far enough along that it's worth freezing.
- [ ] Constraint-based placement UI (was `archive/pre-development-work.md` §3) — needs its own
      design doc; not scoped by anything currently active.
