# Scan tests: validating the assumptions behind the capture protocol

`scan_procedure.md` makes a lot of design decisions on reasoning rather than measurement — which orientation is better for which motion, whether bilateral capture corrupts per-hand data, whether a freeform trajectory gives clean enough per-joint angles, whether pooling averages out noise or just tightens around a bias. Building the full protocol (and `scan3.md`'s implementation) before checking any of that is a bet. This doc is a cheap-to-expensive sequence of small, targeted tests that check the assumptions in roughly increasing order of implementation cost and how much capture-protocol machinery each one needs — so it's easy to see where returns start diminishing and stop there, rather than building the whole thing and hoping.

Each test below is written at the level of "what to capture, what to compute, what result would validate or break the assumption" — not full implementation detail. The first one, at the end, is worked out in full.

## Frame-to-frame noise in a static hold

Hold one hand still, palm facing the camera, for 15–30 seconds. Compute bone lengths and inter-bone angles per frame, and look at how much they jitter with literally nothing moving. This is the noise floor everything else gets compared against — without it, there's no way to tell whether a later "plateau" or "coupling" measurement reflects something real or is just sensor noise. Cheapest possible test: no guided motion, no fitting machinery, no UI beyond a record button.

## Palmar vs. dorsal vs. lateral, same static hold

Repeat the static hold across orientations and compare: `palm-facing`, `palm-away` (dorsal), and the two lateral rolls into the palms-facing-each-other posture, `thumb-away` (thumb up/away from the camera, pinky toward it — the tenting-consistent default) and `thumb-toward` (the opposite roll — `scan_procedure.md` never pins down which edge faces the camera, so both are captured rather than assuming one). This directly checks the premise the whole protocol rewrite rests on — the documented MediaPipe world-landmark collapse away from a direct palm-facing view — against this project's own camera setup, hand, and lighting, rather than trusting a GitHub issue filed against someone else's setup. Still just static holds; only the orientation changes.

A relaxed, fingers-together hold in either lateral orientation is expected to be geometrically harder than `palm-away`: the side-by-side finger spread visible face-on in `palm-facing` rotates toward the camera's line of sight as the hand rolls, so fingers increasingly overlap from the camera's view. `scan_procedure.md` only proposes this orientation for the **abduction** capture, where fingers are actively spread apart rather than held together — so a low-noise result here isn't guaranteed. Treat lateral's numbers as a real, open question this test is meant to answer, not an assumed failure.

## Bone-length agreement between the two canonical (palmar, lateral) orientations

Given the previous test rules out dorsal, check whether the two orientations this protocol actually uses agree with each other on bone length, or whether there's a smaller but still real bias between them. If they disagree by more than the noise floor from the first test, that's a second, subtler orientation bias worth knowing about before it gets silently averaged into a pooled estimate. "The two canonical orientations" is `palm-facing` and `thumb-away` specifically — see `docs/thumbs/test_results.md`'s 2026-08-31 entry for why `thumb-toward` isn't part of this comparison.

**Where the code lives:** the same `static-hold` capture page (no separate route). After each completed recording, if the immediately preceding completed capture was for the same hand in a different orientation, the page compares them — no separate capture or analysis step needed, since both captures already produce the live per-bone mean/stdev table Test 1 uses. What's actually being asked is whether bone _proportions_ changed, not absolute size: manual repositioning between captures can't hold camera distance constant, and distance biases every bone's apparent length by roughly the same factor, so a shared scale factor (the median B/A ratio across all 20 bones — robust to any single bone that genuinely changed, unlike a least-squares fit, which lets one real outlier bias the fit and leak spurious residual difference into every other bone) is removed before comparing. The remaining per-bone difference is measured in combined standard error of the mean (`stdev / √n`, not raw stdev, since the question is whether estimated means differ, not whether individual frames overlap); a bone is flagged past a combined-standard-error threshold. Known limitations worth being upfront about: accepted frames within one hold aren't independent samples (consecutive video frames of a mostly-static pose are highly autocorrelated), so `n` overstates the independent information available and the z-score is likely inflated; and the fitted scale factor's own estimation uncertainty isn't propagated into that z-score either. Treat a flagged bone as worth a second look, not as a proven bias.

## Axis-fit confidence: palm-facing vs. lateral for flexion

`scan_procedure.md` argues for palm-facing on occlusion/training-data grounds while acknowledging the projective geometry favors a lateral view for that joint's rotation axis specifically. First test that requires actual guided motion (a real flex/extend sweep) rather than a static hold, but no fitting infrastructure beyond what already exists in `hand.ts`.

Rather than two discrete captures (one held at `palm-facing`, one held at `thumb-away`) compared as two endpoints, the finger is flexed and extended continuously while slowly rotating the whole 0°–90° range in one session — accepted frames are grouped live into 10° palm-angle bins, each with its own axis-fit confidence and ROM. This answers a more specific question than a two-point comparison could: not just "which of these two orientations is better," but _where in the rotation does tracking quality actually break down_ — the transition zone between them (previously excluded entirely from `palm-facing`/`palm-away`/`thumb-away`'s discrete angle windows) is exactly what this test needs to see, not discard.

**Where the code lives:** `src/routes/scan-tests/flexion-sweep/+page.svelte`, alongside `static-hold` under `src/routes/scan-tests/`. Shares `palmAngleDeg`/`thumbDepthSign` (factored into `src/routes/scan-tests/lib/orientation.ts` so both capture pages read from one calibrated source) and the keypoint overlay (`src/routes/scan-tests/lib/overlay.ts`) with `static-hold`, but not `inTargetRange`/the auto-detect-and-lock positioning phase — there's no single target orientation to detect here, just a continuous angle range binned live as it's crossed. Each bin accumulates full per-frame `Hand` objects (needed because `calculateJoints` fits over the whole batch, not incrementally) and is periodically refit via the canonical `calculateJoints` — the same function `/scan`, `/scan2`, and eventually `/scan3` use — with a placeholder bone-length reference, since only the fitted axis (`V`/`Vinv`) and its confidence matter here, not `Joint.length`.

**Surfacing the confidence signal:** `fitNorms` (`src/lib/hand.ts`) already runs an SVD over the observed bone-direction spread and only ever used the resulting basis (`v`), discarding the singular values (`q`) — exactly the "surfacing it costs almost nothing" signal `scan_utility_evaluation.md` flagged. `fitNorms` now also returns `axisConfidence` (the ratio of the top two singular values, sorted descending — `q` isn't returned sorted), carried on `Joint`'s degree 1/2 variant as an optional field so no other `$lib/hand.ts` consumer is affected.

**One structural property worth knowing before reading the numbers:** a finger's three non-metacarpal joint fits (`calculateJoints`'s deg2/deg3/deg4) all run the SVD over the _same pooled_ bone1+bone2+bone3 vector set — only the coordinate frame each fit runs in changes, carried forward from the previous stage — and SVD singular values are rotation-invariant. So the three joints' `axisConfidence` values come out numerically identical, confirmed against synthetic data with independently-varying per-bone noise levels. There's exactly one confidence number per finger per capture, not three independent per-joint ones; the UI reflects this by showing a single confidence readout rather than a misleading three-row breakdown. ROM (ROM min/max per joint, read directly from each joint's own inter-bone angle, independent of the SVD fit) stays genuinely per-joint.

## Bilateral vs. unilateral equivalence

Run the same finger-flexion elicitation two ways on the same person: mirrored on both hands at once, and one hand at a time with the other hand resting uninvolved. Compare the resulting ROM bounds. This is the test that validates (or invalidates) the biggest structural assumption in the current protocol — that bilateral-by-default doesn't corrupt per-hand measurements — and it's cheap relative to what it protects: if bilateral capture turns out fine, most of the protocol's session-length savings are safe to keep; if not, this is the one result that would change the doc's default recommendation back to one-hand-at-a-time.

## Still-window auto-detection reliability

Ask several people to "hold still" for a rest-posture or comfortable-tier capture, without further coaching, and check whether the velocity-threshold still-window extraction actually finds a clean low-variance sub-window, or needs a longer hold than the 3–5 seconds currently assumed. This was a real, previously-flagged open question in `scanning.md` — answered (one person, so far) in `docs/thumbs/test_results.md`'s 2026-08-31 entry: window length turned out to matter more than threshold — a shorter window (0.5s at 200°/s, or 0.25s at 150°/s) was _more_ reliable than the originally-assumed ~1s window at any threshold tried, since every extra sample in a longer window is another chance for one noisy frame to break it.

**Implemented:** `src/routes/scan3/lib/completion/stillWindow.ts`'s `findStillWindow()` — the real library function `scan3.md`'s Phase 2/Phase 3 comfortable-tier will call, not a throwaway prototype. Verified against synthetic data (settle-then-hold, constant-drift-never-still, two-candidate-windows-prefer-lower-variance), then tuned against real capture via `src/routes/scan-tests/completion-detectors/+page.svelte`, which feeds it real per-frame joint-angle data instead of synthetic input.

## Plateau-detection tuning against human judgment

Record a full flex/extend ROM sweep, run the plateau-detection algorithm, and separately have a person watch the same clip and mark by eye where the finger visibly stopped extending further. Compare the algorithm's declared convergence point and rep count against the human-judged true limit, and tune the "last _k_ cycles fail to extend by more than a small threshold" parameters against that ground truth rather than a guessed default. Live-tuned (one person, so far) in `docs/thumbs/test_results.md`'s 2026-08-31 entry: the rep-boundary peak-detector's hysteresis needed raising from a guessed 3° to 15° — the guessed default sat inside Test 1's own measured noise floor, so ordinary sensor jitter alone was registering as multiple reps per second.

**Implemented:** `src/routes/scan3/lib/completion/plateau.ts`'s `PlateauDetector` — same real-library approach as `stillWindow.ts`. Rep boundaries are detected via a hysteresis-based peak detector on the primary joint (index 0 of the pushed angle vector), not supplied externally. Verified against synthetic data (amplitude growing then plateauing → converges at the right rep; a joint that never plateaus → never converges, including the multi-joint case matching `scan_procedure.md`'s explicit requirement that DIP's own extremum has to converge, not just PIP's). Same live test page as `stillWindow.ts` above, in "plateau" mode.

## DIP/PIP coupling fit quality

Collect a full-tier flexion sweep per finger, fit the linear DIP-vs-PIP regression, and look at the R² and residual pattern per finger — specifically whether residuals are randomly scattered (linear fit is fine) or systematically curve near the ROM extremes (would argue for a richer functional form, which `scan_procedure.md` explicitly declines to build without evidence). This is where that "wait for evidence" open item gets its evidence.

## Enslaving coefficient plausibility and repeatability

Run the freeform paired-finger sweep for one or two finger pairs, fit `E[i][j]`, then repeat the same trial on the same person on a different day. Check whether the fitted coefficient is stable across repeats (a precondition for trusting it as a personalized, rather than noisy, measurement) and whether it's in a plausible range relative to the literature values already cited in `scanning.md`.

## Thumb CMC axis fit and the occlusion-guard logic

Run the thumb's outer CMC sweep, check whether a stable, physically plausible flexion-abduction axis and range actually falls out of the PCA/SVD fit, and deliberately induce an occlusion-truncated sweep (sweep until the thumb visibly disappears behind the hand) to check whether the false-plateau guard correctly flags it as truncated rather than accepting it as a true limit. This is meaningfully harder to set up than the finger tests above, since it needs both a real capture and a deliberately-broken one to check the guard logic against.

## Thumb freeform trajectory extraction vs. an isolated baseline

Run the unconstrained freeform thumb sweep, attempt the MCP/IP angle extraction from that trajectory, and separately run a short isolated thumb-MCP/IP flexion test (mirroring how the fingers are captured) on the same person. Compare the two extractions. This is the protocol's highest-risk open assumption — that a "superposition of everything at once" trajectory yields per-joint angles as clean as an isolated sweep would — and is the most likely single result to force a real protocol change (adding a dedicated thumb flexion test back in) rather than a parameter tweak.

## Coverage-grid resolution in practice

Have several people run the 20–30 second freeform paired-sweep trial and look at how much of the `(θ_i, θ_j)` grid they actually cover in that window, at a few different bin resolutions. This is pure parameter-tuning, not a yes/no validation, and only worth doing once the earlier tests confirm the underlying signals (enslaving, coverage-based completion) are worth collecting at all.

## Full-session repeatability

Run the entire protocol, start to finish, on the same person twice (ideally on different days, to catch day-to-day variability, not just within-session noise) and compare every derived output — bone length, ROM, DIP/PIP coupling, enslaving matrix, thumb CMC fit. This is the integration test: it doesn't isolate any one assumption, but it's the only test that would catch an interaction between two individually-fine components producing a bad combined result. Expensive mainly in time (two full sessions), not in new engineering, assuming everything above already works.

## Fast-tapping validation of the enslaving coefficient

Capture real, fast-typing-speed finger motion (a genuine keystroke-speed tapping trial, not a slow deliberate sweep) and check whether the `E[i][j]` fitted from the slow freeform sweep still predicts the coupling seen at typing speed. This is the most expensive and novel test on this list — it needs a new capture condition this protocol doesn't otherwise ask for, and arguably a way to correlate hand-tracking data against actual keystroke timing. Worth doing only if the accidental-activation check in `key_point_selection.md` ships and its predictions don't match real-world experience; not worth building speculatively ahead of that.

---

## Detailed spec: frame-to-frame noise in a static hold

### What this establishes

Before trusting any pooled or fitted quantity elsewhere in the protocol, it's worth knowing how much a completely motionless hand's bone lengths and joint angles jitter from frame to frame under MediaPipe alone, in the orientation the protocol actually plans to use (palm facing a floor-mounted, upward-facing camera). This is a noise floor, not a validation of anything downstream — it's the number every later test's "is this variation real or just noise" question gets compared against.

### Where the code lives

**Capture page:** `src/routes/scan-tests/static-hold/+page.svelte`, a minimal SvelteKit route under `src/routes/` (required for the dev server to serve it at all). It drives MediaPipe through `src/routes/scan-tests/lib/detector.ts`, a detector built on `$lib/hand.ts` — the canonical FK/IK engine `/beta`, `handoptim.ts`, and the planned `/scan3` route all read from (see `scan3.md`'s "Foundation" section) — rather than `src/routes/scan/lib/hand.ts`, an older fork kept only for `/scan`'s own components. This keeps scan-tests and the eventual `/scan3` implementation computing bone vectors and joint angles the same way.

- Camera/`getUserMedia`/`<video>` setup follows the same pattern `/scan` already uses.
- A dropdown selects the target orientation: `palm-facing`, `palm-away` (dorsal), `thumb-away`, `thumb-toward` (the two lateral rolls).
- **Positioning auto-detects the target orientation; there's no manual record button.** MediaPipe's hand tracker bootstraps via a full-frame palm detector, then tracks frame-to-frame off the previous frame's region rather than re-running full detection every frame — so starting cold in a hard pose (e.g. rolled so fingers stack toward the camera) often never gets an initial lock, while starting from an easy pose and rotating into a harder one, already tracked, usually works. The page runs two phases accordingly:
  1. **Positioning** — starts immediately on "Start," in whatever pose you're in. Every frame's palm-normal angle relative to the camera's forward axis is computed from `Hand.vectors` (the raw, camera-relative landmark positions `makeHand()` returns before its basis-standardizing transform): `cross(indexMcp - wrist, pinkyMcp - wrist)`, normalized, with Right-hand normals negated to match Left's convention (mirrored chirality flips the cross product's sign). ~0° is palm-facing, ~180° is palm-away, ~90° is either lateral roll. Since both lateral rolls read the same palm angle, `thumbDepthSign()` provides a second signal — comparing the thumb's and pinky's raw camera-space depth relative to the wrist, whichever is closer to the camera determines the roll — and the page displays it live during positioning so its sign convention can be checked against an actual hold rather than trusted blindly. Once the angle (and, for lateral targets, the depth sign) matches the target orientation continuously for 0.5s, positioning ends and recording begins automatically.
  2. **Recording** — runs for the configured hold duration, accumulating live per-bone and per-joint statistics (below) from every accepted frame.
- **No file save, no separate analysis script.** The page computes bone-length and joint-angle statistics incrementally, in the browser, from the same `makeHand()`/`CONNECTIONS` math driving live detection, and displays them next to the video feed as they accumulate — there's no download step and no offline script to run for this test. `scan_tests/analyze-static-hold.ts` and any files under `scan_tests/data/` are kept only as an archival record of sessions run before this live workflow existed; they're not part of the current spec.

### Live noise statistics

Per accepted frame (`score >= 0.7`, matching the product's existing confidence threshold) during the recording phase:

1. `makeHand(...)` gives that frame's `limbs` (one `Vector3` per bone, per `CONNECTIONS`' 20 bone segments across the 5 fingers) — the same derived quantity the real pipeline computes, not a reimplementation that could disagree with it for unrelated reasons.
2. Bone length per segment = `vector.length()`.
3. An inter-bone angle per joint (MCP/PIP/DIP-equivalent) = the angle between consecutive bone vectors in the same finger's chain, via three.js's `vectorA.angleTo(vectorB)`, converted to degrees.

Each bone segment and joint has a running mean/variance accumulator (Welford's online algorithm — O(1) memory per accumulator, no need to retain every frame), updated on every accepted frame. The displayed table refreshes every 10 accepted frames rather than every single one, to avoid needless re-renders. The table shows the same numbers the old offline script printed — per-bone mean length, stdev, and CV%; per-joint mean angle and stdev in degrees — plus an aggregate mean-CV / mean-stdev headline for at-a-glance monitoring while the hold is in progress. Verified to match the old script's output bit-for-bit when replayed against the same captured frames.

### How to interpret the result

There's no fixed pass/fail threshold defined in advance — the point of this test is to establish what the number _is_, not to check it against a guess. That said, two rough signposts worth having in mind before running it: a coefficient of variation in the low single digits (a couple of percent) for bone length, and a standard deviation of a few degrees for joint angles, would suggest MediaPipe's frame-to-frame output is stable enough that pooling/averaging across a session meaningfully reduces error rather than just averaging around a large, ever-present jitter. Numbers noticeably larger than that would be a real, first-order finding — worth stopping and reporting before building anything downstream of it, since it would call into question how much precision the rest of the protocol can actually promise.
