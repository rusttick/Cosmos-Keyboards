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
