# thumbs: probabilistic hand model + scan pipeline

Replacing cosmos-keyboards' current fixed hand-shape parameters with a
personalized, literature-grounded probabilistic hand model,
measured via MediaPipe Hands and a staged capture protocol,
and consumed by a new key-placement algorithm.

see **`TODO.md`** for status.

## Spec — normative, must stay internally consistent

- **`goals.md`** — project goals, acceptance criteria, and the hand model's evaluation criteria:
  what's in the model (bone lengths, per-joint-type motion, wrist/forearm, coupling), how it's
  seeded from literature, and how it updates. Start here.

- **`capture-protocol.md`** — the camera/orientation setup and per-phase capture instructions
  (bone length, ROM, DIP/PIP coupling, enslaving, thumb CMC), designed around MediaPipe Hands'
  documented failure modes (dorsal-view collapse, foreshortening).

- **`scan3-architecture.md`** — implementation architecture for `/scan3`: data structures
  (`HandData`, `Joints`, `ContactSpheres`), module layout, state ownership. Not yet updated for
  `average-hand.md`'s `HandPriorState`/`ikSolve.ts` addition (see TODO.md).

- **`key-point-selection.md`** — consumes the hand model's posterior to generate key datums
  (position + orientation per key) without assuming any layout topology.

## Plan — staged rollout, expected to change as work lands

- **`representing-keyboard-build-inputs.md`** — a staged plan for building a real 3D (Threlte) viewer
  for `key-point-selection.md`'s per-finger capability field, starting from an empty scene and ending at
  a cost-colored capability cloud, before any placement/packing algorithm exists.

- **`average-hand.md`** — the current implementation plan: routes every attribute in `goals.md`
  and every live MediaPipe frame through one constrained solve (`ikSolve.ts`). This is what a
  developer should be building toward right now.

- **`ik-solve-research.md`** — the design research `average-hand.md` builds on (why not
  self-calibrate, the promotion-gate/confidence-weighting reasoning). Its `Fixed`/`Learned`
  discrete prior-state framing predates `average-hand.md`'s continuous-covariance model — read
  the reasoning, not the type shapes.

## Research — tooling design, referenced but not itself prescriptive

- **`scan-utility-evaluation.md`** — an evaluation harness (measurement trustworthiness +
  layout-independent kinematic usefulness) for judging whether a scan-pipeline change actually
  helped. `key-point-selection.md` reuses its manipulability/Jacobian construction directly.

- **`keypress-vector-problems.md`** — problem framing (no experiments proposed yet) for turning a
  reachable point into a keypress direction: two non-reconciled models already in this project
  (kinematic Jacobian vs. geometric contact-sphere), contact-point geometry with no ground truth, and
  several other open threads, named so they aren't accidentally resolved by omission.

- **`key-arrangement-in-3d.md`** — the sibling packing-geometry question: given two keys' known shapes,
  positions, and orientations, when do they not collide, without ever animating keycap travel or running
  a mesh intersection check. Solves the 2D single-chain case (a minimum bend-radius formula) in full;
  frames the open 3D generalization and the general key-adjacency taxonomy as unsolved. Succeeded by
  `capability-packing.md` for the actual placement algorithm.

- **`capability-packing.md`** — where `key-point-selection.md`'s capability field and
  `key-arrangement-in-3d.md`'s key-shape geometry meet: reviews the capability field as actually
  implemented (`scan-tests/capability-field/`, and where it's drifted from spec), then specifies a
  convex-overlap (SAT) placement algorithm, in joint-angle space, that replaces the chain/pivot approach.
  Not yet implemented.

## Validation — empirical grounding

- **`test-plan.md`** — the sequence of small tests validating `capture-protocol.md`'s assumptions
  (noise floors, orientation bias, still-window/plateau tuning), cheapest first.
- **`test-results.md`** — append-only running log of what actually happened when those tests were
  run. This is the record of truth; `test-plan.md` is the spec of what each test checks.

## Archive

Superseded docs, kept for history.
