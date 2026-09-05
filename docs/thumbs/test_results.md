# Scan test results: a running log

Results and lessons learned from actually running the tests in `scan_tests.md`, in session order. Each entry records what was measured, what it means for the assumptions `scan_procedure.md` makes, and anything about the testing tooling itself that had to change along the way. Numbers here are the record of truth; `scan_tests.md` stays the spec of what each test is trying to check and how — this doc is what actually happened when we ran them.

---

## 2026-08-30 — Static hold noise floor (Tests 1–2)

### Results

**Test 1, frame-to-frame noise in a static hold (`palm-facing`):** established and converged. 5 clean captures (both hands, multiple sessions) consistently landed at **1.7–2.8% bone-length CV** and **1.2–2.5° joint-angle stdev**. Distal bones/joints (the shorter segments nearer the fingertip) are consistently noisier than proximal ones (metacarpal bones, MCP joints) — a stable pattern across every capture, not a one-off.

**Test 2, palmar vs. dorsal (`palm-facing` vs. `palm-away`):** answered. 4 clean `palm-away` captures (2 Right, 2 Left) converged to **4.46–5.42% bone CV (mean 5.00%)** and **2.54–2.96° joint stdev (mean 2.76°)** — roughly **2x** `palm-facing`'s noise floor, reproduced across both hands with a tight spread (~1% CV, ~0.4° stdev across reps). This confirms, on this project's actual camera/hand/lighting, the MediaPipe dorsal-view degradation `scan_procedure.md` argues for from a GitHub issue about someone else's setup — it isn't just a documented claim, it reproduces here.

**Secondary finding:** the thumb is disproportionately noisy in `palm-away` specifically — thumb bones ran 5–8.5% CV (vs. 2–5% for other fingers' comparable segments) and thumb joint 0 stdev ran 3.2–5.4°, well above every other finger's joints (~2–3°) in all four `palm-away` captures. `palm-facing` doesn't show this gap nearly as strongly. Worth keeping in mind for `scan_procedure.md`'s thumb-CMC capture phase, which already plans to use non-palm-facing orientations.

**Open caveat, not yet resolved:** `palm-away` is a physically harder pose to hold steady than `palm-facing` — rotating the wrist into it is more effortful and less naturally stable than resting palm-down. That means the 2x noise gap above is _at least partly_ conflating two different things: MediaPipe's own tracking degrading in the dorsal view (the thing this test is supposed to isolate), and genuine extra physiological wrist/hand movement from the pose being harder to sustain (not a sensor artifact at all, but not what this test is trying to measure either). The two haven't been separated. Right now there's no way to tell how much of the 2x gap is "MediaPipe is worse at this orientation" versus "this orientation is harder for a human to hold still," and the test as currently built can't tell them apart.

### Lessons learned

**Build on `$lib/hand.ts`, not `src/routes/scan/lib/hand.ts`.** Two independent copies of the hand kinematics engine exist; `scan3.md`'s "Foundation" section already resolved this in favor of the canonical `$lib/hand.ts` (the only copy with the `basis` field later phases need, and the one every other consumer reads from). The test tooling ported `/scan`'s detector onto `$lib/hand` rather than importing the fork, specifically so this testing effort and the eventual `/scan3` implementation stay reading from the same engine.

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

**Decision:** use `thumb-away` as the only practical lateral orientation going forward; `thumb-toward` is dropped from active testing. This also answers something `scan_procedure.md` itself left open (which edge faces the camera in the lateral posture) — empirically, only one direction is usable on this rig.

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

`fitNorms` (`src/lib/hand.ts`) already ran an SVD per joint and only used the resulting basis, discarding the singular values — `scan_utility_evaluation.md` had flagged this as a free signal worth surfacing. It now also returns `axisConfidence` (ratio of the top two singular values), added as an optional field on `Joint` so no existing consumer (`/scan`, `/scan2`, `calculateJoints` itself) is affected.

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

Reviewed the remaining tests (6–14) against what Tests 1–4 actually needed to be cheap: they only required machinery that already existed (`makeHand`, `fitNorms`, live stats). Tests 6–11 each need an algorithm that doesn't exist yet (still-window extraction, plateau detection, DIP/PIP coupling fit, enslaving-coefficient fit, thumb CMC/occlusion-guard logic) — building a throwaway version just to test it in isolation costs about as much as building it for real inside `/scan3`. Tests 12 and 14 are already explicitly deferred by `scan_tests.md`'s own text; Test 13 is the integration test, meant to run once everything else exists, not before. So none of the remaining tests are real prerequisites to starting `/scan3`.

**Decision:** stop writing throwaway test infrastructure. Write each remaining algorithm in its real, final reusable form — the locations `scan3.md`'s own "Directory layout" already specifies — and validate each one with a lightweight live test page against the real library code, not a synthetic-only or reimplemented-for-testing version.

### Implemented: `stillWindow.ts` and `plateau.ts`

Both written at their `scan3.md`-specified locations (`src/routes/scan3/lib/completion/`), grouped together since the doc treats them as the same "completion detection" concern and they're both used across multiple phases.

**`findStillWindow()`** — slides a fixed-duration window across a per-frame signal (after discarding an initial warmup period), keeps every placement where frame-to-frame velocity stays under a threshold throughout, and returns the lowest-variance one (not just the first one found). Verified against synthetic data: settle-then-hold correctly finds the window right after settling; constant drift correctly finds nothing; two candidate still windows of different noise levels correctly picks the quieter one, not the first one encountered.

**`PlateauDetector`** — tracks running min/max per joint, detects rep boundaries via a hysteresis-based peak detector on the primary joint (dead-band before confirming a peak, so ordinary frame jitter doesn't get counted as a rep), and declares convergence once the last N reps each fail to grow any joint's range beyond a threshold. Verified against synthetic data: an amplitude sequence that grows then plateaus converges at the correct rep; a sequence that never plateaus never converges; a multi-joint case where two joints plateau but a third (simulating DIP) keeps growing correctly never converges — matching `scan_procedure.md`'s explicit requirement that every joint's own extremum has to converge, not just the nominal target joint's.

Both verified against synthetic data only so far — not yet run against real capture. `src/routes/scan-tests/completion-detectors/+page.svelte` built to test them live (mode-switchable between the two, reuses the same detector/overlay/throttled-loop pattern established for the other scan-tests pages), feeding both the same 3-joint per-frame angle signal already used throughout this doc.

### First live run: still-window's default velocity threshold was badly miscalibrated

Baseline still-window run (genuine hold, default settings) found nothing. Root cause: `velocity()` combined all 3 tracked joints into one Euclidean-norm delta, which scales with `sqrt(dimension count)` — using Test 1's own established noise floor (~1.5-2.5deg per joint), ordinary frame-to-frame sensor noise alone already produces a combined-norm velocity over 100deg/s with 3 joints tracked, before any real movement. The default threshold (20deg/s) was rejecting normal sensor jitter as motion.

Fixed two things: switched `velocity()` to max-per-component rather than combined-norm (doesn't scale with how many joints happen to be tracked, and better matches "no single joint is moving much" — the actual meaning of "still"); raised the page's default threshold from 20 to 100deg/s as a more realistic starting point. A synthetic worst-case check (fully independent, uncorrelated frame noise at Test 1's stdev) needed a threshold around 200deg/s to reliably pass even with zero real movement — real MediaPipe noise is likely _not_ fully independent frame-to-frame (the tracker uses the previous frame's region as a starting point, so consecutive-frame errors are probably correlated rather than white noise), so real data may need less headroom than that pessimistic synthetic model — genuinely unknown until tested live, hence raising the default rather than guessing a final number.

### Test 6 answered: real threshold found by live tuning — window length matters more than threshold

At the original 1s minimum window: 200deg/s worked but not reliably (passed once, failed on repeat genuine-still holds); 250deg/s worked repeatedly and still correctly failed the negative control (deliberate movement). That looked at first like the answer — until shorter windows were tried directly: **200deg/s at a 0.5s window, and 150deg/s at a 0.25s window, both worked more reliably than 250deg/s at the full 1s window.** Initially treated the shorter-window combinations as a side option traded off against a noisier mean (fewer samples to average); that was the wrong framing. The real mechanism is that a longer required window means more consecutive frame-pairs that all have to clear the velocity threshold _simultaneously_ — every extra sample in the window is another chance for one noisy frame to break the whole window — so window length, not threshold, is the dominant lever on reliability. Page default set to 200deg/s / 0.5s based on this.

This closes Test 6 — the previously-open question ("does still-window auto-detection actually work against real, imperfect human stillness, and what threshold does it need") has a real, empirically-tuned answer now, not a guessed default. Worth remembering for `scan3.md`'s Phase 2/3 implementation: don't default to the doc's originally-assumed ~1s window without retesting against this finding.

### Test 7 answered: plateau's rep-boundary hysteresis had the same miscalibration

First live run: normal MediaPipe frame noise registered as ~5 reps in 15 frames — physically impossible (15 frames is ~0.5s, far too fast for real flex/extend cycles). Same root cause pattern as Test 6's threshold: the peak-detector's hysteresis dead-band (3°) was well inside Test 1's own established ~2-3° frame-to-frame noise floor, so ordinary jitter alone flipped the rising/falling state constantly, each flip counted as a confirmed peak. Confirmed with a synthetic check (clean 5-rep sequence with 2° noise superimposed): hysteresis=3 produced 32 spurious reps; hysteresis=10 and 15 both correctly counted 5. Raised the page default from 3° to 15°.

Live retest at 15° hysteresis / 2° convergence threshold: 3 stable reps, correctly converged. No further tuning needed — unlike Test 6, the first raised default worked on the first real try.

This closes Test 7. Both completion detectors (`stillWindow.ts`, `plateau.ts`) are now validated against real capture, not just synthetic data, with real tuned parameters instead of guessed ones. Three separate instances now, across this whole testing effort (Test 3's thumb bias, Test 6's velocity threshold, Test 7's peak hysteresis), of the same underlying lesson: parameters guessed from first principles or literature undershoot real MediaPipe noise by a wide margin, consistently in the same direction (too tight/too strict), and only live tuning against real capture catches it.

---

## 2026-09-01 — Plan for the remaining algorithms/tests (8–12), three groups

Reviewed what's left (Tests 8–12; 13/14 stay deferred per their own doc text) and grouped by dependency and reuse opportunity, cheapest/lowest-risk first:

**Group 1 — DIP/PIP coupling fit (Test 8).** No new capture needed: `flexion-sweep` already retains full per-frame data per angle bin, so the fit (slope/intercept/R²/residuals between PIP and DIP angle) can run directly against existing captures. Lives at `src/routes/scan3/lib/phases/flexion.ts`. Tested by extending `flexion-sweep`'s UI, not a new page.

**Group 2 — Enslaving coefficient + coverage-grid completion (Tests 9, 12).** Grouped together because they're the fit-and-its-completion-detector pair for the same new capture mode: a freeform _paired_-finger sweep (two fingers tracked simultaneously, which no existing tool does). Completes the "completion detectors" trio `scan3.md` names alongside `stillWindow.ts`/`plateau.ts`. Lives at `src/routes/scan3/lib/phases/pairedSweep.ts` and `.../completion/coverageGrid.ts`. Needs one new capture page (reusing the existing detector/overlay/throttled-loop scaffolding, just a new capture surface). Test 12's actual grid-resolution _tuning_ stays optional/deferred per `scan_tests.md`'s own text — only the algorithm itself (needed for the enslaving fit's completion signal) is in scope now.

**Group 3 — Thumb CMC axis fit + occlusion guard, and thumb freeform trajectory vs. isolated baseline (Tests 10, 11).** Saved for last on purpose: these are the most complex (Test 10's occlusion guard has to distinguish "truncated by occlusion" from "genuinely plateaued," a harder discrimination than anything built so far) and the most exposed to a risk already confirmed twice over (Tests 3 and 4: thumb tracking is disproportionately noisy and biased off `palm-facing`). Better to have Groups 1–2's fitting/completion patterns solid, and the "every guessed threshold has undershot real noise" lesson fully absorbed, before tuning thumb-specific guard logic. Lives at `src/routes/scan3/lib/phases/thumbCmc.ts`, reusing the axis-fit-confidence work from Test 4.

Order: 1 → 2 → 3. Not started yet.

---

## 2026-09-01 — Group 1 implemented: DIP/PIP coupling fit (Test 8)

`src/routes/scan3/lib/phases/flexion.ts` written at its `scan3.md`-specified location: `fitDipPipCoupling(history: Hand[], finger: Finger)` reads PIP (`limbs[1].angleTo(limbs[2])`) and DIP (`limbs[2].angleTo(limbs[3])`) per frame — the same convention `flexion-sweep`'s live ROM table already uses at `j=1`/`j=2` — and fits an ordinary-least-squares line (`dip ≈ slope*pip + intercept`) plus R² and per-frame residuals, matching `scan3.md`'s `DipPipCoupling` shape. A degenerate all-flat sweep (no PIP variation) falls back to slope 0 instead of dividing by zero.

Verified against synthetic data (`flexion.test.ts`, `bun test`) before touching real capture, continuing this doc's established pattern: an exact linear relationship recovers slope/intercept exactly with R²=1; a quadratic relationship (`dip = 0.4*pip + 0.01*pip²`) correctly produces a lower R² and residuals that grow toward the ROM extremes rather than staying flat — confirming the residual-vs-extremes check this test is actually looking for would show up if present.

Per Group 1's plan, no new capture page: `flexion-sweep/+page.svelte` was extended to call `fitDipPipCoupling` over every accepted frame pooled across all palm-angle bins (this question is about the finger's full sweep, not about camera orientation, unlike the axis-confidence/ROM table that stays bin-by-bin) every `STATS_UPDATE_EVERY` frames and again on stop. Displays slope/intercept/R² plus a residual table bucketed into 8 equal-width PIP-angle ranges (mean |residual| per bucket) — a flat trend across buckets means the linear fit holds throughout the sweep; residuals growing in the first/last buckets means the coupling curves near the ROM extremes, the thing `scan_tests.md`'s spec for this test says to look for.

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

**Residuals mostly grow toward full flexion, not symmetrically at both extremes** — in middle-R, ring-R/L, pinky-R, and thumb-R, the worst-fitting bucket is consistently the highest-PIP one, not the lowest. This is a more specific (and different) shape than `scan_tests.md`'s original framing ("curve near the ROM extremes," implying both ends) anticipated — so far it looks closer to "breaks down specifically near full flexion." Pinky-L is the one outlier: residuals stay large through most of the range rather than concentrating at either end.

**Known limitation, carried over from Test 3's design (`scan_tests.md`'s own spec for this test):** per-bucket frame counts are uneven (pinky-L's worst bucket has only 11 frames) and consecutive video frames of continuous motion aren't independent samples, so residual magnitudes in sparsely-populated buckets are less trustworthy than densely-populated ones — a bucket's number should be read alongside its frame count, not on its own.

### Still open

- Single session per finger/hand (index has 2 reps on the Right) — not enough to confirm the middle/ring Left-Right asymmetry or the near-full-flexion residual-growth pattern are real rather than single-session artifacts.
- Whether index's near-zero coupling replicates, and if so, whether it's a real biomechanical property (independent DIP control) or a tracking artifact specific to how MediaPipe resolves the index finger's DIP landmark — not disambiguated here.
- Not yet clear whether the linear model is "good enough" for `scan_procedure.md`'s purposes at any of these R² values, since no threshold was set in advance (consistent with how Test 1 was scoped) — that's a product judgment call, not something this test alone resolves.

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

No further reps needed to answer Test 8's original question set. Remaining open threads are secondary and don't block moving to Group 2: (1) whether index's near-zero coupling is a real biomechanical property or a MediaPipe DIP-landmark tracking artifact — needs a different kind of test than more reps of this one; (2) the newly-noticed pinky Right-vs-Left residual-growth-shape difference; (3) the general "is this R² good enough for scan_procedure.md" product judgment call, not something this test resolves on its own.

---

## 2026-09-01 — Group 2 implemented: enslaving coefficient + coverage-grid completion (Tests 9, 12)

Both algorithms written at their `scan3.md`-specified locations:

**`src/routes/scan3/lib/completion/coverageGrid.ts`** — `makeCoverageGrid(bounds, resolution)`, `updateCoverageGrid(state, sample, confidence, confidenceThreshold?)`, `coverageFraction(state)`, and `isCoverageComplete(state, requiredFraction = 0.7)`, matching `scan3.md`'s `CoverageGridState`/`updateCoverageGrid`/`coverageFraction` API and `scan_procedure.md`'s Phase 5 completion criterion (≥70% of cells confidence-passed). Out-of-bounds samples are dropped rather than clamped to an edge cell, and bounds are fixed at grid creation rather than grown adaptively — Phase 5 normally runs after Phases 3/4 have already established each finger's ROM, unlike Phase 4's abduction capture (which does grow its bounds live, having no prior ROM to anchor to); replicating that adaptive-bounds behavior was deliberately left out of scope here.

**`src/routes/scan3/lib/phases/pairedSweep.ts`** — `fitEnslaving(angleI, angleJ, options?)` implements `scan_procedure.md`'s method directly: `E[i][j] ≈ Δθ_j/Δθ_i`, fit by regression over whichever frame-to-frame deltas have `|Δθᵢ|` both exceeding a minimum-motion floor (default 3°, matching Test 1's established noise floor so ordinary jitter isn't mistaken for a dominant-segment sample) and at least 2× `|Δθⱼ|` — the freeform-sweep stand-in for the literature's "move only finger i" instruction, so no separately-instructed condition is needed. Regression is forced through the origin (coefficient only, no intercept, matching `scan3.md`'s `Enslaving` shape) using the standard through-origin least-squares and R² formulas.

Verified against synthetic data before touching real capture, continuing this doc's established pattern:

- `coverageGrid.test.ts` (6 cases) — empty grid reads 0% coverage; a sample lands in the correct cell without mutating the prior state; below-threshold-confidence and out-of-bounds samples are correctly dropped; full coverage reads 100% and passes the 70% completion check; partial coverage correctly fails it.
- `pairedSweep.test.ts` (5 cases) — an exact synthetic coupling (`Δθⱼ = 0.3·Δθᵢ` during an i-dominant segment, plus a separate j-dominant segment that must be excluded or it would corrupt the fit) recovers the coefficient exactly with R²≈1, and confirms the j-dominant segment was in fact excluded; no-i-dominant-segment and mismatched-length inputs both throw; a noisy-but-real coupling still fits with high R², and an uncoupled (independent-noise) pair correctly fits with low R².

Per Group 2's plan, one new capture page: `src/routes/scan-tests/paired-sweep/+page.svelte`. Reuses the same detector/overlay/throttled-loop scaffolding as `flexion-sweep` and `static-hold`, but is a freeform two-finger recording rather than an auto-detect-orientation or binned sweep — the user picks finger i (dominant/instructed) and finger j (dragged/measured), handedness, grid bounds, and resolution, then moves both fingers freely for the session duration. Both fingers' angles use the same PIP-equivalent convention (`limbs[1].angleTo(limbs[2])`) Test 8's tooling already established, so results are directly comparable. Live view shows the coverage grid as a purple/black cell heatmap, current coverage fraction with a ≥70%-complete indicator, and the enslaving coefficient/R² (refit every 10 accepted frames and again on stop) once an i-dominant segment has actually occurred.

**Not yet run against real capture.** Both algorithms are built and verified against synthetic data only, the same status Group 1's tooling was in before its first live run — real numbers (whether fitted coefficients are stable across repeat sessions, whether they're in a plausible range relative to `scanning.md`'s cited literature values, how much of the coverage grid a real freeform sweep actually visits in 20–30s) are still open. Test 12's grid-resolution _tuning_ stays explicitly deferred per its own scope note in `scan_tests.md` — only the completion algorithm itself was needed here, to unblock Test 9's coverage-gated capture.

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

**More likely explanation: a real conflict between Test 9 and Test 12's shared recording.** Deliberately reaching the (θᵢ, θⱼ) grid's off-diagonal corners — pinky flexed while another finger is extended, and vice versa — requires _deliberately_ moving two fingers in opposite directions at once. `fitEnslaving`'s dominance filter (large `|Δi|`, small `|Δj|` relative to it) can't distinguish "finger j passively dragged by finger i" from "finger j was deliberately driven the opposite way to hit a coverage target" — both look like large, correlated deltas. So a coverage-maximizing session may be systematically biasing the enslaving fit toward whatever anti-phase navigation reached those corners, not measuring involuntary coupling at all. `scan_procedure.md`'s Phase 5 design has Test 9 (enslaving) and Test 12 (coverage) sharing one freeform recording by design — this result is concrete evidence that combination doesn't hold up cleanly when actually maximizing coverage.

**Recommendation, not yet validated:** split the two goals into separate sessions per pair of interest — a "drag" session (move the active finger, consciously keep everything else relaxed) trusted for its enslaving numbers but not its coverage %, and a separate "coverage" session (deliberately visit all four corners) trusted for coverage but not its enslaving fit. Worth testing directly: run both session types back-to-back on the same pair and see whether the drag session's coefficients look more like the earlier "natural" freeform sessions (positive, lower R²) than this coverage-maximizing one did.

---

## 2026-09-01 — Group 3 implemented: thumb CMC axis fit, conjunct coupling, and the occlusion guard (Tests 10, 11)

The `degree: 3` thumb-joint mechanics `scan3.md` specifies were built first, since Phase 6 can't work at all without them:

**`$lib/hand.ts`** gained `ConjunctCoupling` (`{ aCoeff, bCoeff, r2 }`) and a `degree: 3` variant on the `Joint` union. `SolvedHand.fkBy` now computes `angleX = aCoeff·angleZ + bCoeff·angleY` for a `degree: 3` joint and builds `Euler(angleX, angleY, angleZ, 'XYZ')` instead of always forcing the leading term to 0. `SolvedHand.fromLimbs` recovers `angleZ`/`angleY` from the observed bone direction the same way `ik()` already does (a direction vector has only 2 DOF, so it can't reveal twist on its own), computes the same conjunct-coupling-predicted twist, and rotates the generic template's `y`/`z` about the bone axis by it before building the frame — otherwise, per `scan3.md`'s own caveat, the generic path would silently invent an arbitrary twist and corrupt every downstream joint's frame in the chain.

**A real, pre-existing property of `decomposeAngles` surfaced while testing this, unrelated to the new work.** `decomposeAngles` extracts a Euler triple via a `'ZYX'` order, but `fkBy` composes matrices via `'XYZ'` order — those two only invert each other cleanly when at most one of the three axes is nonzero at a time. Every _real_ caller (`PoseResults.svelte`, and `deg1Angles`/`approximateCurl` via `MeasurePose.svelte`) only ever decomposes matrices built by `fromLimbs` (which constructs its frame directly via `makeBasis`, not Euler composition), so this mismatch never surfaces in the app today — but it means `decomposeAngles` should never be paired with an `fkBy`-built matrix expecting an exact round-trip, which the test suite originally (silently, incorrectly) assumed. Tests were rewritten to compare rotation matrices directly instead. Worth remembering if `decomposeAngles` ever gets a new caller downstream of `fkBy`.

**`src/routes/scan3/lib/phases/thumbCmc.ts`**, all built at once since they're the fit-and-guard set for the same phase:

- `fitThumbCmcAxis(history, length, matrix)` — Phase 6a's axis fit. No new algorithm: applies `fitNorms` (already used for every MCP) to the thumb's own bone-0 direction data for the first time, per `scan3.md`'s "why this is a smaller change than it looks."
- `fitConjunctCoupling(history, cmcJoint, referenceBone1)` — Phase 6b's regression. Flexion/abduction come from the same observed-x → YZ-Euler recovery `ik()` uses; twist is measured as bone1's rotation about the bone0 axis, projected onto the plane perpendicular to it and compared against a reference bone1 direction (the mean bone1 from the rigid Phase 6a sweep, where by construction there was no CMC-driven twist). Through-origin 2-predictor least squares (normal equations), matching `ConjunctCoupling`'s shape.
- `thumbMcpIpAngles(hand)` — the Phase 6b byproduct, a thin wrapper reading `signedJointAngle(hand, 'thumb', 1)`/`(..., 2)`, no new fitting math (per `scan_procedure.md`, this is meant to fall out of the trajectory, not be independently derived).
- `OcclusionGuardedPlateau` — Test 10's actual deliverable, the false-plateau guard `scan_procedure.md` requires: "only accept convergence if confidence/yield stayed healthy through the last k cycles, not just the angles." Wraps `PlateauDetector` by composition (plateau.ts itself is unchanged) with a parallel per-rep confidence-yield track. `status()` returns `'converged'` only if the angle-based plateau _and_ the last `k` reps' yield both look healthy; if yield collapsed in those same reps (the thumb went out of view right as it looked like it stopped), it returns `'possibly-occluded'` instead of asserting a false limit.

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

User's response to the above: rather than chase an algorithmic correction or require external bracing hardware, `scan_procedure.md` can be designed so **every step keeps hand-plane-normal movement bounded** (self-discipline during capture, not a brace) -- i.e. each phase's instructions include "keep the palm steady" as a first-class constraint, with the existing live rotation readout as real-time feedback, rather than trying to separate rotation from flexion after the fact.

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

Standing back from the play-by-play above: this session's real finding isn't "the normal was backwards," it's that **this whole test suite has been building on MediaPipe Hands outputs — handedness, world-landmark depth, the wrist-as-pivot assumption already retracted in Group 3 — without first mapping out where each one is actually reliable.** Each limitation so far has been discovered by accident, mid-test, after work was already built on top of the assumption it would hold (the landmark-1 basis circularity, the wrong-bone CMC pivot, now handedness stability). The user's stated goal going forward: build the real hand-scanning process and UI with these limitations known and accounted for up front, so `scan_procedure.md` can carry an actual estimate of scan error instead of discovering each failure mode after the fact.

Concretely, before resuming Tests 10/11 (thumb-CMC axis fit, conjunct coupling, occlusion guard) or any further refinement of the thumb movement model:

1. ~~Test whether `hand.score` predicts handedness flips.~~ **Answered 2026-09-03: no** — `score` stays in the 90s even when tracking is visibly bad, no observed dip around flips. Not a usable early-warning signal.
2. **Build and live-tune a handedness-stabilization mechanism**, blind to `hand.score` per (1) — a short hold/hysteresis purely on the classified label itself (same category of fix as Test 6's still-window and Test 7's peak hysteresis: separate noise-rejection from the raw per-frame signal, don't trust any single frame). Verify it against synthetic data first, then live, per this doc's established pattern.
3. **Re-run the `handPlaneNormal` sweep test** (thumb toward/away, wrist flexion/extension, with the arrow/insets already built in `thumb-cmc`) with handedness stabilized, to check whether that alone fixes the sign, or whether a residual issue remains once handedness is no longer a confound.
4. **If `handPlaneNormal` still isn't reliable after (3)**, `fingerCurlAgreesWithNormal` (or a similar anatomy-grounded check, generalized beyond middle/ring-finger flexion) becomes the load-bearing signal for "which side is the palm on," not a diagnostic on the side — and `scan_procedure.md`'s design should account for that rather than assuming a clean geometric normal is always available.
5. **Only then**, resume Tests 10/11 and further thumb-CMC/thumb-movement modeling — on a foundation where handedness and orientation-sign are known-stable (or their actual failure rate is known and designed around), not assumed.

Broader, standing item for `scan_procedure.md`/`scan3` design work: consolidate every MediaPipe-limitation finding from this whole doc (dorsal-view noise ~2x, depth/Z axis weakest, wrist-as-CMC-pivot invalid, thumb tracking noisiest overall, handedness classification unstable at hard angles, world-landmark basis circularity) into a single reference before designing the scan UI/procedure, so each capture phase can be built against known error sources and an estimated confidence/error budget — not discovered mid-implementation the way most of them have been so far.
