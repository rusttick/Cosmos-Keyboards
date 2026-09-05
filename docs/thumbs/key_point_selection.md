# Key point selection: generating key datums from the posterior hand model

`problems2.md` establishes the hand model this doc consumes:
a correlated posterior (mean + covariance) over bone lengths, per-joint-type motion parameters, and cross-finger coupling,
each seeded from a literature prior and narrowed by measurement.

This doc is the algorithm that turns that posterior into a set of key datums — position + orientation,
one per key — without assuming any layout topology
(no column, no dish, no fixed thumb cluster)
and without assuming the hand model is ever fully converged.

## What a key datum is

One `Matrix4` per key: position plus orientation (press axis + two in-plane axes) —
the same shape `SolvedHand.worldPositions`/`localTransforms` (`src/lib/hand.ts`) already produces.

## Landmark-0 placement: the base frame is a candidate, not a given

Every finger's FK chain hangs off landmark 0 (the wrist).
Its pose relative to the keyboard has 6 DOF, and those 6 DOF are two different kinds of quantity, not one:

- **Rotational (3 DOF): wrist flexion/extension, wrist radial/ulnar deviation, forearm pronation/supination.**
  These are hand-intrinsic and belong in the hand-model posterior (`problems2.md`'s "Wrist and proximal arm" entry) exactly like any other joint:
  population-seeded (wrist ROM ≈85° flex/ext, ≈15°/45° radial/ulnar deviation),
  and _coupled_ — flexion/extension and radial/ulnar deviation are not independent
  (the natural "dart-throwing motion" plane pairs extension with radial deviation and flexion with ulnar deviation),
  and wrist angle is itself correlated with finger-joint rest posture and force capacity via the tenodesis effect
  (wrist extension passively drives finger flexion;
  grip/press force peaks near ≈35° extension/≈7° ulnar deviation and falls off toward neutral).

- A candidate wrist rotation therefore carries two cost terms, in tension rather than agreement:
  a **posture/injury-risk cost** (sustained extension and ulnar deviation are the documented carpal-tunnel risk factors)
  and a **force-availability cost** (derived from the same tendon force-length relationship,
  penalizing wrist angles that leave a finger's press force too low) —
  this is a real tradeoff to expose to the packing cost, not something to resolve by fiat toward "neutral."
  Per `problems2.md`, these three DOF have no webcam observation channel at all
  (single-hand MediaPipe Hands can't decompose wrist rotation from whole-arm rotation without a forearm-referenced landmark,
  and MediaPipe Pose is out of scope for this project) —
  the posterior sampled here is whatever the literature prior plus any manual numeric entry currently gives,
  not a live-tracked signal.

- **Translational (3 DOF): where landmark 0 sits in space relative to the keyboard.**
  This is _not_ a hand-intrinsic property — it's governed by shoulder/elbow position
  and how the user chooses to rest or reposition the arm,
  and the literature treats "hand/wrist displacement" as a separate measured quantity from joint kinematics for exactly this reason.
  It has no population-ROM-style prior;
  treat it as a free design variable bounded only by loose practical reach limits
  (softly informed by the forearm-length and elbow/swivel-angle prior in `problems2.md`,
  which bounds where an elbow could plausibly be even though it's never directly tracked), not by any published "ideal" value.

- **Deliberately excluded:** none of the published split-angle/gable-angle/slope-angle recommendations
  from keyboard ergonomics studies are imported here, in either DOF group.
  Those numbers are outputs of experiments run over a small pre-chosen set of existing keyboard shapes —
  using them as an input would silently reintroduce a layout-topology assumption.
  Only the underlying continuous costs (injury-risk, force-availability) transfer;
  what geometry minimizes them for a specific measured hand is exactly what Steps 1–5 below are supposed to discover, not something handed to them.

- **Mechanically**, landmark-0 pose is sampled the same way finger joint angles are
  (draw from its posterior for the 3 rotational DOF, draw from a wide/uninformative range for the 3 translational DOF),
  and every downstream step runs _per candidate landmark-0 pose_ rather than against one fixed base frame —
  the landmark-0 posture cost above is added into the same total cost the packing in Step 3 already minimizes,
  so it's selected by the same emergent process as everything else, not fixed in advance of it.

## Candidate space per finger, per joint type (not a uniform DOF count)

Each finger's free parameters come from `problems2.md` §2.2, not a flat "N DOF per finger" assumption:

- **PIP, DIP**: true 1-DOF hinges.
  DIP is not sampled as an independent dimension — it is derived from PIP via that finger's own `fitDipPipCoupling` posterior
  (near-fixed for pinky/thumb, effectively free for index, per its own fitted slope/R²).
  Only fingers where the coupling posterior says DIP is genuinely independent get DIP as its own sampled dimension.

- **MCP**: 2 primary, flexion-coupled axes (flexion/extension, abduction/adduction) plus a low-weight axial term —
  sampled as a coupled pair/triple, never as one axis or three independent ones.

- **CMC mobility**: an axis this candidate space did not previously have.
  Present for the thumb (saddle joint: 2 active axes + emergent conjunct rotation)
  and for ring/pinky (independent flexion toward the thumb, absent for index/middle).
  Excluding it for ring/pinky silently reproduces the "rigid palm" assumption this whole model exists to remove.

This requires the FK chain in `$lib/hand.ts` to include the CMC joint for ring/pinky and the thumb's saddle parameterization,
and to root that chain at the Step 0 candidate landmark-0 pose rather than a fixed origin, before this step is buildable —
a data-model prerequisite, not a detail of this algorithm.

## Step 2 — Build the cost field as a posterior sample, not a fixed-ROM grid

For each finger, sample joint-angle vectors from the _current posterior_ (not a fixed min/max ROM box):
draw from the correlated (mean, covariance) state,
respecting each DOF's bounded distribution and the coupling terms above.
For each sample, run FK (`fkBy` + `worldPositions`) and keep the joint-angle vector attached to the resulting position —
later steps need angle-space, not just Cartesian space.

Score each sample with two costs, not the previous three-part scheme:

- **Posture cost** — negative log-density of this joint-angle vector under the current posterior.
  This single term replaces the old separate "neutral-pose deviation" and "comfortable-vs-full ROM tier" mechanisms:
  both were approximating the same thing (how typical is this posture)
  with two placeholders where the posterior model now gives one real quantity.

- **Manipulability cost** — Yoshikawa's index `w(q) = √det(J·Jᵀ)` via a numerical Jacobian over this finger's coupled joint space.
  Low manipulability flags a kinematically marginal spot, independent of whether it's posturally comfortable.

Also record, per sample, **positional uncertainty**:
propagate the posterior's covariance (including the Step 0 landmark-0 rotational posterior, which feeds every finger's base frame)
through the same Jacobian to get the spread of physical positions consistent with the current (possibly still-wide) hand-model state.
A sample from a converged joint (e.g. index PIP) and one from a barely-measured joint (e.g. thumb CMC before any capture)
can land at the same point with very different confidence —
this field is what lets later steps degrade toward the population prior instead of quietly trusting an unconverged estimate.

The result per finger is an unstructured cloud of
`(position, joint-angles, posture cost, manipulability cost, positional uncertainty)`
tuples over however many dimensions that finger's joint-type model actually has free.

## Cost-weighted, spacing-constrained greedy packing

Unchanged in mechanism from before, now reading a richer per-sample cost:

1. Take the lowest-total-cost remaining sample
   (posture + manipulability, penalized further by positional uncertainty —
   an uncertain candidate needs a better nominal cost to be picked over a confident one).
   Place a key there.

2. Exclude a footprint-sized region around it in real physical distance (~one keycap pitch),
   inflated by that sample's positional uncertainty —
   an uncertain key needs a wider clearance margin than a confident one.

3. Take the next-lowest-cost sample outside every existing exclusion zone. Repeat.
4. Stop when no remaining sample beats an acceptable cost threshold, or the workspace is exhausted.

This is the same priority-weighted, spacing-constrained selection as before
(equivalent to weighted Poisson-disk sampling or greedy farthest-point selection over a cost-defined density) —
count and arrangement remain emergent, never chosen in advance.
What changed is that the density being sampled from, and the exclusion radius,
both now come from the posterior rather than a fixed hand model.
The Step 0 landmark-0 posture cost is added to this same total,
so a candidate keyboard's overall cost reflects both key-level kinematics and how it holds the wrist.

## Orientation from the local Jacobian

Unchanged: the SVD of the local Jacobian at each selected point gives the press axis
(principal direction of local motion) and the two in-plane axes completing the keycap frame —
a manipulability-ellipsoid computation, purely local, no shared curve or surface assumed.

## Step 5 — Cross-finger effects, run across all fingers' clouds simultaneously

- **Physical clearance**: finger-agnostic, as before.

- **Kinematic blocking**: excludes a candidate slot for finger A that requires finger B in a jointly-unreachable configuration,
  per the measured prohibited-region posterior.

- **Accidental-activation risk**: estimate the angular excursion of A's keystroke via `Δθ_i ≈ J⁻¹ · Δtravel` (switch pre-travel),
  apply the enslaving posterior `E[i][j]` (mean _and_ its own uncertainty) to get `Δθ_j_induced`,
  and compare against finger B's margin to its own actuation angle —
  widening the required safety margin in proportion to `E[i][j]`'s current uncertainty
  rather than trusting a point estimate.

Running every finger's cloud through one shared selection is what lets the final arrangement come out as whatever shape the real, per-user kinematics support —
including one that doesn't decompose into "one region per finger" at all.

## What this deliberately leaves undetermined

- Total key count, per finger and overall — emergent from the cost-threshold-bounded packing, not chosen anywhere in this algorithm.

- Resulting shape — columnar, dish-like, asymmetric, unnamed — observed after running this on real data, never assumed going in.

- Landmark-0 placement and orientation relative to the keyboard,
  and by extension any resulting tilt/split/slope of the keyboard itself —
  an emergent output of Step 0's joint optimization,
  never a target imported from prior ergonomic-keyboard studies.

- A design produced before every joint's posterior has converged is not a failure state:
  candidates drawn from a wide posterior simply carry larger positional uncertainty and wider exclusion margins,
  biasing the packing toward the population-prior-consistent placement until real measurement narrows it —
  this is `problems2.md`'s confidence-aware degradation requirement,
  satisfied by this algorithm rather than bolted on after it.

## Relationship to other docs

- Consumes `problems2.md`'s hand-model posterior
  (bone lengths, per-joint-type motion model, wrist/forearm rotational state, coupling, update mechanism)
  as its only upstream dependency.

- Requires `$lib/hand.ts`'s FK chain to represent CMC mobility (thumb, ring/pinky),
  coupled MCP axes, and a movable landmark-0 base frame before Steps 0–1 are buildable —
  a prerequisite change, not scoped by this doc.

- Reuses the Jacobian/manipulability construction from `scan_utility_evaluation.md`'s Category 2 machinery —
  same computation, used here as a selection input rather than an evaluation report.

- Feeds `pre-development-work.md` §3's constraint-based placement UI:
  this algorithm produces candidate key datums (with their confidence) for that UI's interactive review layer, not a replacement for it.

## Sources

- [Fast Poisson Disk Sampling in Arbitrary Dimensions — Bridson, SIGGRAPH 2007](https://www.cs.ubc.ca/~rbridson/docs/bridson-siggraph07-poissondisk.pdf)
- [Density-Aware Farthest Point Sampling — arXiv](https://arxiv.org/html/2509.13213v2)
- [Yoshikawa's Manipulability Index / manipulability ellipsoid — overview](https://www.emergentmind.com/topics/yoshikawa-s-manipulability-index)
- [Modeling the Reachability Space of Robotic Manipulators through Ellipsoid Equations](https://link.springer.com/article/10.1007/s10846-025-02294-5)
- [Capturing Robot Workspace Structure: Representing Robot Capabilities (capability maps)](https://www.researchgate.net/publication/224296369_Capturing_Robot_Workspace_Structure_Representing_Robot_Capabilities)
- [Coupling between wrist flexion–extension and radial–ulnar deviation](https://www.sciencedirect.com/science/article/abs/pii/S0268003304002396)
- [Tenodesis grasp — Wikipedia](https://en.wikipedia.org/wiki/Tenodesis_grasp)
- [The relationship between wrist position, grasp size, and grip strength](https://pubmed.ncbi.nlm.nih.gov/1538102/)
- [Kinematics of the fingers and hands during computer keyboard use](https://pubmed.ncbi.nlm.nih.gov/17052825/)
