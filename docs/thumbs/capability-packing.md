# Capability packing: placing keys inside the capability field

> **Status:** Active spec, not yet implemented · Succeeds `key-arrangement-in-3d.md` (its pivot/bend-radius
> approach is superseded by the reasoning in "Why the pivot/chain approach doesn't extend here" below —
> not because it was wrong on its own terms). Depends on: `key-point-selection.md`,
> `representing-keyboard-build-inputs.md`, `scan-utility-evaluation.md`. Consumes the capability field
> implemented at `src/routes/scan-tests/capability-field/` (`src/routes/scan3/lib/keypoints/`).

`key-point-selection.md` names the finger side of this problem "the capability field" and specifies it in
full. `key-arrangement-in-3d.md` named the key-shape side ("when do two keys not collide") and solved it
for a hand-independent, single-chain, planar case. This doc is where the two meet: given a real,
already-implemented capability field (reviewed in "The capability field, as actually implemented" below,
against what's actually built, since it has drifted from spec in specific, load-bearing ways) and the
key-shape packing geometry the sibling doc already derived, how key positions actually get chosen (see
"The recommended algorithm" below).

## The capability field, as actually implemented

This section describes `sampleFingerSweep.ts` / `sampleThumbCmcSweep.ts` / `manipulability.ts` /
`postureCost.ts` / `positionalUncertainty.ts`, and the page that exercises them
(`scan-tests/capability-field/+page.svelte`) — not `key-point-selection.md`'s Steps 0–5 as written. The
gaps between the two are called out explicitly below; they matter for "The recommended algorithm".

**Per finger, independently.** There is no shared, cross-finger selection process running yet — four
non-thumb clouds and one thumb cloud are sampled and rendered side by side, but nothing couples them
(`key-point-selection.md`'s Step 5 — physical clearance, kinematic blocking, accidental-activation risk —
is unimplemented). Whatever this doc's packing algorithm does, it currently has to treat every finger's
field as its own independent domain.

**Free DOF, grid-sampled, not posterior-sampled.** For a non-thumb finger, the free coordinates are `(base flexion [ring/pinky only], MCP flex/ext, MCP ab/ad, PIP flex)` — DIP is never free, always derived from PIP
via that finger's fitted `dip ≈ slope·pip + intercept` coupling, clamped to DIP's own fitted range. Each
axis is swept on a uniform grid across its own fitted `[minDeg, maxDeg]` (from the fused prior), 8 steps per
axis (4 for base flexion), not drawn from the posterior's actual density the way `key-point-selection.md`'s
Step 2 specifies ("sample joint-angle vectors from the current posterior... not a fixed min/max ROM box").
The thumb is sampled over its CMC's 2 driven axes only (24 steps), a 2-DOF shell rather than a filled
volume, because `HandPriorState` has no prior yet for the thumb's other two joints — a named schema gap,
not an oversight.

**Forward kinematics.** Each sample's joint-angle vector is run through `SolvedHand.fkBy` /
`worldPositions(finger, scale=1)`, rooted at a fixed `PLACEHOLDER_LANDMARK0_POSITION` — `key-point- selection.md`'s Step 0 (landmark-0 as its own 6-DOF candidate, jointly optimized with everything else) is
not implemented; the wrist frame is a constant.

**The Jacobian is position-only.** `numericalJacobian` is a central-difference **3 × N** matrix (3 task-space
rows — x/y/z fingertip position — by however many free angles that finger has), computed once per sample.
Nothing downstream computes or stores its singular vectors.

**Three per-sample scalars, no orientation.**

- `postureCost = Σᵢ ((angleᵢ − meanᵢ)/sdᵢ)²` — a per-DOF-independent squared z-score (the negative
  log-density of a diagonal Gaussian up to a constant), not the Beta soft-limit density `average-hand.md`
  specifies, and with no cross-joint covariance term — the same simplification `ikSolve.ts` already makes,
  reused here rather than solved differently for a visualization.
- `manipulability = √det(J·Jᵀ)` (Yoshikawa's index) over the 3×N Jacobian above. Correctly, not buggily,
  zero whenever a sample has fewer than 3 free angles (the thumb's CMC-only shell): a 2-DOF mechanism's
  local motion really is confined to a 2D tangent surface, not a 3D volume.
- `positionalVariance = trace(J · diag(σ²) · Jᵀ)` — each free joint's own fitted variance propagated
  through the same Jacobian, cross-joint covariance dropped, summarized as one scalar (the trace, i.e.
  total x+y+z variance) rather than the full 3×3 covariance ellipsoid.

**No orientation per sample, anywhere.** `key-point-selection.md`'s "Orientation from the local Jacobian"
(the SVD of that same Jacobian giving a press axis and two in-plane axes) is not implemented. This is the
single most important gap for what follows: **every capability sample currently implemented is a bare
`(position, joint-angle vector, 3 scalars)` tuple — a cost-weighted point cloud, not yet a field of posed
key frames.** The Jacobian needed to derive orientation already exists (it's the same 3×N matrix
`manipulability.ts` already builds); only the step of taking its SVD and keeping `U` instead of throwing it
away after computing `det` is missing.

This is what "the capability field" concretely refers to below — a real, working, per-finger scattered
sample cloud over position and three independent costs, with orientation named as a real, currently-missing
piece rather than silently assumed.

## What key-arrangement-in-3d.md solved, restated in this doc's terms

Given two keys' shapes, positions, and orientations, `key-arrangement-in-3d.md` derives exactly when they
don't collide — proven for a chain (its "The solved 2D case: one chain of keys, corner-to-corner" section),
and worked into a full forward-kinematic two-bone joint model with closed-form pivot cases (its
"Forward-kinematic chain model" section), verified against a live 3D tool. Both are **hand-independent**:
bend angle is the arrangement's own free parameter, chosen to explore the packing geometry on its own
terms, with no reference to any finger's kinematics at all.

## Why the pivot/chain approach doesn't extend here

Once key placement has to answer to a real capability field, a key's orientation is no longer a free
parameter belonging to the arrangement — it's derived (once the orientation gap named in "The capability
field, as actually implemented" is closed) from that specific finger's own joint-angle sample. There's no
leftover "bend angle" DOF for a pivot-case derivation to parametrize: picking a different orientation for a
key means picking a _different capability sample_, which changes its cost, not moving along some
independent arrangement curve.

This also explains the recurring "we keep missing a DOF" experience with `scan-tests/key-arrangement`:
key-arrangement-in-3d.md's "Forward-kinematic chain model" section's method is to manually re-derive a new
closed-form pivot case (Socket-Corner Pivot, Wire-Corner Pivot, …) every time a new degree of freedom (tilt,
twist) gets added. That doesn't scale, and it isn't actually required — "do two known, posed shapes
overlap" has a general answer that doesn't depend on how the two shapes got into that relative pose.

## The recommended algorithm

### Shape representation, reused directly from key-arrangement-in-3d.md

A key's collision shape is exactly the two convex pieces named in key-arrangement-in-3d.md's "Vertex
numbering" subsection: the frustum-on-rectangle above the plate (`v1`–`v6`) and the wire-clearance box
below it (`v7`–`v10`). Both pieces are already convex polytopes — no new geometry modeling is needed, only
a different use of the same vertex data.

### Pairwise overlap test: separating axis theorem (SAT), not GJK, not mesh collision

For two convex polytopes, SAT is exact (not approximate) and cheap: test each shape's face normals plus
cross-products of edge pairs as candidate separating axes; if any axis separates the two shapes' projections,
they don't overlap. Two multi-piece keys don't overlap iff every pair of convex sub-pieces (frustum-vs-frustum,
frustum-vs-box, box-vs-frustum, box-vs-box — 4 pairs) doesn't overlap. Unlike the pivot derivations in
key-arrangement-in-3d.md's "Forward-kinematic chain model" section, this is one test defined uniformly over
the full 6-DOF relative pose — no case enumeration, so no DOF can be "missed." SAT also yields, for free,
the minimum translation vector (MTV): the axis of least overlap, and how far along it the shapes need to
separate. This reuses exactly the kind of machinery real-time physics/game engines already rely on for
convex-convex contact (see Sources).

### Placement is optimization over joint-angle space, not over free 6-DOF poses

Each key's placed pose is `FK(q)` for a joint-angle vector `q` drawn from that finger's own capability
field — never an independently chosen position/orientation. This is the fix to the question of how a
correction step could otherwise silently break a key's alignment with its finger's press direction: if
orientation is never anything other than a function of `q`, there's no way to "rotate the key" without it
remaining a legitimate, finger-derived orientation.

### Deterministic initialization

Every key starts at its own finger's lowest-total-cost candidate sample. Not random — this is already a
physically sensible starting layout, just possibly overlapping.

### Correction: SAT's MTV mapped through the Jacobian, not applied as a raw Cartesian move

For an overlapping pair, SAT's MTV gives the Cartesian correction `dx` needed to separate them. Converting
this into a joint-angle correction `dq ≈ J⁺ · dx` (damped pseudoinverse of that finger's own Jacobian —
extended to include orientation rows once the orientation gap named in "The capability field, as actually
implemented" is closed) keeps the correction on the finger's actual reachable manifold. `J⁺` also
distributes the correction according to that finger's manipulability ellipsoid: directions it moves easily
in absorb most of `dx` for little posture-cost increase; directions it's kinematically stiff in require a
disproportionately large, expensive `dq` for the same `dx` — which is exactly "how much this key can afford
to shift before its orientation stops making kinematic sense," read directly off machinery already computed
in "The capability field, as actually implemented" for other reasons, not a new quantity invented for this
purpose.

### Iteration and convergence

Alternate, per iteration: apply each currently-violated pair's correction (order tie-broken arbitrarily —
randomizing only to avoid pathological cycling between two contending pairs, a standard Gauss-Seidel-style
contact solver trick, not a search), plus a small pull of every key back toward its own ideal `q`. This
provably reduces total overlap each round (each step is a directed geometric correction, not a resample-
and-hope), and terminates when every pairwise SAT test clears.

### Infeasibility is a rejection, not a forced solution

If a needed `dq` would require unreasonable posture cost (the correction points into a direction that
finger's Jacobian is nearly singular in), that candidate genuinely cannot be placed there — the right
response is to reject it and fall back to the next-lowest-cost sample outside the conflict, exactly the
"exclude and reselect" mechanism `key-point-selection.md`'s Step 3–4 packing loop already has, not a new
failure mode this approach introduces.

### Topology is emergent, not authored

Whichever pairs end up with an exactly-zero (tight) SAT margin once the loop settles **are** the keyboard's
adjacency graph. No tree, grid, or row/column structure is chosen anywhere in advance — arrangement
flexibility falls out of the algorithm rather than needing to be preserved against it.

## What "tight" means here, and the crystallization risk that follows from it

Two different things "tight packing" could mean matter a great deal here, and the algorithm above commits
to one of them without having said so explicitly:

- **Maximum density** (minimum wasted area/volume for same-size shapes) is the everyday meaning, and it is
  the wrong target: the densest packing of congruent convex tiles is, provably, periodic (hexagonal
  close-packing for circles, square tiling for identical rectangles). Adopting this definition would make a
  uniform grid the mathematically correct answer, not a bug.
- **Locally cost-optimal subject to non-overlap** is what "Deterministic initialization" /
  "Correction: SAT's MTV mapped through the Jacobian, not applied as a raw Cartesian move" /
  "Iteration and convergence" actually compute: a key only moves when a neighbor's shape is physically in
  the way, by exactly the amount needed to clear that conflict, pulled back toward its own capability-field
  optimum the rest of the time. Nothing above asks for maximum density. This is the definition this doc
  uses, and the reason it needs a name at all is that it is _not_ the everyday meaning of "tight."

Committing to the second definition does not fully retire the risk, though. Identical rigid shapes relaxed
purely by mutual contact correction have a well-documented physical tendency to **crystallize into local
lattice order even with no density objective anywhere** — this is the central subject of the granular/
colloidal jamming literature, where "maximally random jammed" packings had to be defined as a deliberately
_different_ target from naive relaxation, precisely because naive relaxation of same-shape particles
reliably orders itself (Torquato & Stillinger). Since every key here is the same shape, that mechanism is
available regardless of what this doc's objective says. What actually opposes it is the strength of each
key's pull-back toward its own (spatially non-periodic, because it comes from real, asymmetric hand
kinematics) capability-field optimum, relative to how far the correction step is allowed to over-relax past
the point where overlap is merely cleared — see "Iteration and convergence"'s hard-stop requirement, which
exists specifically to keep the algorithm from continuing to "settle" once non-overlap is already satisfied.

## Diagnosing accidental crystallization

Whether the loop above is drifting toward artificial lattice order is an empirical question, not something
to reason about in the abstract — the following are standard tools from 2D packing/condensed-matter physics
for detecting exactly this, in order of how directly they answer "did this crystallize":

- **Bond-orientational order parameter, ψ₆.** For each key, take its geometric neighbors (Delaunay
  neighbors, or SAT-active contacts) and compute `ψ₆ = (1/N) Σⱼ e^(6iθⱼ)`, where `θⱼ` is the angle to
  neighbor `j`. `|ψ₆|` near 1 means that key's local neighborhood is hexagonally ordered; near 0 means no
  preferred local symmetry. Averaging `|ψ₆|` over all keys (or computing its own spatial correlation length)
  is the standard order parameter used in the Halperin–Nelson (KTHNY) theory of 2D melting, which
  characterizes exactly the crystalline/hexatic/liquid distinction this doc is worried about crossing
  unintentionally. (A 4-fold analogue, ψ₄, is the more relevant one for square keys specifically — see the
  square-lattice test stage below.)
- **Radial distribution function, g(r).** Histogram every pairwise key-center distance, normalized by what
  a uniform-density arrangement would give at that radius. Sharp, evenly-spaced peaks at multiples of a
  characteristic spacing indicate crystalline order; a single broad peak decaying smoothly to 1 indicates
  disorder. This is the standard liquid/crystal/glass diagnostic in condensed-matter physics and translates
  directly.
- **Structure factor, S(k).** The (numerical) Fourier transform of the key-center positions. Discrete Bragg
  peaks at specific wavevectors mean periodic order (and the peak locations reveal the lattice vectors, if
  any); a diffuse ring means isotropic, liquid-like disorder. This is literally how crystallography
  distinguishes crystalline from amorphous structure, and is the most direct way to check "did a specific
  spatial period get imposed" (relevant to the sine-wave test stage below).
- **Voronoi cell statistics.** Tessellate the key centers; a perfectly crystalline packing has uniform cell
  area and a single dominant cell-side-count (6 for hexagonal, 4 for square); a disordered packing shows real
  spread in both. Cheap to compute and easy to visualize directly (color each key by its own Voronoi cell's
  side count) alongside the 3D/2D view itself.
- **Coordination number distribution.** Count each key's number of currently-active (exactly-touching) SAT
  contacts. A strongly peaked distribution (e.g., every key touching exactly 4 or 6 neighbors) is itself a
  crystallization signal, independent of the geometric diagnostics above.

**Tooling: add `d3-delaunay` rather than hand-roll neighbor-finding.** ψ₆'s "geometric neighbors" and the
Voronoi cell statistics both need a real 2D Delaunay triangulation, not a fixed-k-nearest-neighbor
approximation — a nearest-neighbor stand-in silently changes what the diagnostic measures whenever local
density varies (exactly the radial and discontinuous test stages below). `d3-delaunay` (built on
Delaunator's incremental algorithm) gives both a Delaunay triangulation and its dual Voronoi diagram from a
flat point array directly, is small, has no heavy transitive dependencies, and is the de facto standard
choice for this in the JS ecosystem. This project's usual preference against adding new top-level
dependencies (`CLAUDE.md`) is deliberately overridden here — hand-rolling a robust 2D Delaunay
implementation is real, error-prone computational-geometry work with a well-tested library already solving
exactly this problem.

**Caveat carried into the test plan below:** g(r) and S(k) both implicitly assume the packing is
statistically homogeneous over the region being measured — they're built for "is this uniform region
ordered," not "is this one radially-symmetric or edge-bounded region ordered." Fields with a single center or
a hard edge (two of the test stages below) will need a windowed or locally-referenced version of these
diagnostics, not the plain global one; that adaptation is real work, not a checkbox.

## Incremental validation: a 2D square-packing testbed

Going straight to the real capability field (5-dimensional-plus joint-angle spaces, per-finger, no
orientation yet implemented) makes it impossible to tell whether a crystallization result is about this
packing algorithm or about some incidental property of the real data. The right incremental step is the
same one `key-arrangement-in-3d.md`'s own interactive prototype already took: **build a minimal version
first, in the same 3D viewer, and look at it.**

**Simplify the shape.** Replace the two-piece frustum/box key shape with plain squares lying flat on the
grid plane, each free to rotate in-plane (see "Live findings" below on why a rotation DOF turned out to
matter even at this simplified stage). In 2D, the general convex-polytope SAT test in "Pairwise overlap
test: separating axis theorem (SAT), not GJK, not mesh collision" reduces to the textbook 2D oriented-box
case (each square's own two edge normals are the only candidate separating axes, 4 total between a pair) —
a good, independently useful warm-up for the SAT/MTV machinery itself before it has to handle the real 3D
two-piece shape.

**Simplify the field.** Replace the capability field (and the Jacobian-based correction in "Correction: SAT's
MTV mapped through the Jacobian, not applied as a raw Cartesian move") with a plain scalar cost function
`C(x, y)` over the plane, and use plain gradient descent on `C` as the pull-back step instead of a
joint-angle-constrained one. This deliberately drops the finger-kinematics-consistency question (there's no
hand behind a synthetic field, so nothing to stay reachable with respect to) — this testbed is scoped
purely to the packing/crystallization dynamics in isolation, not to re-validate the Jacobian machinery, which
already has its own prerequisites listed below.

**The field needs an actual gradient, or there's nothing to pack toward.** A perfectly flat `C(x, y)` gives
every candidate position equal cost — there's no basis for "lowest-cost candidate" (per "Deterministic
initialization") to mean anything, and no reason a settled arrangement should land anywhere in particular.
Every stage below therefore uses a real, nonzero gradient over a **bounded** candidate domain (a finite
region standing in for a real finger's finite reachable workspace) — bounded specifically so "lowest cost"
has an actual answer (a linear field over an unbounded plane has no minimum at all). Candidates are a dense
sample of points across that bounded domain, scored by `C`, and placement follows exactly the same greedy
procedure `key-point-selection.md`'s Step 3–4 already specifies (and "Infeasibility is a rejection, not a
forced solution" reuses): take the lowest-cost remaining candidate, place it if it doesn't overlap anything
already placed (SAT), reject and take the next-lowest-cost candidate if it does. This makes the testbed a
faithful miniature of the real algorithm — same selection logic, same correction logic — with only the shape
and the field simplified, not the procedure around them.

**Fixed count, fixed viewer.** A fixed number of squares, dropped onto the same `Viewer.svelte` /
`Grid`/`AxesHelper` scene `scan-tests/key-arrangement` and `scan-tests/capability-field` already use, so
results are visually comparable to both existing tools without inventing new scene conventions.

**Step through, don't auto-run.** Since the question is literally "does tightness move closer to periodic
with each iteration," the UI should let a person trigger one relaxation iteration at a time (rather than
running to convergence and only inspecting the end state) and watch the diagnostics above update live after
each click. The exact interaction design for this is left open — a single "step" button is the obvious
starting point, but whether it also wants play/pause, a step counter, or per-iteration diagnostic history is
a UI decision to make once the first version exists, not one to settle in advance.

**Staged field progression, cheapest/most-revealing first:**

1. **Linear (constant-gradient) field over a bounded domain — the easiest nonzero-gradient case, and the
   first stage to actually run.** `C(x, y) = k · (direction · position)` inside a fixed finite region, one
   fixed `direction` to start (e.g. straight along `+x`). Squares pack in tightest along the downhill edge of
   the bounded domain and queue up behind it — this is now the positive control: the domain is still fully
   homogeneous in the direction perpendicular to the gradient, so nothing breaks translational symmetry along
   that axis, and the packing _should_ still crystallize (a lattice stretched/aligned to the gradient
   direction). If the diagnostics above don't say so unambiguously here, the diagnostic tooling itself is
   broken, not the packing algorithm. Once this runs, sweep `direction` across a range of angles as a cheap
   follow-on within the same stage — still spatially homogeneous along its own perpendicular axis, so this
   calibrates whether the diagnostics correctly detect _anisotropic_ order (a rotated/stretched lattice
   tracking the gradient's direction) rather than only recognizing one axis-aligned case.
2. **Spherical field intersecting the plane.** Cost as radial distance from a fixed point in space (a sphere
   centered off-plane). This is the first stage with genuine in-plane heterogeneity — only rotational, not
   translational, symmetry survives — so it's the first plausible test of whether real heterogeneity actually
   breaks periodicity, and the first place the windowing caveat above becomes unavoidable (g(r)/S(k) need to
   be computed radially-referenced, not globally).
3. **Sine-wave field.** A cost that varies periodically along one in-plane direction, at a spatial period the
   experimenter controls independently of the keys' own natural spacing. This is a direct, well-studied
   physical question — whether a packing locks into registry with an external periodic potential
   (commensurate) or resists it (incommensurate) is exactly the subject of the Frenkel–Kontorova model (a
   chain of particles on a periodic substrate potential) — and it's a controllable way to ask "does the field
   _impose_ a period on the result, versus the result crystallizing on its own."
4. **A hard discontinuity.** A step-function cost boundary (two flat regions at different cost, sharp edge
   between them). Tests whether keys near a seam behave reasonably or produce boundary artifacts — directly
   relevant later, since real per-finger capability fields will have exactly this kind of seam where one
   finger's domain meets another's (`key-point-selection.md`'s Step 5).
5. **A smooth, non-periodic field** (e.g. a sum of a few offset radial wells, or Perlin/simplex noise) as the
   closest synthetic stand-in for what a real multi-finger capability field probably looks like — the last
   stage before swapping the synthetic `C(x, y)` for the real thing.

### Live findings from the first working prototype (`scan-tests/capability-packing`)

Two things reasoned about above turned out to matter more than expected once a real version existed to look
at — both are the kind of thing this whole doc set keeps re-learning: confirm live, don't trust the
derivation alone.

**A uniform gradient applied to a symmetric starting cluster doesn't just favor crystallization — it's a
rigid translation, with zero internal rearrangement, and therefore not a meaningful thing to click through
at all.** Stage 1 as originally specified above (constant `direction`, squares seeded via the greedy
Step 3–4 procedure) turned out to be _doubly_ degenerate in practice: greedy selection already fully
resolves the packing during initialization (it never accepts a conflicting candidate, so there's nothing
left for a relaxation loop to do afterward), and separately, every square under a truly constant direction
feels the exact identical pull — a perfectly regular seed has no internal asymmetry for that force to act
on, so it only ever translates as one rigid body. Both were confirmed directly (identical diagnostics after
20 iterations; per-square displacements identical to five decimal places), not just predicted. Fixed by
switching the interactive prototype's default field to a **radial (center-point) field** (this doc's own
stage 2, promoted ahead of stage 1 for the live demo) and its starting condition to a heavily-overlapping
**tight cluster** (`clusterInit.ts`) rather than a pre-resolved greedy placement — a radial field gives
squares on opposite sides of the cluster genuinely different pull directions, so relaxation has real,
visible work to do across many "Step" clicks. `greedyPlace` (Step 3–4's own logic) is kept as a correct,
tested, separately-useful utility; it's simply the wrong initial condition for a tool whose entire purpose
is watching structure change _across_ iterations.

**"Pack tightly, don't overlap" is underspecified without also saying how a square should be oriented — and
"no rotation DOF yet" silently answers that question by fiat, uninterestingly.** With squares locked to
`theta=0` (as originally planned for this stage), the first overlap-free configuration necessarily showed
every square unrotated — not because zero rotation was discovered to be correct, but because it was the only
option on offer. Fixed by giving each square a `theta`, set directly from the local field direction at its
own position every relaxation sweep (one of the square's two axes points along the local gradient) — the
same "orientation is derived, never independently adjusted by the correction step" principle "Correction:
SAT's MTV mapped through the Jacobian, not applied as a raw Cartesian move" uses the real Jacobian for,
just with the field's own direction standing in for it here. Pairwise overlap became a proper oriented-box
(OBB) SAT test (4 candidate axes: each square's own two face normals) rather than plain AABB overlap, since
squares can no longer be assumed axis-aligned once `theta` is real.

**A single Gauss-Seidel correction pass per "Step" click is not strict enough — real, visible overlap got
through.** Correcting square `i` against `j` can reintroduce an overlap with some earlier `k` that a prior
correction in the very same pass had already cleared, and a single pass never re-checks `k` afterward.
Confirmed live (the user's own report after running the prototype), not just reasoned about. Fixed by
repeating full correction passes within each `relaxStep` call until one pass resolves nothing (or a
generous pass cap is hit), the standard fix in iterative contact solvers (e.g. position-based dynamics),
which run several solver iterations per step for exactly this reason. Two further numerical issues surfaced
getting this fully strict: (1) clamping a square to the domain boundary _after each individual pairwise
correction_ (rather than once per square per pass) fought with neighbor corrections and was a real source
of non-convergence on its own; (2) applying the full-strength MTV every pass could settle into an exact,
persistent back-and-forth cycle in a symmetric multi-body jam — fixed by under-correcting (damping factor
0.5 of the MTV per pass), the standard fix for oscillation in iterative contact solvers, which still
converges (each pass still reduces overlap whenever one exists) without the exact cancellation a
full-strength correction can fall into.

**Spacing between packed shapes is a parameter of the overlap test, not a bigger collision shape.** Once
"how do I require a minimum gap, not just non-overlap" came up, inflating the squares themselves was the
tempting answer but the wrong one to generalize: it works for an isotropic square, but the real key shape
(`key-arrangement-in-3d.md`'s two-piece frustum/box) is anisotropic, so a uniform shape inflation would need
a true Minkowski-sum-with-a-disk offset (rounding every corner by the gap radius) to stay geometrically
honest — real 3D geometry work, and it would distort the taper if done naively. Instead, `overlapObb` takes
a `minGap` parameter folded directly into the same SAT projections it already computes (`overlap = rA + rB + minGap - |d|`), matching `key-arrangement-in-3d.md`'s own `m` notation for exactly this quantity. This needs
no shape changes at all and generalizes to any convex shape pair, square or two-piece key alike.
`diagnostics.ts`'s `coordinationNumbers` needed a matching update: once `minGap` is nonzero, a settled,
non-contending pair sits at `minGap`, not at zero — "touching" now means `obbGap(...) - minGap` is within
tolerance, not `obbGap(...)` itself.

## Prerequisites this depends on, not yet built

- **Orientation per capability sample** (the central gap named in "The capability field, as actually
  implemented") — the SVD of the already-computed 3×N Jacobian, keeping `U`'s columns as the press axis +
  two in-plane axes, per `key-point-selection.md`'s own spec. Needed before the correction step described
  in "Correction: SAT's MTV mapped through the Jacobian, not applied as a raw Cartesian move" has any
  orientation to preserve in the first place.
- **Extending the correction Jacobian to include orientation**, once the above exists, consistently with
  whatever key-datum frame convention `key-point-selection.md` settles on.
- **A SAT implementation for the two-piece key shape** — fully specified geometrically already (the
  vertices named in key-arrangement-in-3d.md's "Vertex numbering" subsection); this doc only changes how
  that data gets used.
- **Step 0** (a movable, jointly-optimized landmark-0) **and Step 5** (cross-finger blocking/enslaving) from
  `key-point-selection.md` — not required to prototype the pairwise correction described in "The
  recommended algorithm" on a single finger's field, but required before a complete keyboard layout, across
  all fingers, comes out the other end.

## Still open

- Whether pairwise SAT/MTV correction alone guarantees a _cluster_ of more than two mutually contending
  keys doesn't self-overlap — the general-topology version of the un-proven "non-adjacent pairs assumed not
  to bind first" caveat from key-arrangement-in-3d.md's "The solved 2D case: one chain of keys,
  corner-to-corner" section.
- No closed-form "how tight can this get" result falls out of this approach the way that same section's
  `R_min` did — a real trade against the sibling doc's method, worth weighing once a numeric prototype
  exists.
- Whether the diagnostics in "Diagnosing accidental crystallization" need a genuinely different (windowed,
  locally-referenced) formulation for the radial and discontinuous field stages, or whether a single
  global implementation with a documented blind spot is good enough — not decided, per that section's own
  caveat.
- The 2D square testbed deliberately excludes the Jacobian/orientation-preservation machinery (there's no
  hand behind a synthetic field); whether crystallization behavior observed there actually transfers to the
  real, joint-angle-constrained correction step, or whether the kinematic constraint itself changes the
  answer, is untested either way.

## What this doc deliberately does not do

No implementation yet — "The recommended algorithm" is a design, not code. No claim that the grid-sampling
(vs. posterior sampling) or fixed landmark-0 named in "The capability field, as actually implemented" are
wrong to leave as-is for now; they're named as gaps because the recommended algorithm depends on knowing
exactly what it's building on, not because closing them is in scope here.

## Sources

- [Separating Axis Theorem — Real-Time Collision Detection background (Dyn4j)](https://dyn4j.org/2010/01/sat/)
- [Gilbert–Johnson–Keerthi distance algorithm — Wikipedia](https://en.wikipedia.org/wiki/Gilbert%E2%80%93Johnson%E2%80%93Keerthi_distance_algorithm)
- [Position Based Dynamics — Müller et al.](https://matthias-research.github.io/pages/publications/posBasedDyn.pdf)
- [XPBD: Position-Based Simulation of Compliant Constrained Dynamics](https://matthias-research.github.io/pages/publications/XPBD.pdf)
- [Kepler conjecture / densest sphere packing — Wikipedia](https://en.wikipedia.org/wiki/Kepler_conjecture)
- [Jamming and maximally random jammed packings — Torquato & Stillinger, Rev. Mod. Phys.](https://journals.aps.org/rmp/abstract/10.1103/RevModPhys.82.2633)
- [Halperin–Nelson (KTHNY) theory of two-dimensional melting — Wikipedia](https://en.wikipedia.org/wiki/Two-dimensional_melting)
- [Bond-orientational order parameters (ψ₆) — Steinhardt, Nelson & Ronchetti](https://journals.aps.org/prb/abstract/10.1103/PhysRevB.28.784)
- [Structure factor — Wikipedia](https://en.wikipedia.org/wiki/Structure_factor)
- [Frenkel–Kontorova model (commensurate/incommensurate lock-in on a periodic potential) — Wikipedia](https://en.wikipedia.org/wiki/Frenkel%E2%80%93Kontorova_model)
- [d3-delaunay — Delaunay triangulation and Voronoi diagrams for 2D points](https://github.com/d3/d3-delaunay)
