# Scan tests: validating the assumptions behind the capture protocol

`scan_procedure.md` makes a lot of design decisions on reasoning rather than measurement — which orientation is better for which motion, whether bilateral capture corrupts per-hand data, whether a freeform trajectory gives clean enough per-joint angles, whether pooling averages out noise or just tightens around a bias. Building the full protocol (and `scan3.md`'s implementation) before checking any of that is a bet. This doc is a cheap-to-expensive sequence of small, targeted tests that check the assumptions in roughly increasing order of implementation cost and how much capture-protocol machinery each one needs — so it's easy to see where returns start diminishing and stop there, rather than building the whole thing and hoping.

Each test below is written at the level of "what to capture, what to compute, what result would validate or break the assumption" — not full implementation detail. The first one, at the end, is worked out in full.

## Frame-to-frame noise in a static hold

Hold one hand still, palm facing the camera, for 15–30 seconds. Compute bone lengths and inter-bone angles per frame, and look at how much they jitter with literally nothing moving. This is the noise floor everything else gets compared against — without it, there's no way to tell whether a later "plateau" or "coupling" measurement reflects something real or is just sensor noise. Cheapest possible test: no guided motion, no fitting machinery, no UI beyond a record button.

## Palmar vs. dorsal vs. lateral, same static hold

Repeat the static hold in all three orientations (palm-facing, dorsal-facing, and the lateral palms-facing-each-other-style view) and compare. This directly checks the premise the whole protocol rewrite rests on — the documented MediaPipe world-landmark collapse in dorsal view — against this project's own camera setup, hand, and lighting, rather than trusting a GitHub issue filed against someone else's setup. Still just static holds; only the number of orientations changes.

## Bone-length agreement between the two canonical (palmar, lateral) orientations

Given the previous test rules out dorsal, check whether the two orientations this protocol actually uses agree with each other on bone length, or whether there's a smaller but still real bias between them. If they disagree by more than the noise floor from the first test, that's a second, subtler orientation bias worth knowing about before it gets silently averaged into a pooled estimate.

## Axis-fit confidence: palm-facing vs. lateral for flexion

`scan_procedure.md` argues for palm-facing on occlusion/training-data grounds while acknowledging the projective geometry favors a lateral view for that joint's rotation axis specifically. Capture the same finger's flexion sweep in both orientations back to back and compare the SVD-derived axis-fit confidence between them, plus whether the recovered ROM values agree. First test that requires actual guided motion (a real flex/extend sweep) rather than a static hold, but no fitting infrastructure beyond what already exists in `hand.ts`.

## Bilateral vs. unilateral equivalence

Run the same finger-flexion elicitation two ways on the same person: mirrored on both hands at once, and one hand at a time with the other hand resting uninvolved. Compare the resulting ROM bounds. This is the test that validates (or invalidates) the biggest structural assumption in the current protocol — that bilateral-by-default doesn't corrupt per-hand measurements — and it's cheap relative to what it protects: if bilateral capture turns out fine, most of the protocol's session-length savings are safe to keep; if not, this is the one result that would change the doc's default recommendation back to one-hand-at-a-time.

## Still-window auto-detection reliability

Ask several people to "hold still" for a rest-posture or comfortable-tier capture, without further coaching, and check whether the velocity-threshold still-window extraction actually finds a clean low-variance sub-window, or needs a longer hold than the 3–5 seconds currently assumed. This is a real, previously-flagged open question in `scanning.md` that's never been checked against real (imperfect) human stillness.

## Plateau-detection tuning against human judgment

Record a full flex/extend ROM sweep, run the plateau-detection algorithm, and separately have a person watch the same clip and mark by eye where the finger visibly stopped extending further. Compare the algorithm's declared convergence point and rep count against the human-judged true limit, and tune the "last _k_ cycles fail to extend by more than a small threshold" parameters against that ground truth rather than a guessed default.

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

**Capture page:** `src/routes/scan-tests/static-hold/+page.svelte`, a new, minimal SvelteKit route (it has to live under `src/routes/` for the dev server to serve it at all). It reuses the existing MediaPipe wiring rather than reimplementing it:

- Import the default export from `src/routes/scan/lib/detector.ts` the same way `src/routes/scan/+page.svelte` already does, for `estimateHands()`.
- Reuse whatever camera/`getUserMedia`/`<video>` setup that same page already has — this test needs no new camera-handling code, just a stripped-down page around the existing pattern.
- UI needed: a dropdown or three buttons to label which orientation is being recorded (`palm-facing`, `dorsal-facing`, `lateral`) — even though this first test only uses `palm-facing`, the next test in this doc reuses the same page for the other two, so building the label in now avoids rebuilding the page later — a countdown/duration display, a start/stop control, and a status line showing frames captured and current confidence score.
- On start, run a `requestAnimationFrame` (or fixed-interval) loop calling `estimateHands()` against the video element for a fixed duration (default 20 seconds), pushing one record per frame into an in-memory array. Only record if a hand of the expected handedness is present in that frame; still record its confidence score even if below the 0.7 threshold — filtering happens later, in analysis, not during capture, so the raw file always has the full picture.
- On stop (or duration elapsed), serialize the captured array plus a small metadata block to JSON and trigger a browser download via `new Blob([...], { type: 'application/json' })` and a temporary `<a download>` — this runs in the actual dev-server page in a real browser tab, not inside any sandboxed preview, so a normal file download works exactly as it would for any other page.

**Where the downloaded file goes:** the browser will drop it in the user's normal downloads folder; move it into a new `scan_tests/data/static-hold/` directory at the repo root (create it if it doesn't exist). This directory holds raw per-frame capture data, which is exactly the kind of thing that shouldn't be committed — add `scan_tests/data/` to `.gitignore`. Name the file descriptively and consistently, e.g. `palm-facing_2026-08-30T14-05-00.json` (orientation, then a filesystem-safe ISO-8601-ish timestamp) — the analysis script doesn't require a specific name, but consistent naming makes it easy to glob later when comparing multiple captures.

**Analysis script:** `scan_tests/analyze-static-hold.ts`, a plain Bun script (not a SvelteKit route, not a `bun:test` test file — this is a one-off analysis tool, not part of the app or its CI-facing test suite) living in a new top-level `scan_tests/` directory, parallel to `src/`, `docs/`, and `target/`, since it's neither app code nor a build-time asset generator (`src/model_gen/`'s existing convention is specifically for producing `target/` artifacts, which this isn't). Run it with:

```bash
bun run scan_tests/analyze-static-hold.ts scan_tests/data/static-hold/palm-facing_2026-08-30T14-05-00.json
```

It imports `makeHand` from `src/lib/hand.ts` directly (a plain TypeScript module with no DOM dependency, safe to import from a Bun script) to reconstruct each frame's bone `vectors` from the raw landmarks, exactly the way the product code does — this matters because it means the analysis is checking the same derived quantities the real pipeline would compute, not a reimplementation that could disagree with it for unrelated reasons.

### Data format

The downloaded JSON file:

```ts
interface StaticHoldCapture {
  meta: {
    capturedAt: string // ISO 8601
    orientation: 'palm-facing' | 'dorsal-facing' | 'lateral'
    handedness: 'Left' | 'Right'
    notes?: string // free text, e.g. camera model, lighting, distance
  }
  frames: Array<{
    t: number // seconds since recording start
    score: number // MediaPipe's own per-frame handedness/detection confidence
    keypoints: { x: number; y: number; z: number }[] // 21 entries, MediaPipe's `keypoints` (2D + relative depth), unmodified
    keypoints3D: { x: number; y: number; z: number }[] // 21 entries, MediaPipe's `keypoints3D` world landmarks, unmodified
  }>
}
```

`keypoints`/`keypoints3D` are stored exactly as MediaPipe's own `NormalizedLandmarkList`/`LandmarkList` shapes (array of `{x,y,z}`), specifically so a frame can be fed straight into `makeHand({ keypoints, keypoints3D, score, handedness })` in the analysis script without any reshaping — the capture page should not pre-compute bone vectors or lengths itself; keep the raw file as close to MediaPipe's own output as possible so nothing about how "bone length" gets derived is baked in before analysis time.

### What the analysis script computes

For each frame with `score >= 0.7` (matching the product's existing confidence threshold — frames below it are dropped, exactly as they would be in real capture, so the noise-floor number reflects what the real pipeline would actually see):

1. Call `makeHand(...)` to get that frame's `vectors` (one `Vector3` per bone, per `CONNECTIONS`' 20 bone segments across the 5 fingers).
2. Bone length per segment = `vector.length()`.
3. An inter-bone angle per joint (MCP/PIP/DIP-equivalent) = the angle between consecutive bone vectors in the same finger's chain, via three.js's `vectorA.angleTo(vectorB)`, converted to degrees. This doesn't need to match the product's full FK/axis-decomposition machinery for this first pass — a simple consistent relative measure is enough to characterize frame-to-frame jitter.

Then, across all accepted frames: per bone segment, the mean length, standard deviation, and coefficient of variation (`stdev / mean`, as a percentage); per joint, the mean angle and standard deviation in degrees. Print this as a plain table to stdout (20 bone rows, ~15 joint-angle rows), and also write a small `<input-file>.summary.json` alongside the input file with the same numbers in structured form, so later tests (which repeat this same analysis under different orientations or on different people) can be diffed against each other programmatically instead of by eye.

### How to interpret the result

There's no fixed pass/fail threshold defined in advance — the point of this test is to establish what the number _is_, not to check it against a guess. That said, two rough signposts worth having in mind before running it: a coefficient of variation in the low single digits (a couple of percent) for bone length, and a standard deviation of a few degrees for joint angles, would suggest MediaPipe's frame-to-frame output is stable enough that pooling/averaging across a session meaningfully reduces error rather than just averaging around a large, ever-present jitter. Numbers noticeably larger than that would be a real, first-order finding — worth stopping and reporting before building anything downstream of it, since it would call into question how much precision the rest of the protocol can actually promise.
