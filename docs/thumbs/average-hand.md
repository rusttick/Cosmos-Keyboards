# Average hand: implementation plan

> **Status:** In progress — plan stages not started (see TODO.md) · Depends on: `goals.md`, `ik-solve-research.md`, `scan3-architecture.md`

This plan routes every attribute in `goals.md`'s model, and every live frame of MediaPipe
tracking, through one constrained solve — `ik-solve-research.md`'s proposed `ikSolve.ts`. The point of
that solve is not abstract fusion — it's that MediaPipe alone can produce anatomically impossible
output (bones that change length frame to frame, joints bent past their real range, a hand that
flips or "explodes" under occlusion), and a confident anatomical prior is what stops a single bad
frame from being displayed as if it were real. The prior term competes against the raw landmark data
in the same objective: where the model is confident, a corrupted reading loses that competition and
the displayed pose stays bounded; where it isn't yet confident, the data still leads, which is
correct — there isn't yet anatomy to trust over it.

## Where this sits relative to existing code

`$lib/hand.ts`'s FK rendering (`SolvedHand.fkBy`, `worldPositions`) is reused as-is to turn a solved
pose into world-space geometry for groups A, B, E, F, and the thumb half of D — no changes needed
there. `$lib/hand.ts`'s `fromLimbs`/`calculateJoints` (hard-constraint fitting, used today by `/scan2`)
is a different, older mechanism and is **not** what this plan builds on — `/scan2` keeps using it
untouched. `ik-solve-research.md`'s `KinematicPriors` sketch becomes the actual `HandPriorState` type
below, populated with the literature values instead of left as a design placeholder.

**One real gap this doesn't cover:** ring/pinky CMC mobility (part of Group D) has no slot in
`hand.ts` today — `CONNECTIONS`/`LIMBS` fix every finger at exactly 4 bones, with no joint for a
proximal CMC axis. `key-point-selection.md` already names this as an FK-chain prerequisite. Without
that joint in the FK chain, the reprojection data term has no way to observe this axis at all, from
any frame — so this plan's solver cannot estimate it, only hold it at Group D's literature seed,
unobserved, exactly like any other permanently-unobserved quantity (see "Underspecified DOF stay
bounded" below). **Rendering it, and estimating it from data at all, are both out of scope until
`hand.ts`'s FK chain is extended** — a separate, small, additive task, not assumed away here.

Group C, on the other hand, needs no new type at all: the existing `degree: 3` + `ConjunctCoupling`
mechanism (`aCoeff·angleZ + bCoeff·angleY = angleX`), built for the thumb CMC, is exactly the shape
MCP's "2 free axes + 1 derived axial term" needs — reuse it, don't invent a second one. One existing-code
note, not a blocker: `calculateJoints` doesn't currently construct a `degree: 3` joint for the thumb
either (it computes `degree: 1` there today) — the type exists, nothing wires it up yet. This plan's
solver produces `degree: 3` joints directly rather than depending on `calculateJoints` for that.

## Underspecified DOF stay bounded, never free-floating

A general rule, with no elbow special case: any quantity with no confident live observation this frame
is initialized to a neutral, prior-consistent value and only moves as far as its connection to whatever
_is_ currently observed allows — it never moves freely, and it's never snapped directly to a raw noisy
reading. There is no structural distinction in this solver between "a joint with a temporarily bad
reading this frame" and "a joint with no reading, ever" — both are the same case: an empty (or
down-weighted) data term for that quantity this frame, with its regularization term (including
`goals.md`'s named cross-group correlations) supplying everything else. This is what lets
`goals.md`'s wrist/forearm/elbow group (Group G) live inside the same solve as every finger joint
rather than as a bolted-on special case:

- Elbow flexion, elbow swivel angle, and forearm pronation/supination never have a reprojection data
  term — no landmark observes them, ever, under this project's scope. Wrist flexion/extension and
  radial/ulnar deviation additionally receive `goals.md`'s weak, composed MediaPipe observation
  (landmark-0 orientation, entered as a term on the _sum_ of wrist+forearm+elbow rotation, never
  decomposed). Both cases run through the identical Mahalanobis-prior-plus-coupling machinery as an
  MCP joint, just with a permanently near-empty (Group G's wrist DOF) or fully-empty (elbow, forearm
  pronation) data term instead of a merely-occluded one.
- Concretely, on first detection: every pose variable, Group G included, is initialized to its current
  `HandPriorState` mean — the population prior on day one, narrower once `goals.md`'s named
  cross-group correlations (tenodesis, forearm-length↔stature, swivel-angle↔wrist-pose) have pulled it
  via whatever else has already solved this session.
- From then on, each frame's solve updates it exactly like any other pose variable: pulled toward its
  own prior/coupling terms, pulled toward the (near-)empty data term it does have, output alongside
  every other joint's angle. No separate deterministic FK step, no back-driving, no elbow-specific code
  path — stage 6 renders it the same way it renders a finger joint, because by this point it mechanically
  is one.

## Parameter groups

Every group below is an entry in the same `HandPriorState`, and every group — Group G included — is
consumed by `ikSolve.ts` as either a pose variable or a frame-constant (per stage 3). What differs
frame to frame is only whether a quantity has a data term this frame, which is a per-quantity runtime
fact, not a structural per-group split: a finger MCP usually has one, an occluded finger this frame
doesn't, and elbow flexion/swivel/forearm pronation never do — all three are handled by the identical
prior-vs-data machinery (see "Underspecified DOF stay bounded" above). Group G's two wrist DOF
additionally receive the weak composed MediaPipe observation `goals.md` describes.
`key-point-selection.md`'s landmark-0 placement step still reads the resulting posterior — that's a
second consumer of the same state, not evidence that `ikSolve.ts` skips it.

Block-diagonal per group is the right simplification for most pairs — not one dense N×N matrix across
everything — but three cross-group entries are explicit exceptions, sourced directly from
`goals.md`'s named correlations, and must be represented even though they cross a group boundary:
(1) Group G's wrist flex/ext & radial/ulnar deviation ↔ Groups B/C's rest-flexion component
(tenodesis); (2) Group G's forearm length ↔ Group A's hand-length reference (shared stature
regression); (3) Group G's elbow swivel angle ↔ its own wrist-pose and forearm-length entries
(swivel-angle criterion). Every other pairing stays block-diagonal unless a future citation justifies
adding it.

**A — Bone lengths**

- Parameters: 4 lengths × 5 fingers, ratio to hand-length reference.
- Distribution: lognormal, full covariance per finger (and across fingers where regression supports it).
- Literature seed: anthropometric regression, R² 0.49–0.99 by segment (`ik-solve-research.md`) —
  **needs one named source dataset picked and its actual per-segment mean/SD table transcribed;
  not yet done, tracked as a task below.**
- Update channels: MediaPipe Hands, caliper.
- In the solve: not a free variable — the current mean is a constant parametrizing the FK map for
  that frame. When the frame is `ScanSession`-sourced, its own inter-landmark distance vs. that
  constant is collected as an observation for stage 4's cross-session update — never for a
  live-tracking frame, per `goals.md`'s "ordinary use never updates it" rule — not solved jointly
  with pose (see stage 3's timescale note).

**B — PIP/DIP ROM**

- Parameters: 1 ROM bound × 2 joints × 5 fingers.
- Distribution: Beta, scaled to anatomical stop.
- Literature seed: MCP ≈90°, PIP ≈90°, DIP ≈45–50°, SD ≈6–17°.
- Update channels: MediaPipe Hands (plateau detector supplies the convergence signal used for promotion).

**C — MCP axes**

- Parameters: flex/ext ROM, ab/ad ROM + flexion-coupling term, axial-rotation weight, × 4 fingers.
- Distribution: Beta (ROM) + linear coupling coefficient.
- Literature seed: flex/ext ≈90°, ab/ad wider in extension/choked in flexion,
  axial term from 4D-CT (index pronates-then-supinates through flexion).
- Update channels: MediaPipe Hands.
- The _pose_ here (the joint's 2–3 angles this frame) is a free variable in the per-frame solve,
  softly penalized by the ROM prior. The _coupling coefficient itself_ (how tightly ab/ad tracks
  flexion) is, like bone length, a constant for that frame — updated across sessions in stage 4,
  not re-solved every frame.

**D — CMC mobility**

- Parameters: thumb — flex/ext ROM, ab/ad ROM, conjunct-rotation `aCoeff`/`bCoeff`
  (reuses `ConjunctCoupling`); ring/pinky — 1 flexion ROM each.
- Distribution: Beta (ROM) + linear (`aCoeff`/`bCoeff`).
- Literature seed: thumb ROM ≈53°/42°/17° axial (±3° stabilized); ring/pinky ≈15–30°.
- Update channels: MediaPipe Hands, caliper (thumb bone lengths only, never thumb angles
  from non-`palm-facing` capture — `goals.md`'s exclusion rule, enforced as a hard filter on
  which observations ever reach the solve, not a post-hoc down-weighting). Thumb only, for the
  MediaPipe Hands channel specifically: ring/pinky CMC has no observation channel at all yet — no
  reprojection data term exists for it until `hand.ts`'s FK chain gains the joint (see "One real gap
  this doesn't cover" above) — so it holds at its literature seed, unobserved, same as any other
  permanently-unobserved quantity.

**E — DIP/PIP coupling**

- Parameters: slope + intercept × 5 fingers × 2 hands.
- Distribution: Gaussian on slope/intercept.
- Literature seed: **no independent population-literature source found** — seed from this
  project's own Test 8 measurements (`test-results.md`), flagged as a lower-rigor interim
  prior, not a literature citation.
- Update channels: MediaPipe Hands.

**F — Enslaving coefficients**

- Parameters: 5×4 matrix entries.
- Distribution: Gaussian, through-origin.
- Literature seed: **no population-literature source found** — start uninformative
  (wide prior), update only from this project's own `fitEnslaving` capture.
- Update channels: MediaPipe Hands.

**G — Wrist/forearm**

- Parameters: wrist flex/ext + radial/ulnar ROM (coupled — not two independent Beta marginals; see
  the tenodesis cross-term above), forearm pronation/supination ROM, elbow flexion + swivel angle,
  forearm length ratio.
- Distribution: Beta (angles) + lognormal (length), plus the three named cross-group covariance
  entries above — this group cannot be represented as independent per-DOF Beta marginals without
  losing the tenodesis and swivel-angle relationships `goals.md` requires.
- Literature seed: wrist ROM ≈85°/85°, ≈15°/45°; elbow ≈90–110°; swivel-angle criterion
  (<5° error, reaching-task origin, untested for typing).
- Update channels: forearm length — caliper, direct. Elbow flexion/swivel/forearm pronation — no
  data term, ever, under this project's scope; posterior moves only via the cross-group correlations
  above and manual numeric entry when supplied. Wrist flex/ext and radial/ulnar deviation — the same,
  plus `goals.md`'s weak composed MediaPipe-Hands observation (landmark-0 orientation, entered as
  a term on wrist+forearm+elbow rotation summed, never decomposed; wide noise, never allowed to
  dominate the prior alone). Manual numeric entry, for any DOF in this group, is ingested exactly
  like a caliper or MediaPipe observation elsewhere in the model — its own noise variance set by how
  it was obtained (a goniometer reading behaves like a caliper measurement, a self-report carries
  wider noise), subject to the same exclusion/plausibility gate, never written to the posterior mean
  directly. Consumed by `ikSolve.ts` as a pose variable like every other group (see "Underspecified
  DOF stay bounded" and the parameter-groups intro above) — also read by `key-point-selection.md`'s
  landmark-0 placement step, which is a second consumer of the same posterior, not a separate one.
  The weak composed MediaPipe observation plays both roles this doc distinguishes: every frame, live
  or captured, it's a stage-3 data term that helps that frame's own displayed pose; only when the
  frame is `ScanSession`-sourced does it additionally become a stage-4 observation narrowing the
  long-term Group G posterior. An ordinary live-tracking frame's composed observation is used once,
  for display, and then discarded — it never accumulates toward the posterior, same as everything
  else `goals.md`'s "ordinary use never updates it" rule covers.

Groups E and F's "no literature found" status is a real gap, not a placeholder — flag it plainly in
code comments rather than inventing a citation.

## Implementation stages

1. **Types.** `src/routes/scan3/lib/priors/handModel.ts` — `KinematicPriors`/`HandPriorState`:
   one struct spanning every group above, each entry a `PriorValue<T>` (mean, covariance, an
   implicit confidence from that covariance's magnitude). This _is_ `ik-solve-research.md`'s
   `KinematicPriors` interface, filled in rather than left as a sketch.

2. **Seed data.** `src/routes/scan3/lib/priors/handModelData.ts` — the literature-cited numeric
   values for groups A–D and G (each constant carries a source comment, same convention
   `hand.ts`'s `ConjunctCoupling` doc comment already uses), and the explicitly-flagged
   interim/uninformative values for E–F. This is "the average hand" as a `HandPriorState` value.

3. **The solver.** `src/routes/scan3/lib/priors/ikSolve.ts` — two timescales for state, plus a third for
   continuity within the faster of the two: `HandPriorState` itself only ever moves on stage 4's slow,
   cross-session timescale, never on this stage's per-frame one — this stage only _reads_ it, treating
   it as fixed input no matter where the frame came from — a
   scan phase, the evaluation page, or eventual production tracking. Nothing in this stage ever writes
   back to `HandPriorState`; that's stage 4's job, and stage 4's alone (see below) — the direct fix for
   what MediaPipe Hands alone gets wrong: an impossible movement or a spontaneous change in the
   displayed model during ordinary use must never quietly become the new prior. The per-frame
   solve's only free variables are **pose** (joint angles, ~25–35 DOF for one hand, now including
   Group G's five wrist/forearm/elbow angles alongside the finger joints — see "Underspecified DOF
   stay bounded" above for why they're ordinary pose variables here, not a separate mechanism) — a small
   Gauss-Newton/Levenberg-Marquardt run every frame, on landmarks that have already passed through
   the existing `landmarkFilter.ts` despike + One Euro filter unchanged (that filter cleans the raw
   landmark signal itself and stays exactly where it is today, upstream of everything below, per
   `ik-solve-research.md`). Every other group (lengths, coupling coefficients) is a **constant** for
   that frame, read from `HandPriorState`'s current mean — not a variable the per-frame solve
   touches. Their own updates happen only in stage 4, across many frames, which is what keeps this
   solve small enough to run in real time instead of growing into a 50+ DOF joint state estimate.
   - **Data term**: landmark reprojection error — the (already-filtered) tracked landmark positions
     vs. FK-predicted positions for a candidate pose (FK parametrized by the current, constant,
     bone-length/coupling means).
   - **Prior term**: for every pose angle, a Mahalanobis penalty pulling it toward that joint's
     current ROM/axis mean, weighted by that prior's inverse covariance. This single term is what
     makes a converged ROM behave like a near-hard limit and an unconverged one behave like almost no
     constraint at all — continuously, with no discrete tiers, exactly as `goals.md` requires.
   - **ROM term**: negative log-density under each joint's Beta prior — a soft limit, not a clamp
     (folds into the prior term above; called out separately here since it's the mechanism, not a
     second penalty).
   - **Coupling consistency term**: this is what actually uses the anatomical relationships to correct
     bad data, not just bound it — for every coupling in `HandPriorState` (Group E's DIP-given-PIP
     slope, Group C's MCP ab/ad-given-flexion coupling, Group F's finger-j-given-finger-i enslaving),
     a penalty on how far the solved values disagree with what that relationship predicts, weighted by
     the coupling's own confidence. A confidently-solved PIP (good data) pulls a corrupted DIP reading
     (bad data) back toward the coupling-predicted value through this term — the same mechanism as the
     ROM term, just conditional on another solved quantity instead of a fixed constant. Without this
     term the coupling coefficients would only ever be _learned from_ the solver's output, never _used
     by_ it — the gap that would leave "lean on good data to correct bad data via anatomy" undone.
   - **Warm start and temporal smoothness**: every frame after the first seeds the optimizer's initial
     guess from the _previous frame's solved pose_, not cold from scratch, and adds a quadratic penalty
     between the candidate pose and that previous solved pose — a separate term from the landmark
     filter above, which cleans the raw signal; this one keeps the _solved_ pose from jumping between
     plausible-but-different local optima frame to frame. The penalty's weight scales down as
     inter-frame time delta grows, so a dropped frame or a genuinely fast movement isn't penalized as
     if it were normal-cadence motion — a live-tuned parameter, in the same spirit as the One Euro
     filter's `minCutoff`/`beta` and `test-results.md`'s threshold recalibrations, not a guessed
     constant shipped as final.
   - **First-frame cold start**: with no previous solved pose to warm-start from, initialize every pose
     variable to `HandPriorState`'s current population-mean pose — the same neutral-initialization
     rule "Underspecified DOF stay bounded" above already specifies for a quantity with no observation,
     applied here to the very first frame of a session rather than to a specific DOF.
   - **Divergence recovery**: a warm start is a liability, not just a convenience, if the solver gets
     stuck in a wrong local basin — nothing about warm-starting alone un-sticks it. If the residual
     (stage output, below) stays above a threshold for _k_ consecutive frames, discard the warm start
     and re-cold-start: run the solve from a small fixed set of plausible initial poses (the population
     mean, plus a couple of named archetypal postures) and keep whichever converges to the lowest total
     cost. This is the same "easy pose to bootstrap into a hard one" property `ik-solve-research.md`
     already flags MediaPipe's own detector as relying on, applied to this solver instead.
   - No landmark-level confidence downweighting from bone-length deviation yet
     (that signal needs at least one already-converged length to bootstrap from, which doesn't exist at
     first use — a fast-follow once Group A has real confidence, not a permanent gap). This remains the
     one named v1 simplification in this stage.
   - Output per frame: the solved pose (joint angles) and a residual (how well the current prior set
     explains this frame) — the residual is what stage 4 reads.

4. **Promotion / posterior update.** `src/routes/scan3/lib/priors/update.ts` — the only place
   `HandPriorState` is ever written, per `goals.md`'s "ordinary use of the model never updates it"
   rule. Its inputs are exactly the two kinds of observation that rule recognizes as legitimate — never
   a third: (a) the constrained solver's pose + residual output, when the underlying frame is sourced
   from a designated `ScanSession` capture phase (`scan3-architecture.md`); and (b) a direct external
   measurement — caliper, goniometer, or manual numeric entry — supplied as an explicit user action
   (Groups A, D, G). What both share, and what a live-tracking frame lacks, is deliberateness: each is
   the result of a specific, user-initiated measurement act, not ambient accumulation from ordinary use.
   That's the actual distinguishing property behind the boundary — not "did it pass through the
   solver," which would wrongly exclude caliper/manual-entry channels, but "was this act a deliberate
   measurement, or passive accumulation." No `ScanSession`-external MediaPipe frame, and no passive
   accumulation of any kind, ever reaches this stage, no matter how many frames accumulate or how
   consistent they look — the same reasoning `ik-solve-research.md`'s rejection of unsupervised
   self-calibration already establishes (Test 3's reproducible thumb bias — an unscripted, uncontrolled
   source of motion has no mechanism to catch a systematic bias, so it must never be allowed to
   silently become the new ground truth), applied here to draw the line between "using the model" and
   "measuring the hand" at the code level, not just the reasoning level. Within that boundary, updates
   apply a recursive Bayesian mean/covariance update to the relevant `HandPriorState` entries, gated
   by: the orientation/condition exclusion rule (an excluded observation never reaches the solve at
   all, not just the update) and cross-session consistency before any parameter's variance is allowed
   to shrink (confidence to grow). There is no separate direct-geometry update path running alongside
   this one, and no path from live-tracking frames at all.

5. **Render.** Reuse `SolvedHand.fkBy`/`worldPositions` (existing, unmodified `hand.ts` code) to turn
   the solver's per-frame pose into world-space geometry. Pure glue, not a second fitting step.

6. **Read-only evaluation page.** Extend `src/routes/scan-tests/multi-view/+page.svelte`: every live
   frame, run the solver against whichever `HandPriorState` snapshot is currently loaded (initially
   just the literature seed) and the frame's raw tracked landmarks, and render the corrected pose. Raw
   MediaPipe output is never shown as the final answer; what's displayed is always the
   model-constrained solve, read against that fixed snapshot. The elbow, and the rest of Group G, are
   solved and rendered exactly like every other joint in stages 3/5 — no separate step is needed here.
   What's worth watching for at this stage: whether the displayed wrist/elbow posture looks
   anatomically plausible given the loaded prior's current confidence, and whether corrupted or
   occluded frames fail to visibly distort the displayed hand — not whether the posture narrows during
   the session, since this page never writes to `HandPriorState` (stage 4 is the only writer) and isn't
   expected to. **This is a permanent property of live tracking, not a v1 gap**: no future version of
   this page, or of production tracking, ever triggers a posterior update — updating the model stays
   exclusively a `ScanSession` capture-phase action (stage 4), never something ordinary use of the
   model can do, by design.
   - **Confidence needs to be visible, not just the pose.** "Looks plausible given the loaded prior's
     current confidence" isn't judgeable without seeing that confidence — a joint that's merely sitting
     near its (unconverged, wide) prior and a joint that's confidently converged there can render
     identically otherwise. Color or vary the opacity of each rendered joint by its `HandPriorState`
     covariance magnitude (a separate visual channel from any existing deviation-from-neutral coloring
     elsewhere in this codebase, e.g. the contact-sphere preview's tiers — this one encodes confidence,
     not posture). Without it, a corrupted frame's pose staying bounded reads the same whether it was
     genuinely constrained by a confident prior or coincidentally close to a wide, barely-informative
     one.

## Testing

Unit-testable (pure functions, `bun:test`, same convention as `landmarkFilter.test.ts`/`overlay.test.ts`):

- `handModelData.test.ts` — every length prior is positive; every ROM prior's bounds fall within the
  anatomical range it was seeded from; covariance matrices are positive semi-definite.
- `ikSolve.test.ts` — given synthetic clean landmarks generated from a known pose against a known
  `HandPriorState`, the solver recovers that pose and those parameters; a synthetic excluded-condition
  observation is confirmed to never enter the objective (not merely down-weighted); regularization
  strength scales with confidence — holding the same observation fixed, a low-covariance (confident)
  parameter moves less than a high-covariance (unconverged) one. **The core promise, checked directly:**
  given a `HandPriorState` with confident (low-covariance) lengths/ROM, a single frame with a wildly
  corrupted landmark (a fingertip teleported behind the palm, a bone-implying distance well outside
  its prior) produces a solved pose whose bone lengths and joint angles stay within the prior's bounds
  — not a pose matching the corrupted input. **Coupling correction, checked directly:** given a
  high-confidence DIP/PIP coupling and a clean PIP reading, a corrupted DIP landmark is pulled toward
  the coupling-predicted angle rather than the corrupted one; the same check repeated with a low-
  confidence coupling confirms the pull is much weaker. **Cross-group correlation, checked directly:**
  given confident (low-covariance) finger rest-flexion data and the tenodesis cross-term, the wrist
  flex/ext posterior narrows from its literature-prior covariance even though it has zero direct or
  composed observations that session — confirming Group G benefits from evidence elsewhere in the
  model rather than sitting frozen at the population prior forever, and stays strictly narrower than
  an uninformed prior even with no MediaPipe channel of its own. **Manual entry as a suspect
  observation, checked directly:** a manual wrist-angle entry tagged with self-report-level noise
  moves the posterior less than a goniometer-tagged entry of the same value; an implausible manual
  entry that fails the exclusion gate is confirmed to never enter the update at all — the same gate
  applied to a MediaPipe or caliper observation elsewhere in the model. **Warm start and smoothness,
  checked directly:** a synthetic clean sequence recovers the same pose whether cold- or warm-started
  (warm start changes convergence speed, not the answer); a synthetic sequence with one wildly
  corrupted frame sandwiched between clean ones stays close to the clean trajectory at that frame
  rather than jumping to match the corrupted input, which cold-start-only (no smoothness term) does
  not guarantee. **Divergence recovery, checked directly:** a warm start deliberately seeded into a
  wrong local basin (a synthetic finger-identity swap) is confirmed to trigger re-cold-start within
  the configured _k_-frame threshold and recover the correct pose, rather than staying stuck.
- `update.test.ts` — the recursive mean/covariance update, fed synthetic solver output, moves the mean
  toward it and shrinks variance; a caliper/manual-entry-tagged observation dominates a MediaPipe-tagged
  one of equal magnitude given their declared noise difference; a joint update against a correlated
  pair (e.g. the tenodesis term) narrows the unobserved dimension's variance, not just the observed
  one's — confirming the update is a true joint-covariance conditioning step, not N independent
  per-scalar updates that happen to share a struct.

Not unit-testable, and not attempted as such: whether the solver's live corrected pose _looks_ more
anatomically plausible than raw tracking. That's the multi-view page's job — a human judgment call,
the same role live capture pages already play for every other empirically-tuned parameter in this
project (`test-results.md`'s Tests 6/7).

## Non-goals (this plan)

- Landmark-level confidence downweighting from bone-length deviation — bootstraps once Group A has
  real confidence; a fast-follow, not part of this plan.
- A UI to trigger a posterior update from stage 6 or any other live-tracking context — not a gap to
  fill later, a permanent boundary (see stage 4/6 above): updating `HandPriorState` is exclusively a
  `ScanSession` capture-phase action. Stage 6's persistence gap is real and separate — it doesn't yet
  save a `ScanSession`'s own promoted results either — but that's an implementation detail of the one
  legitimate update path, not evidence that live tracking might grow one.
- Sourcing Group A's exact per-segment mean/SD table from a specific named anthropometric study —
  flagged in stage 2 as a required task, not done by this plan itself.
- Groups E/F's literature gap — left as an honest uninformative prior, not backfilled with an
  invented number.
