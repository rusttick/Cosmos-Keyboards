# Project goals and acceptance criteria (v2)

Re-statement of the project's objective and success criteria,
written after the scan-tests research (`test_results.md`) and the IK design proposal (`iksolve_research.md`).
Supersedes the informal goal in earlier docs.

## Goal statement

Replace cosmos-keyboards' current keyboard-design input model — a small set of hand-shape parameters tuned to fit the existing dactyl-style parametric solver —
with a **personalized 3D hand model measured from a single consumer webcam via MediaPipe**,
precise enough to drive a **less constrained keyboard geometry generator**
that places keys directly against the wearer's actual measured hand geometry (bone lengths, joint axes, ROM, per-finger coupling)
rather than against the dactyl solver's built-in assumptions about hand shape.

The deliverable is not "a better dactyl config." It's two independent artifacts:

1. A **hand model** — a joint probability distribution over a per-user set of anatomical quantities (lengths, axes, ROM, coupling),
   seeded from a cited reference-population prior
   and narrowed toward the specific hand as single-hand MediaPipe Hands, caliper, and manual-numeric-entry observations arrive.

2. A **keyboard geometry generator** that consumes that distribution directly (not through the dactyl solver's parameter set)
   and produces a 3D-printable, hand-wireable keyboard shape — built and validated first against the reference-population mean hand,
   then continuously re-driven as the individual's posterior narrows.

Success is not "MediaPipe tracks perfectly" — it demonstrably doesn't,
and the research to date (noise floors, orientation bias, thumb distortion) is about characterizing and compensating for that, not eliminating it.

Success is: **for each anatomical quantity the keyboard generator needs,
is the posterior narrow enough to weight it strongly in the generator's solve,
and does the generator degrade smoothly toward the population prior as it isn't?**

The project is done when every input the generator needs is backed by:

1. a literature-grounded prior
2. a defined observation/update process
3. a generator behavior across the whole range of posterior confidence

Do not attempt to achieve flawless tracking.

## Hand model evaluation criteria

Every joint's motion model and every bone-length prior must match documented biomechanics, not an assumed uniform single-axis model.

The hand model is one joint probability distribution — mean vector + covariance — over all bone lengths and joint parameters,
not a collection of independent per-attribute numbers;
a confident measurement on one quantity should narrow uncertainty on quantities the literature says are correlated with it.

### Prior: a correlated, literature-grounded reference hand

- **Bone lengths**: distribution over length _ratios_ to one reference length (overall hand length),
  lognormal per segment (ratio-scale, strictly positive),
  with a full covariance across segments
  so measuring one segment narrows correlated segments (published regression R² between 0.49 and 0.99 depending on segment).
  Sourced from one deliberately chosen, cited anthropometric study, documented as an engineering starting point calibrated to this project's expected users
  — not a biological universal,
  and not a blend of incompatible studies.

- **Joint ROM**: a bounded distribution per DOF (e.g. Beta scaled to that joint's anatomical stop),
  not an unbounded Gaussian — a joint cannot flex past its ligament limit with nonzero probability.
  Seeded from published ROM studies (mean/SD per joint — e.g. MCP ≈90° flexion, PIP ≈90°, DIP ≈45–50°, reported SDs on the order of 6–17°),
  correlated with the bone-length draw only where the literature supports that link.

- **Forearm length**: one more entry in the same correlated bone-length distribution, ratio-anchored to hand length. No direct hand↔forearm regression is cited here yet — seed indirectly from the fact that both segments independently regress strongly against stature (forearm-length↔stature r>0.9), and source a direct regression before this is trusted further. This is the one wrist/forearm quantity with a caliper channel (below); everything else in that group is an angle, not a length, and has none.

- **Joint motion model**: per joint type, not one generic axis assumption — see 2.2.

### Per-joint-type motion model

**PIP / DIP (all fingers)** — true 1-DOF hinges.
Single-axis fit is the correct model here;
update signal is the existing plateau-detector ROM convergence and axis-fit confidence,
unchanged from prior work.

**MCP (index–pinky)** — flexion/extension dominates,
but abduction/adduction is a real second axis coupled to it
(widest near extension, mechanically choked as the joint flexes toward it, per collateral-ligament tightening),
plus a smaller flexion-phase-dependent axial rotation documented by 4D-CT studies
(e.g. the index finger pronates through early flexion, supinates through late flexion).
Model as 2 primary, flexion-coupled axes plus a low-weight third axial term — never a single pooled axis.
This is also the retroactive explanation for Test 4's own finding:
fitted axis confidence for real finger flexion stayed low (1.3–1.9) throughout,
because a single-axis model was being asked to explain motion that structurally has 2–3 coupled axes.

**CMC mobility (thumb, and ring/pinky)** — a joint category the current model has no representation for at all.

- Thumb CMC: a saddle joint with 2 actively-controlled axes (flexion/extension, abduction/adduction)
  whose combination produces axial rotation as an emergent, not independently drivable, conjunct rotation
  (passively stabilized to roughly ±3° under load).
  Reported ROM ≈53° flex/ext, ≈42° ab/ad, ≈17° axial informs this prior directly.

- Ring/pinky CMC: unlike the near-rigid index/middle CMC, these two joints independently flex ≈15–30° toward the thumb to cup the palm —
  a DOF proximal to the MCP that motion previously attributed to "the MCP"
  (the rolling behavior observed in the ring/pinky proximal segments) may actually originate from.
  Modeled as its own axis with its own prior and confidence,
  never folded into the MCP model or left unrepresented.

- Both carry the same orientation-bias exclusion rule as thumb bone length:
  observations from a biased or occluded capture condition are excluded from the update entirely, never smoothed in by volume.

**Wrist and proximal arm (landmark 0 and beyond)** — another category with no prior representation, and the one whose measurement channels are structurally different from every joint above it, but **not a category outside the same coupled model.** It is modeled as an always-occluded node in the same joint distribution as every finger joint: it never carries a direct, decomposable data term, but it updates through exactly the same shared-covariance mechanism a temporarily-occluded finger uses on a single bad frame — permanent rather than transient, not structurally different (see "Update mechanism" below for how a correlated-but-unobserved dimension still narrows).

- Wrist itself is biaxial: flexion/extension and radial/ulnar deviation (ROM ≈85°/85°, ≈15°/45°), coupled rather than independent — the natural "dart-throwing motion" plane pairs extension with radial deviation and flexion with ulnar deviation. Wrist angle is further correlated with finger-joint rest posture and press-force capacity via the tenodesis effect (wrist extension passively drives finger flexion; grip/press force peaks near ≈35° extension/≈7° ulnar deviation and falls off toward neutral) — this correlation is one of the model's few named cross-group covariance entries (listed under "Update mechanism" below), not a separate rule bolted on the side, and it is exactly the channel through which a confident finger-rest-posture reading narrows the wrist-DOF posterior despite no direct wrist observation ever existing.
- Forearm pronation/supination is a distinct, more proximal joint (radioulnar, not wrist) but is the third rotational quantity determining the wrist's orientation; modeled alongside the two wrist DOF above rather than folded into either.
- Elbow flexion and swivel angle (the arm's redundant DOF — for a fixed wrist pose, the elbow can still rotate about the shoulder-wrist axis) are seeded from desk-ergonomics ROM guidance (flexion ≈90–110°) and a published swivel-angle criterion (elbow rotates such that the palm tends toward the head; <5° error against measured reaching movements) — the reaching-task origin of that criterion is a real caveat, since it's unvalidated for sustained typing posture specifically. Swivel angle is itself correlated with wrist pose and forearm length (the criterion is defined in terms of both) — the third named cross-group entry.
- **Measurement channels are narrower here than elsewhere, but not absent.** This project scopes all measurement inputs to single-hand MediaPipe Hands landmarks, offline caliper/goniometer measurement, and manual numeric entry — MediaPipe Pose (or any other multi-body-part tracker) is explicitly out of scope. None of these channels can **decompose** wrist rotation from forearm/shoulder rotation individually — that requires a forearm-referenced landmark this project doesn't have. But one of them still constrains the _joint_ distribution over wrist + forearm/elbow rotation, weakly: MediaPipe Hands' own landmark-0 orientation is a real, continuous observation of wrist rotation composed with forearm rotation composed with torso/shoulder orientation, all folded together. Under a stated engineering assumption — the camera sits in a roughly fixed relationship to the user's torso during capture, itself never measured — that composed reading is a legitimate, if wide-noise and never individually decomposable, observation: it enters the model as a term on the **sum** of wrist+forearm+elbow rotation, never assigned to any one DOF. This channel is weaker than every other channel in the model, is never allowed to dominate the literature prior on its own, and never substitutes for the exclusion/orientation-bias rules elsewhere — but it is a real update path, and describing this group as having "no webcam channel at all" overstates the gap. Forearm length (above) remains the one quantity in this group with a clean, direct caliper channel. Everything else narrows only via: this weak composed MediaPipe observation, the named cross-group correlations above, and manual numeric entry when supplied — entered as one more observation with source-dependent noise (a goniometer reading behaves like a caliper measurement; a self-report carries wider noise), subject to the same exclusion/plausibility gate as any other observation in the model, never written to the posterior as unquestioned ground truth. An attribute that has received none of these narrows only as far as the cross-correlations allow and otherwise stays at its literature prior — an explicitly labeled steady state, not a failure of the model, and not different in kind from how a chronically-occluded joint is treated.

**DIP/PIP coupling** and **enslaving coefficient**

- unchanged in substance (finger-specific R², tracked per hand),
  now explicit instances of the one update process in 2.3 rather than a separately-described mechanism.

### Update mechanism: One process, not two.

Bone lengths (near-linear, largely independent-axis)
update via straightforward recursive Bayesian estimation — a mean/covariance update per observation.

Coupled, nonlinear joints (MCP's coupled axes, CMC's conjunct rotation)
update via the same constrained MAP solve `iksolve_research.md` already specifies for live IK.
Both read and write the same correlated (mean, covariance) state —

there is exactly one place confidence lives, not a separate scheme per attribute type.

A dimension with zero direct observations this update is not a special case of this process — it is the same recursive Bayesian/MAP update with an empty data term for that dimension, every time. Its posterior can still move, because the shared covariance couples it to dimensions that _do_ have data this update: conditioning a correlated multivariate (mean, covariance) state on an observed subset narrows the unobserved subset in proportion to how strongly the literature ties them together — the standard conditioning identity for a jointly-updated Gaussian state, adapted per-DOF for this model's Beta-bounded marginals via a working transform rather than a change to which mechanism runs. This is what makes a permanently-unobserved quantity like elbow swivel angle still worth carrying in the model at all: it is never informed by anything as strong as a direct measurement, but it is not frozen at its population value forever either, and it is provably narrower than "no model" — i.e. raw MediaPipe, which supplies nothing for it — the moment any correlated dimension is confidently measured.

Named cross-group correlations the model must represent explicitly (not covered by any single group's own internal covariance, and not a move toward one dense cross-group matrix — every other pairing stays block-diagonal unless a future citation justifies adding it):

- Wrist flexion/extension & radial/ulnar deviation ↔ finger MCP/PIP rest flexion (tenodesis effect).
- Forearm length ↔ hand length ↔ stature (both regress independently against stature, r > 0.9) — the model's one indirect anchor for forearm length absent a direct forearm↔hand regression.
- Elbow swivel angle ↔ wrist pose & forearm length, per the swivel-angle criterion's own definition.

- Exactly three observation channels are in scope, project-wide: single-hand MediaPipe Hands landmarks, offline caliper/goniometer measurement, and manual numeric entry. No other tracker (MediaPipe Pose included) is used to source an observation, for any attribute — this is a firm project boundary, not a per-attribute choice. (The wrist/forearm group's weak composed-rotation term, above, is landmark-0 data from this same MediaPipe Hands channel, used differently — as a term on a sum of DOF rather than a per-DOF reading — not a fourth channel.)

- A caliper measurement is an observation with very low measurement-noise in this same update —
  it dominates the posterior rather than requiring a separate hard/soft distinction. Manual numeric entry is treated the same way: an observation with noise set by how the number was obtained (a goniometer reading behaves like a caliper measurement; a self-reported estimate does not and should carry wider noise).

- An observation from an excluded condition (dorsal, thumb-lateral, self-occluded)
  never enters the likelihood for that quantity, regardless of how many accumulate —
  this is what stops the posterior from confidently converging on a wrong value
  (`iksolve_research.md`'s rejection of unsupervised self-calibration).

- Every attribute is reported as its current posterior (mean + variance/covariance entry)
  plus its evidence (session count, source: population prior / MediaPipe Hands / caliper / manual entry) — never a bare point value.

## Keyboard design output — required attributes

see key_point_selection.md
