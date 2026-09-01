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
