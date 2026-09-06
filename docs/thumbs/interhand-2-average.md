# Filling `handModelData.ts` from InterHand2.6M: implementation plan

> **Status:** Plan, not started · Depends on: `from-external-data.md`, `handModel.ts`, `handModelData.ts`,
> `external-data/interhand26m/` (gitignored local download) · Related: `average-hand.md`

`from-external-data.md` identified which `HandPriorState` fields InterHand2.6M's real 3D joint data
could plausibly fill (bone-length ratios, the thumb's unsourced `wristToCmc` segment, DIP/PIP coupling,
the MCP ab/ad choke coefficient, and the `meanDeg`/`sdDeg` half of several `BetaRom` values) and which
it can't (axial-roll twist, anything in `wristForearm`, true instructed-isolation enslaving). This plan
covers only the fillable set, and it is staged so that **every step earns trust before the next one
spends it**: the raw data's index order and coordinate frame get verified before any statistic is
computed from it; every computed statistic gets a sanity check before it's proposed as a replacement;
every proposed replacement goes through a human review gate before it's written into
`handModelData.ts`; and the final result is checked against subjects that were never touched by any of
the fitting above. No stage assumes the previous one was correct — each one re-derives its own evidence
that the thing it depends on actually holds.

Everything computed here is closed-form: sample means, sample covariances, linear regressions. Nothing
in this plan trains a model of any kind.

## Where this work lives

Plain TypeScript, run with `bun`, alongside the existing prior code — a new
`src/routes/scan3/lib/priors/interhand/` directory:

- `remap.ts` — parses `external-data/interhand26m/skeleton.txt` into a joint tree and produces the
  reindexing function described in Stage 1, rather than hardcoding the mapping found by eyeballing the
  file once (if the file is ever re-fetched at a different dataset version, a hardcoded table could
  silently go stale; parsing it fresh each run can't).
- `subjectSplit.ts` — the fixed, versioned held-out/fit subject partition from Stage 2, checked into
  the repo as a small static file (not the raw dataset itself, which stays gitignored).
- `fitBoneLengths.ts`, `fitDipPipCoupling.ts`, `fitMcpChoke.ts`, `fitRom.ts` — one file per target field
  group from Stage 3, each producing a candidate `ScalarPrior`/`VectorPrior`/`BetaRom` plus the report
  data Stage 4 needs.
- `report.ts` — assembles Stage 4's side-by-side comparison.
- `*.test.ts` next to each of the above, run with `bun test` — the automatable sanity checks in each
  stage below. The non-automatable ones (visual inspection) are called out explicitly as such, the same
  way `average-hand.md`'s own Testing section separates unit-testable checks from "a human judgment
  call, the same role live capture pages already play."

## Stage 0 — Confirm what's actually on disk

Before writing any parsing code: open `external-data/interhand26m/train/InterHand2.6M_train_joint_3d.json`
and `skeleton.txt` directly and confirm the top-level shape matches what's assumed below (subject ID →
capture ID → frame ID → hand → joint → `world_coord`/`joint_valid`, per the structure already sampled
while writing `from-external-data.md`). This is a five-minute check, not a formal stage, but skipping it
and coding against a remembered assumption is exactly the kind of silent-mismatch risk this whole plan
is trying to avoid elsewhere.

## Stage 1 — Verify the index mapping and coordinate frame, before trusting either

This is the highest-leverage place for a silent, undetectable bug: if the remap from InterHand2.6M's
tip-to-base ordering to `$lib/hand.ts`'s wrist-to-tip ordering is wrong, every statistic computed in
every later stage is wrong too, in a way that won't throw an error or look obviously broken — it'll just
quietly produce plausible-looking wrong numbers. Four checks, in order, each gating the next:

1. **Parse, don't hardcode.** `remap.ts` reads `skeleton.txt`'s `(name, index, parent_index)` triples
   and builds the actual joint tree, rather than encoding "index 0 is thumb-tip" as a literal constant
   from having read the file once. A unit test asserts the parsed tree is well-formed: exactly 21 nodes
   per hand, each with a single parent-chain to the wrist root (index 20 right / 41 left), five
   four-node finger chains hanging off it, and the finger order (thumb, index, middle, ring, pinky)
   matches `$lib/hand.ts`'s `FINGERS` order. If any of that fails, stop — don't proceed to a numeric
   remap built on a tree that doesn't look like a hand.
2. **Bone-length invariance on raw data, before any remap-dependent statistic.** Take one subject's one
   capture, several consecutive frames, and — using only the parsed parent/child tree from step 1, not
   yet the full MediaPipe-order remap — compute the distance between every parent/child joint pair in
   every frame. A real rigid skeleton keeps each segment's length constant frame to frame; if the parsed
   tree actually groups anatomically adjacent points (as opposed to, say, an off-by-one that pairs a
   fingertip with the wrong finger's base), those lengths should be near-constant (some noise is
   expected — this is real capture data, not synthetic). A segment whose length swings wildly is
   evidence the tree parsing or the underlying file itself is not what Stage 0 assumed, not evidence
   about the hand.
3. **A rendered visual check — the answer to "how do I even look at this."** Reuse this project's
   existing rendering path rather than building a new one: `multi-view`'s scene already knows how to
   render a plain 21-entry `Vector3[]` landmark array (the same shape `poseToLandmarkVectors` produces
   for a solved pose, and the same shape a live MediaPipe frame arrives in). Build a small dev-only
   loader that reads one InterHand2.6M frame, applies the Stage 1 remap to put it in that same
   wrist-first, base-to-tip order, and — since InterHand2.6M's coordinates are in millimeters in a
   per-capture camera frame, not aligned to whatever frame `multi-view`'s scene expects — rigidly aligns
   it (translate the wrist to the origin, orient using two reference vectors, e.g. wrist→middle-MCP and
   the palm normal) before handing it to the exact same render component a live tracked frame already
   uses. Add a simple frame-index scrubber (previous/next, or a slider) so a whole capture sequence can
   be stepped through, not just one static frame — real continuous motion should look smooth stepping
   frame to frame; a jump or a finger snapping to an impossible position mid-sequence is a visible sign
   something upstream is wrong, the same "look at a render and see" fallback `from-external-data.md`
   and the earlier testing research both already settled on as the last resort when nothing else can
   check anatomical plausibility. This is a manual gate, not a unit test — call it explicitly
   non-automated in the plan, don't try to force a pass/fail assertion onto a human judgment call.
4. **Two independent visual references, not one.** Compare the rendered InterHand2.6M frame against (a)
   `docs/thumbs/mediapipe_hand_reference.png`, the reference diagram this project already uses for
   exactly this kind of "does this look like the expected landmark layout" check, and (b) a live `/scan`
   capture of your own hand in a roughly similar pose. Two independent comparisons catch a mistake one
   alone might not (e.g. a remap that's internally self-consistent but globally mirrored would still
   pass check 2's length-invariance test, but should look wrong against either visual reference).

**Do not proceed to Stage 2 until all four checks pass**, including the two manual visual ones. A
convenient failure mode this guards against: getting a plausible-looking bone-length-invariance pass
from an internally-consistent but wrong remap (e.g. a systematic mirroring or a swapped finger pair)
that only the visual check would catch.

## Stage 2 — Subject-level held-out split

Parse `subject.txt` (27 subjects, each listing which of InterHand2.6M's own `train`/`val`/`test`
capture directories belong to them — note that file's train/val/test split is InterHand2.6M's own
machine-learning benchmark split, unrelated to the fit/held-out split this plan needs, and a subject can
appear in more than one of InterHand2.6M's folders). Pick a subset of subject IDs — a fifth to a
quarter of the 27 is a reasonable starting point — to reserve as held-out, covering both sexes and
multiple InterHand2.6M folders so the reserved set isn't accidentally homogeneous. Write that partition
to a static, committed `subjectSplit.ts` (a plain list of fit-subject IDs and held-out-subject IDs) so
a later re-run can't silently reshuffle who was "seen" during fitting. Every stage from here on reads
frames only from the fit-subject list; the held-out list is untouched until Stage 6.

## Stage 3 — Compute each candidate statistic

For each target, the extraction method, and the sanity check that must pass before it's even proposed
in Stage 4's report (proposing an unchecked number defeats the point of having a check at all):

**3a. Bone-length ratios (`boneLengths.fingers`, including the thumb's `wristToCmc`).** For every
fit-subject frame: apply the Stage 1 remap, compute each parent/child segment length, divide by that
frame's own wrist-to-middle-fingertip distance (the same reference "hand length" `handModelData.ts`
already uses), and accumulate the sample mean and covariance across all frames and fit subjects — the
same operation `vectorPriorFromRatios` already performs on Buryanov & Kotiuk's published summary table,
just computed directly from raw points instead of trusting someone else's mean/SD row. _Sanity check:_
report the candidate ratio next to Buryanov & Kotiuk's cited value for every segment that has one. A
large disagreement is more likely a remap or unit bug than a real anatomical difference between
populations, given B&K's numbers are already independently trusted — treat a big gap as a reason to
re-check Stage 1, not as new information about hands, unless it survives that re-check.

**3b. DIP/PIP coupling (`dipPipCoupling`).** A useful simplification applies here that doesn't apply to
every field: PIP and DIP are simple one-axis hinges with no ab/ad or twist degree of freedom in this
project's own joint model, so each one's flexion angle is just the angle between its two adjacent bone
vectors — directly computable from raw 3D positions via a dot product, with no need for the per-subject
calibrated local axis (`V`/`Vinv`) that `ikSolve.ts`'s own doc comments say this project can only get
from its own captured-motion fitting. That per-subject calibration requirement is real for anything
involving axis _identity_ (which direction counts as "ab/ad" versus "flex," or any axial roll about a
segment's own length), but a pure hinge's bend _magnitude_ doesn't depend on it. Regress DIP angle
against PIP angle (`dip ≈ slope·pip + intercept`) across all fit-subject frames, per finger. _Sanity
check:_ report the fitted slope, intercept, and R² plainly — there's no independent published number to
compare against (that's the whole reason this field is a placeholder today), but a slope near 0 or
negative, or a very low R², is a sign the two angles aren't actually being measured correctly (e.g. a
sign flip in the remap), not evidence DIP/PIP coupling doesn't exist.

**3c. MCP ab/ad choke coefficient (`mcpAxes.*.abAdChokeCoeff`).** Unlike 3b, this does need an
ab/ad-versus-flexion axis split, and this project has no per-subject calibrated axis for InterHand2.6M's
subjects. Use one fixed, explicitly-declared convention applied identically to every subject (e.g. the
same "knuckle-row" plane construction `buildDefaultSkeleton` already uses for its own splay), and flag
the result plainly as computed under an assumed shared convention, not per-subject anatomical truth —
consistent with `from-external-data.md`'s caveat that any axis-dependent quantity fit from this data
needs its convention stated, not fitted as if it were a physical fact independent of the choice made.
Bin frames by flexion angle and check, before fitting anything, that the raw ab/ad half-range visibly
shrinks as flexion increases — a plot or a simple binned-mean table, eyeballed. _Sanity check:_ only
fit the slope if that qualitative shrinkage is visible in the raw binned data first; if it isn't, that's
a finding to report honestly (either the assumed axis convention doesn't isolate the effect well, or the
effect is smaller/noisier than the literature's qualitative description suggests), not something to
force a number out of anyway.

**3d. ROM mean/SD refinement (`pipDipRom`, `mcpAxes.*.flexExtRom`, etc.).** Compute the sample mean and
SD of each joint's naturally-occurring flexion angle across all fit-subject frames. _Sanity check:_
confirm the candidate mean falls within the _currently cited_ `minDeg`/`maxDeg` hard bounds — a
violation there points to an angle-recovery sign or unit bug, not (per `from-external-data.md`'s
reasoning) evidence the literature's hard limits are wrong, since this dataset's natural/task-driven
poses aren't expected to approach true anatomical extremes anyway.

## Stage 4 — Human review gate, before `handModelData.ts` changes at all

Assemble one report (`report.ts`'s output — a markdown table is enough) with one row per candidate
field: current value and its `source` string, candidate value, how many frames/fit-subjects it came
from, the relevant sanity check's result, and the delta between current and candidate. No field is
written automatically. You review the table and decide, per field, to accept, adjust, or reject — the
same way every existing number in `handModelData.ts` carries a hand-written, hand-checked `source`
comment rather than a script-trusted one. This mirrors `average-hand.md`'s own stage-4 update
philosophy (a deliberate, reviewed promotion step, never silent accumulation) applied to a batch of
literature-gap fills instead of a live capture session.

## Stage 5 — Apply accepted changes, then re-verify the existing invariants

For each field accepted in Stage 4, hand-edit `handModelData.ts` (not a scripted overwrite) with a new
`source` string following the file's existing convention — see the thumb `wristToCmc` re-eyeball
comment for the expected shape: what was computed, from how much data, with what caveat, and dated.
Then:

- Run `npm run check` and `npm test` — `handModelData.test.ts`'s existing invariants (every length
  prior positive, every ROM's bounds internally consistent, every covariance matrix positive
  semi-definite) must still hold against the new numbers.
- Re-run `ikSolve.test.ts` against the updated `HAND_PRIOR_SEED`. Its existing synthetic-pose recovery
  tests should still pass structurally; a coefficient that changed enough to break one of those tests
  is worth understanding before moving on, not silencing.

## Stage 6 — Held-out verification (why Stage 2's split existed)

Only now touch the subjects reserved in Stage 2. For their frames: recover joint angles the same way
Stage 3 did, and check what fraction fall within the _updated_ `BetaRom` bounds; check the residual of
held-out DIP/PIP pairs against the newly fitted coupling line; check held-out MCP ab/ad spread against
the newly fitted choke coefficient. Because these subjects never entered any fit above, a poor result
here is a genuine finding about the updated model, not a restatement of what fitting it already
guaranteed — the same reasoning `from-external-data.md`'s testing section lays out. Report this
alongside Stage 4's table as the closing piece of evidence for whether the change was actually an
improvement, not just a different number.

Also worth running here, since it costs nothing extra once the Stage 1 renderer exists and doesn't
depend on any of this plan's fitted numbers at all: render a few held-out-subject poses (including any
tight grasps/fists that appear in their captures) and check for self-intersection — a pure-geometry
check, independent of everything fitted above, and a second, differently-sourced confirmation that
nothing about the model went visibly wrong in the process.

## What this plan deliberately does not attempt

- Fitting `axialRotationWeight` or any axial-roll term from this data — `from-external-data.md`'s
  reasoning (no independently known bone-axis convention, so a fitted "twist" risks being an artifact of
  whatever convention gets assumed) still applies and isn't solved by anything in this plan.
- Fitting true enslaving coefficients — same conflated-with-voluntary-co-contraction problem as before;
  if a co-flexion correlation is computed from this data anyway, it must be labeled for what it actually
  is in `handModelData.ts`'s `source` string, not presented as satisfying the original definition.
- Anything in `wristForearm` — InterHand2.6M doesn't capture the forearm or elbow at all.
