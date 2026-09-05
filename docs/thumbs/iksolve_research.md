# Constrained IK with staged anatomical priors: research and design

This document proposes a replacement for the current live-tracking model — where every frame is solved independently from `fitNorms()`/`calculateJoints()` with no memory of anything learned before it — with a **constrained inverse-kinematics solve driven by a personalized, progressively-completed anatomical model**. It's the connective tissue between the deliberate capture protocol `scan_procedure.md` already specifies and the open question of how a _live_ scan or design session should use that captured data to correct or stabilize per-frame MediaPipe output, rather than only consuming it after the fact for keyboard placement.

Nothing here changes `scan_procedure.md`'s capture protocol itself (orientation rules, phase order, completion detectors) — those stay as designed. What changes is what consumes a phase's output: instead of writing a finished number straight to `HandData` and never touching it again, each phase's result becomes a _prior_ in a running kinematic model, with a confidence value, that the live IK solver both consumes (as a constraint) and helps refine (by producing better-conditioned pose histories for the next phase to fit against). No implementation has started; this is a design proposal to be reviewed before any code is written.

## Why not just let bone lengths self-calibrate from arbitrary movement?

This was the first branch point worth resolving, since it changes the whole shape of the design: could accumulated frames from ordinary, unscripted hand movement converge on an accurate personalized skeleton on their own, making a deliberate scan procedure unnecessary?

**The technique is real.** Robotics has a well-established line of work on exactly this — augmenting a Kalman/particle filter's state with the kinematic parameters themselves (link lengths, joint offsets) alongside pose, giving those parameters near-zero process noise (they don't change frame to frame), and letting the filter converge on them over time _given enough motion diversity_ ("persistent excitation" in the control-theory sense) ([IMU-based online kinematic calibration of a robot manipulator](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC3835480/); [self-calibrating optical motion tracking for articulated bodies](https://www.researchgate.net/publication/4165373_Self-calibrating_optical_motion_tracking_for_articulated_bodies); [simultaneous hand pose and skeleton bone-length estimation from a single depth image](https://www.researchgate.net/publication/321719432_Simultaneous_Hand_Pose_and_Skeleton_Bone-Lengths_Estimation_from_a_Single_Depth_Image)). This is structurally the same problem as camera self-calibration or SLAM: static parameters, dynamic state, solved jointly online.

**It's the wrong tool here, for a reason this project already proved empirically.** Self-calibration only cancels _random_ per-frame noise by averaging over many samples — it has no mechanism to detect a _systematic, orientation-dependent bias_, and `test_results.md`'s Test 3 (2026-08-31) already found exactly that kind of bias: `thumb-away` consistently shrinks thumb bone 0 by 7–13% and inflates bones 1–3 by 16–44%, reproducibly, across independent sessions and both hands. An unsupervised filter fed uncontrolled motion has no internal signal telling it the "consensus" it's converging toward is wrong — the bias doesn't average out, it _becomes_ the filter's new ground truth, confidently. Only an external reference (a caliper) can catch that, which is the whole reason `scan_procedure.md` already includes one.

**Conclusion carried into this design:** bone lengths (and by extension axes, ROM, coupling) are only ever allowed to become trusted priors through the deliberate, orientation-restricted capture protocol already specified — optionally cross-checked against a direct physical measurement — never through blind accumulation of arbitrary motion. The rest of this document describes how a _partial_ set of such priors can still be used productively before the full set exists, and how the set grows in a controlled, gated way.

## Choosing which measurements to trust externally

A related question: given that multiple external (caliper/ruler) ground-truth measurements are possible, which landmark pairs are worth anchoring this way? The answer comes from data this project already has, not new research — `test_results.md`'s Test 1 established that:

- Proximal landmarks (wrist, MCPs) are consistently lower-noise than distal ones (PIP/DIP/tip) in every orientation tested.
- `palm-facing` is the only orientation where non-thumb fingers are both low-noise (1.7–2.8% bone-length CV) and low-bias.
- The thumb carries a _systematic_ bias in non-palm-facing orientations (Test 3), on top of being disproportionately noisy even in `palm-away` (Test 1's secondary finding: 5–8.5% CV vs. 2–5% for other fingers).
- The wrist-as-CMC-pivot assumption was tested and retracted (2026-09-01ish entries) — don't anchor a measurement to a pivot location whose own position isn't trusted yet.

This is corroborated independently in the literature: the wrist landmark is generally the most stable of MediaPipe's 21 because it's tracked within a much larger surface area than any finger landmark, reducing the depth-ambiguity problem that hits fingertip landmarks hardest ([MediaPipe/GMH-D clinical validation](https://www.sciencedirect.com/science/article/pii/S1746809424005664)). Depth/Z accuracy in general is the weak axis for any RGB-only (non-depth-sensor) monocular system, MediaPipe included — there is no depth channel to ground it.

**Selection rule:**

| Tier                                           | Landmark pairs                                              | Treatment                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Good — anchor with an external measurement     | wrist(0)→MCP(5,9,13,17); MCP→PIP on index/middle/ring/pinky | Fixed prior from day one, cross-validated for consistency across repeated palm-facing captures                                                                                                                                                                                                   |
| Marginal — usable, wider tolerance             | PIP→DIP→tip on the four non-thumb fingers                   | Fixed once averaged over enough frames; don't expect caliper-grade agreement                                                                                                                                                                                                                     |
| Do not anchor via MediaPipe-mapped measurement | any thumb segment, in any orientation                       | Either caliper the thumb bones directly (bypasses MediaPipe's length-reading bias entirely, since no video measurement is involved) or treat as Learned with a wide anthropometric prior — never derive its length by mapping a caliper measurement onto MediaPipe's own reported thumb geometry |
| Excluded entirely                              | anything requiring dorsal orientation                       | Already excluded by `scan_procedure.md`'s hard rule                                                                                                                                                                                                                                              |

Hand-anthropometry literature is a plausible fallback prior for whatever isn't calipered directly: digit-segment lengths scale from a single reference length (typically overall hand length) with documented regression models, but reliability varies a lot by segment — R² between 0.49 and 0.99 depending on which segment ([Anthropometric data for describing the kinematics of the human hand](https://pubmed.ncbi.nlm.nih.gov/1572336/); [Proportions of Hand Segments](https://scielo.conicyt.cl/pdf/ijmorphol/v28n3/art15.pdf)) — i.e., the literature's own version of "some segments predict well from one anchor, others (the thumb, again) don't," matching this project's own findings independently.

## Prior state: `Fixed` vs. `Learned`

Every anatomical quantity in the model — bone length, joint axis direction, ROM bound, DIP/PIP coupling coefficient, enslaving coefficient — carries one of two states:

- **`Fixed`**: known, hard-constrained in the IK solve, never re-estimated. Seeded from a direct physical measurement (caliper/ruler) for whichever segments the table above marks as trustworthy, or promoted here later (see below) once a `Learned` quantity converges under gate criteria.
- **`Learned`**: not yet trustworthy. Carries a current best-guess value and a confidence/variance. Seeded either from a wide population prior (the anthropometric ratio literature, for lengths) or as fully uninformative (for axes, ROM, coupling, which have no equivalent "measure it with calipers" option).

At the very start of a new hand's model, `Fixed` may contain almost nothing — say, just the wrist→MCP anchors for four fingers, if that's all that's been measured. Everything else starts `Learned`. The system is designed to be useful in that state, not just in its fully-converged end state.

## The per-frame constrained IK solve

A small nonlinear least-squares problem (Gauss-Newton or Levenberg-Marquardt; roughly 20–30 DOF for one hand — cheap to run every frame), replacing today's independent-per-frame `fitNorms()`/`calculateJoints()` computation for live tracking:

- **`Fixed` priors** are baked into the forward-kinematics chain as hard equality constraints — they are not solved-for parameters, and they reduce the effective DOF of the problem by however many they cover. This is the mechanism through which "only a few priors" is still useful on day one: even a handful of Fixed anchors immediately makes the whole solve better-conditioned than solving with zero constraints, the same benefit hierarchical robot-arm calibration gets from fixing proximal links before attempting distal ones ([Review on Kinematics Calibration Technology of Serial Robots](https://www.researchgate.net/publication/278649160_Review_on_Kinematics_Calibration_Technology_of_Serial_Robots) — link-by-link calibration, with the caveat that errors compound distally, which is exactly why anchoring the _most reliable_ links first matters).
- **`Learned` quantities** enter as soft regularization terms — a penalty pulling the solve toward the current best-guess value, weighted by that value's confidence. Low confidence means the term barely constrains the solve (behaves close to a free parameter); as confidence grows, the same term increasingly behaves like a `Fixed` constraint, with no discrete cutover required.
- **Objective function**, standard for this class of problem ([kinematic skeleton fitting with fixed bone lengths, from 2D keypoints](https://arxiv.org/pdf/1712.03866); [constrained IK for real-time hand tracking](https://www.researchgate.net/publication/224137742_Motion_capture_with_constrained_inverse_kinematics_for_real-time_hand_tracking)): confidence-weighted landmark reprojection error, plus the `Learned`-prior regularization terms above, plus a soft ROM-limit penalty (using whatever ROM bound is currently known, permissive/wide if not yet converged), plus temporal smoothness against the previous frame's solved pose (which also serves as the warm start).
- **Confidence weighting per landmark**: this project already found (2026-09-03 entry) that `hand.score` doesn't predict tracking quality. The proposed substitute, which directly reuses the scanned model rather than needing a new MediaPipe-native signal: compare each frame's raw (pre-fit) bone length for a given segment against that segment's known `Fixed` length. A bone reading e.g. 40% longer/shorter than its known-true length is the tell that this frame's landmarks for that segment are corrupted (occlusion, foreshortening, a tracking glitch) — down-weight or drop it from the objective for that frame. This only works for segments that already have a `Fixed` length, which is one more reason to get the reliable anchors established early.
- **Output every frame**: the solved pose (joint angles, global hand position/orientation), plus the residual — how well the current prior set explains this frame's observations, useful as a live diagnostic independent of anything else.

This directly answers "how do you do constrained IK with only a few priors": you don't need a complete model to benefit from this approach. Partial constraints already reduce degeneracy versus today's zero-memory, all-independent-every-frame computation.

## Turning solved frames back into better priors

This is `scan_procedure.md`'s existing phase structure, unchanged in its capture instructions, but re-plumbed to read from the IK solver's output and to close into an explicit loop rather than a one-shot write to `HandData`:

1. Run a capture phase (e.g., the index-finger flexion sweep) using whatever prior set currently exists — however incomplete.
2. Because the solve is already constrained by whatever `Fixed` priors exist, the resulting pose history is better-conditioned for fitting than an independent per-frame computation would produce — the same benefit a hierarchical calibration gets from doing well-observed links first.
3. Feed that pose history into the phase's existing extraction logic — `fitDipPipCoupling`, the plateau detector, `fitEnslaving`, still-window bone-length harvesting (`stillWindow.ts`, `plateau.ts`) — all already built and empirically tuned (Tests 6/7).
4. **Promotion gate.** When a `Learned` quantity's fit converges by its phase's own criterion, it is not automatically trusted — it must additionally pass the same guardrails established above: captured in a permitted orientation (never dorsal, never a known-biased lateral-thumb angle for the thumb specifically); stable across repeated sessions; and, where a direct physical measurement exists, in agreement with it. Only if it passes does its state flip: confidence jumps, and it behaves as `Fixed` in every subsequent solve, for this hand, from then on.
5. Proceed to the next phase. It now runs against a model with strictly more `Fixed` constraints than the previous phase had available — each phase both benefits from the last phase's promotions and produces its own for the next. Promotion is gated by convergence-and-consistency checks already built into this project's tooling, not by the optimizer's own confidence, which is the direct safeguard against the "self-calibration converges on a confidently-wrong model" failure mode described above — nothing gets promoted just because the solver likes it.

Thumb-CMC still goes last in this ordering, per `scan_procedure.md`'s existing reasoning (most complex, most occlusion- and bias-prone) — and benefits the most from this design, since by the time it's attempted every other joint's geometry is already `Fixed`, leaving the solve fewer unknowns to explain the thumb's own noisier signal with. If the thumb's bone lengths are calipered directly (bypassing MediaPipe's length-reading bias entirely, since a physical caliper measurement involves no video at all), only its axis, ROM, and conjunct-rotation coupling remain `Learned` — the quantities that structurally cannot be measured with calipers regardless of how careful the measurement is.

## Where this lives in the code

- New module, e.g. `src/routes/scan3/lib/ikSolve.ts`: the Gauss-Newton/Levenberg-Marquardt solver, parameterized by a `KinematicPriors` object:

  ```ts
  interface PriorValue<T> {
    value: T
    confidence: number // 0 = fully uninformative, 1 = Fixed
    fixed: boolean
  }

  interface KinematicPriors {
    lengths: Record<Bone, PriorValue<number>>
    axes: Record<Joint, PriorValue<Vector3Tuple>>
    rom: Record<Joint, PriorValue<[number, number]>>
    dipCoupling: Partial<Record<Finger, PriorValue<DipPipCoupling>>>
    enslaving: PriorValue<Enslaving> // per finger pair
  }
  ```

- Each existing `scan3/lib/phases/*.ts` extraction function keeps its current shape and completion detector, but its input becomes `ikSolve`'s pose output instead of raw `Hand`/`fitNorms` history.
- A `promotePrior()` step, called from each phase's completion handler, applies the gate criteria above and updates `KinematicPriors` in place — this is the one new piece of logic this design actually requires beyond the solver itself.
- Post-scan (or once every relevant field is `Fixed`), live tracking calls `ikSolve` with the fully-promoted `KinematicPriors` — solving pose only, all lengths/axes/ROM held constant — which is the eventual "positioned by MediaPipe video input" runtime behavior this whole design is aimed at.
- Downstream of `ikSolve`, the existing landmark-space filtering (`landmarkFilter.ts`'s despike + One Euro, in `detector.ts`) is unaffected and stays exactly as-is — it cleans the raw landmark signal that feeds _into_ the IK solve's objective function, a different stage of the pipeline serving a different purpose (general input hygiene vs. confidence-gated model fitting), not a redundant or competing filter.

## Open questions, not resolved here

- Confidence-weight calibration for the `Learned`-prior regularization terms (how quickly a term should transition from "barely constrains" to "acts fixed") needs live tuning against real capture, consistent with this whole project's established practice of not trusting guessed parameters (Tests 6/7's threshold recalibrations, the One Euro filter's live-tuned `minCutoff`/`beta`).
- Whether the bone-length-deviation-from-`Fixed`-value confidence signal is a good enough substitute for per-landmark visibility across all the ways a frame can go bad (occlusion vs. motion blur vs. basis drift under whole-arm rotation, per the 2026-09-04 rotation-vs-flexion findings) is untested.
- Whether to caliper the thumb bones directly (removing thumb length from `Learned` entirely) or accept an anthropometric-prior/wide-uncertainty treatment is a product decision, not resolved by this document.
- The IK solver's own robustness to a genuinely bad initial guess (cold start, no previous frame to warm-start from) isn't designed here — likely needs the same "easy pose to bootstrap into a hard one" property MediaPipe's own detector already relies on (per the 2026-08-30 entry).

## See also

- `docs/thumbs/scan_procedure.md` — the capture protocol whose phases feed this design; unchanged by it.
- `docs/thumbs/scan3.md` — the implementation architecture for capture (`HandData`, `ScanSession`, phase modules) this design builds directly on top of.
- `docs/thumbs/test_results.md` — the empirical record (noise floors, thumb bias, handedness/orientation findings) every reliability judgment in this document is drawn from.
