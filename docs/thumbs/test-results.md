# Scan test results: a running log

> **Status:** Active empirical record · Append-only · Depends on: `test-plan.md`

Results and lessons learned from actually running the tests in `test-plan.md`, in session order. Each entry records what was measured, what it means for the assumptions `capture-protocol.md` makes, and anything about the testing tooling itself that had to change along the way. Numbers here are the record of truth; `test-plan.md` stays the spec of what each test is trying to check and how — this doc is what actually happened when we ran them.

---

## 2026-08-30 — Static hold noise floor (Tests 1–2)

### Results

**Test 1, frame-to-frame noise in a static hold (`palm-facing`):** established and converged. 5 clean captures (both hands, multiple sessions) consistently landed at **1.7–2.8% bone-length CV** and **1.2–2.5° joint-angle stdev**. Distal bones/joints (the shorter segments nearer the fingertip) are consistently noisier than proximal ones (metacarpal bones, MCP joints) — a stable pattern across every capture, not a one-off.

**Test 2, palmar vs. dorsal (`palm-facing` vs. `palm-away`):** answered. 4 clean `palm-away` captures (2 Right, 2 Left) converged to **4.46–5.42% bone CV (mean 5.00%)** and **2.54–2.96° joint stdev (mean 2.76°)** — roughly **2x** `palm-facing`'s noise floor, reproduced across both hands with a tight spread (~1% CV, ~0.4° stdev across reps). This confirms, on this project's actual camera/hand/lighting, the MediaPipe dorsal-view degradation `capture-protocol.md` argues for from a GitHub issue about someone else's setup — it isn't just a documented claim, it reproduces here.

**Secondary finding:** the thumb is disproportionately noisy in `palm-away` specifically — thumb bones ran 5–8.5% CV (vs. 2–5% for other fingers' comparable segments) and thumb joint 0 stdev ran 3.2–5.4°, well above every other finger's joints (~2–3°) in all four `palm-away` captures. `palm-facing` doesn't show this gap nearly as strongly. Worth keeping in mind for `capture-protocol.md`'s thumb-CMC capture phase, which already plans to use non-palm-facing orientations.

**Open caveat, not yet resolved:** `palm-away` is a physically harder pose to hold steady than `palm-facing` — rotating the wrist into it is more effortful and less naturally stable than resting palm-down. That means the 2x noise gap above is _at least partly_ conflating two different things: MediaPipe's own tracking degrading in the dorsal view (the thing this test is supposed to isolate), and genuine extra physiological wrist/hand movement from the pose being harder to sustain (not a sensor artifact at all, but not what this test is trying to measure either). The two haven't been separated. Right now there's no way to tell how much of the 2x gap is "MediaPipe is worse at this orientation" versus "this orientation is harder for a human to hold still," and the test as currently built can't tell them apart.

### Lessons learned

**Build on `$lib/hand.ts`, not `src/routes/scan/lib/hand.ts`.** Two independent copies of the hand kinematics engine exist; `scan3-architecture.md`'s "Foundation" section already resolved this in favor of the canonical `$lib/hand.ts` (the only copy with the `basis` field later phases need, and the one every other consumer reads from). The test tooling ported `/scan`'s detector onto `$lib/hand` rather than importing the fork, specifically so this testing effort and the eventual `/scan3` implementation stay reading from the same engine.

**MediaPipe's hand tracker needs an easy pose to bootstrap, then can follow into harder ones.** It bootstraps via a full-frame palm detector, then tracks frame-to-frame off the previous frame's region rather than re-running full detection every frame. Starting cold in a hard pose (e.g. rotated so fingers stack toward the camera) often never gets an initial lock at all; starting in `palm-facing` and rotating into the target orientation while already tracked usually works. The capture page's "positioning" phase exploits this directly — recording starts immediately in whatever pose you're in, and a live palm-angle computation (below) detects when you've rotated into the target range.

**A cached detector instance can get silently wedged by one bad frame, breaking every later recording.** Feeding the detector deliberately degenerate landmark geometry (the self-occluded lateral pose, before it was removed) could throw inside MediaPipe's internal `onResults` callback dispatch — not somewhere our own code could catch it. The library's failure mode there is to keep resolving `send()` normally forever after but simply stop invoking `onResults`, with no visible error. Since the capture page originally cached one detector instance across recordings, one bad capture silently broke every recording after it in the same browser tab, including orientations that had worked moments before. Fixed by disposing and recreating the detector at the start of every recording rather than reusing one across a session.

**`Hands.send()` isn't safe to call concurrently, and the obvious `requestAnimationFrame` loop violates that.** Firing a new `estimateHands()` call every animation-frame tick regardless of whether the previous call resolved works fine when inference is fast (`palm-facing`) but piles up and can wedge the tracker when inference is slower or less certain (`palm-away`) — which read, confusingly, as "detection permanently stops right when I rotate into the harder pose." Fixed by only scheduling the next detection call after the current one settles. (`/scan`'s original `Recording.svelte` has the same unthrottled pattern; it just doesn't push the detector into conditions harsh enough to surface the bug there.) A secondary stall-recovery — auto-calling `detector.reset()` after 3 seconds with no detected hand — was added on top, since even with throttling fixed, the tracker can still genuinely lose a hard pose and needs a nudge to re-attempt full detection rather than waiting indefinitely.

**Svelte reactivity gotcha: `array.push()` doesn't trigger a re-render.** The frame counter displayed as permanently stuck at 0 despite frames genuinely accumulating in memory and downloading correctly, because Svelte only re-renders on reassignment to a tracked variable, not on in-place mutation. Reassigning (`frames = frames`) after the push fixed the display; the underlying data had been fine the whole time; this was cosmetic (and confusing, since the on-screen symptom was indistinguishable from an actual capture failure until we cross-checked the downloaded file's contents).

**Orientation can be auto-detected from data already being computed.** `makeHand()`'s raw, camera-space landmark vectors (`Hand.vectors`, before the basis-standardizing transform) are enough to compute a live palm-normal angle relative to the camera: `cross(indexMcp - wrist, pinkyMcp - wrist)`, angle to the camera's forward axis. ~0° is palm-facing, ~180° is palm-away. Left and Right hands have mirrored chirality, which flips the cross product's sign — confirmed empirically against real capture data (raw Right-hand `palm-facing` angles clustered near 165°, Left's near 8°; negating the Right-hand normal brings both to the same ~0°/~180° convention). This let the capture page auto-detect "you've reached the target orientation" (angle in range, held for a short dwell) instead of relying on a fixed timer or manual judgment.

**Live, in-browser noise analysis removes the need for a file round-trip entirely.** The exact bone-length/joint-angle math an earlier offline Bun script (`scan_tests/analyze-static-hold.ts`) computed from a downloaded JSON file is now computed incrementally in the browser via Welford's online algorithm (O(1) memory, no per-frame storage needed) and displayed live next to the video feed, refreshed every 10 accepted frames. Verified to match the offline script's output bit-for-bit when replayed against the same captured frames. The old script and any previously-downloaded files under `scan_tests/data/` are kept only as an archival record of pre-live-tool sessions; this test's workflow no longer produces or depends on saved files.

### Still open

- Separating "MediaPipe is worse at `palm-away`" from "`palm-away` is harder to hold still" — needs either a still-window/motion filter on the live capture (the doc's later "Still-window auto-detection reliability" test, now with a concrete motivating reason to build sooner) or an independent way to confirm how still the hand actually was during a `palm-away` hold.
- Lateral (`thumb-away`/`thumb-toward`) capture was reinstated in the same auto-detect/throttled/stall-recovery framework `palm-away` now uses, so it's testable again — but not yet tested. Two things to check once real captures exist: whether the fingers-together self-occlusion finding from the first attempt (structurally noisy or entirely undetected) holds up with reliable tooling behind it, and whether `thumbDepthSign()`'s sign convention (used to tell `thumb-away` from `thumb-toward` apart, since both read the same ~90° palm angle) is actually correct — it's an unverified guess, exposed as a live debug readout for exactly this reason.

---

## 2026-08-31 — `thumb-toward` dropped; `thumb-away` is the practical lateral orientation

`thumbDepthSign()`'s sign convention was confirmed correct against real data (`thumb-away` consistently read negative, both hands, matching the documented convention). `thumb-away` itself captured successfully both hands. `thumb-toward` failed repeatedly: sweeping through the roll, tracking is stable up to ~60° and again past ~130–140°, but unstable and frequently undetected in between (roughly the 60–140° band both lateral targets sit in); the depth-sign discriminator stayed negative throughout that band and only moved near ~170°, well outside the target window — so `thumb-toward`'s condition (angle in range and positive depth sign) never co-occurred. Root cause not disambiguated (self-occlusion vs. an unreachable rotation path from this starting pose) and not worth resolving further right now.

**Decision:** use `thumb-away` as the only practical lateral orientation going forward; `thumb-toward` is dropped from active testing. This also answers something `capture-protocol.md` itself left open (which edge faces the camera in the lateral posture) — empirically, only one direction is usable on this rig.

---

## 2026-08-31 — Test 3: bone-proportion agreement, `palm-facing` vs. `thumb-away`

### Building the comparison tool

Test 3 ("bone-length agreement between the two canonical orientations") was implemented directly in the `static-hold` page rather than as a separate tool: after two back-to-back captures of the same hand in different orientations, it compares their per-bone means. The first version compared raw means and immediately hit a confound — manual repositioning between captures can't hold camera distance constant, and MediaPipe's monocular depth scale is distance-sensitive, so a pure camera-distance shift alone can inflate or shrink every bone's apparent length together. Fixed by fitting a shared scale factor (median of per-bone B/A ratios — robust to any single bone that genuinely changed, unlike a least-squares fit, which was tried first and let one outlier bone bias the fit enough to leak spurious residual disagreement into every unrelated bone) and comparing what's left after removing it, which isolates proportion changes from pure size changes.

### Result

Scale correction did **not** collapse the disagreement to near-zero the way it does for a pure distance artifact (confirmed against a synthetic test: fitting and removing a true uniform scale drift brought every row to z≈0). Real, substantial per-bone differences remain in both captures run so far (`palm-facing` vs. `thumb-away`, one per hand):

| bone    | Left capture | Right capture |
| ------- | ------------ | ------------- |
| thumb 0 | -12.9%       | -7.4%         |
| thumb 1 | +33.8%       | +25.6%        |
| thumb 2 | +16.1%       | +43.7%        |
| thumb 3 | +38.4%       | +41.5%        |

Non-thumb fingers also show real disagreement (several bones in the 5–12% range — `indexFinger3` -11.7% to -22.9%, `middleFinger2` -12.0%, `pinky1` -9.5%), smaller than the thumb's but still well beyond what frame-to-frame jitter alone would explain once averaged over ~1000 frames per capture (jitter is high-frequency and should average out over that many samples; a difference that survives averaging implies a systematic bias, not noise — the live keypoint overlay confirms the jitter itself is fast/random-looking, not slow drift, which is the case where averaging wouldn't help).

**The finding:** the thumb's bias is directionally consistent across both captures — bone 0 consistently shrinks, bones 1–3 consistently inflate, similar rough magnitudes both times, from two different hands in two independent sessions. That consistency is hard to explain as coincidental noise. This looks like a real, reproducible systematic distortion in how `thumb-away` estimates thumb bone proportions relative to `palm-facing` — on top of, not instead of, the extra frame-to-frame noise Tests 1–2 already found for non-palm-facing orientations. Only 2 data points (1 per hand) so far; more reps would strengthen this, particularly on the non-thumb fingers where the signal is smaller and closer to where jitter/autocorrelation caveats could plausibly matter more.

### Still open

- Only one `palm-facing`/`thumb-away` pair per hand so far — worth at least one more rep per hand to confirm the thumb bias magnitude and direction hold up, and to get a clearer read on whether the smaller non-thumb differences are real or borderline.
- Not yet determined whether this is specific to `thumb-away`'s roll or would show up in `palm-away` too (Test 2 only measured _noise_, not _mean_ bone length, for `palm-away` vs. `palm-facing`) — worth a same-style proportion comparison there for a complete picture.

---

## 2026-08-31 — Test 4 implemented: axis-fit confidence, `palm-facing` vs. `thumb-away`

### Building it

Added `src/routes/scan-tests/flexion-sweep/+page.svelte`: same auto-detect-orientation/throttled-detection framework as `static-hold`, but instructs a flex/extend sweep of a chosen finger instead of a static hold, and compares axis-fit confidence and ROM between two back-to-back captures for the same finger/hand. The orientation math (`palmAngleDeg`, `thumbDepthSign`, `inTargetRange`) and the keypoint overlay drawing were factored out of `static-hold` into shared modules (`src/routes/scan-tests/lib/orientation.ts`, `.../overlay.ts`) so both pages read from one calibrated source rather than risking the two drifting apart.

`fitNorms` (`src/lib/hand.ts`) already ran an SVD per joint and only used the resulting basis, discarding the singular values — `scan-utility-evaluation.md` had flagged this as a free signal worth surfacing. It now also returns `axisConfidence` (ratio of the top two singular values), added as an optional field on `Joint` so no existing consumer (`/scan`, `/scan2`, `calculateJoints` itself) is affected.

### A structural finding, caught before shipping the UI

Tested the new confidence field against synthetic per-finger motion with independently-varying noise on each bone, expecting three different per-joint confidence numbers. Got the same number three times, every time. Traced it to how `calculateJoints` actually works: a finger's three non-metacarpal joint fits (deg2/deg3/deg4) all run their SVD over the _same pooled_ bone1+bone2+bone3 vector set — each fit only changes the coordinate frame it's expressed in, carried forward from the previous stage's result — and SVD singular values don't change under rotation. So the "per-joint" confidence this method produces was never actually three independent measurements; it's the same number, viewed three times. This is a real, previously-invisible property of the existing canonical fitting code (not something introduced by this test), only noticed because surfacing the discarded `q` value made it checkable. The flexion-sweep UI shows one confidence number per finger per capture instead of a misleading three-row table.

### First real runs: index finger, 6 reps (3 Right, 4 Left — one Left rep counted in both the confidence and ROM tallies below)

**Confidence shows no consistent effect.** Across 6 palm-facing/thumb-away pairs, the winner flips rep to rep (B−A: −0.11, +0.07, +0.19, −0.06, +0.19, −0.07 — mean +0.035, essentially zero) and the between-rep spread within a single orientation (A: 1.36–1.69, B: 1.43–1.85) is larger than the between-orientation gap in any individual rep. Confidence itself sat low in both orientations throughout (1.3–1.9, versus ~3.5 for a clean synthetic single-axis rotation) — real index-finger flexion apparently isn't clean single-axis motion regardless of camera angle, which may be why this metric doesn't discriminate well between orientations at all.

**ROM showed a striking pattern in 4 Left-hand reps that didn't replicate in 2 Right-hand reps.** Joints 2 and 3 (more distal, closer to where fingers self-occlude in the lateral roll) were wider in `thumb-away` than `palm-facing` in all 4 Left-hand reps (joint 2: ~40% wider; joint 3: ~2x wider), while joint 1 (proximal) showed no difference — consistent with the occlusion-glitch theory (min/max is maximally sensitive to rare bad frames; a proximal joint that stays visible throughout wouldn't show it, distal joints that go in and out of occlusion would). But the 2 Right-hand reps didn't show the same pattern — one had joint 3 narrower in `thumb-away`, the other had joint 2 narrower. Unconfirmed: real Left/Right asymmetry (different camera angle relative to that hand?) vs. a 4-for-4 streak that happened by chance with only 6 total reps.

### Redesigned: continuous angle-binned sweep instead of two discrete captures

The two-discrete-capture design (separate `palm-facing` and `thumb-away` runs, each requiring the auto-detect-and-dwell positioning gate) was replaced with a single continuous session: rotate slowly from `palm-facing` (0°) to full lateral (~90°) while continuously flexing, with accepted frames binned live into 10° palm-angle windows (9 bins), each independently refit for axis-fit confidence and ROM. Two reasons: the discrete-capture ceremony made collecting the reps above slower than it needed to be, and — more importantly — the two-endpoint comparison was throwing away the 30°–60°/whatever-transition-zone data entirely, which is exactly where the interesting question ("where does tracking break down") actually lives. A continuous binned sweep answers that directly instead of inferring it from contrasting two endpoints.

Binning/refit mechanics verified against synthetic data (frames sort into ascending angle bins as rotation increases; each populated bin fits without error).

### Continuous sweep runs: index finger, 3 sessions (1 Left, 2 Right), 0-90° in 10° bins

No cutoff angle found. Confidence stayed flat and low (1.3-1.9) through 10-70° in all three runs, then rose sharply at 80-90° in all three (2.43, 2.83, 3.35) — the opposite of a breakdown signal. Checked against ROM span in that same bin rather than taking the rise at face value: spans collapsed there too (Run 2's joint 1 dropped to a 10.8° span vs. 22-44° everywhere else in that run; joint 2 dropped from 47.5° to 31.9° in Run 2 and 43.5° to 21.2° in Run 3), meaning less motion got captured in that bin — the same sweep-amplitude-inflates-confidence confound already documented above, not genuine improvement near the lateral extreme. Frame counts stayed solid throughout (76-393 per bin from 10° up in every run) — whatever's happening near 90°, MediaPipe isn't losing the hand outright.

One lead, unconfirmed: joint 2's ROM span narrowed sharply at 80-90° in both Right-hand runs but stayed flat in the one Left-hand run — the same Left/Right asymmetry theme that showed up in the earlier discrete-capture data. Not resolved with n=1 Left rep against n=2 Right reps.

### Test 4: inconclusive

Neither the discrete two-capture design nor the continuous angle-binned redesign found a clean, repeatable signal for "does axis-fit confidence or ROM favor palm-facing over lateral for flexion," or a clear angle where measurement quality breaks down. Confidence appears to not discriminate meaningfully between orientations for real (non-idealized) finger flexion — real motion isn't clean single-axis regardless of camera angle, and the metric sits low (1.3-1.9) throughout the range tested. ROM shows an intriguing but unconfirmed Left/Right asymmetry in how it behaves near 90° that a future test could specifically target (e.g., several more reps split evenly by hand, focused just on the 70-90° range) if revisited. Closed for now.

---

## 2026-08-31 — Test 5 skipped; pivot from testing to implementation

Test 5 (bilateral vs. unilateral) skipped on the user's own subjective assessment — no perceptible difference in hand movement between mirrored-bilateral and unilateral-resting elicitation, and if there is one, it's small. Not empirically measured; recorded here as a deliberate scope decision, not a validated finding.

Reviewed the remaining tests (6–14) against what Tests 1–4 actually needed to be cheap: they only required machinery that already existed (`makeHand`, `fitNorms`, live stats). Tests 6–11 each need an algorithm that doesn't exist yet (still-window extraction, plateau detection, DIP/PIP coupling fit, enslaving-coefficient fit, thumb CMC/occlusion-guard logic) — building a throwaway version just to test it in isolation costs about as much as building it for real inside `/scan3`. Tests 12 and 14 are already explicitly deferred by `test-plan.md`'s own text; Test 13 is the integration test, meant to run once everything else exists, not before. So none of the remaining tests are real prerequisites to starting `/scan3`.

**Decision:** stop writing throwaway test infrastructure. Write each remaining algorithm in its real, final reusable form — the locations `scan3-architecture.md`'s own "Directory layout" already specifies — and validate each one with a lightweight live test page against the real library code, not a synthetic-only or reimplemented-for-testing version.

### Implemented: `stillWindow.ts` and `plateau.ts`

Both written at their `scan3-architecture.md`-specified locations (`src/routes/scan3/lib/completion/`), grouped together since the doc treats them as the same "completion detection" concern and they're both used across multiple phases.

**`findStillWindow()`** — slides a fixed-duration window across a per-frame signal (after discarding an initial warmup period), keeps every placement where frame-to-frame velocity stays under a threshold throughout, and returns the lowest-variance one (not just the first one found). Verified against synthetic data: settle-then-hold correctly finds the window right after settling; constant drift correctly finds nothing; two candidate still windows of different noise levels correctly picks the quieter one, not the first one encountered.

**`PlateauDetector`** — tracks running min/max per joint, detects rep boundaries via a hysteresis-based peak detector on the primary joint (dead-band before confirming a peak, so ordinary frame jitter doesn't get counted as a rep), and declares convergence once the last N reps each fail to grow any joint's range beyond a threshold. Verified against synthetic data: an amplitude sequence that grows then plateaus converges at the correct rep; a sequence that never plateaus never converges; a multi-joint case where two joints plateau but a third (simulating DIP) keeps growing correctly never converges — matching `capture-protocol.md`'s explicit requirement that every joint's own extremum has to converge, not just the nominal target joint's.

Both verified against synthetic data only so far — not yet run against real capture. `src/routes/scan-tests/completion-detectors/+page.svelte` built to test them live (mode-switchable between the two, reuses the same detector/overlay/throttled-loop pattern established for the other scan-tests pages), feeding both the same 3-joint per-frame angle signal already used throughout this doc.

### First live run: still-window's default velocity threshold was badly miscalibrated

Baseline still-window run (genuine hold, default settings) found nothing. Root cause: `velocity()` combined all 3 tracked joints into one Euclidean-norm delta, which scales with `sqrt(dimension count)` — using Test 1's own established noise floor (~1.5-2.5deg per joint), ordinary frame-to-frame sensor noise alone already produces a combined-norm velocity over 100deg/s with 3 joints tracked, before any real movement. The default threshold (20deg/s) was rejecting normal sensor jitter as motion.

Fixed two things: switched `velocity()` to max-per-component rather than combined-norm (doesn't scale with how many joints happen to be tracked, and better matches "no single joint is moving much" — the actual meaning of "still"); raised the page's default threshold from 20 to 100deg/s as a more realistic starting point. A synthetic worst-case check (fully independent, uncorrelated frame noise at Test 1's stdev) needed a threshold around 200deg/s to reliably pass even with zero real movement — real MediaPipe noise is likely _not_ fully independent frame-to-frame (the tracker uses the previous frame's region as a starting point, so consecutive-frame errors are probably correlated rather than white noise), so real data may need less headroom than that pessimistic synthetic model — genuinely unknown until tested live, hence raising the default rather than guessing a final number.

### Test 6 answered: real threshold found by live tuning — window length matters more than threshold

At the original 1s minimum window: 200deg/s worked but not reliably (passed once, failed on repeat genuine-still holds); 250deg/s worked repeatedly and still correctly failed the negative control (deliberate movement). That looked at first like the answer — until shorter windows were tried directly: **200deg/s at a 0.5s window, and 150deg/s at a 0.25s window, both worked more reliably than 250deg/s at the full 1s window.** Initially treated the shorter-window combinations as a side option traded off against a noisier mean (fewer samples to average); that was the wrong framing. The real mechanism is that a longer required window means more consecutive frame-pairs that all have to clear the velocity threshold _simultaneously_ — every extra sample in the window is another chance for one noisy frame to break the whole window — so window length, not threshold, is the dominant lever on reliability. Page default set to 200deg/s / 0.5s based on this.

This closes Test 6 — the previously-open question ("does still-window auto-detection actually work against real, imperfect human stillness, and what threshold does it need") has a real, empirically-tuned answer now, not a guessed default. Worth remembering for `scan3-architecture.md`'s Phase 2/3 implementation: don't default to the doc's originally-assumed ~1s window without retesting against this finding.

### Test 7 answered: plateau's rep-boundary hysteresis had the same miscalibration

First live run: normal MediaPipe frame noise registered as ~5 reps in 15 frames — physically impossible (15 frames is ~0.5s, far too fast for real flex/extend cycles). Same root cause pattern as Test 6's threshold: the peak-detector's hysteresis dead-band (3°) was well inside Test 1's own established ~2-3° frame-to-frame noise floor, so ordinary jitter alone flipped the rising/falling state constantly, each flip counted as a confirmed peak. Confirmed with a synthetic check (clean 5-rep sequence with 2° noise superimposed): hysteresis=3 produced 32 spurious reps; hysteresis=10 and 15 both correctly counted 5. Raised the page default from 3° to 15°.

Live retest at 15° hysteresis / 2° convergence threshold: 3 stable reps, correctly converged. No further tuning needed — unlike Test 6, the first raised default worked on the first real try.

This closes Test 7. Both completion detectors (`stillWindow.ts`, `plateau.ts`) are now validated against real capture, not just synthetic data, with real tuned parameters instead of guessed ones. Three separate instances now, across this whole testing effort (Test 3's thumb bias, Test 6's velocity threshold, Test 7's peak hysteresis), of the same underlying lesson: parameters guessed from first principles or literature undershoot real MediaPipe noise by a wide margin, consistently in the same direction (too tight/too strict), and only live tuning against real capture catches it.

---

## 2026-09-01 — Plan for the remaining algorithms/tests (8–12), three groups

Reviewed what's left (Tests 8–12; 13/14 stay deferred per their own doc text) and grouped by dependency and reuse opportunity, cheapest/lowest-risk first:

**Group 1 — DIP/PIP coupling fit (Test 8).** No new capture needed: `flexion-sweep` already retains full per-frame data per angle bin, so the fit (slope/intercept/R²/residuals between PIP and DIP angle) can run directly against existing captures. Lives at `src/routes/scan3/lib/phases/flexion.ts`. Tested by extending `flexion-sweep`'s UI, not a new page.

**Group 2 — Enslaving coefficient + coverage-grid completion (Tests 9, 12).** Grouped together because they're the fit-and-its-completion-detector pair for the same new capture mode: a freeform _paired_-finger sweep (two fingers tracked simultaneously, which no existing tool does). Completes the "completion detectors" trio `scan3-architecture.md` names alongside `stillWindow.ts`/`plateau.ts`. Lives at `src/routes/scan3/lib/phases/pairedSweep.ts` and `.../completion/coverageGrid.ts`. Needs one new capture page (reusing the existing detector/overlay/throttled-loop scaffolding, just a new capture surface). Test 12's actual grid-resolution _tuning_ stays optional/deferred per `test-plan.md`'s own text — only the algorithm itself (needed for the enslaving fit's completion signal) is in scope now.

**Group 3 — Thumb CMC axis fit + occlusion guard, and thumb freeform trajectory vs. isolated baseline (Tests 10, 11).** Saved for last on purpose: these are the most complex (Test 10's occlusion guard has to distinguish "truncated by occlusion" from "genuinely plateaued," a harder discrimination than anything built so far) and the most exposed to a risk already confirmed twice over (Tests 3 and 4: thumb tracking is disproportionately noisy and biased off `palm-facing`). Better to have Groups 1–2's fitting/completion patterns solid, and the "every guessed threshold has undershot real noise" lesson fully absorbed, before tuning thumb-specific guard logic. Lives at `src/routes/scan3/lib/phases/thumbCmc.ts`, reusing the axis-fit-confidence work from Test 4.

Order: 1 → 2 → 3. Not started yet.

---

## 2026-09-01 — Group 1 implemented: DIP/PIP coupling fit (Test 8)

`src/routes/scan3/lib/phases/flexion.ts` written at its `scan3-architecture.md`-specified location: `fitDipPipCoupling(history: Hand[], finger: Finger)` reads PIP (`limbs[1].angleTo(limbs[2])`) and DIP (`limbs[2].angleTo(limbs[3])`) per frame — the same convention `flexion-sweep`'s live ROM table already uses at `j=1`/`j=2` — and fits an ordinary-least-squares line (`dip ≈ slope*pip + intercept`) plus R² and per-frame residuals, matching `scan3-architecture.md`'s `DipPipCoupling` shape. A degenerate all-flat sweep (no PIP variation) falls back to slope 0 instead of dividing by zero.

Verified against synthetic data (`flexion.test.ts`, `bun test`) before touching real capture, continuing this doc's established pattern: an exact linear relationship recovers slope/intercept exactly with R²=1; a quadratic relationship (`dip = 0.4*pip + 0.01*pip²`) correctly produces a lower R² and residuals that grow toward the ROM extremes rather than staying flat — confirming the residual-vs-extremes check this test is actually looking for would show up if present.

Per Group 1's plan, no new capture page: `flexion-sweep/+page.svelte` was extended to call `fitDipPipCoupling` over every accepted frame pooled across all palm-angle bins (this question is about the finger's full sweep, not about camera orientation, unlike the axis-confidence/ROM table that stays bin-by-bin) every `STATS_UPDATE_EVERY` frames and again on stop. Displays slope/intercept/R² plus a residual table bucketed into 8 equal-width PIP-angle ranges (mean |residual| per bucket) — a flat trend across buckets means the linear fit holds throughout the sweep; residuals growing in the first/last buckets means the coupling curves near the ROM extremes, the thing `test-plan.md`'s spec for this test says to look for.

### First live runs: 11 reps across all 5 fingers, both hands (1 session each; index has 3 reps, 2 Right + 1 Left)

| finger | hand | R²    | slope | intercept | frames |
| ------ | ---- | ----- | ----- | --------- | ------ |
| index  | L    | 0.285 | 0.435 | 30.76°    | 868    |
| index  | R    | 0.013 | 0.035 | 35.09°    | 1021   |
| index  | R    | 0.111 | 0.138 | 34.29°    | 968    |
| middle | R    | 0.658 | 0.390 | -4.47°    | 970    |
| middle | L    | 0.388 | 0.196 | 6.57°     | 831    |
| ring   | R    | 0.616 | 0.289 | 3.24°     | 984    |
| ring   | L    | 0.183 | 0.094 | 6.93°     | 923    |
| pinky  | R    | 0.773 | 0.923 | 0.07°     | 843    |
| pinky  | L    | 0.726 | 1.034 | 11.25°    | 920    |
| thumb  | R    | 0.535 | 1.007 | 8.81°     | 954    |
| thumb  | L    | 0.692 | 1.372 | 4.72°     | 802    |

**Coupling strength varies a lot by finger, not just by noise.** Pinky is the strongest and most consistent (R² 0.73–0.77 both hands, slope near 1 — DIP tracks PIP almost 1:1). Index is by far the weakest and most inconsistent (R² 0.01–0.29 across 3 reps, slope far below 1 in two of three reps) — DIP barely moves with PIP at all in most index reps, the clearest evidence yet that the linear-coupling assumption doesn't hold uniformly across fingers. Middle and ring sit in between, each with a real-looking Right > Left gap (middle: 0.658 vs 0.388; ring: 0.616 vs 0.183) — the same Left/Right asymmetry theme Test 4 flagged for ROM, unconfirmed here too with only n=1 per side per finger.

**Thumb caveat:** the tool's generic "PIP"/"DIP" labels (limb-chain positions 1↔2 and 2↔3) land on the thumb's **MCP and IP** joints, not true PIP/DIP, since the thumb has one fewer non-metacarpal bone than the other fingers — the same convention `flexion-sweep`'s ROM table already uses for thumb. Not a bug, but the thumb rows above answer "does MCP couple to IP," a different, unplanned-for question from Group 3's dedicated thumb CMC work.

**Residuals mostly grow toward full flexion, not symmetrically at both extremes** — in middle-R, ring-R/L, pinky-R, and thumb-R, the worst-fitting bucket is consistently the highest-PIP one, not the lowest. This is a more specific (and different) shape than `test-plan.md`'s original framing ("curve near the ROM extremes," implying both ends) anticipated — so far it looks closer to "breaks down specifically near full flexion." Pinky-L is the one outlier: residuals stay large through most of the range rather than concentrating at either end.

**Known limitation, carried over from Test 3's design (`test-plan.md`'s own spec for this test):** per-bucket frame counts are uneven (pinky-L's worst bucket has only 11 frames) and consecutive video frames of continuous motion aren't independent samples, so residual magnitudes in sparsely-populated buckets are less trustworthy than densely-populated ones — a bucket's number should be read alongside its frame count, not on its own.

### Still open

- Single session per finger/hand (index has 2 reps on the Right) — not enough to confirm the middle/ring Left-Right asymmetry or the near-full-flexion residual-growth pattern are real rather than single-session artifacts.
- Whether index's near-zero coupling replicates, and if so, whether it's a real biomechanical property (independent DIP control) or a tracking artifact specific to how MediaPipe resolves the index finger's DIP landmark — not disambiguated here.
- Not yet clear whether the linear model is "good enough" for `capture-protocol.md`'s purposes at any of these R² values, since no threshold was set in advance (consistent with how Test 1 was scoped) — that's a product judgment call, not something this test alone resolves.

### Second batch: 15 more reps (index L×3/R×2, middle L×2/R×2, ring L×2, thumb L×2/R×2)

Running totals now: index L=4/R=4, middle L=3/R=3, ring L=3/R=1 (unchanged — none submitted), pinky L=1/R=1 (unchanged), thumb L=3/R=3.

**Index's near-zero coupling replicates cleanly.** All 4 Left reps (0.285, 0.180, 0.045, 0.066) and all 4 Right reps (0.013, 0.111, 0.002, 0.098) stay in a 0.00–0.29 band — consistently the lowest-R² finger of the five, on both hands. This is no longer a single-rep fluke; index's DIP genuinely doesn't track PIP linearly on this rig.

**Middle's Right>Left asymmetry holds up at n=3 per side, though the gap narrowed.** Left: 0.388, 0.334, 0.663 (mean ≈0.46). Right: 0.658, 0.806, 0.854 (mean ≈0.77). The ranges barely overlap (Left's best rep, 0.663, is about equal to Right's worst, 0.658) — real difference, smaller than the original single-rep comparison suggested but still a consistent direction across all 3 reps each side.

**Thumb turned out consistent both hands, not asymmetric.** Left: 0.692, 0.563, 0.728 (mean ≈0.66). Right: 0.535, 0.543, 0.609 (mean ≈0.56). Overlapping ranges, no clear hand effect — thumb's MCP/IP coupling (see labeling caveat above) sits moderately-high on both hands, unlike middle/ring.

**Ring's asymmetry is still unconfirmed — no new Right-hand ring reps came in this batch.** The 2 new Left reps (0.236, 0.254) landed close to the original Left rep (0.183), tightening that side's range to 0.18–0.25 — but Right still has only the original single rep (0.616), so the apparent gap is exactly as unconfirmed as before.

**The "residuals grow near full flexion" pattern does not replicate universally — it's finger-specific, not general.** It held clearly for 3 of 4 new thumb reps and one of the two new index-Right reps (worst bucket at the high-PIP end). It did **not** hold for either new ring-Left rep (residuals flat-to-decreasing toward the high end in both) or for one of the two new middle-Left reps (worst bucket was the _first_ one, not the last). Revising the earlier note: this looks like a real pattern for thumb specifically, occasionally for index, but not a property of DIP/PIP coupling in general — ring in particular trends the opposite way.

**Pinky got no new reps this batch** — still n=1 per hand, its Left-side residual-growth-through-the-whole-range outlier is still unconfirmed.

### Third batch: 7 more reps (ring R×3, pinky L×2, pinky R×2) — closes out every remaining open item

**Ring's asymmetry is now decisively confirmed.** Right jumps from n=1 to n=4: 0.616, 0.787, 0.848, 0.806 (range 0.62–0.85, mean ≈0.76). Left stays at 0.183, 0.236, 0.254 (range 0.18–0.25, mean ≈0.22, n=3). The two hands' ranges don't overlap at all — this is the clearest Left/Right split of any finger tested, well past the point of single-rep coincidence.

**Pinky is consistent both hands, and the earlier Left-side residual outlier does not replicate.** Left: 0.726, 0.811, 0.768 (n=3, tight range). Right: 0.773, 0.683, 0.719 (n=3, tight range). No real hand asymmetry. The original Left rep's 16.04°-residual spike in its last bucket (only 11 frames) doesn't show up in either new Left rep — both stay in a flat 6.5–12° band throughout the PIP range, no dramatic tail spike. That original number now reads as a sparse-bucket artifact (the same caveat this test's own spec already carries: a bucket with few frames is an unreliable residual estimate), not a real finding — the pinky-Left "outlier" is retracted.

**New, unflagged observation (not chased further here, just noted):** pinky-Right's two new reps both show residuals climbing sharply toward higher PIP (rep 2 peaks at 16.56° in the 48-58° bucket; rep 3 climbs steadily to 14.26° by the 79-89° bucket), while pinky-Left's reps stay flat throughout. This is a hand-specific residual-growth difference for pinky specifically — the opposite of what the original "does the growth-near-extremes pattern replicate" question was asking, and outside Group 1's original scope. Worth a look if pinky's coupling model gets built out further, not blocking anything right now.

### Group 1 (Test 8) data collection: complete

Every open item from the previous two batches is now resolved:

| Finger | Asymmetry?                                                         | Confidence                 |
| ------ | ------------------------------------------------------------------ | -------------------------- |
| index  | none — uniformly low both hands (0.00–0.29)                        | high, n=4/side             |
| middle | real, Right > Left (≈0.77 vs ≈0.46)                                | high, n=3/side             |
| ring   | real, Right > Left (≈0.76 vs ≈0.22) — largest gap of any finger    | high, n=4 Right / n=3 Left |
| pinky  | none — consistent both hands (≈0.7–0.8)                            | high, n=3/side             |
| thumb  | none — consistent both hands (≈0.56–0.66), MCP/IP not true PIP/DIP | high, n=3/side             |

No further reps needed to answer Test 8's original question set. Remaining open threads are secondary and don't block moving to Group 2: (1) whether index's near-zero coupling is a real biomechanical property or a MediaPipe DIP-landmark tracking artifact — needs a different kind of test than more reps of this one; (2) the newly-noticed pinky Right-vs-Left residual-growth-shape difference; (3) the general "is this R² good enough for capture-protocol.md" product judgment call, not something this test resolves on its own.

---

## 2026-09-01 — Group 2 implemented: enslaving coefficient + coverage-grid completion (Tests 9, 12)

Both algorithms written at their `scan3-architecture.md`-specified locations:

**`src/routes/scan3/lib/completion/coverageGrid.ts`** — `makeCoverageGrid(bounds, resolution)`, `updateCoverageGrid(state, sample, confidence, confidenceThreshold?)`, `coverageFraction(state)`, and `isCoverageComplete(state, requiredFraction = 0.7)`, matching `scan3-architecture.md`'s `CoverageGridState`/`updateCoverageGrid`/`coverageFraction` API and `capture-protocol.md`'s Phase 5 completion criterion (≥70% of cells confidence-passed). Out-of-bounds samples are dropped rather than clamped to an edge cell, and bounds are fixed at grid creation rather than grown adaptively — Phase 5 normally runs after Phases 3/4 have already established each finger's ROM, unlike Phase 4's abduction capture (which does grow its bounds live, having no prior ROM to anchor to); replicating that adaptive-bounds behavior was deliberately left out of scope here.

**`src/routes/scan3/lib/phases/pairedSweep.ts`** — `fitEnslaving(angleI, angleJ, options?)` implements `capture-protocol.md`'s method directly: `E[i][j] ≈ Δθ_j/Δθ_i`, fit by regression over whichever frame-to-frame deltas have `|Δθᵢ|` both exceeding a minimum-motion floor (default 3°, matching Test 1's established noise floor so ordinary jitter isn't mistaken for a dominant-segment sample) and at least 2× `|Δθⱼ|` — the freeform-sweep stand-in for the literature's "move only finger i" instruction, so no separately-instructed condition is needed. Regression is forced through the origin (coefficient only, no intercept, matching `scan3-architecture.md`'s `Enslaving` shape) using the standard through-origin least-squares and R² formulas.

Verified against synthetic data before touching real capture, continuing this doc's established pattern:

- `coverageGrid.test.ts` (6 cases) — empty grid reads 0% coverage; a sample lands in the correct cell without mutating the prior state; below-threshold-confidence and out-of-bounds samples are correctly dropped; full coverage reads 100% and passes the 70% completion check; partial coverage correctly fails it.
- `pairedSweep.test.ts` (5 cases) — an exact synthetic coupling (`Δθⱼ = 0.3·Δθᵢ` during an i-dominant segment, plus a separate j-dominant segment that must be excluded or it would corrupt the fit) recovers the coefficient exactly with R²≈1, and confirms the j-dominant segment was in fact excluded; no-i-dominant-segment and mismatched-length inputs both throw; a noisy-but-real coupling still fits with high R², and an uncoupled (independent-noise) pair correctly fits with low R².

Per Group 2's plan, one new capture page: `src/routes/scan-tests/paired-sweep/+page.svelte`. Reuses the same detector/overlay/throttled-loop scaffolding as `flexion-sweep` and `static-hold`, but is a freeform two-finger recording rather than an auto-detect-orientation or binned sweep — the user picks finger i (dominant/instructed) and finger j (dragged/measured), handedness, grid bounds, and resolution, then moves both fingers freely for the session duration. Both fingers' angles use the same PIP-equivalent convention (`limbs[1].angleTo(limbs[2])`) Test 8's tooling already established, so results are directly comparable. Live view shows the coverage grid as a purple/black cell heatmap, current coverage fraction with a ≥70%-complete indicator, and the enslaving coefficient/R² (refit every 10 accepted frames and again on stop) once an i-dominant segment has actually occurred.

**Not yet run against real capture.** Both algorithms are built and verified against synthetic data only, the same status Group 1's tooling was in before its first live run — real numbers (whether fitted coefficients are stable across repeat sessions, whether they're in a plausible range relative to `archive/scanning.md`'s cited literature values, how much of the coverage grid a real freeform sweep actually visits in 20–30s) are still open. Test 12's grid-resolution _tuning_ stays explicitly deferred per its own scope note in `test-plan.md` — only the completion algorithm itself was needed here, to unblock Test 9's coverage-gated capture.

### Redesigned before first live run: one active finger vs. all four others, not one pair per session

Prompted by an observation while planning the first live session: when one finger moves, the other fingers all show at least some involuntary movement, not just an adjacent "partner." The original pairwise design (pick finger i and finger j, record just those two) would need up to 10 sessions to cover all finger pairs from one hand. Since all 5 fingers' angles are computed every frame regardless of which one is "active," there's no reason not to record all 5 simultaneously and fit against every other finger from one recording — this is actually closer to the classic enslaving-matrix method than the original design was: the literature's own protocol instructs "move only finger i" and records the response on every finger at once, then repeats per i, needing only 5 trials for the full matrix rather than 10.

**`pairedSweep.ts`** gained `fitEnslavingAll(fingerI, angles, options?)`, which loops `fitEnslaving` over every other finger independently against the active finger's history — each pair keeps its own dominance-filtered segment (a frame can be i-dominant relative to one finger while another finger was also moving that same frame), so there's no shared "the segment" to reuse across fingers; a finger with no i-dominant segment of its own is simply omitted from the result rather than failing the whole batch. Verified with 3 new synthetic cases (`pairedSweep.test.ts`, 8 total now): recovers distinct coefficients for two differently-coupled fingers from one recording; a finger with no i-dominant segment (moves entirely on its own) is correctly omitted rather than forced to a spurious fit; a completely static finger (zero delta every frame) is a valid degenerate fit (coefficient 0, r2 1) rather than an omission, since a zero delta trivially clears the dominance filter.

**`paired-sweep/+page.svelte`** now tracks all 5 fingers' angles every frame. The UI keeps one "active finger (i)" selector (deliberately move this one more) and separately a "coverage-grid partner finger" selector, since the 2D `(θᵢ, θⱼ)` coverage grid is inherently pairwise (a geometric-blocking question between two specific fingers) and doesn't generalize to a 5-way grid the way the enslaving fit does. The result summary now lists `E[i][j]` for every other finger on its own line, still in the same terse/pasteable format.

The coverage-grid concept stays exactly as scoped before — the redesign only broadens the enslaving half.

---

## 2026-09-01 — Signed-angle audit and switch: hyperextension is no longer collapsed into flexion's numbers

Prompted by a design question: some people's natural ROM genuinely includes hyperextension (bending past straight), and every angle this whole testing effort has computed so far — `flexion.ts`, `pairedSweep.ts`'s inputs, both capture pages' live readouts — used `Vector3.angleTo()`, which is mathematically restricted to `[0°, 180°]` and can't distinguish "5° hyperextended" from "5° flexed." Both read as the same small positive number.

**Audit first.** Read through `$lib/hand.ts` and every scan3 modeling module built so far (`plateau.ts`, `stillWindow.ts`, `coverageGrid.ts`, `flexion.ts`, `pairedSweep.ts`) for anything that clamps, floors, or errors on a negative value. Result: the fitting/completion/tracking layer was already sign-agnostic throughout — `PlateauDetector`'s min/max, `findStillWindow`'s `Math.abs`-based velocity, `coverageGrid`'s numeric range math, and both regression fits all operate on raw numbers with no non-negativity assumption anywhere. The exclusion was entirely at the _measurement_ layer: every place computing an angle from raw bone vectors used `angleTo()` directly. Found four such call sites: `flexion.ts`'s own `pipDipAngles` helper (missed in the original build — it's genuinely in scan3 scope, not just test-page scaffolding), the duplicated `flexionAngle()` helper in `flexion-sweep`/`paired-sweep`, and `$lib/hand.ts`'s canonical `SolvedHand.deg1Angles()` (feeding `approximateCurl()`, used by `/scan2`'s `MeasurePose.svelte` curl-progress gauge and both `/scan`'s and `/scan2`'s `Pose.svelte` rotation-averaging displays).

**The fix.** Added `signedJointAngle(hand, finger, boneIndex)` to `$lib/hand.ts` — the one canonical, reusable location, so `scan3/lib` and the test pages both import from the library rather than duplicating (or worse, drifting on) the sign convention. Sign is read off which way the bend rotates around a knuckle-line axis (pinky MCP → index MCP, mirrored for chirality the same way `orientation.ts`'s `palmAngleDeg` already is) — explicitly documented as a **best-guess convention, not yet verified against a real capture with known hyperextension**, the same epistemic status this project already gives `thumbDepthSign`'s sign (see the 2026-08-30 entry). If a real hyperextension capture comes back with the wrong sign, it's a single isolated negation, not a redesign, since every downstream consumer already treats sign as opaque data.

Also rewrote `SolvedHand.deg1Angles()` to reuse the existing (already-signed) `decomposeAngles()` Euler extraction instead of its own separate `angleTo()`-based computation — this is a strict correctness fix with no new convention to invent, since `decomposeAngles` was already extracting the right value, just discarding the sign that `fkBy`/`fromLimbs` built the matrix from in the first place. `approximateCurl()` (which sums `deg1Angles()` across fingers) is now a genuine net-curl measure — a hyperextended joint partially cancels flexed ones rather than both adding to the same positive total. One consumer needed a follow-up fix: `/scan2`'s `MeasurePose.svelte` `curlQuality()` fed this into `Math.min(1, curl/80)` for a 0–1 UI progress gauge, which had an implicit non-negative floor that the old unsigned `approximateCurl()` always satisfied; added an explicit `Math.max(0, …)` now that a hyperextended rest pose can legitimately start below 0.

**Verification, synthetic only (real-capture verification of the sign direction is still open, same as `thumbDepthSign`):**

- `hand.test.ts` (new, 5 cases) — `deg1Angles` recovers the exact signed `angleZ` a synthetic `fkBy` call was built from, including negative values that the old code would have returned as positive; `approximateCurl` confirms a hyperextended joint produces a _lower_ net curl than an all-flexed hand, not a higher one.
- `flexion.test.ts` (+1 case, 4 total) — a sweep spanning `pip` from −30° to +50° (through hyperextension) still recovers the exact linear coefficients and confirms the negative samples actually came back negative rather than folded into a positive magnitude.
- `pairedSweep.ts` needed no code changes — its regression math was already sign-agnostic, confirmed by the audit; it now receives signed inputs from the capture page without modification.

98/98 tests pass, `npm run check` clean. Not yet run against a real hyperextension capture — that's the next real test, and the one that will actually confirm or flip the sign convention.

---

## 2026-09-01 — Group 2 first live runs (Tests 9, 12): full 20-pair enslaving matrix collected, one real anomaly found

13 sessions run, one per "active finger" per rep (Right hand only so far), explicitly framed as validating the tooling's _capability_ rather than collecting this person's personal enslaving matrix as an end in itself.

### The one-active-finger-vs-all-others redesign works as intended

The first 5 sessions (one per finger) produced the full 5×4 = 20-entry asymmetric matrix in 5 recordings, confirming the point of the 2026-09-01 redesign (broadening from pairwise to one-active-finger-records-everyone).

### Ring↔middle: persistently low even under a deliberate stress test — looks like a real finding, not a tool artifact

Initial data (ring-active→middle: R²=0.001–0.184 across reps; middle-active→ring: R²=0.001–0.074 across reps) never broke ~0.2, well below the pairs the tool clearly can detect. Suspecting this was the dominance-ratio filter (`|Δi| ≥ 2×|Δj|`) getting starved specifically for genuinely-coupled pairs — a tightly-coupled pair moves together, making it harder for either finger to "dominate" — a follow-up round explicitly instructed "consciously brace/still the other finger while moving the active one, harder than a normal freeform sweep." Result: still low (ring-active→middle: 0.031, 0.158; middle-active→ring: 0.038, 0.074, 0.040 across the deliberate reps). Critically, **the same tool, in the same recording session, cleanly detected three other strong couplings simultaneously** — one middle-active rep produced R²=0.628 (index), 0.484 (thumb), 0.479 (pinky) while ring sat at 0.040 in that identical recording. This rules out a broad tool-starvation explanation: the method isn't blind to strong coupling in general, it specifically isn't finding one between ring and middle on this rig — a real discrepancy from the classic enslaving-matrix literature (which usually cites ring/middle as one of the _most_ coupled pairs), not yet explained.

### Coverage never reached the 70% completion bar across any of 13 sessions

Range 16–59% throughout, including a session explicitly instructed to deliberately visit all 4 corners of the grid (26%, another pair 43%). This is now a finding about Test 12's design, not a "try harder" problem: either 30s sessions are too short, the 9×9/0–90° grid is finer than a real freeform sweep naturally covers in that time, or 70% isn't a realistic bar for this capture style at all. Still open — needs a dedicated longer session (60–90s+) on one pair to see whether coverage keeps climbing with time or plateaus below 70% regardless of duration.

### Index's independence replicates across two different measurements

Both new index-active sessions show near-zero R² against every other finger (0.000–0.067) — the same independence signature Test 8 found in index's DIP/PIP intra-finger coupling. Two different measurements (intra-finger coupling in Test 8, inter-finger coupling here) now agree index is the outlier-independent finger on this hand — convergent evidence, not just one test's idiosyncrasy.

### Thumb↔pinky negative control holds up

R² stayed low (0.012–0.056) across reps, consistent with the expected "anatomically distant, minimal real coupling" result — though coverage there is still low (17%), so this hasn't been stress-tested at high coverage yet.

### Still open — the validation grid's remaining two rows

- **Hyperextension check**: push a finger known to hyperextend into that range mid-sweep (with `boundsMin` set negative) and confirm it reads negative rather than being dropped or misread — first real test of the 2026-09-01 signed-angle switch against live data.
- **Segmented-motion stress test**: explicit phases (move only i, then move only j with i held still, then both freely) to confirm `fitEnslaving` correctly isolates the i-only segment from real, not synthetic, data.
- Ring↔middle's anomaly and the coverage-threshold question above are both new open items from this batch, not carried over from before.

### A dedicated coverage-maximizing session (pinky-active, Left, best coverage yet at 60%) surfaced a real design tension between the two things Phase 5 asks one recording to do

First Left-hand data point. Coverage reached 60% (up from a prior max of 59%), the best result yet from explicitly trying to visit all four grid corners — but all four `E[pinky][j]` coefficients came back **negative** (thumb −0.146, index −0.142, middle −0.142, ring −0.101), with real fit quality (R² 0.11–0.43, among the strongest seen). Pinky moving one way corresponds to every other finger moving the _opposite_ way — the reverse of ordinary "fingers drag together" coupling.

Ruled out as a byproduct of the signed-angle work: `signedJointAngle`'s per-hand chirality negation applies uniformly across all five fingers in a given hand's frame, and a uniform sign flip applied to both factors of a ratio (`cov(Δi,Δj)/var(Δi)`) cancels exactly — it can't flip a fitted coefficient's sign on its own.

**More likely explanation: a real conflict between Test 9 and Test 12's shared recording.** Deliberately reaching the (θᵢ, θⱼ) grid's off-diagonal corners — pinky flexed while another finger is extended, and vice versa — requires _deliberately_ moving two fingers in opposite directions at once. `fitEnslaving`'s dominance filter (large `|Δi|`, small `|Δj|` relative to it) can't distinguish "finger j passively dragged by finger i" from "finger j was deliberately driven the opposite way to hit a coverage target" — both look like large, correlated deltas. So a coverage-maximizing session may be systematically biasing the enslaving fit toward whatever anti-phase navigation reached those corners, not measuring involuntary coupling at all. `capture-protocol.md`'s Phase 5 design has Test 9 (enslaving) and Test 12 (coverage) sharing one freeform recording by design — this result is concrete evidence that combination doesn't hold up cleanly when actually maximizing coverage.

**Recommendation, not yet validated:** split the two goals into separate sessions per pair of interest — a "drag" session (move the active finger, consciously keep everything else relaxed) trusted for its enslaving numbers but not its coverage %, and a separate "coverage" session (deliberately visit all four corners) trusted for coverage but not its enslaving fit. Worth testing directly: run both session types back-to-back on the same pair and see whether the drag session's coefficients look more like the earlier "natural" freeform sessions (positive, lower R²) than this coverage-maximizing one did.

---

## 2026-09-01 — Group 3 implemented: thumb CMC axis fit, conjunct coupling, and the occlusion guard (Tests 10, 11)

The `degree: 3` thumb-joint mechanics `scan3-architecture.md` specifies were built first, since Phase 6 can't work at all without them:

**`$lib/hand.ts`** gained `ConjunctCoupling` (`{ aCoeff, bCoeff, r2 }`) and a `degree: 3` variant on the `Joint` union. `SolvedHand.fkBy` now computes `angleX = aCoeff·angleZ + bCoeff·angleY` for a `degree: 3` joint and builds `Euler(angleX, angleY, angleZ, 'XYZ')` instead of always forcing the leading term to 0. `SolvedHand.fromLimbs` recovers `angleZ`/`angleY` from the observed bone direction the same way `ik()` already does (a direction vector has only 2 DOF, so it can't reveal twist on its own), computes the same conjunct-coupling-predicted twist, and rotates the generic template's `y`/`z` about the bone axis by it before building the frame — otherwise, per `scan3-architecture.md`'s own caveat, the generic path would silently invent an arbitrary twist and corrupt every downstream joint's frame in the chain.

**A real, pre-existing property of `decomposeAngles` surfaced while testing this, unrelated to the new work.** `decomposeAngles` extracts a Euler triple via a `'ZYX'` order, but `fkBy` composes matrices via `'XYZ'` order — those two only invert each other cleanly when at most one of the three axes is nonzero at a time. Every _real_ caller (`PoseResults.svelte`, and `deg1Angles`/`approximateCurl` via `MeasurePose.svelte`) only ever decomposes matrices built by `fromLimbs` (which constructs its frame directly via `makeBasis`, not Euler composition), so this mismatch never surfaces in the app today — but it means `decomposeAngles` should never be paired with an `fkBy`-built matrix expecting an exact round-trip, which the test suite originally (silently, incorrectly) assumed. Tests were rewritten to compare rotation matrices directly instead. Worth remembering if `decomposeAngles` ever gets a new caller downstream of `fkBy`.

**`src/routes/scan3/lib/phases/thumbCmc.ts`**, all built at once since they're the fit-and-guard set for the same phase:

- `fitThumbCmcAxis(history, length, matrix)` — Phase 6a's axis fit. No new algorithm: applies `fitNorms` (already used for every MCP) to the thumb's own bone-0 direction data for the first time, per `scan3-architecture.md`'s "why this is a smaller change than it looks."
- `fitConjunctCoupling(history, cmcJoint, referenceBone1)` — Phase 6b's regression. Flexion/abduction come from the same observed-x → YZ-Euler recovery `ik()` uses; twist is measured as bone1's rotation about the bone0 axis, projected onto the plane perpendicular to it and compared against a reference bone1 direction (the mean bone1 from the rigid Phase 6a sweep, where by construction there was no CMC-driven twist). Through-origin 2-predictor least squares (normal equations), matching `ConjunctCoupling`'s shape.
- `thumbMcpIpAngles(hand)` — the Phase 6b byproduct, a thin wrapper reading `signedJointAngle(hand, 'thumb', 1)`/`(..., 2)`, no new fitting math (per `capture-protocol.md`, this is meant to fall out of the trajectory, not be independently derived).
- `OcclusionGuardedPlateau` — Test 10's actual deliverable, the false-plateau guard `capture-protocol.md` requires: "only accept convergence if confidence/yield stayed healthy through the last k cycles, not just the angles." Wraps `PlateauDetector` by composition (plateau.ts itself is unchanged) with a parallel per-rep confidence-yield track. `status()` returns `'converged'` only if the angle-based plateau _and_ the last `k` reps' yield both look healthy; if yield collapsed in those same reps (the thumb went out of view right as it looked like it stopped), it returns `'possibly-occluded'` instead of asserting a false limit.

**Verified against synthetic data, continuing this doc's established pattern:**

- `hand.test.ts` (+4 cases) — the conjunct twist rotates `y`/`z` about the bone axis by exactly `aCoeff·flexion + bCoeff·abduction`, checked via direct rotation-matrix comparison (not `decomposeAngles`, per the finding above) for both `fkBy` and `fromLimbs`; zero coupling exactly reproduces the ordinary untwisted frame in both.
- `thumbCmc.test.ts` (7 cases) — `fitConjunctCoupling` recovers exact `aCoeff`/`bCoeff` from synthetic flexion/abduction/twist data with R²>0.99; throws on too few frames. `OcclusionGuardedPlateau`: a genuine high-confidence plateau converges; the same angle trajectory with confidence collapsing in the final two reps reads `'possibly-occluded'` instead — the core Test 10 behavior; a still-growing sweep reads `'in-progress'` regardless of confidence.

**New capture page:** `src/routes/scan-tests/thumb-cmc/+page.svelte`, mode-switchable (outer sweep / freeform), reusing the established detector/overlay/throttled-loop scaffolding. Outer-sweep mode pushes _every_ detected frame into the guard regardless of confidence (unlike every other page's confidence-gated accumulation) — the guard needs to see confidence drop to do its job, so filtering low-confidence frames out before they reach it would hide the exact signal Test 10 is checking for. A separate "Fit axis from history" button runs the real `fitThumbCmcAxis` once the guard reads converged, rather than refitting on every frame. Freeform mode is gated on that fit already existing (flexion/abduction/twist are only meaningful relative to it), refits `conjunctCoupling` every 10 accepted frames, and tracks thumb MCP/IP running min/max as the Test 11 byproduct — meant to be compared against a same-session `flexion-sweep` run with "thumb" selected (already-existing tooling, no new isolated-capture page needed).

108/108 tests pass, `npm run check` clean. **Not yet run against real capture** — same status every other group's tooling was in before its first live session. The two things this test was specifically designed to check — whether a stable, plausible axis actually falls out of a real outer sweep, and whether the guard correctly distinguishes a deliberately-occluded sweep from a genuine limit — are both still open until a real thumb-CMC session runs.

### First live run: outer-sweep reps completed on every frame while holding still at an extreme

Same "guessed defaults undershoot real MediaPipe noise" pattern Tests 6/7 already established, but with a compounding design mistake specific to this page: the live rep-completion proxy was `startBone0.angleTo(bone0)` — **unsigned**, folding CMC flexion and abduction motion (and noise) into one omnidirectional "distance from start" number, unlike every other joint-angle signal in this test suite, which are signed and single-axis. Two consequences: reps correctly couldn't complete until the signal fell back from a peak (expected, not a bug), but holding still at an extreme apparently jittered the unsigned proxy by more than the 10° hysteresis, repeatedly, on every frame — plausible given thumb tracking is already the noisiest joint measured in this whole effort (Test 2), the proxy entangles two axes' worth of noise instead of one, and the reference itself was a single (possibly noisy) first frame.

Fixed three things in `thumb-cmc/+page.svelte`: switched to a **signed, single-axis proxy** (rotation of bone0 away from start, read off the same knuckle-axis convention `signedJointAngle` uses, rather than unsigned omnidirectional distance); **averaged the first 5 confidence-passing frames** into the start reference instead of trusting a single frame; and **exposed peak hysteresis as a live-tunable UI input** (default raised to 15°) instead of a hardcoded 10°, so it can be tuned against real capture the way Test 7's finger hysteresis was, rather than guessed once and left alone.

**Not yet re-verified live** — this is a first-pass fix based on diagnosis, not a confirmed resolution. If reps still complete too easily after this change, the next lever is raising hysteresis further (now UI-adjustable) before suspecting anything else.

### Second live run: 15° hysteresis swung the opposite direction — required an almost-full-range reversal to confirm one rep

15° was Test 7's tuned value, but that was tuned for finger flexion, whose ROM (30–90°+) is much larger than the thumb CMC's own range. The same fixed dead-band that was appropriately small relative to a finger's range ate a much larger fraction of the CMC's smaller range, so completing a rep required reversing almost the entire sweep. Lowered the default to 6° — a smaller starting point, not a re-verified answer. This is the same lesson Test 6 already drew about window length vs. threshold, applied to a new joint: a value tuned against one joint's ROM doesn't transfer to a different joint with a different range, and only live tuning against the actual joint in question resolves it. Peak hysteresis stays live-tunable in the page specifically because this number isn't settled yet.

### Third round: lowering hysteresis alone couldn't resolve it — a magnitude threshold structurally can't do both jobs at once

Confirmed live: a low hysteresis needed less motion to trigger, as expected, but also let a single noisy MediaPipe frame cross it — and since `PlateauDetector` resets its tracked extreme to whatever value crossed the threshold, the very next frame bouncing back could cross it again immediately, producing repeated false reps ("if it triggers at all it triggers multiple times"). No single fixed reversal-magnitude value can simultaneously reject single-frame noise and trigger on modest genuine motion — those are in direct tension for any one threshold.

**Fixed the same way Test 6 fixed the analogous problem in `stillWindow.ts`: separate noise-rejection from the trigger threshold using a short window, not magnitude alone.** Added `smoothedProxy()` — a 5-frame moving average applied to the swept-angle proxy before it reaches the peak detector. Genuine motion persists across consecutive frames and survives averaging; a single noisy frame gets diluted into the average rather than individually crossing the threshold. With noise mostly filtered upstream, hysteresis could drop to 4° without reopening the false-rep problem. Smoothing was applied in the capture page, not inside `PlateauDetector` itself — scoped to this page's specific noisy proxy signal rather than changing already-tuned behavior (Test 7's finger reps) for every other consumer of the shared detector.

Not yet re-verified live. If reps still misbehave, the next lever is the smoothing window length (5 frames), not hysteresis — a shorter window trades less noise rejection for less lag, a longer one the reverse.

### Fourth round: still not one-to-one after the smoothing fix — traced to the wrong mechanism entirely, not another parameter

Live retest with the smoothed proxy: hysteresis=8 prevented rep capture outright; hysteresis=5 had fewer false positives but still needed far more physical motion than expected to trigger a rep. Diagnosed live (user observation): detection only became reliable after settling into one specific motion direction — evidence the fixed knuckle-axis proxy (tuned to the _other four fingers'_ flexion axis) is anatomically mismatched for the thumb CMC's own flexion/abduction axes, which aren't fitted yet at this point in the sweep (fitting them is what the sweep produces). Real motion along the CMC's actual axes was projecting onto only a small component of the chosen axis, so genuine large motion looked like a small proxy swing — explaining why even a small hysteresis needed disproportionate real motion. Three tuning rounds on the same rep-counting mechanism (hysteresis value, then smoothing) without resolving it was the signal to change the mechanism, not keep adjusting its parameters.

**Replaced discrete rep-counting with a magnitude/growth-based guard.** `OcclusionGuardedPlateau` (hysteresis peak-detection, wrapping `PlateauDetector`) assumes a clean single-axis "flex to max, then extend" signal — true for finger flexion (Tests 6/7), never true for the thumb CMC's outer sweep, which explores two independent DOFs at once with no fitted axis to project onto cleanly. Added `OcclusionGuardedGrowthPlateau` to `thumbCmc.ts`: tracks the running maximum of an **unsigned** magnitude (total angular distance from a start reference, direction-agnostic across both CMC axes) and declares convergence once that max hasn't grown by more than a threshold over a trailing time window — the same "has this stopped changing" idea `stillWindow.ts` already uses for stillness, applied to a running maximum instead of a held-still value. No axis, no sign, and no clean per-rep shape needed: motion along either CMC axis, or both at once, just grows the tracked max until it plateaus. `PlateauDetector`/`OcclusionGuardedPlateau` themselves are untouched and kept — still valid for genuinely single-axis, cyclic signals (finger reps), just no longer used by this page.

Verified against synthetic data (`thumbCmc.test.ts`, +5 cases, 12 total in the file): a continuously-growing max reads in-progress; a max that plateaus with healthy confidence throughout converges; the same trajectory with confidence collapsing right as it plateaus reads possibly-occluded, not converged (the core Test 10 behavior, now on the new mechanism); not enough elapsed time reads in-progress even given an already-flat signal; and — the case that specifically validates the redesign's premise — an unsigned magnitude that rises and dips as a sweep changes direction between two axes, never regressing past its own running max, still converges once it settles, unlike a rep-based detector would require.

`peakHysteresis` was removed from the page entirely (rep-based detection is gone), replaced by `growthWindowSeconds`/`convergenceThreshold`, both live-tunable. 113/113 tests pass, `npm run check` clean. Not yet re-verified live — this is the fourth attempt at getting outer-sweep completion detection right, and given the first three each looked plausible until real capture disproved them, this one should be treated the same way until confirmed.

### First live run of the growth-based redesign: converges reliably, but two new issues surfaced

Two sessions (Right, Left), both hands: outer sweep converged cleanly on the new mechanism — no false/repeated triggers, the core problem the last three rounds failed to fix. But two new findings:

**Outer sweep converged after implausibly little motion** (7.8° and 14.5° "max swept," vs. a CMC's real range of roughly 40–60° per axis per the literature). With the initial 2-second growth window, a brief pause while deciding where to move next — natural when exploring two axes at once — looks identical to "found the true limit." Raised the default `growthWindowSeconds` to 4 as a next starting point; genuinely unconfirmed until retested, same as every threshold in this history. This likely also explains the low `conjunctCoupling` R² in both sessions (0.073, 0.246) — Phase 6b's flexion/abduction decomposition is only as good as Phase 6a's fitted axis, and that axis was fit from a small slice of the real range.

**Thumb MCP/IP byproduct ROM was physiologically implausible** (Right: MCP −36.9 to 103.6°, IP −112.5 to 62.7°; Left: MCP −39.8 to 90.7°, IP −90.3 to 14.1° — spans of 100–175°, well beyond real thumb ROM). Same root cause already found and fixed for the outer-sweep proxy three rounds ago: a single MediaPipe tracking glitch (plausible at fast or unusual thumb configurations) produces one wildly wrong instantaneous angle, and an unbounded running min/max latches onto it permanently. Fixed by applying the same lesson here that fixed it there: `thumbMcpIpAngles`' `mcp`/`ip` values are now each smoothed (5-frame moving average) before updating the running extrema, via a `makeSmoother()` factory shared with the outer-sweep proxy rather than two independent implementations.

Not yet re-verified live. Both fixes are diagnosis-driven, same status every fix in this history has had before its next live confirmation.

### Second live run of the growth-based redesign: MCP/IP fix confirmed, outer sweep still converging too early

Three real sessions (Right hand), window already raised to 4s.

**MCP/IP smoothing fix confirmed working.** All three sessions produced physiologically plausible, mutually consistent ROM (MCP spans 44–49°, IP spans 59–65° across all three reps) — a sharp contrast with the previous batch's 100–175° spans. No further action needed here.

**Outer sweep is still converging far too early** (8.4°, 9.1°, 21.0° swept — doubling the window from 2s to 4s barely moved these from the 7.8–14.5° range seen before, so the window alone isn't the lever). This is very likely the direct cause of `conjunctCoupling`'s instability across the same three sessions: R² 0.211/0.495/0.146, and `aCoeff`/`bCoeff` swinging wildly and even flipping sign (0.437/0.684/−0.657) — each session refits its own CMC axis from a small, differently-incomplete slice of real motion, so "flexion" and "abduction" aren't consistently defined session to session, making the regression coefficients not directly comparable to each other, on top of whatever noise the small sample itself adds.

**Added a minimum-plausible-max floor rather than guessing a fourth window value.** `OcclusionGuardedGrowthPlateau` gained `minPlausibleMax` (optional, default disabled): convergence is now blocked below this swept distance regardless of how flat the growth curve looks. This targets the actual gap directly — growth plateauing is necessary but not sufficient for "this is a real limit"; a person deciding where to move next, or moving within an already-explored sub-range for a few seconds, looks identical to genuine convergence to the growth check alone, and no amount of window-tuning fixes that distinction. Default set to 25° in the capture page, live-tunable like everything else. 3 new synthetic tests (16 total in the file): a plateau below the floor stays in-progress even with otherwise-flat growth; a plateau clearing the floor converges normally; omitting the floor entirely preserves the original (unfloored) behavior.

116/116 tests pass, `npm run check` clean. Not yet re-verified live — the floor is a diagnosis-driven fix like every other change in this history, unconfirmed until the next real session.

### Third live run: floor worked, and surfaced two more findings — one an actionable false positive, one a real open methodological question

The floor pushed real sweeps to 29.3° then 32.3° (well past the 25° default) across two sessions, confirming it does what it was built for.

**First of the two: `confidenceThreshold`/`minHealthyYield` (0.7/0.8) were hardcoded, never live-tuned, and flagged "possibly-occluded" on a session where the user confirmed no deliberate occlusion was attempted** — a false positive, not the guard correctly catching a real truncated boundary. Consistent with this whole project's established finding (Tests 1-2) that thumb tracking is the noisiest joint measured, especially away from ideal viewing angles — the CMC's genuine extremes are plausibly just harder to track than the 0.7/0.8 defaults (borrowed with no CMC-specific tuning) assume, without actually going out of frame. Exposed both as live-tunable UI inputs in `thumb-cmc/+page.svelte` rather than guessing new hardcoded values, matching how every other threshold in this history eventually needed live tuning rather than a single guess.

**Second, more significant finding, not fixed:** the user reported the swept-distance max didn't exceed ~20° during ordinary motion, only climbing past that when the thumb was pointed toward the camera. MediaPipe's monocular depth (Z) estimate is inherently noisier than its image-plane (X/Y) estimate — rotating a bone toward the camera changes mostly its depth component, exactly the least-reliable axis. So the climb past 20° specifically during toward-camera motion may be measuring depth-axis _noise_, not additional real rotation. This would also explain the falling `axisConfidence` across the last several sessions (6.95, 7.28, vs. 10-25 earlier) — the fitted axis may now be partly built from this artifact rather than only real motion. Documented as an open methodological caveat in the capture page rather than patched: unlike every fix in this history so far, this looks closer to Tests 1-2's foundational orientation-reliability finding than a threshold or mechanism bug, and may mean the sweep _instruction_ itself needs to change (e.g. deliberately staying in-plane) rather than the completion algorithm. Not chased further without more live data specifically isolating in-plane vs. toward-camera motion.

### Correction and a bigger finding: wrong bone, not a bad orientation

Follow-up from the user corrected an initial misreading: "palm-down" in their report meant palm facing _toward_ a floor-mounted, upward-facing camera — the reliable orientation, not the dorsal one. In that reliable orientation, sweeping the CMC gave an eyeballed real motion of ~15° but a measured max of only ~5° — a roughly 3x undershoot in the _good_ orientation, which the earlier "dorsal degrades tracking" explanation can't account for. The toward-camera inflation finding above still holds independently (confirmed again: "the farther I rotate towards the camera, the higher the max-swept angle becomes").

**Likely root cause, not yet confirmed: the wrong bone.** `fitThumbCmcAxis`, the outer-sweep proxy, `flexionAbduction`, and `twistAngle` all read `hand.limbs.thumb[0]` — the vector from the wrist landmark to the "thumb CMC" landmark — as "the CMC's bone." But that segment sits very close to the CMC joint's own pivot point; the segment that actually sweeps through a visible arc when the CMC flexes or abducts is bone[1] (CMC landmark to MCP landmark), the true first metacarpal, the rigid body that pivots _at_ the CMC rather than sitting proximal to it. If so, bone[0] would show only a small fraction of real CMC rotation regardless of orientation — exactly matching a real, visible ~15° sweep reading as ~5°.

This is a much bigger claim than anything else in this history — it would mean the entire Group 3 implementation, not just its tuning, is keyed off the wrong landmark segment, and could also mean the `degree: 3` joint index chosen in `$lib/hand.ts` (joint 0) needs to move to joint 1. Rather than committing to that rework on reasoning alone, added a cheap, non-invasive diagnostic first: the capture page now tracks a second, parallel max off bone[1] (smoothed the same way, but not wired into the guard or any fit) and shows it side by side with the real bone[0]-based max in the result summary. Next live session should show directly which one actually tracks real motion before any further code changes are made.

### Confirmed by the diagnostic, confirmed by the literature, and fixed: the whole Group 3 implementation was measuring the wrong bone

The diagnostic settled it decisively: **bone[0] max 4.1°, bone[1] max 37.7°** for the same real sweep — not a marginal difference. The user identified the root cause directly: MediaPipe models the wrist as a zero-width single point, and this changes where the thumb's base joint effectively sits in the model.

Researched published literature on this specific limitation before committing to a rework. [MediaPipe Hands: On-device Real-time Hand Tracking](https://arxiv.org/pdf/2006.10214) confirms the wrist landmark's depth is trained only on synthetic data, making it a structurally weak anatomical reference. More directly relevant, [Proof of Concept and Validation of Single-Camera AI-Assisted Live Thumb Motion Capture](https://pmc.ncbi.nlm.nih.gov/articles/PMC12349048/) does almost exactly what this test does and explicitly avoids using the wrist-to-CMC-landmark vector as a pivot reference for the same reason — instead computing the CMC angle between (landmark 1→2, the actual metacarpal, our bone[1]) and (landmark 0→9, wrist to middle-finger MCP, a stable palm-level reference), reporting mean error −2.13 ± 2.81° (ICC 0.97, r=0.974) with that method. The same paper's other finding reinforces this project's own Tests 1-2 orientation theme independently: systematic underestimation of palmar abduction in dorsal view (mean error −8.40 ± 2.81°), attributed to thenar-eminence occlusion and poor depth cues. A second paper ([PMC11540810](https://pmc.ncbi.nlm.nih.gov/articles/PMC11540810/)) found raw MediaPipe-only correlation of just 0.84 for a related thumb angle, needing an ML correction layer to reach 0.99 — consistent with raw landmarks alone not being CMC-accurate without correcting for exactly this reference-point problem.

**What this means for using MediaPipe for thumb motion at all:** the wrist-as-pivot approach has to be abandoned for the CMC specifically (bone[1], not bone[0], is the segment that carries real rotation); ~2-3° of angular error should be expected as a realistic floor even with the corrected method, not near-zero (acceptable for keyboard key placement, where that translates to a small fraction of the physical tolerance a printed shell already has); and palm-facing (not dorsal) orientation matters even more than previously established, now with a concrete literature error number attached to violating it.

**Fixed:** `fitThumbCmcAxis`, the outer-sweep proxy, `flexionAbduction`, and `twistAngle` all shifted from bone[0]/bone[1] to bone[1]/bone[2] — the CMC's rotation is now read off the metacarpal (bone[1]) instead of the wrist-adjacent stub (bone[0]), and twist is measured on the next segment out (bone[2]) about the metacarpal's own axis instead of bone[1] about bone[0]. `$lib/hand.ts`'s `ConjunctCoupling` doc comment updated to note the `degree: 3` joint conceptually belongs at `joints.thumb[1]`, not `joints.thumb[0]` — `joints.thumb[0]` should stay `degree: 0` (fixed), the same convention every other finger's metacarpal already uses. `fkBy`/`fromLimbs` themselves needed no changes (the `degree === 3` handling was already index-agnostic). `minPlausibleMax` reset to 15° as a conservative starting floor on the corrected signal (bone[1] read ~38° for motion that eyeballed at ~15-20°, so 15 leaves real headroom without being a guess pulled from nowhere). Removed the now-resolved bone0-vs-bone1 diagnostic scaffolding from the capture page.

116/116 tests pass (`thumbCmc.test.ts`'s synthetic fixture shifted its encoding from limb indices 0/1 to 1/2 to match), `npm run check` clean. Not yet re-verified live on the corrected bone — the diagnostic proved bone[1] carries real signal, but the full pipeline (axis fit quality, conjunctCoupling stability, growth-guard behavior) needs its own live confirmation now that it's reading the right segment.

### Bone[1] confirmed working (3 sessions converged at 30.8-38.8° swept, matching the ~15-20° eyeballed range now that bone[1] isn't undershooting) — but a new, deeper confound found live

A deliberate negative control: a rigid elbow/forearm rotation with the thumb not flexing relative to the palm at all still read as ~50° of "sweep." `hand.basis` (rebuilt every frame from a few landmarks, meant to express bone vectors in a hand-relative frame independent of whole-arm orientation) is itself estimated from landmarks with the same weak monocular depth estimate as everything else in this test suite — so whole-arm rotation, which changes those landmarks' depth/foreshortening, can leak into the basis estimate and from there into every basis-transformed limb vector, including the metacarpal this test now depends on. Not fixable by bone choice or a threshold — it's upstream of both, the same depth-estimation root cause as the toward-camera finding, now shown to also masquerade as CMC motion via imperfect whole-hand orientation cancellation, not just via direct thumb-toward-camera rotation.

Also notable: `axisConfidence` dropped sharply on the corrected bone (3.48-3.81, down from the wrong-bone sessions' 7-43 range) — plausibly a more honest number now that real 2-axis CMC motion (which shouldn't look single-axis-clean to a PCA fit) is actually being captured, rather than a spuriously "clean" signal from a segment that barely moved.

**Primary mitigation recommended: physical, not algorithmic** — brace the forearm/elbow against a fixed surface for the whole outer sweep, preventing whole-arm rotation mechanically rather than needing to detect it after the fact. **Added as a complementary live diagnostic** (not wired into the guard): the capture page now tracks palm/forearm orientation change from the start reference via `handOrientation()` (already exposed on `$lib/hand.ts`, quaternion-based, averaged over the same 5-frame start window the metacarpal reference uses), shown live during recording (amber warning past 5°) and in the result summary, so a session can be checked afterward for whether its "sweep" was contaminated by whole-arm rotation rather than trusting the number blindly.

116/116 tests pass, `npm run check` clean (diagnostic-only addition, no changes to any fitting/completion logic). Not yet clear how much of the bracing recommendation alone resolves this, or whether the diagnostic needs to become an actual filter — next real session should show both numbers together.

---

## 2026-09-02 — Root cause of the whole-arm-rotation confound found: `$lib/hand.ts`'s canonical palm basis is built partly from a thumb landmark

### The finding

Discussion while reviewing the MediaPipe landmark model raised a question: is landmark 1 ("thumb CMC") actually independent of the wrist, or effectively part of it? Checked against `$lib/hand.ts`'s actual `makeBasis()` (the function that produces `hand.basis`, the canonical palm-relative reference frame every finger's — not just the thumb's — bone vectors are expressed in):

```js
const up = vectors[9] - vectors[0]     // wrist -> middle-finger MCP
const left = vectors[17] - vectors[1]  // thumb CMC -> pinky MCP  (Gram-Schmidt'd against `up`)
const x = up × left                    // the palm normal
```

This uses landmark **1** (thumb CMC) as one endpoint of the "left" reference vector. That's a circularity: the reference frame the thumb's motion is measured _against_ is partly built _from_ a thumb landmark. Noticed independently that `orientation.ts`'s `palmAngleDeg()` (used only for the scan-tests orientation classifier, unrelated to the canonical basis) already uses a different, landmark-1-free formula: `cross(landmark5 - landmark0, landmark17 - landmark0)` — the two conventions in this codebase have never agreed with each other.

First hypothesis (now retracted): maybe landmark 1 is close enough to anatomically fixed relative to the wrist that its apparent motion is mostly noise, not real signal — in which case averaging it with landmark 0 (cheap, ~free) would give a steadier anchor without meaningfully diluting thumb-independence. Circumstantial support existed: bone[0] (landmark0→landmark1 direction) topped out at only ~4-5° during real CMC sweeps that hit ~30-38° on bone[1], suggesting landmark 1 barely moves _directionally_ relative to landmark 0.

**Retracted by further live testing on `thumb-cmc`:** the user found joint 1 and joint 2 (i.e. landmark 1's own position and bone[1]'s resulting direction) show real, meaningful correlation with genuine thumb movement — landmark 1 is not anatomically inert the way the bone[0]-angle result suggested. (The earlier bone[0] angle result was measuring _directional_ change specifically, which can stay small even while the landmark's position itself moves in ways correlated with real thumb motion — a narrower measurement than "is this landmark independent of the thumb," and apparently not narrow enough to rule out the correlation.) **Decision: landmark 1 must be excluded from the palm plane definition entirely, not diluted via averaging. The palm plane is defined by `[0, 5, 17]`** — wrist, index MCP, pinky MCP — matching `orientation.ts`'s existing (separate) formula. This also resolves the two-conventions inconsistency noted above by adopting the landmark-1-free one codebase-wide.

### Implementation notes for next session — this is a broadly-breaking change, not a page-local one

**What needs to change:** `makeBasis()` in `$lib/hand.ts` (currently ~line 137, the function `makeHand()` calls to build `hand.basis`). New formula, two vectors from a common origin (landmark 0) instead of the current mixed-origin pair:

```js
const v1 = vectors[5] - vectors[0]   // wrist -> index MCP
const v2 = vectors[17] - vectors[0]  // wrist -> pinky MCP
const x = v1 × v2 (or v2 × v1)       // palm normal -- verify sign/order against the existing `reverse` (Left/Right) chirality convention
// derive up/left via the same Gram-Schmidt approach the current code uses, seeded from v1 or v2
```

Keep the function signature (`makeBasis(vectors, reverse)`) unchanged so the `makeHand()` call site doesn't need to change. The exact sign/handedness convention (which vector to cross in which order, whether `reverse` still negates the same term) needs to be re-derived and verified against real Left/Right captures — don't assume the old code's exact sign choices transfer; this project's own established practice all session has been "live-verify signs, don't guess" (see `thumbDepthSign`, `signedJointAngle`'s doc comments).

**Blast radius — this touches the coordinate convention for the entire app, not just thumb-CMC:**

- `hand.basis` and everything derived from it (`hand.limbs` for _every_ finger, `handOrientation()`) shifts for every consumer: `/beta`'s hand-fit view, `viewer3dHelpers.ts`, `handoptim.ts`, `/scan`, `/scan2`, and every `scan-tests` page (`static-hold`, `flexion-sweep`, `paired-sweep`, `completion-detectors`, `thumb-cmc`).
- **Not affected, no changes needed:** `orientation.ts`'s `palmAngleDeg()`/`thumbDepthSign()` — both already operate on raw (non-basis) landmark vectors directly, and already use the landmark-1-free convention this change adopts.
- **Side benefit:** `signedJointAngle`'s knuckle-axis (built from landmarks 5, 17) becomes internally consistent with the new palm-plane definition — both now derive from the same two non-thumb landmarks, where before they used different landmark sets entirely.
- **Every previously-logged numeric finding in this doc (Tests 1-2's noise floors, Test 3's bone-proportion agreement, Test 8's DIP/PIP coupling, Test 9's enslaving coefficients, every Group 3 number) was computed under the old basis convention.** Expect small shifts in exact values once this changes, not necessarily in qualitative conclusions — this is an expected, acknowledged side effect of fixing a foundational coordinate convention, not a regression to chase down number-by-number. Re-running everything isn't necessary, but a sanity check on 1-2 already-validated tests (e.g. Test 8's DIP/PIP numbers, which have the most reps behind them) after the change would catch anything that shifted more than expected.

**Suggested implementation/verification plan:**

1. Rewrite `makeBasis()` as above.
2. Add a unit test (synthetic Left/Right hand vectors) verifying the new basis is a valid orthonormal frame and preserves correct chirality for both handedness values — same pattern already used elsewhere in `hand.test.ts` this session.
3. Run `npm run check` + `bun test` (full suite) to catch anything that broke.
4. Re-run the `thumb-cmc` page's negative control (rigid elbow/forearm rotation, thumb not flexing) that originally exposed this — the palm-rotation diagnostic and bone[1] sweep number should both show less contamination than the ~50° "sweep" and large palm-rotation reading from before, since the reference frame no longer has a channel for thumb motion to leak through. This is the direct test of whether the fix worked, separate from (and complementary to) the physical-bracing mitigation already recommended.
5. Treat this as its own isolated change (commit/review separately from thumb-CMC-specific work), given the blast radius.

Not implemented yet — documented for the next session, per the user's own note that they're out of time.

---

## 2026-09-02 — `makeBasis()` fix implemented; palm-tilt leveling UI built, then found and fixed pointing 180° backwards

### The landmark-1 basis fix, implemented

`makeBasis()` in `$lib/hand.ts` was rewritten per the previous entry's plan: the palm plane is now defined by landmarks `[0, 5, 17]` (wrist, index MCP, pinky MCP) instead of `[0, 1, 17]` (wrist, thumb CMC landmark, pinky MCP), removing the circularity where the frame a thumb's motion is measured _against_ was partly built from a thumb landmark. `hand.test.ts` gained two new cases (basis is a valid orthonormal, proper-rotation frame for both handedness values; independent of landmark 1 — perturbing it produces an identical basis). 118/118 tests pass, `npm run check` clean. Not yet re-verified against the `thumb-cmc` negative control from the previous entry (rigid forearm rotation) — superseded by the larger finding below before that re-test happened.

### Bubble/crosshair leveling UI built for `thumb-cmc`

Added `orientation.ts`'s `palmTilt()` (palm normal's transverse `x`/`y` components plus `z` and `totalDeg`, all off one `palmNormal()` call) and `PalmBubble.svelte` (a bubble-level widget: dot offset by tilt direction/magnitude, green within a threshold, red beyond) as a live overlay on `thumb-cmc`'s video feed — meant to give positioning feedback for bracing the palm level, not just a bare angle number. A calibration flow was added on top (`palmTilt(hand, reference)`, re-zeroing against a sampled true-level pose via a "Calibrate level" button that averages `CALIBRATION_FRAMES` confidence-gated samples) after live testing found a consistent ~10° baseline offset at true physical level — a real, repeatable bias worth calibrating out per-session rather than guessing a constant into the model.

### Live testing found the bubble direction unreliable — and it led to discovering the underlying normal computation is broken

Live sweeps (thumb rotating toward/away from the camera, wrist flexion/extension) found the bubble stayed in roughly the same quadrant regardless of direction — reliable in magnitude (`totalDeg` behaved sensibly) but not showing any directional signal for reversed motion. Diagnosed in stages, each ruling out one hypothesis before moving to the next (consistent with this whole doc's practice of live-verifying rather than guessing):

1. **Added `drawPalmNormalOverlay`** (`overlay.ts`) — draws the palm normal as an arrow on the video feed itself, rooted at landmark 0, colored by `sign(z)`. Rationale: the arrow's on-screen _position_ can't show front/back (a normal tilted one way facing the camera projects identically to the mirror-image tilt facing away — that's inherent to projecting 3D onto 2D), so sign has to be carried by color instead.
2. **Added `drawVectorSpaceTriangle`** — an inset showing the `[0,5,17]` triangle purely from `hand.vectors`'s x/y, to check whether `hand.vectors` (built from MediaPipe's _world_ landmarks) shares the same left/right convention as the 2D `keypoints` the on-screen skeleton is drawn from. **Result: they matched** — ruled out a coordinate-frame/mirroring bug between world landmarks and image landmarks. (Every finding validated earlier in this doc — bone lengths, joint angles via `angleTo()` — is a magnitude or relative angle, invariant to a uniform mirror flip; this was the first test to draw an _absolute_ direction against the real image, so the first place such a bug could have surfaced at all.)
3. **Added `drawVectorSpaceTopView`** — a companion inset projecting `(x, z)` (top-down) instead of `(x, y)` (front-on), since a front view discards exactly the depth information the normal's sign depends on. **Result: the arrow never crossed either axis** — it changed magnitude but not direction regardless of which way the hand was actually rotated (thumb toward vs. away, wrist flexion vs. extension). Rooting the arrow at landmark 0 instead of the `[0,5,17]` centroid (per a follow-up request) didn't change this — expected, since `v1 × v2` is rotation-covariant and where you _draw_ it from doesn't change what direction it points.
4. **Tried an alternate signal, `palmWindingSign`** — 2D shoelace/signed-area of the knuckle polygon (`[0,5,9,13,17]`) in raw image space, deliberately avoiding landmark Z entirely (MediaPipe's weakest axis) in favor of its strongest (2D layout). **No improvement** — reverted (removed from `orientation.ts` and the page) rather than left in as dead weight.
5. **Built `fingerCurlAgreesWithNormal`** instead — an anatomy-grounded independent check rather than another geometric projection of the same landmarks: a flexed middle or ring finger curls toward the palm's front, the same side the normal should point out of, so `(finger bend direction) · (palm normal)` should be positive whenever those fingers are genuinely flexed. Computed from raw `hand.vectors` (not `hand.limbs`, which is expressed in `hand.basis`'s frame — using it would risk silently inheriting the same uncertainty being investigated rather than giving an independent read) and gated on real MCP flexion via `signedJointAngle` (≥15° both fingers by default; returns `undefined` below that rather than a misleading value). `signedJointAngle` itself stays reliable regardless of the normal's sign question — it's a relative angle between two vectors sharing one transformation, and both the angle and its sign are invariant to whatever proper rotation that shared transformation happens to apply.

**Result: `fingerCurlAgreesWithNormal` confirmed the normal genuinely tracks real rotation** (agree/disagree flipped correctly with real motion) **but is uniformly offset by 180°** — it points out the back of the wrist instead of out of the palm, consistently, not an unstable/noisy flip. This reframed the whole investigation: not a tracking-quality or noise problem (which the earlier sessions' Z-axis-noise findings had made the leading hypothesis), but a fixed sign error.

### First fix attempt — a blanket 180° flip — tried, then retracted

Added `correctedTilt()`/`correctedCurlCheck()` wrapper functions in `thumb-cmc/+page.svelte` that negated `palmTilt()`'s `x`/`y`/`z` and took the supplementary angle (`180 - totalDeg`), scoped to the page rather than editing `palmNormal()`/`palmTilt()` in `orientation.ts` directly (those shared functions are relied on by `static-hold`/`flexion-sweep`/`paired-sweep`/`completion-detectors`, and Tests 1–2 validated the _un-flipped_ convention under a different physical camera setup — desk-facing webcam vs. this rig's floor-mounted, camera-facing-up one — see the 2026-09-01 "palm-down" correction entry). Visually confirmed correct at the moment of testing.

**Retracted the same session, on a direct correctness challenge:** a "palm normal" whose sign depends on which rig it's run on isn't a coherently-named thing — pushed on whether the flip should really be universal. Checked `static-hold`, using the exact same _unflipped_ `palmAngleDeg`/`palmNormal` formula, on this same rig, at a genuine static palm-facing pose (not a sweep): it read **~10–15°**, correct, not backwards. That rules out "this rig is globally backwards" — and it means the blanket flip was wrong too: applied to `thumb-cmc`, it would make the _rest_ reading wrong (~165–170°) to fix a symptom that only appeared mid-sweep. Removed `correctedTilt()`/`correctedCurlCheck()` entirely; `thumb-cmc` is back to calling `palmTilt()`/`fingerCurlAgreesWithNormal()` directly, unflipped.

There's also a physical argument against camera-mounting-orientation being the culprit: rotating the whole camera (floor-up vs. desk-forward) rotates everything relative to the camera's own optical axis, and a rotation can't by itself turn a correct front/back determination backwards — that needs an actual reflection somewhere, not a change of mounting angle.

**Revised understanding: correct at rest, wrong somewhere mid-sweep — not a constant offset.** Leading hypothesis: MediaPipe's handedness classification (Left/Right) is a separate, imperfect prediction from landmark tracking, and `palmNormal()` negates based on it (`if (hand.handedness === 'Right') normal.negate()`). A brief misclassification during a hard, self-occluding rotation (exactly what this sweep produces) would flip the normal for exactly those frames while leaving rest — and easier poses — correct, matching everything observed so far.

**Added a live handedness diagnostic to test this directly**, rather than fixing on reasoning alone (same practice as everything else in this doc): `thumb-cmc` now tracks `currentHandedness` and a `handednessFlipCount` — since the page only reads `hands[handedness]` (keyed by MediaPipe's own reported label, so a hand object accessed this way can never appear to hold the "wrong" label), a misclassification instead shows up as the selected hand _vanishing_ for a frame while the _opposite_ label's slot is populated with a hand that frame. That specific event — the same physical hand relabeled — increments the flip counter and is shown live (`handedness: ... (selected ...) -- flipped Nx!`) and logged in both result summaries. Not yet run live against the exact sweep that showed the backwards arrow.

118/118 tests pass, `npm run check` clean throughout this back-and-forth.

### Still open

- **Does handedness actually flip during the problematic rotations?** The diagnostic above is built but not yet tested against a real sweep. If `handednessFlipCount` climbs exactly when the arrow points backwards, that confirms the mechanism and the real fix is either upstream (encourage/force detector stability, e.g. don't let a single misclassified frame override a recently-stable label) or downstream (smooth/hold `handedness` across a short window rather than trusting every frame's raw classification). If it _doesn't_ flip, the mechanism is still open and needs a fresh hypothesis.
- **Does `$lib/hand.ts`'s `makeBasis()` have an analogous problem?** Still unresolved from the previous entry — it uses the identical `v1 × v2` cross product this whole investigation has been chasing, and it's the production kinematics engine, not a diagnostic. Whatever the real mechanism turns out to be here (handedness misclassification or otherwise) should be checked against `makeBasis()` too before trusting `hand.basis` through large rotations.
- The `~10°` baseline-offset calibration and the palm-tilt bubble are unaffected by this back-and-forth (both were already correct at rest) — still worth a fresh live pass through a full sweep once the handedness question is settled, to confirm the bubble gives directionally correct feedback throughout, not just at rest.

Thumb-CMC's original goal (Tests 10/11 — axis fit, conjunct coupling, occlusion guard) is still on hold until the orientation readout is trustworthy through a full sweep, not just at rest.

### `palmNormal()` renamed to `handPlaneNormal()`

Live confirmation that `handednessFlipCount` climbs with real movement (see above) settled the mechanism question, but raised a naming one: "palm normal" asserts a reliable anatomical direction, and this quantity doesn't have one — it's correct at rest and wrong often enough during real motion that the name overpromises. Renamed `palmNormal()` → `handPlaneNormal()` throughout `orientation.ts`/`overlay.ts`/`thumb-cmc` (`palmTilt()`, `fingerCurlAgreesWithNormal()`, `drawPalmNormalOverlay`/`drawVectorSpaceTriangle`/`drawVectorSpaceTopView`'s doc comments) — it's still the same `[0,5,17]`-plane cross product, just named for what it verifiably is (a plane normal) rather than what it isn't yet proven to reliably be (specifically the palm side of that plane). `palmTilt`/`PalmTilt`/`palmAngleDeg` keep their names for now — `palmAngleDeg`'s `palm-facing`/`palm-away` labeling is the one piece with real validation behind it (Test 2's noise-pattern result, and this rig's own static-hold spot check), just not through fast/large rotations. 118/118 tests, `npm run check` clean.

### `hand.score` is MediaPipe's handedness-classification confidence, not a landmark-quality score — needs testing

Asked whether handedness misclassification is inherent to the MediaPipe Hands model. Checked `@mediapipe/hands`'s own type definitions rather than answering from memory:

```ts
export interface Handedness {
  index: number
  /** Confidence score between 0..1. */
  score: number
  /** Identifies which hand is detected at this index. */
  label: 'Right' | 'Left'
}
```

`Handedness.score` is explicitly documented as confidence in the **Left/Right label**, not landmark position quality — and this codebase's `hand.score` (`detector.ts`: `score: handednessList[i].score`) is exactly that field. **Every confidence gate in this whole test suite (`score >= 0.7` throughout Tests 1–9 and every capture page) has been gating on handedness-classification confidence, not landmark-tracking quality** — two conceptually different things that happen to share one field in the API. This is architectural, not a bug: MediaPipe Hands classifies handedness fresh per frame from the cropped hand image's appearance, with no temporal smoothing/tracking across frames in the base solution, and Left/Right hands are mirror images of each other — the only signal that distinguishes them in a single 2D image is subtle appearance detail (thumb side, finger ordering, palm curvature) that genuinely degrades or vanishes at hard viewing angles (self-occlusion, edge-on rotation — exactly what this sweep produces). The `score` field's existence is MediaPipe's own acknowledgment that this classification is sometimes uncertain.

**NEEDS TESTING, not yet done:** whether `hand.score` dips right before/during the frames `handednessFlipCount` counts. If MediaPipe's own confidence already flags an impending misclassification, `score` is a usable early-warning signal — raising the gate, or holding the handedness label through a brief low-confidence dip (the same "average a short buffer, don't trust one frame" pattern used throughout this doc, e.g. `thumb-cmc`'s start reference, Test 6's window-vs-threshold finding), could stabilize it cheaply. If `score` _doesn't_ dip beforehand, the misclassification is closer to random/unpredictable from this signal alone, and a different mitigation is needed (e.g. hysteresis purely on the label itself, ignoring its own score).

---

## 2026-09-03 — `hand.score` answered: doesn't predict misclassification, stays in the 90s even when tracking is visibly bad

Answered by live observation (`hand.score` surfaced next to the palm-tilt bubble in `thumb-cmc`, moved to just above the result summary): the score sits in the 90s even during frames where tracking is clearly going wrong — it does not dip ahead of, or during, the problems it would need to predict. Closes the "NEEDS TESTING" item above in the negative: `score` is not a usable early-warning signal for handedness flips (or apparently for tracking quality generally) on this rig.

**Consequence for the plan below:** step 1 ("test whether `hand.score` predicts flips") is done, and the answer rules out the score-informed branch of step 2. The stabilization mechanism has to be a hold/hysteresis purely on the classified label itself, blind to its own confidence value, not a threshold tuned against `score`.

---

## 2026-09-03 — Palm-tilt bubble's "random per-session offset" traced to a wiring bug, not a measurement limitation

Reported symptom: the palm-tilt bubble starts each recording offset from true level by a different, unpredictable amount, then holds that offset steady for the whole run rather than drifting further.

Checked whether any known technique gets an absolute "level" reference from a single RGB camera with no IMU/gravity input — there isn't one; every monocular hand-tracking system that needs an absolute orientation reference self-calibrates against an assumed neutral/rest pose at the start of a session, the same "average a short buffer, don't trust one frame" pattern this doc already uses elsewhere (`startMetacarpal`/`startOrientation` in `thumb-cmc`).

That mechanism already existed here too — `calibrationReference`, averaged from 15 score-gated `handPlaneNormal()` samples — but it was wired to a manual "Calibrate level" button (`startCalibration()`) that `start()` never invoked. `start()` already resets `startMetacarpal`/`startOrientation` for a fresh per-recording reference, but left `calibrationReference` untouched, so unless the button was pressed before every single recording, `palmTilt()` silently fell back to the raw camera-forward-relative reading for the entire run — an offset equal to however far that session's actual starting pose happened to sit from the camera's optical axis, which varies session to session with hand placement/rig setup and stays constant through the run because nothing re-anchors it. Matches the reported symptom exactly.

**First fix (superseded below):** `start()` set `calibrating = true` itself, reusing the manual button's averaging code path, so leveling ran unconditionally the instant Start was clicked.

**Superseded by an explicit pre-recording pipeline**, prompted by a real workflow requirement: pressing Start with the mouse using the same hand that then has to move into frame, meaning the target hand often isn't in view yet at the moment Start is clicked — auto-leveling immediately would average garbage/absent-hand frames instead of the real starting pose. `thumb-cmc`'s `Phase` type gained three states ahead of `recording`: `waiting-for-hand` (until anything is detected), `settling` (10 consecutive score-gated frames, so the detector's first, least-stable lock isn't what gets leveled against), `leveling` (the same ~15-frame calibration average as before), then `recording`. Each phase is shown live as a colored badge overlaid directly on the video feed, not just in the text summary. `recordingStartElapsed` was added so `sessionDuration`'s auto-stop timer starts counting at the moment `recording` actually begins, not at Start — otherwise time spent getting the hand into frame would eat into the capture budget. Losing the hand mid-`settling`/`leveling` (stale for >1s) drops back to `waiting-for-hand` rather than carrying a broken streak forward. The manual "Calibrate level" button still works mid-recording, unchanged, for an explicit re-calibration against a deliberately-held truer level pose. `npm run check` clean. Not yet re-verified live — next `thumb-cmc` run should show the badge progressing through all four states and the bubble settling near center once recording actually starts, using whatever pose the hand happened to be in once it arrived and steadied, not the pose it was in the instant Start was clicked.

---

## 2026-09-03 — Rotation-vs-flexion negative control re-run post-`makeBasis()` fix: still conflated

Re-ran the rigid-forearm-rotation negative control (thumb held still, hand/wrist rotated) against the current code, post the 2026-09-02 landmark-1 `makeBasis()` fix. Answer: **max-swept still climbs from pure hand rotation alone** — the conflation is not resolved by that fix.

This is worth being precise about, since it clarifies what the earlier fix actually did. `hand.limbs.thumb[1]` is already expressed relative to `hand.basis` — in principle a perfect basis should cancel whole-arm rotation on its own, since the thumb bone's direction _relative to the hand_ shouldn't change under a rigid whole-arm rotation. That it still does means `hand.basis` itself drifts under rotation, most likely from monocular depth noise in the landmarks (`0`, `5`, `17`) that define it, worsening with rotation magnitude (more foreshortening off-axis). The landmark-1 fix addressed a different, unrelated bug (the backwards-normal circularity, where a thumb landmark helped define the frame the thumb's own motion was measured against) — it was never expected to fix this, and didn't.

**Consequence:** the handedness-flip-stabilization item in the standing plan above is no longer the most direct prerequisite for this specific problem — a stable label wouldn't fix a magnitude/precision issue in the basis fit, only a sign error. It's still worth doing for its own sake (the arrow-points-backwards problem is real and separate), but isn't blocking the rotation/flexion separation work specifically.

### Built: in-page rotation-vs-flexion analysis table, replacing a file-export/offline-script plan

Original plan was a JSON export button plus an offline Bun analysis script (following `scan_tests/analyze-static-hold.ts`'s established pattern of dumping raw per-frame `keypoints`/`keypoints3D` and recomputing via `$lib/hand.ts` afterward). **Changed on request**: the user wants to read/paste the analysis directly from the page rather than round-tripping a file, so the computation moved in-browser instead — `computeRotationAnalysis()` in `thumb-cmc/+page.svelte`, producing a selectable CSV block (`t, score, palmRotationDeg, rawBoneAngleDeg, basisRelativeAngleDeg`) shown under a new "Rotation-vs-flexion analysis" section once a run stops, alongside the existing "Result summary" panel. `outerElapsed` (parallel array to `outerHistory`) was added to give each frame a real timestamp for this, since `outerHistory` alone didn't retain one.

Two of the three originally-planned columns turned out to be one: an "explicit correction, subtract the measured whole-hand rotation from the raw bone vector" column was dropped before being built, because `handOrientation()` is derived from the exact same per-frame basis fit as `hand.limbs` already is — applying it by hand to "correct" the raw vector reproduces `basisRelativeAngleDeg` exactly, not a different number. A genuinely different correction would need a _different_ orientation estimate than the current single-frame 3-point fit — e.g. a temporally-smoothed one — which is a real next experiment, not yet built.

`npm run check` clean. Not yet used for real analysis — next step is running the rigid-rotation negative control (and a real sweep) through this table and reading the actual numbers, rather than the yes/no answer already established above.

### Negative control run through the table: quantified, not just yes/no

1528-frame rigid-rotation run (thumb held still, hand/wrist rotated through ~83° of palm rotation) analyzed offline from the pasted CSV. Confirms the conflation, but the shape is more specific and more useful than a flat yes/no:

- `rawBoneAngleDeg` (uncorrected) tracks `palmRotationDeg` almost 1:1 (slope 0.71, r=0.89) -- the expected full contamination with no correction applied.
- `basisRelativeAngleDeg` (the actual `hand.limbs.thumb[1]` production signal) reaches **33°** at points despite zero real thumb motion -- comparable to a real CMC's ROM (~40-60°) and well above the growth-guard's `minPlausibleMax` floor (15°). This rigid-rotation-only run could have spuriously "converged" as a fake CMC sweep.
- The basis correction is doing real, partial work, not nothing: it cuts the raw leak substantially (raw hits 68° at peak palm rotation; basis only 7.8° at that same instant), and its rank correlation with palm rotation (Spearman 0.37) is much weaker than raw's (0.87). But binned by `palmRotationDeg`, the residual doesn't scale cleanly with angle -- mean sits anywhere from 7-21° with no consistent trend, more like a noise floor than a proportional leak.
- Two things predict how bad the residual gets: rotation _speed_ (`|palm rotation velocity|` correlates 0.31 with the residual -- faster whole-hand rotation leaks more, matching the existing toward-camera/motion-blur pattern), and `hand.score` (correlates **-0.73**, much stronger) -- the opposite of the earlier handedness-flip finding (score didn't predict that), but for _this_ failure mode, confidence is a real predictor.
- Confidence-gating alone doesn't fully solve it though: restricting to `score >= 0.97` frames during `palmRotation > 40°` still leaves the residual averaging ~10.5° (max 18.5°). At `score >= 0.97` AND `palmRotation < 10°` (both conditions satisfied), residual drops to ~3.1° mean (max 8.3°) -- small relative to real CMC ROM, i.e. a plausible noise floor to design around.

**Conclusion:** not a simple proportional-subtraction problem, and confidence-gating alone isn't enough to trust the corrected signal through a large rotation. Backs up physical bracing as the most robust mitigation for the magnitude this residual can reach.

### Pivot: bounded hand-plane rotation per scan-procedure step, no external bracing

User's response to the above: rather than chase an algorithmic correction or require external bracing hardware, `capture-protocol.md` can be designed so **every step keeps hand-plane-normal movement bounded** (self-discipline during capture, not a brace) -- i.e. each phase's instructions include "keep the palm steady" as a first-class constraint, with the existing live rotation readout as real-time feedback, rather than trying to separate rotation from flexion after the fact.

The tooling already supports testing this directly, no new code needed: `thumb-cmc`'s outer sweep already shows `displayedPalmRotation` live (amber past 5°) during recording, and the new rotation-vs-flexion analysis table (above) gives a full post-hoc readout to check afterward. Based on the negative-control numbers just established, **~10° looks like a reasonable target bound** to consciously hold `palmRotationDeg` under during a real thumb-flexion sweep -- inside that range (and at reasonable confidence) the residual noise floor measured above was only ~3-8°, small relative to real CMC ROM.

**Next test:** a real thumb-flexion sweep, consciously trying to keep the hand plane steady (watching the live amber warning), analyzed the same way. This checks two things at once: whether a person can actually hold rotation under ~10° for the duration of a sweep without external bracing, and whether `basisRelativeAngleDeg` under that condition tracks real thumb motion cleanly.

---

## 2026-09-04 — Landmark denoising (despike + One Euro filter) and a scoping decision that incidentally fixes the handedness-flip problem

### The problem

Real capture motion for this scanning procedure is slow and full-range-of-motion (unlike, say, a fast gesture), but the live keypoint overlay visibly "danced" -- roughly tracking real motion but jittering on top of it. Slow, deliberate motion is the favorable case for aggressive smoothing: there's little genuine high-frequency signal to lose, so heavy denoising costs little lag.

### Design

Chose the **1€ (One Euro) filter** (Casiez, Roussel, Vogel 2012) over a fixed-window moving average: its cutoff adapts to estimated speed, so it smooths hard while a landmark is nearly still and loosens automatically during genuine fast motion, rather than trading a single fixed amount of lag for smoothing everywhere. Preceded by a **median-of-3 despike** per coordinate, so a lone bad frame (this doc's found several of these already -- Test 6's velocity-threshold miscalibration, Test 7's peak-hysteresis miscalibration, the thumb-CMC ROM byproduct's 100°+ spans) gets outvoted by its neighbors instead of corrupting a running min/max or feeding into the One Euro filter's own state.

No existing dependency provided this (checked `package.json` -- nothing signal-processing-related) and the whole thing is small (~30 lines for One Euro, ~15 for despike), so it's hand-written rather than a new dependency, per this project's "prefer reusing what's there" convention.

**Implemented at `src/routes/scan-tests/lib/landmarkFilter.ts`** (+ `landmarkFilter.test.ts`, 6 cases, synthetic-only per this doc's established verify-before-live pattern): `OneEuroFilter` (single scalar, real elapsed-time `dt` rather than an assumed fixed frame rate) and `LandmarkFilter` (despike + One Euro per landmark, per coordinate). A gap since a landmark's last update longer than `maxGapSeconds` resets that landmark's despike/One-Euro state entirely, rather than filtering a resumed signal against stale pre-gap history -- same "reset rather than fight a gap" pattern as `detector.reset()` after a stall.

**Wired into `detector.ts`, upstream of `makeHand()`** -- two independent `LandmarkFilter` instances (`keypoints`, the 2D image-normalized set; `keypoints3D`, the 3D world-landmark set), applied to MediaPipe's raw output before anything else touches it. This means every consumer (the overlay, bone vectors, joint angles, orientation) sees one filtered signal instead of each capture page inventing its own page-local smoother over some derived value -- confirmed by tracing `Hand.hand`/`Hand.vectors`/`Hand.limbs`/`Hand.basis` all the way back to the filtered `keypoints`/`keypoints3D` arrays. `hand.score` (handedness-classification confidence, not landmark quality -- see 2026-09-02 entry) is deliberately left unfiltered; there's no landmark position to despike, and this doc already found `score` doesn't predict tracking-quality problems anyway.

### A design question that changed the architecture: handedness flips vs. per-label filter state

Before implementing, walked through what happens when a per-label filter (one instance per `Left`/`Right`) meets a handedness misclassification (this doc's own well-established finding -- `handednessFlipCount`, 2026-09-02/09-03): a glitched frame's real landmarks would feed the _wrong_ label's filter (which has no real history in a single-hand capture), while the correct label's filter sees a dropout. Worse, the dropout distorts the filter on resume in two specific ways: the despike window compares against samples that are further apart in time than it assumes, and (if `dt` isn't handled carefully) a value that moved a normal amount over a doubled time gap reads as moving twice as fast, loosening the One Euro filter's smoothing right when it should be cautious. Net effect: every handedness flip would produce a localized filter artifact on top of the raw dropout.

**Resolved by scoping, not by patching the filter.** The user agreed to limit scanning to one hand per session. This let handedness classification be removed from the per-frame path entirely rather than stabilized: `detector.ts` now fixes `maxNumHands` to 1 and takes the physical hand to scan as a declared constant for the whole session, instead of reading `hands[handedness]` keyed by MediaPipe's own per-frame Left/Right label. The single detected hand (whatever label MediaPipe assigns it internally) is always treated as the declared hand.

This is a bigger fix than it looks: `handPlaneNormal()`'s sign depends on `hand.handedness`, and the entire 2026-09-02/09-03 investigation (arrow points backwards mid-sweep, `handednessFlipCount` climbing with real movement) traced that specifically to per-frame classification instability. With handedness now a session-level constant instead of a per-frame classifier output, there is no more per-frame label for `handPlaneNormal()` to depend on -- it structurally cannot flip mid-session anymore. The gap/despike interaction above is also moot: with only one hand ever tracked, an ordinary dropout (occlusion, low confidence, hand briefly out of frame) is the only kind of gap left, and `maxGapSeconds` already handles that.

**New responsibility split, per the user's explicit direction:** each scanning-procedure step is now on the hook for identifying its own bad data (occlusion, low confidence, implausible motion) rather than the detector guessing whether a frame is trustworthy. `hand.score` and the existing per-page confidence gates are the mechanism for that; nothing new was added here beyond what already existed.

### Cleanup

Removed from `thumb-cmc/+page.svelte`, now redundant given upstream filtering: the page-local `makeSmoother()` factory and its four instances (`smoothedProxy`, `smoothedMcp`, `smoothedIp`, `smoothedPalmRotationDisplay`), plus the `currentHandedness`/`handednessFlipCount` diagnostic and its `hands[opposite]` check, which can no longer fire now that there's no per-frame label to flip. Stale doc comments referencing the removed smoothers were updated to point at the new upstream filter instead.

### Tuning surface added to `flexion-sweep`

Added live-tunable inputs for `minCutoff`, `beta`, `derivativeCutoff`, and `maxGapSeconds` (alongside the existing handedness/session-duration controls), wired into `createDetector(handedness, filterOptions)` -- `detector.ts`'s constructor and default-export factory both take an optional `LandmarkFilterOptions`, applied identically to both landmark-set filters. `flexion-sweep` is a natural place to tune from: it already runs a slow palm-angle sweep with live confidence/ROM/DIP-PIP readouts to judge the effect against, continuing this doc's "live-tune, don't guess" practice (Tests 6/7's thresholds, the thumb-CMC guard's several parameters) rather than trusting first-principles defaults.

**One caveat surfaced, not yet resolved:** `beta`'s effective strength differs between the two filtered landmark sets, since `speed = Δvalue/Δt` and the two sets are in different units -- `keypoints` is image-normalized (~0-1 range), `keypoints3D` is MediaPipe's world-landmark meters (~±0.1 range). The same `beta` value produces a very different effective speed-response in each, so a beta tuned by eye against the (2D) overlay isn't necessarily well-tuned for the 3D angles the actual measurements come from.

Also added: numeric-display and table refresh throttling on `flexion-sweep`, tied to `1/minCutoff` seconds, so the on-screen numbers (palm angle, thumb depth sign, confidence, the bin/DIP-PIP tables) change at roughly the rate the filter itself considers "real" motion rather than repainting at full frame rate. Underlying capture (which bin a frame lands in, ROM extrema) is computed from the live per-frame value regardless of the display throttle -- only the repaint rate is affected, not what gets recorded.

### Live-tuned defaults

User tuned `minCutoff`/`beta` against real capture on `flexion-sweep` and set new defaults: **`minCutoff: 2 Hz`, `beta: 0.1`** (up from the initial untuned guesses of 0.8/0.02), promoted into `landmarkFilter.ts`'s `DEFAULT_OPTIONS` as the new baseline for every capture page. `derivativeCutoff` (1) and `maxGapSeconds` (0.15s) are untouched from their original starting values.

116/118 -- 124/124 tests pass throughout (`landmarkFilter.test.ts`'s 6 new cases included), `npm run check` clean at every step.

### Still open

- The `minCutoff: 2`/`beta: 0.1` defaults are live-tuned for _visual smoothness_ against the overlay, not yet validated against a quantified re-run of an earlier test (e.g. Test 8's DIP/PIP coupling R² values, or Test 4's axis-fit confidence) to see whether filtering measurably changes those numbers, and if so in which direction. Worth a rerun once there's time, the same way the `makeBasis()` fix's blast-radius note (2026-09-02) flagged for that change.
- The beta-units caveat above (2D vs. 3D landmark sets) is unresolved -- worth checking whether the two filtered signals need independently-tunable beta values rather than one shared value, once there's a concrete case where they visibly disagree.
- Filtering doesn't change any of this doc's still-open findings about _where_ MediaPipe's signal itself is unreliable (dorsal-view noise, wrist-as-CMC-pivot, thumb tracking being the noisiest joint, world-landmark basis drift under whole-arm rotation) -- it only reduces frame-to-frame jitter on top of whatever signal (real or biased) is actually there. The standing plan below is otherwise unaffected except where noted.

---

## Plan: handedness and hand-plane-normal stability, before further thumb-movement work

**Amended 2026-09-04:** item 2 below is superseded for this project's actual scope, not completed as originally framed. Scanning was scoped to one hand per session (see the entry above), which removes per-frame handedness classification from the pipeline entirely rather than stabilizing it -- `detector.ts` now assigns a session-declared handedness unconditionally instead of reading MediaPipe's per-frame label. This resolves the practical problem (handPlaneNormal() can no longer flip mid-session) without building the hold/hysteresis mechanism item 2 describes. That mechanism would still be needed if this project ever supports tracking two hands in one session -- not currently planned. Items 3-5 (re-check handPlaneNormal, fall back to fingerCurlAgreesWithNormal if needed, then resume Tests 10/11) still apply and are unaffected by this amendment.

Standing back from the play-by-play above: this session's real finding isn't "the normal was backwards," it's that **this whole test suite has been building on MediaPipe Hands outputs — handedness, world-landmark depth, the wrist-as-pivot assumption already retracted in Group 3 — without first mapping out where each one is actually reliable.** Each limitation so far has been discovered by accident, mid-test, after work was already built on top of the assumption it would hold (the landmark-1 basis circularity, the wrong-bone CMC pivot, now handedness stability). The user's stated goal going forward: build the real hand-scanning process and UI with these limitations known and accounted for up front, so `capture-protocol.md` can carry an actual estimate of scan error instead of discovering each failure mode after the fact.

Concretely, before resuming Tests 10/11 (thumb-CMC axis fit, conjunct coupling, occlusion guard) or any further refinement of the thumb movement model:

1. ~~Test whether `hand.score` predicts handedness flips.~~ **Answered 2026-09-03: no** — `score` stays in the 90s even when tracking is visibly bad, no observed dip around flips. Not a usable early-warning signal.
2. **Build and live-tune a handedness-stabilization mechanism**, blind to `hand.score` per (1) — a short hold/hysteresis purely on the classified label itself (same category of fix as Test 6's still-window and Test 7's peak hysteresis: separate noise-rejection from the raw per-frame signal, don't trust any single frame). Verify it against synthetic data first, then live, per this doc's established pattern.
3. **Re-run the `handPlaneNormal` sweep test** (thumb toward/away, wrist flexion/extension, with the arrow/insets already built in `thumb-cmc`) with handedness stabilized, to check whether that alone fixes the sign, or whether a residual issue remains once handedness is no longer a confound.
4. **If `handPlaneNormal` still isn't reliable after (3)**, `fingerCurlAgreesWithNormal` (or a similar anatomy-grounded check, generalized beyond middle/ring-finger flexion) becomes the load-bearing signal for "which side is the palm on," not a diagnostic on the side — and `capture-protocol.md`'s design should account for that rather than assuming a clean geometric normal is always available.
5. **Only then**, resume Tests 10/11 and further thumb-CMC/thumb-movement modeling — on a foundation where handedness and orientation-sign are known-stable (or their actual failure rate is known and designed around), not assumed.

Broader, standing item for `capture-protocol.md`/`scan3` design work: consolidate every MediaPipe-limitation finding from this whole doc (dorsal-view noise ~2x, depth/Z axis weakest, wrist-as-CMC-pivot invalid, thumb tracking noisiest overall, handedness classification unstable at hard angles, world-landmark basis circularity) into a single reference before designing the scan UI/procedure, so each capture phase can be built against known error sources and an estimated confidence/error budget — not discovered mid-implementation the way most of them have been so far.

---

## 2026-09-06 — `multi-view`'s degenerate splay diagnosed and fixed; three real bugs found along the way

Follow-on to the 2026-09-06 `ikSolve.ts` gap-closing entry in `TODO.md`: this session used `scan-tests/multi-view` (the 8-side-tile FreeCAD-style corrected-model viewer, plus a new static reference tile added along the way) as a visual audit tool for `average-hand.md`'s population-prior model itself, not for any particular capture. The headline finding — `buildDefaultSkeleton`'s identity `V`/`Vinv` per joint makes every finger's knuckle-row landmark (5, 9, 13, 17) sit exactly collinear, regardless of pose — was suspected from reading the code, then confirmed by eye (screenshots showing Top/Bottom tiles as a bunched, tearing-apart bundle rather than a recognizable palm, and Front/Left/Right/Rear tiles showing fingers flattened into the palm plane instead of curling out of it) and then numerically (a debug dump showed `lm5`/`lm9`/`lm13`/`lm17` all sitting on the same ray from the wrist).

### What was built

- **`projectCorrectedOntoKeypoints`** (`scan-tests/lib/overlay.ts`) — the center tile used to show raw MediaPipe keypoints over the live video; it now projects the _corrected_ model (the same `ikSolve.ts` solve the 8 side tiles already use) onto the video instead, via an orthographic approximation (undo `hand.basis`'s rotation, scale by a real tracked bone's screen-pixel-length-to-model-length ratio, anchor at the real wrist). This turned the center tile into the actual "does the corrected model look like the real hand" comparison the page's own doc comment always claimed to provide but didn't.
- **`buildRestExtensionPose`/`buildRestExtensionSkeleton`** (`ikSolve.ts`) — a new static, never-tracked "model rest" tile (replacing the old live Isometric view) rendering the prior alone (bone lengths, ROM) in a fixed maximum-extension pose, for auditing those in isolation from live-tracking noise. Needed its own splayed skeleton variant before `buildDefaultSkeleton` itself got fixed (see below), since no pose choice can un-collapse a `degree: 0`/`degree: 1` joint 0 that has no ab/ad DOF at all.
- **Real splay added to `buildDefaultSkeleton` itself** — `KNUCKLE_FAN_DEG`/`THUMB_SPLAY_DEG`/`KNUCKLE_FAN_FRACTION` (module-level constants in `ikSolve.ts`), an eyeballed, uncited fan (index/middle/ring/pinky fanned symmetrically, thumb splayed further to the index side), applied to joint 0's frame for every finger. This is the actual fix to the degenerate-splay finding above — it now lives in the skeleton every live tile and the center overlay both solve against, not just the diagnostic tile.

### Three real bugs found while building/tuning this, each with a concrete numeric signature

1. **Unit-mismatch scale bug in `projectCorrectedOntoKeypoints`'s first version.** Computed its screen-pixels-per-model-unit ratio from `hand.vectors`' own real-world 3D distance (MediaPipe world landmarks, meters, ~0.08) but applied it to `correctedVectors`' magnitude (`SolvedHand.worldPositions()`'s default `scale=100` on top of millimeters, ~6800 for a single bone) — a ~100,000x mismatch. Symptom: center-tile overlay collapsed to two lines running off-screen, only landmark 0 visible. Diagnosed from the user's own observation ("only landmark 0 visible, not a degenerate orientation") rather than by guessing — a genuinely different failure signature than a shape/orientation bug, which would still show all landmarks, just implausibly arranged. Fixed by deriving the scale ratio from `correctedVectors`' own reference-bone length instead of `hand.vectors`', matching how the 8 side tiles already self-normalize.
2. **Gimbal-lock singularity in `trackedPose`'s angle recovery**, surfaced (not introduced) by the splay fix above. `angleY = asin(x.z / -cos(angleZ))` divides by `cos(angleZ)`, which is exactly 0 at `angleZ = 90°` — one of this project's own placeholder ROM means (`mcpAxes.*.flexExtRom.meanDeg = 90`). The old identity-only skeleton kept `x.z` at exactly 0 by perfect symmetry, so `0/~0` stayed `0`; the new splay perturbs `x.z` just enough that dividing by a near-zero `cos(90°)` produces a large spurious angle (confirmed directly: a synthetic 90°-exact MCP flexion recovered a ~9° phantom ab/ad; 89.9° or 80° did not). Fixed with an epsilon guard defaulting `angleY` to 0 at the singularity — the angle is genuinely unrecoverable from a direction vector there regardless, the standard gimbal-lock convention, not a new approximation.
3. **Handedness sign wrong twice, in opposite functions.** First, `buildRestExtensionSkeleton`/`buildRestExtensionPose`'s mirror convention was backwards relative to the page's own mirrored (selfie-style) video — user's spec, arrived at after noticing the model-rest thumb side didn't match the live video: a real Right hand's thumb should read on the _left_ of a mirrored display, not the right. Second and separately, `buildDefaultSkeleton` — the skeleton the _solver_ actually runs against — was given no `handedness` parameter at all, on the theory that `makeHand`'s own chirality-reversal correction (`makeBasis`'s `reverse` param) already normalizes real Left and Right hands into one consistent frame, so one fixed splay convention should agree with both. Live testing disproved that directly: with the fixed (unmirrored) convention, a real Right hand's corrected center-tile overlay put the thumb on the pinky side while a real Left hand fit correctly. `buildDefaultSkeleton` now takes its own `handedness` parameter, calibrated and signed independently from `buildRestExtensionSkeleton`'s (the two solve different problems — interpreting real chirality-corrected tracking data vs. synthesizing a display-only hand from nothing — and ended up needing _opposite_ signs, confirmed against real capture rather than assumed to match). `multi-view/+page.svelte`'s live `skeleton` is now reactive on the same `handedness` value used to select which tracked hand to solve.

### Iterative visual tuning of the "model rest" tile's thumb, against `docs/thumbs/mediapipe_hand_reference.png`

Three rounds, each a real sign/magnitude correction, not just visual polish:

- Landmark 0→1 (`wristToCmc`, `handModelData.ts`'s own flagged made-up placeholder) went from a 0.05 hand-length ratio (~8mm, visibly a tiny sliver against the reference diagram's proportions) to 0.19 (~30mm), eyeballed from the reference diagram's own segment-length ratios, not a citation.
- The thumb's landmark-1 bend direction was wrong twice in a row before landing right: first attempt (`abAdRom.maxDeg` at full fraction) compounded with the joint-0 splay to ~87° total, a sharp unnatural kink; second attempt (a 0.4 fraction) still overshot the reference diagram's actual 5-7° secondary bend by roughly 3x; the reference-diagram angle estimate behind that second attempt then turned out to be backwards entirely once compared against live user judgment — the correct bend narrows back _toward_ the reach axis (roughly -10°), not further away from it. Landed on a direct, ROM-decoupled `THUMB_MCP_BEND_DEG = -10` constant rather than a fraction of `abAdRom.maxDeg` (tying a cosmetic pose choice to a real ROM limit was never well-justified in the first place).
- That -10° bend violated the seeded `cmcMobility.thumb.abAdRom`'s own `minDeg` of 0 (no adduction modeled at all) — a real, if narrow, gap in the seed data the tuning process surfaced, not just a display-constant issue. Widened `abAdRom.minDeg` to -15 in `handModelData.ts`, per the user's explicit choice between widening the ROM vs. finding a workaround that avoided touching it.

### Result: all of this session's rough visual indicators now pass

Per the user's own live assessment, on the current (uncalibrated, population-prior-only) model: thumb lands on the correct side of the hand for both handednesses; the palm triangle (landmarks 0/5/17) is visible in Top and Bottom tiles; finger curl is visible (fingers dip below the palm plane) in Left/Right/Front/Rear tiles instead of the flattened, impossible-looking shape from before. Explicitly **not** claimed: that any specific bone-length ratio or ROM value is anatomically correct beyond "doesn't look absurd" — this was a structural/orientation audit, not a measurement-accuracy one.

### Still open

- `buildDefaultSkeleton`'s knuckle/thumb splay magnitude (`KNUCKLE_FAN_DEG = 10`, `THUMB_SPLAY_DEG = 45`) and its now-confirmed handedness sign are both eyeballed against one user's live capture on one session — not verified across multiple people/cameras, and explicitly flagged in-code (same epistemic status as `signedJointAngle`/`thumbDepthSign` elsewhere in this doc) as something to revisit if a different capture disagrees.
- The center-tile projection (`projectCorrectedOntoKeypoints`) is an orthographic approximation that ignores perspective foreshortening entirely — accurate for a hand roughly parallel to the camera's image plane, more visibly wrong for one angled sharply toward/away from it. Not yet characterized how wrong.
- Bone-length ratios were only audited for gross implausibility (the `wristToCmc` fix above); no other segment was re-examined this session, and the user's own closing note flagged some ratios as "could still be tweaked" without specifying which.
- This entire session worked on `average-hand.md`'s _population-prior_ model (`buildDefaultSkeleton(HAND_PRIOR_SEED, handedness)`) — none of it touched or validated per-user calibration (`calculateJoints`/`fitNorms`), which still produces `degree: 2` (unsplayed) MCP joints and has no fitted equivalent of any of this session's splay constants.

---

## 2026-09-06 — External multi-camera hand-pose datasets found, InterHand2.6M chosen, downloaded, and a first per-subject extraction pipeline built

A separate thread from the `/scan3` capture-protocol work above: researching how to test/validate `handModelData.ts`'s priors surfaced three published research datasets, each built from real people's hands captured with multi-camera or depth rigs, independent of MediaPipe and of anything this project has assumed. Findings and decisions written up in `docs/thumbs/from-external-data.md`:

- **FreiHAND** — multi-camera triangulation + human-QC'd MANO mesh fit, ~130k independent-still samples, non-commercial research license.
- **InterHand2.6M** — a synchronized 34-color/46-monochrome-camera dome, ground truth from direct human-clicked multi-view triangulation (closest to model-free of the three), real continuous motion sequences, 27 subjects.
- **DexYCB/HO-3D** — fewer views, MANO-fit optimization, object-grasping motion only; needs a MANO-decode step just to get raw joint positions out.

**Decision: InterHand2.6M**, on strength of (a) it ships raw 3D joint positions directly, no MANO/neural-net decode needed, (b) real per-subject continuous motion, useful for coupling fits `handModelData.ts` currently has no source for at all (`dipPipCoupling`, `enslaving`), and (c) 27 subjects is enough to reserve some as a genuinely held-out test set later. Downloaded the annotation-only release (no images) to `external-data/interhand26m/` (gitignored, ~63MB): per-split `joint_3d.json`/`camera.json`, plus `skeleton.txt` and `subject.txt`.

**A staged plan for turning this into `handModelData.ts` candidates was written to `docs/thumbs/interhand-2-average.md`** — verify the landmark remap before computing anything from it, hold out subjects before fitting anything, compute per-field candidates with an honest sanity check each, human review before any `handModelData.ts` edit, then check the result against the held-out subjects. Also settled, before writing any code: bone lengths, PIP/DIP ROM, and MCP/thumb ROM are the fields most likely to be usable from this source; true axial-roll twist and anything in `wristForearm` are not (no landmark data can recover them); true enslaving coefficients and the ring/pinky-base/true-MCP split are structurally limited by what a sparse landmark skeleton can and can't separate.

### Built and verified against subject 0 (right hand, 417 valid frames across 44 pose sequences)

All at `src/routes/scan3/lib/priors/interhand/`:

- **`skeleton.ts`** — parses `skeleton.txt`'s (name, index, parentIndex) triples and _derives_ the remap from InterHand2.6M's raw joint order to this project's own (`$lib/hand.ts` `CONNECTIONS`) order, rather than hardcoding it from a one-time read. Finding: InterHand2.6M numbers each finger tip-to-base with the wrist last, the reverse of this project's wrist-first/base-to-tip convention — structurally compatible (same 21-landmark, no-separate-CMC-track layout) but not a direct pass-through. `skeleton.test.ts` validates the parsed tree (throws on a broken parent chain or a missing node rather than silently mismapping) and cross-checks the real downloaded file against a literal fixture — 6/6 pass.
- **`loadFrames.ts`** — loads one subject's frames from a split's `joint_3d.json`, filters to one hand with every landmark valid, applies the remap.
- **`fitBoneLengths.ts`** — per-subject bone-length ratios (to wrist-to-middle-fingertip hand length), including the thumb's `wristToCmc` segment, which `handModelData.ts` currently seeds as an explicit unsourced guess.
- **`fitRom.ts`** — per-joint bend-angle (min/mean/max/SD), tagged with a `Directness` (`'clean-hinge'` / `'flex-abd-combined'` / `'joint-stacked'`) derived from `ikSolve.ts`'s own `degreesFor` joint structure, each with a variance multiplier (1x/4x/9x) so declared confidence reflects how directly the raw measurement maps to its target `HandPriorState` field, not just its sample spread. `fitRom.test.ts` (8 cases) verifies the angle math and the directness tagging itself.
- **`segmentConsistency.ts`** — per-frame outlier filter: a frame is dropped for a given joint if either adjacent segment's length deviates >30% from that segment's own subject-median (threshold chosen from a real gap in the observed deviation distribution — smooth 0–25% climb through the bulk of frames, then a jump to 42%+ by the 90th percentile — not a guessed round number). `segmentConsistency.test.ts` (3 cases) verifies it.
- **`subjectReport.ts`** — runs both fits for one subject and prints a side-by-side report against the current `handModelData.ts` seed; nothing writes to `handModelData.ts` automatically (Stage 4's human-review gate, deliberately not skipped).

17/17 tests pass across the four test files.

### What subject 0's numbers actually showed

- **Bone lengths**: every finger's `metacarpal` (wrist-to-MCP) ratio came in far higher than the current seed (e.g. index 67.9% vs. 43.4%) — worked through as a likely genuine finding, not a bug: `handModelData.ts`'s own comments already flag this exact segment as bone-only (X-ray) vs. landmark-based (skin/wrist-crease) measurements disagreeing, and the gap size (~38mm) is anatomically plausible as the carpal-bone region neither source measures the same way. Total hand length matched the current seed almost exactly (156.5mm vs. 156.9mm), supporting this reading. Flagged as the strongest single candidate finding so far, pending review.
- **ROM**: thumb's "MCP"/"IP" hinges — fields `ikSolve.ts` currently has _no_ prior for at all — got real first candidate numbers (mean 48.7°/26.9°, clean-hinge, no mapping penalty). `pipDipRom.dip` initially showed an impossible 147.7° max (ring finger) before outlier filtering; after filtering (57 frames excluded for that joint specifically, on the segment-consistency signal above) max dropped to a plausible 74.6°, comfortably inside the current 90° hard bound.

### Still open

- Nothing has been written to `handModelData.ts` — everything above is Stage 3/pre-Stage-4 output, explicitly not yet reviewed or committed as a model change.
- Only subject 0, only the right hand, only `train` split frames — the other 26 subjects, left hands, and `val`/`test` frames are untouched.
- The subject-level held-out split (`interhand-2-average.md` Stage 2) hasn't been created yet — no subject has been formally reserved for testing rather than fitting.
- The Stage 1 visual-render sanity check (rendering a remapped InterHand2.6M frame through the existing hand-rendering pipeline, side by side with `mediapipe_hand_reference.png` and a live `/scan` capture) was proposed but not built — numeric checks (skeleton-tree validation, bone-length invariance, segment-consistency filtering) stood in for it so far.

---

## 2026-09-06 — Interhand-derived priors made independent, never edit the literature seed; DIP/PIP coupling and MCP ab/ad choke coefficient extracted

Superseding `interhand-2-average.md`'s Stage 4/5 as written: that plan described hand-editing
`handModelData.ts` with reviewed InterHand2.6M numbers. That's no longer the design — `HAND_PRIOR_SEED`
stays a permanent, pure literature-only constant nothing ever writes to. Every subject (InterHand
subjects now, real `/scan3` captures later) instead gets its own separate, permanent `PriorSource`
(`priorSource.ts`), and any subset of sources — literature included, on equal footing, not privileged as
a base — can be combined for comparison via `fuseSources.ts`, purely for display in `multi-view`, never
written back anywhere.

**`fuseSources.ts`**: N-way fusion computed directly as a sum over the whole selected array (precision
sums for scalars, information-form matrix addition for correlated vectors), not by chaining `update.ts`'s
pairwise `updateScalar`/`updateVector` calls — mathematically identical (Bayesian fusion of independent
Gaussian estimates is just two running sums under the hood, and addition is associative/commutative), but
order-independence holds by construction instead of by trusting that chaining happens to commute.
Verified directly (`fuseSources.test.ts`): several random re-orderings of the same source set, including
correlated (non-diagonal) covariance, produce bit-identical results. A field with zero selected sources
is genuinely unconstrained (huge finite variance, not `Infinity` — avoids a `0 * Infinity = NaN` in
`ikSolve.ts`'s coupling terms — and widened `BetaRom` bounds), never silently backed by literature.

**`fitted/interhand-0.ts`**: subject 0's `PartialHandPriorState`, generated by
`generateFittedSubject.ts` from the already-validated `fitBoneLengths.ts`/`fitRom.ts` output (bone
lengths, all fingers; PIP/DIP ROM, the four non-thumb fingers) and two new extractions:

- **DIP/PIP coupling** (`fitDipPipCoupling.ts`) — an OLS regression of DIP angle against PIP angle per
  finger, no axis calibration needed (same "pure hinge bend magnitude is calibration-free" reasoning
  `fitRom.ts` already established), filling a field that was a pure uninformative placeholder in
  `handModelData.ts` before this. Fit cleanly against subject 0: R² 0.62 (ring) to 0.81 (middle), slopes
  0.40–0.55, intercepts near 0 — none of Stage 3b's own warning signs (near-zero/negative slope, very
  low R²) that would flag a remap or sign bug. A real, usable candidate where there was nothing before.
- **MCP ab/ad choke coefficient** (`fitMcpChoke.ts`) — the one field in this batch that does need an
  assumed axis convention (this project has no per-subject calibrated axis for InterHand2.6M's
  subjects), so it reuses `$lib/hand.ts`'s own canonical `palmBasisAxes` (the same `[0, 5, 17]`-landmark
  palm frame `buildDefaultSkeleton`'s splay and every multi-view tile already read from) rather than
  inventing a new convention, and — per `interhand-2-average.md` Stage 3c's own instruction — only fits
  a slope where binning frames by flexion actually shows the ab/ad half-range visibly shrinking first
  (Pearson correlation ≤ -0.3 between binned flexion and binned half-range), never forcing a number out
  of noise. Real, non-uniform result: index/middle showed no visible shrinkage (correlation weakly
  positive) and are honestly reported as unfitted, absent from `interhand-0.ts`'s `mcpAxes` entirely;
  ring fit at -0.39 correlation (chokeCoeff 0.026, borderline-clean); pinky fit at -0.78 (chokeCoeff
  0.233) with a strikingly clean, near-monotonic shrinkage across all 8 flexion bins (half-range 15° near
  full extension down to ~4° by 70-90° flexion) — the strongest, cleanest signal of any field extracted
  from this subject so far.

**One real bug caught before trusting the MCP result.** The first `abAdDeg` implementation computed
`atan2(leftComponent, upComponent)` of the MCP→PIP direction against the palm frame's own `up`/`left`
axes. Looked fine at low flexion, but at high flexion the direction vector rotates out of the `up`/`left`
plane entirely (toward `normal`, the flexion direction), so both components shrink toward zero and
`atan2` becomes noise-dominated -- it wrapped across ±180° for what should have been a small real ab/ad
angle, producing nonsensical 150-170° "half-ranges" specifically in the highest-flexion bins (fist poses,
exactly where the choke effect should be checked). Caught by eyeballing the raw per-bin table before
trusting the correlation, the same "look at the actual numbers, don't trust an aggregate" habit this
whole document's earlier entries already established. Fixed by switching to `asin(direction · left)` --
the direction's deviation from the sagittal plane -- which has no such blind spot at any flexion angle,
since a unit vector's dot product with any axis is always well-defined in `[-1, 1]`. Both fitters have
synthetic-data unit tests (`fitDipPipCoupling.test.ts`, `fitMcpChoke.test.ts`) verifying exact recovery
of a known linear coupling and correct accept/reject behavior on a known shrinking/non-shrinking ab/ad
spread, respectively, matching this whole effort's established pattern of verifying against synthetic
data before trusting a real-data run.

**`multi-view/+page.svelte`** now shows a checklist over every registered `PriorSource`
(`registry.ts`'s `ALL_PRIOR_SOURCES`) instead of a single fixed literature snapshot -- any combination
can be checked (including zero, or excluding literature entirely), fused live via `fuseHandPriorState`,
and fed through the exact same `buildDefaultSkeleton`/`solvePose` pipeline the literature-only snapshot
used before.

### Still open

- Only subject 0 is registered; the other 26 InterHand2.6M subjects, both hands, and real `/scan3`
  captures are all still just the one-more-registry-entry extension `registry.ts` was designed for, not
  yet done.
- Enslaving-adjacent co-flexion correlation (`TODO.md`'s remaining low-confidence item) not attempted.
- The thumb's own MCP/IP hinges have real candidate numbers (`fitRom.ts`'s clean-hinge output,
  discarded by `subjectReport.ts`) but nowhere in `HandPriorState` to map onto -- needs a schema
  extension to `handModel.ts` (a sibling group to `cmcMobility.thumb`, which only covers the CMC/base
  joint), not just another fitter. Identified, not started.
- `fitMcpChoke.ts`'s axis convention is explicitly a shared, unverified assumption (same epistemic
  status as `thumbDepthSign`/`signedJointAngle` elsewhere in this project) -- index/middle's null result
  could mean either "no real choke effect visible in this gesture set" or "the convention doesn't
  isolate ab/ad well for these two fingers specifically." Not disambiguated.
- A per-subject "posterior" storage format was speculated as `fitted/subject-N-hand.json` in an earlier
  entry; it landed instead as a committed `.ts` module (`fitted/interhand-0.ts`) exporting a typed
  `PriorSource` constant, not a JSON file loaded at runtime -- simpler for a browser `import` and gets
  compile-time type checking against `PartialHandPriorState`, at the cost of needing a re-run of
  `generateFittedSubject.ts` (not a hand edit) whenever the fitting methods change.

---

## 2026-09-06 — `flexion-sweep` rebuilt into a personal-prior capture tool; every prior source made a Right/Left pair; a real ROM-starvation bug caught by the user, not a test

Continuation of the same-day multi-view/fuseSources work above. Three things landed, in the order they
were actually found, since the middle one changed the shape of the first.

### `flexion-sweep` repurposed: from an orientation-bias diagnostic to a real capture tool

The page (built for Test 4 to answer "does confidence/ROM degrade as you rotate 0-90deg") now also
folds each completed sweep into a running personal `HandPriorState` belief -- the thing multi-view
needed to answer "the model doesn't match my hand." The orientation-sweep mechanics and diagnostic
tables are unchanged; new on top of them, per completed sweep:

- **ROM** (MCP/PIP/DIP): a real `BetaRom` (mean/SD, not just extrema -- needed a new Welford
  accumulator per bin, later replaced, see below) from the near-palm-facing portion of the sweep only.
- **DIP/PIP coupling**: `flexion.ts`'s `fitDipPipCoupling` gained an OLS coefficient-covariance formula
  (previously only returned slope/intercept/R^2 -- fine for display, not enough to fold into a
  `VectorPrior` belief), ported from the same derivation already used in
  `interhand/fitDipPipCoupling.ts`.
- **Enslaving**, new and not previously planned for this page: since MediaPipe tracks all 5 fingers
  every frame regardless of which one is "active," every OTHER non-thumb finger's total flexion was
  already available in each accepted frame for free. `pairedSweep.ts`'s `fitEnslavingAll` (built for the
  abduction-plane `paired-sweep` page) runs against it directly -- this is exactly
  `capture-protocol.md`'s own, never-implemented "flexion-plane paired-finger exploration... in this
  same palm-facing orientation" note, not a new capture design. `pairedSweep.ts`'s `Enslaving` type
  gained `variance`/`n` fields (previously only `coefficient`/`r2`) for the same reason DIP/PIP needed
  its covariance -- a display-only number can't be fused, a (mean, variance) pair can.
- One Euro filter tuning inputs (min cutoff, beta, derivative cutoff, gap reset) were removed from the
  page per direct request -- they'd already converged to fixed values (`landmarkFilter.ts`'s
  `DEFAULT_ONE_EURO_OPTIONS`) and were no longer being tuned.

Saving works by download, not a repo write -- a browser page has no filesystem access. A button
serializes the running belief into the same `.ts`-module-exporting-a-typed-`PriorSource` shape
`generateFittedSubject.ts` writes for an InterHand2.6M subject, for the user to drop into
`scan3/lib/priors/fitted/` and register in `registry.ts` themselves (or hand to Claude to do that step).

### Every `PriorSource` redesigned as a Right/Left pair, in two steps -- the first step was wrong

First pass: gave "my hand" two completely separate stores/sources (`my-hand-right`, `my-hand-left`),
each independently checkable in multi-view. Prompted directly by a real, already-established finding
this doc's own 2026-09-01 entries proved: ring finger's DIP/PIP coupling R^2 came back decisively
different per hand (Right ~0.76, Left ~0.22, non-overlapping ranges at n=4/n=3) -- so a naive single
shared "my hand" blob would have silently averaged two hands' independent measurements of the same
quantity together, destroying exactly that asymmetry. Splitting into two stores fixed the averaging bug
but got the _shape_ wrong: it also meant re-auditing every other source (literature, InterHand-0) for
the same issue and discovering InterHand-0 had only ever been fit from the subject's right-hand frames,
silently presented as hand-agnostic (id/label said nothing about it, though the description text did).

Second pass, after direct feedback that a subject's two hands should be "a pair, not a prior for right
and a prior for left": redesigned `PriorSource.data` from a single `PartialHandPriorState` (or a
same-shaped-but-tagged-with-one-`handedness` field, the first pass's approach) into a `PriorSourcePair`
(`{ Right?, Left? }`). One checkable row per subject again, matching every other source's shape, with
both hands' data traveling together as one unit -- but `fuseHandPriorState(sources, hand)` now takes an
explicit hand and reads only that half of each selected source's pair, so a Right sweep and a Left sweep
inside the same source still never get averaged together. The literature seed registers the _same_
`HAND_PRIOR_SEED` object under both `Right` and `Left` keys -- one piece of evidence contributing
identically to both fusions, the correct representation of "no individual asymmetry claim," not two
copies that happen to agree. `generateFittedSubject.ts` was generalized to fit both of a subject's real
hands (previously right-only) into one file: InterHand-0's left hand has 426 frames available (was
never loaded before) and, notably, showed the MCP ab/ad choke shrinkage check passing on **all four**
non-thumb fingers, versus only ring/pinky on the right -- another real per-hand difference, surfaced
purely by finally looking.

Multi-view's checklist and `myHandStore.ts` were both collapsed back down accordingly: one "My hand" row
again, one `Writable<PriorSourcePair>` store, `mergeFlexionSweepFragment` updates only the half matching
its own `fragment.handedness`, `resetMyHandPrior(handedness?)` can clear one hand or both.

### A real bug the user caught, not a test: ROM silently never populated

After the redesign above shipped, live use of `flexion-sweep` showed DIP/PIP coupling and enslaving
populating normally on every sweep, but ROM (MCP/PIP/DIP) never checking off, on any finger, across
multiple sweeps -- a clean, consistent symptom pointing at one specific mechanism rather than general
flakiness. Root cause: ROM was gated on a single 10-degree-wide bin (0-10deg palm angle, "nearest true
palm-facing"), while DIP/PIP coupling and enslaving pool frames across the ENTIRE sweep regardless of
angle. In real, continuous capture, a hand practically never holds dead-on 0deg palm angle for 2+
consecutive frames while also actively flexing/extending -- so that one bin stayed empty every single
run, silently starving ROM of any data, while the two angle-agnostic fits kept working fine off the same
underlying frames. This is the same category of lesson this whole document keeps relearning (Tests 6/7:
a parameter guessed from first principles undershoots real capture's actual behavior) -- here the
"parameter" was an implicit assumption (bins are populated near 0deg) rather than an explicit tunable
one, which is presumably why it wasn't caught by review or by the unit tests (which use synthetic data
that doesn't reproduce real capture's actual angle distribution).

Fixed by widening ROM's source from bin 0 alone to bins 0-2 (0-30deg -- still comfortably inside the
low-bias range Test 4 found degradation to be gradual through, not a return to the original strictness),
and computing the `BetaRom` directly from the pooled raw frames (mean/SD/min/max via `signedJointAngle`)
rather than trying to combine multiple bins' separately-tracked Welford accumulators -- simpler and
correct, and it let the now-unused per-bin Welford tracking (`romMean`/`romM2`, added earlier the same
day specifically to support the single-bin approach) be deleted outright rather than kept as dead code.

### Still open

- `flexion-sweep` work is paused here, to resume later -- real capture against the fixed (bins 0-2)
  ROM gate hasn't been run yet, only reasoned through from the symptom.
- Thumb sweeps still produce nothing saved to "my hand" (no `HandPriorState` field exists for the
  thumb's own MCP/IP or for thumb enslaving -- the same schema gap identified earlier the same day).
- Bone lengths are still not captured by `flexion-sweep` at all -- flagged as an open design question
  (add here, or a separate capture) in an earlier same-day entry, not yet decided.
- Nothing currently warns or gates on a `handedness` mismatch when fusing (e.g. checking a source whose
  only real data is one hand while viewing the other) -- purely on the honor system today.

---

## 2026-09-06 — Knuckle-row spacing added as a real "bone"; a real InterHand2.6M methodology bug found and fixed while extracting it (`handLengthMM` was pose-dependent)

Prompted directly by the user noticing `/bones`' newly-numbered landmarks made the model's MCP-to-MCP
spacing look visibly wrong (`buildDefaultSkeleton`'s joint-0 splay had only ever been a fixed, uncited
10deg fan angle -- confirmed by back-computing what that angle implied for actual spacing: ~12/8/6mm for
the three adjacent gaps, well under a real adult hand's ~15-20mm).

**Modeled as a real measurable quantity, not another display constant.** `HandPriorState.boneLengths`
gained `knuckleRow: VectorPrior` (index-middle/middle-ring/ring-pinky MCP-to-MCP distances, ratio to
`handLength`, same convention as every other bone length). `ikSolve.ts`'s joint-0 splay is no longer a
fixed angle: `knuckleRowSplayDeg()` derives the real angle between each pair of adjacent fingers via the
**law of cosines**, from two things the model already has (each finger's own metacarpal length) plus
this new measured gap -- exact triangle geometry given real inputs, not an approximation. Verified
directly: a synthetic prior with knuckleRow set to 18/16/14mm reproduces exactly that spacing in the
rendered rest skeleton (`ikSolve.test.ts`, to 5 decimal places). Seeded in `handModelData.ts` with a
rough, explicitly-unsourced placeholder (20/18/16mm) -- deliberately NOT derived from the old fan angle,
since that would just carry the same "way off" numbers forward under a new name. `caliperMeasurement.ts`
gained a second span type (`resolveKnuckleSpan` in `boneSpan.ts`) alongside the existing within-finger
one, so `/bones` can measure an adjacent-MCP pair (e.g. landmark 5->9) through the exact same UI and
Kalman-conditioning math already built for within-finger spans -- no new page controls needed.

**Caught and fixed a real latent bug in `myHandStore.ts` while wiring this in**: `mergeCaliperFragment`
was overwriting `boneLengths` wholesale on every finger measurement, which would have silently wiped out
any previously-recorded `knuckleRow` measurement (and vice versa) the moment both existed for the same
hand. Fixed by spreading the existing `boneLengths` before applying either kind of update.

### A much bigger finding, surfaced only by trying to extract knuckleRow from InterHand2.6M

Asked whether knuckle-row spacing could be derived from InterHand2.6M the same way bone lengths already
are. First attempt gave nonsense: ~50% coefficient of variation (SD nearly as large as the mean) for a
quantity that should be close to anatomically fixed. Root-caused by checking real numbers instead of
assuming bad tracking:

- **The raw numerator was fine.** Straight-line MCP-to-MCP distance across all 417 real frames (44 pose
  sequences) was tight and stable -- no outliers even at a lenient 30% deviation-from-median threshold.
- **The denominator was the problem.** `fitBoneLengths.ts`'s `handLengthMM()` computed hand length as
  the direct 3D (Euclidean) distance from landmark 0 to landmark 12 -- which collapses dramatically
  whenever the middle finger curls (confirmed: as low as ~59mm in some frames vs. ~190mm extended, a
  >3x range, across perfectly ordinary InterHand pose sequences like `thumbup_rigid`). Dividing a
  stable, pose-invariant numerator (any real bone segment, or the knuckle gap) by a wildly pose-dependent
  denominator inflates the ratio's tail every time the denominator happens to be small that frame.
- **This wasn't unique to knuckleRow.** Checked the index finger's own metacarpal ratio (landmark 0->5,
  computed the exact same way) on the same 417 frames: median 0.517, but p90 already at 1.25 -- the
  identical signature. Every existing InterHand-derived bone-length ratio in `interhand-0.ts` had been
  silently affected by this since the source's original 2026-09-06 entry above, not just the new field.
- **Root cause: a real definitional mismatch, not a data-quality ceiling.** `handModelData.ts`'s own
  `HAND_LENGTH_MM` is a bone-chain SUM (the middle finger's own segments, added up) -- pose-invariant by
  construction, matching Buryanov & Kotiuk's actual anthropometric definition. `fitBoneLengths.ts`'s
  InterHand-side `handLengthMM()` used a _different_, pose-dependent definition (straight-line distance)
  for the same-named quantity. The two had been measuring different things the whole time.

**Considered abandoning InterHand-derived bone lengths entirely given the ~50% CV**, on the reasoning
that if it's this unreliable it might not be trustworthy at all. Decided against it, since the
unreliability was traced to one fixable function, not a property of the dataset: the raw segment
measurements underneath were already shown to be tight and stable; a sum of stable quantities is itself
stable, so fixing the definition mismatch was expected to (and did) resolve the problem everywhere at
once, not just relocate it.

**The fix, and the improvement it actually produced (not just assumed):** `chainHandLengthMM()` now sums
the middle finger's 4 segments instead of taking the direct 0->12 distance, restricted to frames where
those 4 segments individually pass the same per-segment consistency check `fitRom.ts` already uses
(`segmentConsistency.ts`, previously unused by `fitBoneLengths.ts` at all) -- extended to gate every
OTHER ratio too, since a frame's ratio is only as trustworthy as the `handLength` it's divided by, not
just its own numerator. Before -> after, subject 0 right hand: `handLength` 156.5mm (SD ~46mm, the
pose-collapsed value) -> 191.0mm (SD ~2mm); knuckle-row gaps SD ~14.5mm -> ~1.2mm (a ~10x tightening);
index metacarpal CV dropped to 2.2%, matching the ORIGINAL "16 of 20 segments held 4-8% CV" claim this
session had found reason to doubt. The corrected metacarpal absolute value (93.2mm) reads much larger
than Buryanov & Kotiuk's own 68.12mm X-ray figure -- not a new problem, but a re-confirmation of a gap
`handModelData.ts` already documented: MediaPipe's tracked "wrist" landmark sits further back than where
the metacarpal bone itself starts, so the tracked segment is expected to run longer than a pure
bone-only measurement.

### Still open

- Only subject 0 has been regenerated with the fixed `handLengthMM` -- any future subject needs the same
  (automatic, since it's the same shared function, just noted so a re-run isn't forgotten).
- `FittedFingerBoneLengths.n`/`.excluded` are now per-segment arrays (a frame can be trustworthy for one
  segment and not another, and the handLength-trustworthiness gate can vary independently too) -- a
  breaking shape change from the previous single scalar `n`, propagated to `buildSubjectPrior.ts`'s
  source-string formatting but not otherwise consequential.
- The corrected absolute bone-length values (handLength ~191mm, metacarpals ~90+mm) have not been
  cross-checked against the held-out-subject verification `interhand-2-average.md` Stage 6 describes --
  still only subject 0, still pre-Stage-4 candidate output, nothing written to `handModelData.ts`.

---

## 2026-09-06 — multi-view raw-vs-corrected overlay added; a real ~50deg literature curl bias found and partially fixed via a live-capture visual comparison

With bone lengths/knuckle spacing starting to look more trustworthy, moved to the next-biggest visible
problem: "the model is not tracking hand movements very well" in multi-view's center tile.

**`drawHandOverlay` gained `color`/`clear` options** (`overlay.ts`) -- backward-compatible (every other
caller unaffected) -- so multi-view's center tile now draws raw MediaPipe keypoints in blue first, then
the corrected/model-solved hand in yellow/purple on top without clearing, instead of only ever showing
the corrected layer. Lets the two be compared directly by eye, not just inferred from the residual number.

### `mismatch.png`: a real, large, prior-specific divergence

A live capture of a fully-extended hand (fingers straight, spread) showed blue (raw MediaPipe) tracking
the real photographed hand well, while yellow (corrected, literature prior) rendered a flat, over-splayed
fan with the fingers curled noticeably more than either the real hand or MediaPipe's own reading --
confirmed by the user as a _literature-prior-specific_ symptom: switching to subject-0-only (literature
unchecked) resolved the excess curl, and the mismatch shape differs by prior rather than being a uniform
tracking problem.

**Root-caused with a direct synthetic test, not just eyeballing the image**: fed a perfectly straight
(all-zero-angle) synthetic tracked frame into `solvePose` against the literature seed alone. A hand that
started dead straight came back with ~25deg of injected MCP flexion, ~18deg PIP, ~6deg DIP (~50deg total)
-- confirming the corrected render really was curling frames that were never curled to begin with, not a
perception effect from the side-by-side comparison.

**Cause: three placeholder `meanDeg` values in `handModelData.ts` sat at or near their own joint's
`maxDeg`** (`mcpAxes.flexExtRom`: mean 90 == max 90, literally the hard limit, not a "typical posture";
`pipDipRom.pip`: mean 90 of a 0-110 range). `solvePose` pulls every tracked frame partway toward
`meanDeg` regardless of what's actually tracked (the same mechanism that protects a corrupted frame), so
these meant every frame -- corrupted or perfectly clean -- got dragged toward near-maximum flexion.
`pipDipRom.dip`'s mean (47.5) was already close to its own midpoint (45) and not part of the problem.

**Fix: recentered `meanDeg` to the honest "no real data yet" default (the plain midpoint of
minDeg/maxDeg)** for all three fields, rather than inventing another guessed number -- `mcpAxes.flexExtRom`
90->35, `pipDipRom.pip` 90->55, `pipDipRom.dip` 47.5->45. Re-ran the same synthetic straight-hand test
after the fix: 9.8/11.0/5.9deg (MCP/PIP/DIP) -- roughly a 45% reduction in injected curl, not a full
elimination. One test (`ikSolve.test.ts`) broke because it had accidentally coupled its own
corrupted-reading-detection math to the literature seed's exact `meanDeg` value; fixed by rewriting that
test's synthetic setup to use fixed literals instead of reading the (intentionally mutable) seed constant
-- the kind of hidden coupling worth naming so it doesn't recur silently next time these constants move.

**The remaining ~27deg is understood, not mysterious**: it's the ROM term still doing its actual job
(pulling every frame toward a "plausible" value in proportion to `sdDeg` vs. `DATA_NOISE_SD_RAD`), not a
leftover version of the same bug -- recentering fixed the WRONG-DIRECTION bias, not the existence of a
pull at all. Loosening `sdDeg` (rather than moving `meanDeg` again) would be the next lever if this
residual amount turns out to matter in practice.

### Decision: pause further multi-view tracking-accuracy work until personal measurements are in

User's own read: the remaining tracking artifacts may just as easily be "a hand of one size/shape driving
a hand of another size/shape" (a real prior/subject mismatch) as anything left to fix in the solver
itself -- and untangling the two isn't productive before `/bones` has real personal bone-length/knuckle
measurements entered (paused mid-session previously, "I will come back and enter all bone lengths in a
bit"). Decided to treat current multi-view behavior as good enough for now and resume tracking-accuracy
investigation after that personal data exists, so a real solver problem isn't chased using a prior that's
also known to not match the person driving it.

### Still open

- The residual ~27deg literature curl-bias magnitude has not been judged against real use -- `sdDeg`
  tuning only proposed, not attempted.
- Whether the "different mismatch shape per prior" pattern (literature: over-curl; others: unspecified
  "different form... pretty bad") has a similarly findable single cause each, or several, is unexplored --
  only literature's was root-caused this session.
- No `/bones` measurements have been entered yet for either hand -- multi-view/`/bones` testing after
  that is the explicitly agreed next step, not yet started.

---

## 2026-09-07 -- `docs/thumbs/representing-keyboard-build-inputs.md` built and completed: a real 3D capability-field viewer, staged from an empty scene to cost-colored per-finger volumes

A separate thread from the `/scan3` capture-protocol work above: `key-point-selection.md`'s Step
1-2 candidate-space/cost-field algorithm had no way to be looked at in 3D -- every existing scan-tests
page renders via HTML5 Canvas 2D, not this project's real 3D stack (`three`/`@threlte/core`/
`@threlte/extras`). Planned in `docs/thumbs/representing-keyboard-build-inputs.md` as nine small,
independently-verified stages (0-8), built and completed this session at
`src/routes/scan-tests/capability-field/+page.svelte`, backed by tested modules under
`src/routes/scan3/lib/keypoints/`. Adopted naming: **capability sample** (one `(position, joint-angles, posture cost, manipulability, positional uncertainty)` tuple), **capability field/cloud** (the
collection), tied to the robotics "capability map" literature `key-point-selection.md` already cites --
deliberately not "keypress space" (implies a 2D structure the model doesn't have) or "reachability"
(already means something narrower and layout-_dependent_ elsewhere in this codebase).

### What got built, stage by stage

- **Stage 0-1**: empty lit scene (`Viewer.svelte` + `@threlte/extras`'s `Grid`/`AxesHelper`), then one
  placeholder primitive to fix the mm-scale convention before real data existed.
- **Stage 2**: a synthetic point cloud settling `CapabilityCloud.svelte`'s visual API -- switched from a
  shell (hollow, sees through the volume) to a solid cubic-lattice fill on direct user feedback, since
  real capability samples fill a volume, they don't lie on its boundary.
- **Stage 3-4**: `sampleMcpSweep.ts` (one finger's MCP only, 2 free angles -- confirmed live to trace a
  2D shell, not a volume) then `sampleFingerSweep.ts` (MCP + PIP, 3 free angles, DIP derived via
  `dipPipCoupling` rather than independently sampled -- confirmed live to fill a genuine 3D volume).
- **Stage 5-6**: generalized across all four non-thumb fingers (identity-colored, reusing
  `PoseCanvas.svelte`'s existing finger/color convention), then the thumb's saddle joint isolated in its
  own `sampleThumbCmcSweep.ts` (CMC's 2 driven axes only -- the thumb's other two joints have no prior
  in `HandPriorState` at all, a real, already-identified schema gap, so they're held straight rather
  than swept with invented numbers).
- **Stage 7**: a plain skeleton (`RestSkeleton.svelte` -- joint spheres, bone lines, deliberately not the
  rigged GLB mesh, so no specific hand shape is implied) via a new `restSkeletonLandmarks.ts`, later
  extended with `neutralPose.ts` for a real "typical posture" pose (every joint's own fitted `meanDeg`,
  not an assumed straight/extended hand).
- **Stage 8**: three real per-sample costs -- `postureCost.ts` (Gaussian penalty against each joint's
  fitted mean/SD, matching `ikSolve.ts`'s own existing simplification rather than the spec's Beta
  density), `manipulability.ts` (numerical Jacobian + Yoshikawa's index, reused from
  `scan-utility-evaluation.md`'s own machinery), `positionalUncertainty.ts` (posterior variance
  propagated through the same Jacobian) -- exposed as two independently-selectable channels (color,
  brightness), prompted directly by the user's own suggestion that color needn't be the only visual
  channel: brightness scales `CapabilityCloud`'s existing per-instance `instanceColor`, chosen over true
  per-instance transparency because three.js's standard materials don't read alpha from `instanceColor`
  at all -- that would need a custom shader, not a prop.

### Bugs found live, in the order they surfaced

1. **`Text` (troika-three-text) silently broke `OrbitControls`.** Adding grid scale-reference labels via
   `@threlte/extras`'s `Text` made drag-to-rotate stop responding entirely, reproducibly, though the
   server never crashed and a fresh page load still rendered. Root cause not fully isolated (candidates:
   `Text`'s own `forwardEventHandlers`/raycasting registration, or its async font-load/worker path) but
   irrelevant once diagnosed -- swapped for `@threlte/extras`'s `HTML` component
   (`pointerEvents="none"`, a plain non-interactive DOM overlay) instead, which fixed it immediately and
   is a better fit for "2D text" than a WebGL mesh anyway.
2. **A ~100x scale bug, the same class `multi-view`'s `projectCorrectedOntoKeypoints` hit in an earlier
   session.** `buildDefaultSkeleton` (`ikSolve.ts`) bakes joint lengths as already-absolute millimeters
   (`bones.mean[i] * handLength`), but `worldPositions`'s own default `scale=100` is calibrated for the
   _other_ joint representation (`calculateJoints`'s live-tracking fit, where `length` is a plain
   unitless ratio). Using the default silently double-applied the mm conversion -- fingertip positions
   came out around 15,000mm instead of ~150mm, rendering nothing visible. Fixed with `scale=1`
   everywhere a `buildDefaultSkeleton` skeleton is walked; locked in with a regression test asserting
   fingertip-to-wrist distance stays in a plausible 50-400mm band.
3. **Landmark-0 placeholder orientation was 90 degrees off, then upside down, by sign.** A plain-identity
   landmark-0 position put the palm plane (`$lib/hand.ts`'s `fkBy` treats local Y as the palm normal --
   confirmed live via a pure-flexion/pure-abduction probe) perpendicular to this viewer's ground grid.
   `PLACEHOLDER_LANDMARK0_POSITION = makeRotationX(+PI/2)` fixed the perpendicularity but read as the
   whole hand upside down; the user's own live read ("180 degrees around the red/x axis") was the fix --
   flipped the sign to `makeRotationX(-PI/2)`, confirmed by rendering, not re-derived from first
   principles. Same "live-verify signs, don't guess" practice this doc has needed for `thumbDepthSign`/
   `signedJointAngle` elsewhere.
4. **`neutralPose.ts`'s DIP angle was read from the wrong place.** Used `pipDipRom.dip[finger].meanDeg`
   directly, but `sampleFingerSweep.ts` never treats DIP as independently sourced -- it's always derived
   from PIP via `dipPipCoupling`. For the index finger this was a real ~10 degree discrepancy (21.3
   derived vs. 31.1 direct), pulling the neutral-pose fingertip off of any pose the sweep itself could
   ever produce -- confirmed by the user noticing the fingertip no longer sat on the sweep cloud's own
   surface after the neutral-pose change landed. Fixed by deriving DIP the coupling way everywhere.
5. **Ring/pinky's own base-of-hand flexion was never swept at all.** `$lib/hand.ts`'s
   `degreesFor('ringFinger'|'pinky')` gives them a real `degree: 1` hinge at joint index 0 (unlike
   index/middle's genuinely fixed `degree: 0` metacarpal) -- `goals.md`'s own "ring/pinky CMC" group,
   modeling their independent flexion toward the thumb to cup the palm. `sampleFingerSweep.ts` held this
   joint at `[0, 0]` for every finger regardless, so ring/pinky's own capability cloud never explored a
   dimension the model actually has. Surfaced the same way as (4): the neutral pose (which does pose
   this joint, via `neutralPose.ts`) landed visibly outside ring/pinky's sweep cloud specifically, not
   index/middle's. Fixed by adding it as a real 4th swept dimension for ring/pinky only, at a coarser
   resolution (4 steps) than the other three axes to bound the total sample count. This is a direct,
   concrete instance of `key-point-selection.md`'s own named warning: excluding ring/pinky CMC mobility
   "silently reproduces the 'rigid palm' assumption this whole model exists to remove" -- it had, quietly,
   until the viewer made it checkable.
6. **A second, unfixed instance of the already-documented "meanDeg pinned at maxDeg" bug.** The
   2026-09-06 session (above) found and fixed `mcpAxes`/`pipDipRom` entries whose `meanDeg` sat exactly
   at the joint's own hard limit rather than a typical-posture value, and recentered them to the plain
   min/max midpoint. `cmcMobility.thumb.flexExtRom`/`abAdRom` had the identical bug (`meanDeg` == `maxDeg`
   in both) but were missed by that pass entirely -- surfaced when the neutral-pose thumb landed in a
   corner of its own CMC sweep volume rather than its center. Fixed the same way, on direct user
   confirmation given the shared-seed blast radius: `flexExtRom` 53->26.5, `abAdRom` 42->13.5.

### Diagnosed and deliberately left as-is: the knuckle-row "impossible" look

At the neutral pose, ring/pinky's MCP position (landmarks 13/17) sits ~30mm below index/middle's
(landmarks 5/9, exactly coplanar since their metacarpal has zero modeled DOF) -- a sharp discontinuity in
the knuckle-row line rather than a smooth arch. Confirmed this is genuinely what the fused prior
produces, not a bug: `cmcMobility.ring/pinky.flexionRom` is `rom(0, 30, 22.5, ...)`, tagged
`ROUGH_ROM_SOURCE` -- 22.5 is 73% of the way to a real anatomical stop (`degree: 1`'s own maximum, per
`sin(22.5deg) * ~80mm metacarpal ~= 31mm`, matching the observed drop almost exactly), not the
exact-at-the-limit pattern the thumb bug above was, so it wasn't "fixed" the same way. Two separable
causes, neither obviously wrong enough to silently override: the specific 22.5-degree figure is an
uncited working guess that may be too aggressive for a genuinely relaxed "neutral" (as opposed to an
actively-gripping) posture; and index/middle's metacarpal being modeled as _exactly_ rigid (`goals.md`
itself calls the real joint "near-rigid," not perfectly rigid) structurally guarantees a discontinuity
regardless of ring/pinky's own number. Left both alone on explicit user direction: this display's job
right now is troubleshooting the prior/scan data and the resulting motion model, not presenting a
polished result, so a visibly-implausible neutral pose that traces back to an honestly-flagged rough
placeholder is the display doing its job, not failing at it.

### Lessons learned

**A visualization can be a real bug-finding tool, not just a deliverable, if it's built to expose
internal consistency.** Three of the six bugs above (DIP-derivation mismatch, ring/pinky's missing
sweep dimension, the thumb CMC data bug) were found purely by checking whether a pose computed one way
(the neutral-pose function) landed inside a volume computed another way (the sweep sampler) -- both
already existed and were individually "correct" in isolation, but the viewer made their disagreement
visible in a way neither one's own unit tests could, since each only tested itself. Worth designing
future diagnostic tooling around this same "two independently-computed views of the same posterior
should agree" check, not just "does this one number look plausible."

**Sign and orientation conventions in this codebase still need live verification, every time, no matter
how carefully reasoned in advance.** The landmark-0 placeholder's rotation direction was derived
correctly on paper (map the palm-normal axis onto the grid's up axis) but still came out upside down in
practice, and the fix was "the user looked at it and said which way," not a corrected derivation. Same
practice this whole document has needed repeatedly for `thumbDepthSign`, `signedJointAngle`, and
`handPlaneNormal`'s handedness sign -- add this session's landmark-0 rotation to that list.

**A single already-fixed bug pattern is worth grepping for elsewhere before assuming it's contained.**
The "meanDeg pinned at the joint's own maxDeg" bug was found and fixed once (2026-09-06, `mcpAxes`/
`pipDipRom`) but silently persisted in `cmcMobility.thumb`, in the same file, seeded around the same
time, simply not touched by that pass. The fix pattern (recenter to the plain midpoint) was already
established and required no new judgment call -- only noticing it needed to be applied again.

**Brightness/scale are real, cheap second visual channels on top of `InstancedMesh` color; per-instance
transparency is not.** `instanceColor` already gave per-marker color for free; scaling that color by a
second, independently-selected cost (posture cost driving hue, positional uncertainty simultaneously
driving brightness, say) cost nothing more than arithmetic. True per-instance alpha would need a custom
shader, since three.js's standard materials don't read an alpha channel from `instanceColor` -- worth
remembering as a real technical boundary, not just an implementation preference, next time a "can we show
two things at once" request comes up against `InstancedMesh`.

### Still open

- The knuckle-row discontinuity above (`cmcMobility.ring/pinky.flexionRom`'s specific `meanDeg`, and
  index/middle's exactly-zero-mobility simplification) -- deliberately left unresolved, flagged for
  whenever real per-user or literature data can replace the rough placeholder.
- `docs/thumbs/representing-keyboard-build-inputs.md`'s own remaining open item (landmark-0's placeholder
  position/orientation isn't visually marked as a placeholder on-screen) -- explicitly deprioritized by
  the user ("good starting point... no need to tweak it further now"), not fixed.
- Everything the plan doc scoped out from the start remains genuinely not started: Step 0's real
  landmark-0 sampling, Step 3's cost-weighted packing into key candidates, Step 5's cross-finger effects
  (clearance/blocking/accidental-activation), and any keyboard-shape rendering at all.
- Only `indexFinger`/`middleFinger`/`ringFinger`/`pinky`/`thumb` for a single `'Right'` hand and the
  `[LITERATURE_SOURCE, INTERHAND_0_SOURCE]` fused prior were exercised this session -- `'Left'`
  handedness and other/future `PriorSource`s haven't been run through this viewer at all.
