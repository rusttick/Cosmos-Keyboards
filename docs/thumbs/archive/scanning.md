# Scanning process: extracting a richer kinematic model

`problems.md` established that most of what limits our current model — no ROM, no neutral-pose ground truth, no cross-finger coupling data — is a **scanning problem**, not a placement-algorithm problem. This doc works through how to get that data out of the hardware we actually have: a single fixed (or hand-holdable) camera, MediaPipe Hands, and a moving hand — no depth sensor, no force plate, no EMG.

## What we're working with

- **MediaPipe Hands** gives 21 landmarks/hand/frame, 2D + a monocular "world landmark" 3D estimate. No force, no muscle activity, no true depth sensing — only what's visually inferable, frame by frame.
- **One camera.** Whether it's a webcam or a phone recording played back later, there's one viewpoint per clip. The thing we _do_ have freedom over is **which way the hand is oriented relative to that camera**, and **how many separate clips we ask for** — the hand moves, the lens doesn't (unless we ask the user to reposition the phone between clips, which is cheap and worth using).
- **Today's `/scan` pipeline** (`src/routes/scan/Recording.svelte`, `stats.ts`, `hand.ts`) is a single unstructured phase: "move your hands around for ~1000 good frames," then everything gets pooled into one mean length + one PCA-fit axis per joint. Per-frame data is discarded after aggregation. That's the specific thing that has to change for everything below.

The throughline for this whole doc: **every new signal we want needs (a) a guided, instructed sub-task, not free motion, and (b) per-frame time-series data retained through that sub-task, not just a final pooled average.** Both are pipeline changes, not new CV capability.

## The five things we want, one at a time

### 1. Joint/bone lengths — already working, one refinement worth making

Already reasonably solved (§2 of `problems.md`): average bone length across ~1000 pooled frames is low-variance. One real bias exists though: monocular length estimates are worst when a bone points toward/away from the camera (foreslortening) and best when it's roughly perpendicular to the view axis. A dedicated "hold your hand flat, fingers spread, rotate slowly" phase — weighting length samples by how perpendicular the bone was to the camera at that frame — would tighten this further. Low priority; not blocking anything else.

### 2. Neutral/resting position

**Why it's not the same as "the average of a motion recording":** today's pooled mean is the centroid of wherever the recording happened to sample, which is only equal to the true relaxed pose if the recorded motion happened to be symmetric around it — usually false. We need a dedicated _held-still_ capture, not a derived statistic from unrelated motion.

**Protocol:** explicit instruction — "let your hand fall relaxed, as if resting on a desk, hold still for ~3 seconds." Capture that as its own short segment.

**Extraction:** don't trust the whole 3-second window blindly (the user won't hold perfectly still, and the first ~0.5s is often still settling). Compute frame-to-frame joint-angle velocity across the segment and select the lowest-variance sub-window automatically — a standard motion-segmentation technique (velocity/acceleration thresholding to detect "rest" intervals), same idea used broadly in gesture and mocap segmentation. Average joint angles over that sub-window = neutral pose.

### 3. Full range of motion (anatomical limit)

This needs an **actively guided, per-joint elicitation sequence** — casual "wiggle your hand" motion never approaches true anatomical extremes for most joints. The standard clinical distinction is relevant here: **active ROM** (the client's own unassisted muscle contraction) vs. **passive ROM** (external force pushing further) — active is what we can capture with a camera and no assistant, and it's also the more relevant one for typing, since passive-only range is a few degrees beyond what any voluntary motion (including a keystroke) would ever reach anyway ([goniometry ROM protocol overview, PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC3718433/); [Intra/inter-rater reliability of goniometric finger ROM using a written protocol](https://www.archivesofphysiotherapy.com/index.php/aop/article/view/3049)).

**Protocol:** a scripted, UI-paced sequence — "flex and extend your index finger fully, 3 times" → "now your middle finger" → etc., then the same for thumb-specific joints, then MCP abduction/spread per finger. The UI drives timing (a metronome/animated prompt), so segment boundaries are known in advance rather than inferred after the fact.

**Viewpoint matters a lot here, and it's the one lever a single camera gives us.** Two relevant findings: (1) monocular estimation is worst for out-of-plane/depth-axis motion and best for motion that stays roughly in the camera's imaging plane ([Monocular 3D Hand Pose Estimation with Implicit Camera Alignment](https://arxiv.org/html/2506.11133v1)); (2) when only two viewpoints are available, the best pair is roughly 90° apart ([multi-view hand pose viewpoint selection findings](https://arxiv.org/html/2506.11133v1)). We can't get two simultaneous views from one camera, but we _can_ ask the user to reorient their hand between phases — e.g., palm-facing-camera for MCP flexion (keeps the flexion arc in-plane), then a quarter-turn for MCP abduction/spread (keeps that motion in-plane instead). This is the practical workaround for the single-camera constraint: change which DOF is "in-plane" by changing hand orientation per elicitation phase, not by adding hardware.

**A cheap upgrade worth floating, given you already record via phone:** two short clips from two orientations ~90° apart (e.g. one facing the camera, one from the side), rather than one continuous clip. Since you're already recording video files and copying them over, this costs nothing extra and gives a real second viewpoint for cross-checking, not just a reoriented single view.

**Extraction:** retain per-frame joint angles through each elicitation segment (not just pooled stats), take min/max within that segment's known time window. Filter both by MediaPipe confidence (already done, threshold 0.7) and by motion-blur/high-jerk frames near the true extremes, where tracking is least reliable — expect to need a "did we get enough valid frames" check per segment with a retry prompt if not.

### 4. Comfortable range (the subset that actually matters for RSI)

Full anatomical ROM and _comfortable_ ROM are different things, and this is the one signal we genuinely can't infer purely from kinematics — we have no force/EMG/strain sensor, so "this is starting to hurt" isn't visually observable. This has to be **self-reported through the instruction**, same as clinical practice distinguishes active/passive/functional ROM as different _instructed conditions_, not different measurement techniques.

**Protocol:** two explicit tiers per elicitation phase instead of one — "move to your comfortable maximum, without strain, hold" (tier 1), then separately "now push to your true limit" (tier 2, this is where §3's full-ROM data comes from). Tier 1's held pose gets the same still-window extraction as §2's neutral-pose capture.

**A speculative secondary signal, worth prototyping but not relying on:** per Flash & Hogan's minimum-jerk framework (`problems.md` §3), comfortable voluntary motion tends toward smooth, symmetric bell-shaped velocity profiles; motion near a genuinely strained limit often shows hesitation or asymmetric deceleration. In principle the velocity-profile _shape_ during tier 2's push-to-limit could auto-flag where discomfort likely started, cross-checking the self-reported tier-1 boundary. Flag this as exploratory — there's no established validation that this generalizes reliably to finger joints specifically, so treat tier-1's explicit self-report as ground truth and this as, at best, a sanity check.

### 5. Cross-finger interaction: dragging and blocking (enslavement + collision, unified)

These looked like two separate problems in an earlier draft of this doc, but they're not — or rather, three mechanisms are bundled under what was being called "collision," and two of the three share a measurement method with enslaving:

1. **Active neuro-muscular enslaving** ("dragging") — shared tendon/cortical drive causes finger _j_ to move involuntarily when finger _i_ moves, even with fingers held apart in free air. Roughly config-independent: the coupling doesn't depend much on where the fingers currently are.
2. **Passive mechanical coupling** — connective tissue/webbing between adjacent fingers limits independent movement once they've separated past a threshold. Unlike (1), this _is_ configuration-dependent, and the literature treats it as a distinct cause of "enslaving," separate from the neural component ([Human Finger Independence: Limitations due to Passive Mechanical Coupling Versus Active Neuromuscular Control, J Neurophysiol](https://journals.physiology.org/doi/full/10.1152/jn.00480.2004)).
3. **Rigid mechanical blocking** ("pushing out of the way") — one finger's flesh/joint physically obstructing another's path. Pure geometry; would exist even in a robot hand with fully independent motors.

(1) is a genuinely different phenomenon from (2)/(3) — it's about shared drive, not physical space, and happens with fingers nowhere near each other. But (2) and (3) can be **measured the same way, and the earlier plan to model collision from a guessed finger-width was the wrong approach** — better to sample it directly. If we systematically vary both fingers' configurations during elicitation and record what MediaPipe successfully tracks, **physically-blocked configurations simply won't appear as reachable in the data** — collision/blocking shows up as gaps in the observed joint-angle-pair space, not as something computed from an assumed finger geometry. No width guess needed for the finger-vs-finger blocking question; it falls out of good elicitation coverage.

**Unified protocol:** paired-finger sweeps with full per-frame angle capture for both fingers throughout, varied by instruction:

- **Drag condition** (surfaces mechanism 1, and 2 wherever it's active): "move only finger _i_ — keep finger _j_ as relaxed and still as possible." Fit `E[i][j] ≈ Δangle_j / Δangle_i` via linear regression over the segment — this is the standard enslaving-matrix method, ported from isometric force to unloaded kinematic angle, and produces a _personalized_ matrix rather than borrowing literature coefficients (worth doing regardless, since the literature notes enslaving is individual — [PMC: origin of finger enslaving](https://pmc.ncbi.nlm.nih.gov/articles/PMC7814910/)).
- **Block condition** (surfaces mechanisms 2 and 3, not distinguished from angle data alone — and they don't need to be, for placement purposes): "move finger _i_ through its full range while finger _j_ is actively held at [varied target positions across _j_'s own range]." Record, for each fixed _j_ position, the achievable max/min angle of _i_. The resulting `(θ_i, θ_j)` pairs that were never successfully reached, despite the elicitation asking for them, define an empirical **prohibited-region boundary** for that finger pair — a measured constraint, not a modeled one.

**Two honest limitations to flag:**

- **Coverage.** This only tells us about configurations actually attempted during elicitation. Unlike a single-finger ROM sweep, a paired-configuration space is much bigger to cover — this is more scan time and a more complex protocol than either enslaving or collision would have needed alone. Worth scoping how coarse a grid of `j` target positions is "good enough" before committing to a full combinatorial sweep.
- **Tracking degrades exactly where we need it most.** MediaPipe confidence drops with occlusion and closely-spaced/overlapping fingers (§3's viewpoint discussion) — which is precisely the region near a blocking boundary. Expect noisier data right at the boundary we're trying to measure, and plan for a wider confidence-filtering margin there than elsewhere.

**Methodological note on the drag condition specifically:** the literature's enslaving-matrix method uses instructed isometric maximal-force trials under controlled lab conditions; ours is self-instructed, unloaded, freely-moving, consumer video. That's a real gap from the classic method — but it's arguably _more_ representative of typing itself (low-force, dynamic, unloaded) than the isometric literature is. Soechting & Flanders' typing-specific study measured correlated finger motion during real keystrokes, not isometric force, and is the closer methodological precedent for what we're building here ([Flexibility and repeatability of finger movements during typing, PubMed](https://pubmed.ncbi.nlm.nih.gov/9046450/)).

**What stays genuinely separate — and needs no scan data at all:** whether two _chosen key positions_ (a downstream design decision, made after scanning) have physically overlapping keycap footprints is pure key geometry — footprint dimensions vs. computed 3D positions — nothing about finger width or tissue is involved. Don't conflate this with the finger-vs-finger blocking question above; the earlier draft did, and that's the mistake being corrected here.

## Wrist position: out of scope for scanning, and that's the right call

An earlier draft of this doc proposed capturing wrist ROM/neutral position the same way as finger ROM — a guided elicitation with the forearm "anchored" against the desk, inferring wrist angle from how the hand's frame rotates relative to that anchor. That idea doesn't survive contact with how a wrist actually needs to be constrained, and it's worth recording why, so it doesn't get re-proposed later without this context.

**The core problem: nothing short of skeletal fixation actually holds a forearm still enough.** Pinning one bony point (e.g. the ulnar styloid against a desk-clamped block) constrains translation of that point but leaves the forearm free to rotate around it — a single point contact is a ball joint, not a rigid mount. Preventing that rotation without also constraining muscle/tendon deformation would require bone-only contact at both the wrist _and_ the elbow simultaneously — that's an external fixator, not a desk fixture. This is a hardware/anatomy limit, not a protocol-design problem, and no amount of scan-UI cleverness fixes it.

**The deeper issue underneath that: MediaPipe Hands gives us no elbow/forearm landmark at all**, so even a well-constrained forearm would only let us _infer_ wrist angle indirectly (hand-frame rotation relative to an assumed-fixed reference) — never measure it directly. Chasing better mechanical constraint was solving the wrong end of the problem.

**Resolution: leave the scan alone, and treat wrist/forearm placement as what it actually is — a manual placement decision, not a measurement.** Everything in §1–§5 above (bone lengths, joint axes, finger ROM, finger interaction) works because it's computed _within_ the hand's own self-built frame (`makeBasis`) — none of it needs to know how the wrist is oriented in the world, only how the fingers relate to the palm. The scan should stop exactly there. Nothing about wrist/forearm posture belongs in the capture protocol.

**Where wrist/forearm placement belongs instead: `SolvedHand.position`, made interactive.** This transform already exists in the codebase as a free 6-DOF anchor for the whole hand assembly — today it's either hardcoded (`Pose.svelte`, `Stage.svelte`) or derived from the wrist-rest shell geometry (`Viewer3D.svelte`), never scanned or solved. That's not a gap to close with better tracking — it's the right architecture already. The fix is a UI, not a protocol: let the user drag/rotate the whole hand model (built entirely from the _reliable_ scanned finger data) into position relative to the virtual keyboard surface, by eye and feel, the same way tenting is set manually today — except now there's an actual posed hand to judge the placement against instead of an abstract angle number.

**Two things worth adding to that placement UI, both purely advisory:**

- **A visual forearm/elbow line** extending from landmark 0, using a literature-typical forearm length by default (or a user-entered tape-measure value for a bit more personalization) — a sanity-check aid for "does this look like an achievable arm posture," not tracked or measured data. Label it as illustrative in the UI so it's never mistaken for scan output.
- **Live guardrail feedback using the wrist-posture literature**, cited below: as the user drags the hand into position, compute the implied wrist extension/deviation angle (straightforward, since it's just the angle between the placement transform and neutral) and surface it — e.g. "this placement implies ~X° of wrist extension; carpal tunnel pressure rises measurably above 30°." Same numbers originally proposed as a scanned personalized target, repurposed as feedback on a human choice instead of ground truth for an automated one. Normative wrist ROM for the guardrail bounds: ~73° flexion, ~71° extension, ~19° radial deviation, ~33° ulnar deviation ([Functional ranges of motion of the wrist joint](https://pubmed.ncbi.nlm.nih.gov/1861019/)); pressure thresholds around 30° extension / 15° radial deviation ([Effect of Wrist Posture on Carpal Tunnel Pressure While Typing](https://pubmed.ncbi.nlm.nih.gov/18383144/); [Guidelines for Wrist Posture Based on Carpal Tunnel Pressure Thresholds](https://www.researchgate.net/publication/6490035_Guidelines_for_Wrist_Posture_Based_on_Carpal_Tunnel_Pressure_Thresholds)); flexion-extension and radial-ulnar deviation are coupled, not independent ([Coupling between wrist flexion-extension and radial-ulnar deviation](https://pubmed.ncbi.nlm.nih.gov/15621323/)), worth reflecting in how the guardrail's bounds interact rather than treating the two axes independently.

See `problems.md`'s tenting section for how this reframes the "replace tenting with wrist data" idea into something honest about what's measured vs. chosen.

**Not pursued, and now unlikely to be worth it:** MediaPipe Pose (elbow/shoulder tracking) was floated earlier as a fallback if the desk-anchoring trick proved too noisy. Given the trick itself is what's being abandoned here — not just its noise level — adding a second CV model to solve a problem we've decided to route around manually isn't justified. Revisit only if a future need for genuinely _measured_ (not manually placed) wrist data emerges.

## Cross-cutting pipeline changes this all requires

None of the above needs new CV capability — MediaPipe already gives everything at the landmark level. What's missing is entirely on our side:

1. **A scripted, multi-phase capture UI**, replacing today's single unstructured "move around" phase — a paced sequence of instructed sub-tasks (rest-hold → per-finger full ROM at 2 tiers → paired drag/block trials → an orientation change or two). Wrist/forearm data is explicitly not part of this sequence — see above. The UI tracks segment boundaries so post-processing knows which frames belong to which elicitation.
2. **Retaining per-frame joint-angle time series through each segment, for both fingers in a pair**, not just accumulating pooled sums like `stats.ts` does today — a structural change to what gets kept, not to how angles are computed (the FK/joint math already exists).
3. **Automatic still-window / motion-segmentation detection** (velocity-threshold-based) for the neutral and comfortable-hold captures, so we're robust to a user who doesn't hold perfectly still on cue.
4. **Per-phase orientation instructions**, chosen so the DOF being measured stays roughly in-plane relative to the camera — the practical answer to "one fixed camera" is "the hand reorients between phases, not the camera."
5. **A retry/quality-gate per segment** ("didn't get enough confident frames for that one, let's redo it") rather than silently accepting whatever was captured, since guided-motion phases are shorter and more failure-sensitive than today's long free-motion capture — and widen the confidence margin specifically for the block-condition trials in §5, where tracking is weakest right at the boundary being measured.
6. **An interactive `SolvedHand.position` placement UI**, per the wrist section above — the manual-placement replacement for what was going to be a wrist-scan phase. Separate piece of work from items 1–5, doesn't touch the capture pipeline at all.

## Open questions to validate before committing engineering effort

- Does the still-window auto-detection (item 3) actually work reliably on real recordings, or does it need a much longer hold-still instruction than 3 seconds to find a clean window?
- How much does hand reorientation between phases (item 4) actually improve angle accuracy in practice, versus just being extra friction in the scan process — worth a quick before/after comparison on one phase before building the whole sequence.
- Is self-instructed finger isolation (§5, drag condition) actually achievable by most people without practice, or does it need a short "try this first" warmup, given that true single-finger independence is limited even in principle (`problems.md` §3)?
- How coarse can the block-condition's grid of partner-finger target positions be before the measured prohibited-region boundary stops being useful — this determines whether §5 is a short addition to the scan or a substantially longer one.
- For the placement UI's guardrail feedback: is a default literature forearm length good enough for the visual aid, or does it need the user-entered measurement to look convincing enough to be useful rather than distracting?

## Sources

- [Analysis of the reliability and reproducibility of goniometry compared to hand photogrammetry — PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC3718433/)
- [Intra- and inter-rater reliability of goniometric finger range of motion using a written protocol — Archives of Physiotherapy](https://www.archivesofphysiotherapy.com/index.php/aop/article/view/3049)
- [Monocular 3D Hand Pose Estimation with Implicit Camera Alignment — arXiv](https://arxiv.org/html/2506.11133v1)
- [Matrix analyses of interaction among fingers in static force production tasks — Biological Cybernetics](https://link.springer.com/article/10.1007/s004220050466)
- [On the origin of finger enslaving: control with referent coordinates and effects of visual feedback — PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC7814910/)
- [Flexibility and repeatability of finger movements during typing: analysis of multiple degrees of freedom — PubMed (Soechting & Flanders, 1997)](https://pubmed.ncbi.nlm.nih.gov/9046450/)
- [Functional ranges of motion of the wrist joint — PubMed](https://pubmed.ncbi.nlm.nih.gov/1861019/)
- [Coupling between wrist flexion-extension and radial-ulnar deviation — PubMed](https://pubmed.ncbi.nlm.nih.gov/15621323/)
- [Effect of Wrist Posture on Carpal Tunnel Pressure While Typing — PubMed](https://pubmed.ncbi.nlm.nih.gov/18383144/)
- [Guidelines for Wrist Posture Based on Carpal Tunnel Pressure Thresholds — ResearchGate](https://www.researchgate.net/publication/6490035_Guidelines_for_Wrist_Posture_Based_on_Carpal_Tunnel_Pressure_Thresholds)

See also `docs/thumbs/problems.md` for the biomechanical grounding (RSI risk factors, ROM literature, minimum-jerk motor control, enslaving) this protocol is designed to fill in.
