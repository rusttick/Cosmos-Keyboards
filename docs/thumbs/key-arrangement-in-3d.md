# Key arrangement in 3D: describing key shape to constrain placement

> **Status:** 2D single-chain case solved, including a forward-kinematic model (§6) verified against
> an interactive 3D prototype at `/scan-tests/key-arrangement` (drag either joint; it stays
> mechanically constrained to the curves §6.2 names, in both bend directions). 3D generalization and
> the general adjacency taxonomy are still open. Depends on: `representing-keyboard-build-inputs.md`.
> Sibling to `keypress-vector-problems.md` (that doc asks "which direction can a key be pressed at a
> reachable point"; this doc asks "given two keys' shapes, positions, and orientations, when do they
> not collide" — a pure packing-geometry question, independent of hand kinematics). **Next step,
> across both docs:** combining this doc's key-surface space with that doc's finger-movement space —
> see §6.6 below for how the two might connect, and `keypress-vector-problems.md`'s open threads
> (particularly #1, #4, #9) for what's still unresolved on that side before the combination can be
> implemented.

## Goal and non-goals

Derive closed-form geometric constraints on key position/orientation that guarantee collision-freedom
**by construction** — never by animating a keycap through its press travel, and never by running a
polygon/mesh intersection test after placement.

Walls, screws, baseplates, and MCU mounting are out of scope — this is purely about key-to-key spacing.

## 1. The key shape, defined once

**Claim K1 (proven, see §2): the at-rest, unpressed shape already contains every pressed intermediate state.**

No travel/animation modeling is needed anywhere below.

Coordinates: z = 0 at the mounting-plate surface, +z above the plate (toward the fingertip), −z below
(toward the wiring side).

- **Keycap+switch region**, `z` from `0` to `h1`:
  - Cross-section: a frustum — width `B` at `z=0`, tapering to width `w1` at `z=h1`.
  - Real values: `B ≈ 18.1mm`, `w1 ≈ 14.4mm`, `h1 ≈ 16mm` (switch 6.2mm + XDA depth 9.9mm — **the 16mm
    figure needs confirming**, since it's not verified whether these two published numbers double-count
    any overlap).
- **Wire-clearance region**, `z` from `0` to `−h2`:
  - Cross-section: a prism (no taper) — width `w2` at every `z` in that range.
  - Real values: `w2` = real socket footprint (~18mm); `h2` = solder/hotswap clearance depth, **not yet
    sourced from `PART_INFO`**.

Both pieces share the same base at z=0. The keycap piece narrows going _up_ (away from the plate); the
wire-clearance piece doesn't narrow at all going _down_ — consistent with, and required by, Claim K1
(§2's proof needs cross-section non-increasing toward the plate on the side that moves; the static side
below the plate never needs to satisfy this at all, since nothing there moves).

## 2. Why "at rest, no travel modeling" is valid

A pressed keycap is a rigid downward translation of the same shape along its own axis, by up to `travel`
(3.6mm for MX). At height `z`, the pressed shape's cross-section equals the at-rest shape's cross-section
at `z + t` (that's the material that slid down to `z`). Since the at-rest cross-section is non-increasing
going up, cross-section at `z + t` ≤ cross-section at `z` — so the pressed footprint at every height is
already contained in the at-rest footprint there. The union over all press depths is therefore a subset
of the at-rest shape **iff** the at-rest cross-section is non-increasing as z increases away from the
plate. Both pieces above satisfy this by construction, so travel is never separately modeled.

## 3. The solved 2D case: one chain of keys, corner-to-corner

**Setup.** Model each key's cross-section (in the bend plane) as an isosceles trapezoid: base `B` at the
plate, top width `w` at height `h`, standing on a chord of a curve. Adjacent keys share exactly one base
corner (a chain — key i's right base corner is key i+1's left base corner). This is **Taxonomy Case 1**
below; the others are open (§5).

**Result.** The trapezoid's non-overlap condition with its neighbor is governed by the height its
slanted sides _would_ meet at if extended past the real top — the virtual apex:

```
H_virtual = h · B / (B − w)
R_min     = √(H_virtual² + (B/2)²)          -- minimum local bend radius
θ_max     = 2·arcsin( (B/2) / R_min )        -- equivalent max turning angle per joint
```

Special cases: `w = 0` (a true point) gives `H_virtual = h`, recovering the plain-triangle formula.
`w = B` (no taper at all — a rigid box) gives `H_virtual → ∞`: **a non-tapering shape has no finite safe
bend radius; only a dead-straight run is safe**, unless a wider model-base is substituted (next
paragraph).

**Two-sided (asymmetric) case.** The keycap side (height h1, taper to w1) and the wire-clearance side
(height h2, no taper) get independent radii, `R_min,1` and `R_min,2` — a curve only stresses one side at
a time (bending toward the keycap side automatically relaxes the wire-clearance side, and vice versa),
so the binding constraint at any joint is `R ≥ R_min` on whichever side the bend is concave toward.

**The wire-clearance side needs an inflated base to have a finite answer at all**, since it doesn't
taper on its own. This is where the structural web-width minimum (~4mm, a real manufacturing
requirement, independent of this math) does double duty: using `B = switch_footprint + web_width` as the
_model_ base for this side introduces exactly the artificial taper needed to make `H_virtual` (and hence
`R_min`) finite. This isn't a coincidence to be suspicious of — the web has to exist anyway for
structural reasons, and it happens to be exactly the quantity that makes the packing math well-posed.

**Worked numbers (keycap side, pending h1 confirmation):** B=18.1, w=14.4, h≈16 → H_virtual ≈ 78mm →
R_min ≈ 78.7mm. This is far larger than treating the keycap as a sharp-tipped triangle would suggest
(≈18mm) — the taper is real but shallow, so the sides are nearly parallel and the virtual apex is far
away. **The wire-clearance side's numbers depend on h2 and web_width, both still unsourced.**

**Not yet verified even in this simplest case:** only _adjacent_ (curve-neighbor) pairs have a proven
non-overlap condition. For a short chain (≤8 keys, no spiral wrapping — this project's actual scale),
non-adjacent pairs are assumed not to bind first, but this hasn't been proven, only argued informally.

## 4. Going to 3D: the one thing definitely not yet handled

Everything in §3 assumes the bend is _planar_ — every key's local frame differs from its neighbor's by a
rotation about one consistent axis perpendicular to a shared plane. `key-point-selection.md`'s actual
per-key orientation (the SVD of the local manipulability Jacobian) is a genuinely 3D rotation between
neighbors, not constrained to a single axis. It is **not established** whether "minimum radius" survives
this generalization as one number, or whether it needs to split into separate components (e.g. an
in-plane bend limit and an out-of-plane twist limit, each with its own bound) — this is the central open
question for extending §3 to real 3D layouts, and nothing below attempts to resolve it.

## 5. Open: a taxonomy of how two keys can be "near" each other

This is the piece that's been hard to put into words. A first-draft attempt, offered to react to and
correct rather than as a finished answer:

1. **Point-adjacent chain** (solved, §3): keys share exactly one base corner, forming an ordered path.
   Two neighbors, no branching.
2. **Edge-adjacent**: two keys' base footprints share a full edge, not just a corner — a grid where keys
   have real shared walls on multiple sides. Not analyzed. Might be _stricter_ (zero gap along a whole
   edge, not just a point) or might collapse to something simpler if both keys are locally coplanar along
   that shared edge — unclear which, not worked out.
3. **Non-touching, separated by a finite gap**: the actual common case — most real key pairs aren't
   pressed corner-to-corner at all, they have some positive web gap between them. This is probably
   _easier_ than Case 1 in one sense (if exactly-touching is proven safe at `R_min`, any larger gap is
   safer still) but Case 1's formula doesn't yet say how _much_ gap trades off against how much bend is
   allowed — a more general "gap as a function of bend angle" formula, not derived here, is probably the
   actually-useful one for a real layout.
4. **Two-directional (grid) adjacency**: a real layout is a 2D mesh where a key can have neighbors on
   more than two sides at once, not a single chain. Case 1 only handles a path graph; a full adjacency
   graph is the real target topology and hasn't been reduced to formulas.
5. **A second, independent tilt axis**: §3's whole derivation bends the chain within one plane. Real
   layouts also tilt keys _across_ the row direction (column stagger/tenting) — a genuinely separate
   degree of freedom this document hasn't touched at all.

## 6. Forward-kinematic chain model (2D, single row)

This section works out a concrete kinematic model for a row of keys, arrived at by walking through the
actual rotations that bring two adjacent keys into contact, in both bend directions. It refines the
single-frustum shape from §1 into **frustum on rectangle**: the "keycap+switch region" (z: 0 to h1) is a
straight-sided rectangle of width B for its lower part (the switch housing, height hs), with a tapering
frustum (height hf, top width w1) on top of it. hf + hs = h1. The wire-clearance region below the plate
(width w2, height h2) is unchanged from §1.

### 6.1 Vertex numbering

Each key has 10 vertices, in its own local frame (origin at vertex 1, x horizontal, z vertical, plate at
z=0):

```
v1  = (0, 0)                          -- plate corner, switch-housing side, facing neighbor
v2  = (B, 0)                          -- plate corner, switch-housing side, far side
v3  = (B, hs)                         -- switch-housing top corner, far side (taper root)
v4  = ((B+w1)/2, h1)                  -- keycap top corner, far side
v5  = ((B-w1)/2, h1)                  -- keycap top corner, facing neighbor
v6  = (0, hs)                         -- switch-housing top corner, facing neighbor (taper root)
v7  = ((B-w2)/2, 0)                   -- wire-clearance box, top corner facing neighbor
v8  = ((B+w2)/2, 0)                   -- wire-clearance box, top corner, far side
v9  = ((B+w2)/2, -h2)                 -- wire-clearance box, bottom corner, far side
v10 = ((B-w2)/2, -h2)                 -- wire-clearance box, bottom corner facing neighbor
```

v1-v6 trace the above-plate hexagon (switch housing + keycap taper, merged, no line drawn between
them since both have width B at their shared height); v7-v10 trace the below-plate wire-clearance
rectangle.

### 6.2 Named cases (two adjacent keys, gap m at rest)

Starting from **Flat Case** (both keys resting on z=0, edges B apart plus a gap m), two adjacent keys can
be brought together in two ways, named by which vertex is held fixed as the pivot:

**Convex** (right key rotated clockwise -- switch-housing sides come together, keycap tops spread apart):

- **Socket-Corner Pivot** -- pivot = the right key's own v1 (fixed at (B+m, 0) in the left key's frame).
  Rotation continues until the right key's v10 becomes coterminal (same direction from the pivot) as the
  left key's v9 -- i.e. the wire-clearance boxes' corners first come into angular alignment.
- **Wire-Corner Pivot** -- pivot switches to the right key's own v10 (now fixed wherever Socket-Corner
  Pivot left it). Rotation continues until edge 9-10 (right key) is vertical. Total rotation from the
  Flat Case is exactly 90 degrees (edge 9-10 was horizontal at rest, and a rigid 90-degree rotation
  makes any originally-horizontal edge vertical, regardless of which pivot was used along the way).

**Concave** (right key rotated counter-clockwise -- keycap tops come together, switch-housing sides
spread apart):

- **Taper-Corner Pivot** -- pivot = the right key's own v6, which sits exactly m away from the left
  key's v3 in the Flat Case (both at height hs). Rotation continues until the left key's v4 and the
  right key's v5 are exactly m apart -- equivalently, until edge 3-4 (left key) is parallel to edge 5-6
  (right key).
- **Keycap-Corner Pivot** -- pivot switches to the right key's own v5 (now fixed wherever Taper-Corner
  Pivot left it). Rotation continues until edge 4-5 (right key) is vertical. Total rotation from the
  Flat Case is again exactly 90 degrees, for the same reason as the convex case.

### 6.3 Layer 1: abstract forward kinematics (bones + joint angles)

Each key-to-key joint is modeled as a 3-bone planar chain: a fixed root bone (bone 0, no joint -- it is
just the rigid Flat Case placement) followed by two articulated bones (bone 1, bone 2), whose joint
angles phi1 and phi2 are treated as **independent** free variables (not coupled to a single total bend
angle -- see the note at the end of 6.4 on why this was relaxed).

Given key i's pose (Pi, Ti) -- position and orientation -- and the joint angles phi1, phi2 for the joint
to key i+1:

```
Phi_n = psi_n + sum(k=0..n) phi_k         [cumulative direction of bone n; phi0 = 0 always]

P(i+1) = Pi + sum(n=0,1,2) L_n * (cos(Phi_n), sin(Phi_n))
T(i+1) = Ti + phi1 + phi2
```

Three fixed bone lengths (L0, L1, L2), three fixed baseline angles (psi0, psi1, psi2), and two free
joint angles (phi1, phi2), each independently bounded to its own range. Orientation is exactly linear in
the joint angles; only position picks up the multi-bone geometry. This is the same formula for both the
convex and concave case -- only the bone constants (6.4) differ, and a joint is always entirely one case
or the other (never a mix). Sign convention: phi positive means clockwise for the convex bone set,
counter-clockwise for the concave bone set.

### 6.4 Layer 2: bone constants, in terms of key dimensions

|            | Convex (pivots: v1 then v10)            | Concave (pivots: v6 then v5) |
| ---------- | --------------------------------------- | ---------------------------- |
| L0         | B + m                                   | sqrt((B+m)^2 + hs^2)         |
| psi0       | 0 deg                                   | atan2(hs, B+m)               |
| L1         | sqrt(((B-w2)/2)^2 + h2^2)               | sqrt(((B-w1)/2)^2 + hf^2)    |
| psi1       | atan2(-h2, (B-w2)/2)                    | atan2(hf, (B-w1)/2)          |
| L2         | = L1 (same segment, opposite direction) | sqrt(((B-w1)/2)^2 + h1^2)    |
| psi2       | psi1 + 180 deg                          | atan2(-h1, -(B-w1)/2)        |
| phi1 range | [0, alpha_cvx]                          | [0, alpha_ccv]               |
| phi2 range | [0, 90 - alpha_cvx]                     | [0, 90 - alpha_ccv]          |

Numeric values, using B=18.2, w1=14, hf=9.5, hs=6.5, h1=16, w2=14, h2=10, m=0.5 (all mm; see 6.1 note on
where these came from):

- Convex: L0=18.7, L1=L2=10.218, psi1=-78.14 deg, psi2=101.86 deg.
- Concave: L0=19.797 (psi0=19.17 deg), L1=9.729 (psi1=77.54 deg), L2=16.137 (psi2=-97.48 deg).

**alpha_cvx and alpha_ccv come from different defining conditions** (matching 6.2's case definitions),
so they do not share one formula:

- alpha_cvx (coterminal-direction condition, v9/v10) has a closed form:

  ```
  alpha_cvx = atan2(-h2, (B-w2)/2) - atan2(-h2, (w2-B)/2 - m)      [~= 26.43 deg]
  ```

- alpha_ccv (distance = m condition, v4/v5) comes from solving `|D0 + R(gamma)*u| = m`, where
  `u = ((B-w1)/2, hf)` and `D0 = ((B-w1)/2 + m, -hf)`. Expanding gives a standard
  `E*cos(gamma) + F*sin(gamma) = G` equation (E = D0 dot u, F the corresponding cross term,
  G = (m^2 - |D0|^2 - |u|^2)/2), solved in closed form as:

  ```
  alpha_ccv = atan2(F, E) +/- arccos(G / sqrt(E^2 + F^2))          [~= 24.93 deg]
  ```

  taking whichever root is the smaller positive angle (the first crossing as gamma increases from 0).

### 6.5 Why phi1, phi2 are independent, not coupled

The original construction (walk the pivot from v1 to v10, or v6 to v5, only once the first pivot's range
is exhausted) makes phi1 and phi2 into a single coupled degree of freedom: phi1 = min(theta, alpha),
phi2 = max(theta - alpha, 0) for a single total bend theta. That is a strictly smaller family of shapes
than allowing phi1 and phi2 to vary independently within their own ranges -- some key-row shapes are
reachable only if the second bone can rotate by an amount not equal to "whatever total bend is left
over" from the first. Relaxing the coupling is what turns this into a genuine 2-degree-of-freedom joint
(configuration space `[0,alpha] x [0,90-alpha]` per bend direction), which is the object 6.3-6.4 actually
describe.

**Verified live, and worth flagging plainly: the relaxed 2-DOF box is not the space to place keys
in.** Building the interactive prototype (§6.6) and dragging phi1, phi2 independently showed the keys
visibly separating -- once phi1 is anywhere short of its own max, bone2 is pivoting about a point (v10
or v5) that isn't actually in contact yet, so allowing phi2 to also be nonzero there just moves the
keys apart. Only the coupled single-parameter curve (phi1 = min(theta, alpha), phi2 =
max(theta - alpha, 0), one theta per joint) keeps every key adjacent (gap m) throughout, matching every
diagram in §6.2. The full independent box may still matter for other purposes (see §6.6), but
placing keys along a row means walking this curve, not searching the box.

### 6.6 An interactive check, and the open bridge to finger movement

The model in 6.1-6.5 is implemented and verified at `/scan-tests/key-arrangement`: key 0 fixed at the
origin, any number of further keys each placed by its own joint (chain.ts composes joints the same way
a robot arm's forward kinematics composes per-joint transforms), each independently draggable with the
drag solved backward onto the nearest point on its own coupled theta curve (fkSolve.ts). Dragging stays
mechanically constrained to the named cases in §6.2, in both bend directions, for any chain length --
confirmed live, not just by the math above.

This gives a concrete object for the still-unresolved question this doc's header points to: combining
this doc's space of possible key-bearing surfaces with `keypress-vector-problems.md`'s space of possible
finger movements. One route discussed but not yet implemented: a chain's reachable positions are the
**workspace** of a serial linkage (joint-angle space `theta_1 x theta_2 x ... x theta_(n-1)` is the
**configuration space**; forward kinematics, as implemented here, maps one to the other -- see that doc's
open thread #1/#4/#9 for what a per-key "valid press direction" constraint would even be measuring before
it can be turned into a bound on theta). If a finger's press-direction constraint at a given key turns out
to be (at least approximately) linear in the cumulative bend angle up to that key, intersecting it with
each joint's `[0, 90]` range would carve the configuration-space box down into a convex polytope -- every
point still inside it a mechanically valid, finger-reachable row. Whether that linearity holds, and what a
"valid press direction" constraint should be measuring in the first place, are exactly the open questions
`keypress-vector-problems.md` names and does not yet resolve.

## What this document deliberately does not do

No 3D formula is derived (this section's forward-kinematic model is 2D, one row only). No edge-adjacent
or grid-adjacency case is solved. No experiments are proposed. The solved content is §2-§3 (the
at-rest-shape argument and the single-chain 2D bend radius) and §6 (the two-bone-per-joint forward
kinematics for a row, in both bend directions); everything else above is named so it isn't silently
assumed away later.
