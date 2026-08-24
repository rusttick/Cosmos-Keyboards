# Key point selection: generating key datums from hand kinematics without assuming a layout shape

`problems.md` and `scanning.md` established what the scanned hand model needs to contain; `scan_utility_evaluation.md` established how to tell whether the model is good enough to trust. This doc is the missing piece between them: **the actual algorithm that turns a trustworthy kinematic model into a set of key datums (position + orientation, one per key) in 3D space** — the input to keyboard design, not an evaluation of one.

**A design principle stated up front, because an earlier draft of this reasoning violated it:** nothing below assumes a column, a dish, a sphere, or any other predetermined layout topology. An earlier version of this algorithm fixed each finger's abduction angle at neutral and swept only flexion — which is, quietly, the columnar-layout assumption again, just derived from real data instead of hardcoded. That's not neutral. The corrected approach treats the _entire_ multi-DOF reachable workspace as the candidate space and lets key count, arrangement, and local surface shape fall out of the selection process — whatever shape results (columnar, dish-like, a lopsided cluster, something with no name) is an output to observe, never an input to assume.

## What a key datum actually is

A key isn't a point — a keycap sits on a switch that presses along one axis and should face roughly toward the fingertip's natural approach at that spot. So the output of this whole process is one `Matrix4` per key: a position plus an orientation (press axis + two in-plane axes), the same shape of object `SolvedHand.worldPositions`/`localTransforms` (`src/lib/hand.ts:349-389`) already traffics in.

## Step 1 — Build the full-DOF cost field per finger

This reuses, without modification, the sampling and scoring machinery `scan_utility_evaluation.md`'s Category 2 metrics already call for — it's not new work, it's the same field repurposed as an input rather than a report:

- Sample every **free** joint angle combination within ROM — flexion _and_ abduction together, for every joint with `degree ≥ 1` (`hand.ts:127-131`) — via `SolvedHand.fkBy` + `worldPositions(finger)[4]` (`hand.ts:310-365`). Critically, **keep the joint-angle vector attached to each sample**, not just the resulting 3D position — later steps need to go back to angle-space, not just Cartesian space.
- Score each sample with a cost combining: deviation from the joint's neutral angle (`problems.md` §3's minimum-jerk-grounded principle), which ROM tier it falls in (comfortable vs. full, once `scanning.md` §4's two-tier data exists), and manipulability (Yoshikawa's index, `w(q) = √det(J·Jᵀ)`, computed via a numerical Jacobian on the same `fkBy`/`worldPositions` calls — see `scan_utility_evaluation.md`'s Category 2 for the exact construction). Low manipulability near a sample flags a kinematically marginal spot — sensitive to small placement or scan error — worth penalizing even if it's technically in range.

The result, per finger, is not a curve and not a fixed-shape surface — it's an unstructured cloud of `(position, joint-angles, cost)` tuples covering however many dimensions that finger actually has free (3 for non-thumb fingers, 3 for the thumb, per the DOF table already established).

## Step 2 — Select key slots via cost-weighted, spacing-constrained greedy packing

This is the actual placement step, and it's a well-precedented technique, just applied to a hand-kinematics cost field instead of its usual domains:

1. Take the lowest-cost remaining sample. Place a key there.
2. Exclude a footprint-sized region around it, measured in real physical 3D distance (roughly one keycap pitch) — not in joint-angle distance, since equal angle steps don't correspond to equal physical spacing once curvature/manipulability varies across the workspace.
3. Take the next-lowest-cost sample that falls outside every existing exclusion zone. Repeat.
4. Stop when no remaining sample beats an acceptable cost threshold (e.g. it falls outside the comfortable-ROM tier), or the workspace is exhausted.

This is a **priority-weighted, spacing-constrained point-selection** procedure — structurally the same idea behind two well-established techniques, applied here to a domain-specific cost field instead of image-space or geometric density:

- **Weighted/adaptive Poisson-disk (blue-noise) sampling** — the graphics-and-simulation-literature technique for producing point sets that are locally well-spaced (no clumps, no gaps) while still following an underlying density/priority function, typically via a dart-throwing or capacity-based elimination process ([Fast Poisson Disk Sampling in Arbitrary Dimensions, Bridson, SIGGRAPH 2007](https://www.cs.ubc.ca/~rbridson/docs/bridson-siggraph07-poissondisk.pdf); adaptive/weighted variants using per-point Voronoi-capacity weighting exist for exactly this "respect a density function, not just a fixed radius" case).
- **Greedy farthest-point / facility-location-style selection** — the standard greedy algorithm for picking a well-spread subset of a point cloud: repeatedly add the point that's farthest (here: lowest-cost _and_ outside existing exclusion zones, a priority-weighted variant) from what's already selected, related to the classical Gonzalez algorithm for k-center clustering ([Farthest Point Sampling overview](https://arxiv.org/html/2509.13213v2); [Gabriel Peyré: FPS as greedy sampling from a density defined by distance](https://twitter.com/gabrielpeyre/status/1028159124004134912)).

Either framing is a fine way to think about step 2 — the key property both share, and the one that matters here, is that **the count and arrangement of selected points is an emergent output of running the algorithm, never a parameter chosen beforehand.**

## Step 3 — Derive orientation locally, from the same Jacobian, not from a curve

Because nothing in step 2 assumes selected key points lie along a shared curve or surface, orientation can't be "the tangent of the path" — there is no path. Instead, use what the manipulability computation already produces at each sampled point: the **SVD of the local Jacobian** gives not just the scalar manipulability but the _principal directions_ of local motion at that exact point — the axis the fingertip most readily moves along right there, right now, independent of any neighboring key. Use that direction as the press axis; the two directions orthogonal to it complete the keycap's local frame. This is the same underlying computation robotics calls a **manipulability ellipsoid** — its principal axes and lengths characterize local dexterity and preferred motion direction, and are a standard part of capability-map-style workspace analysis for grasp/placement point selection ([Yoshikawa's manipulability ellipsoid — overview](https://www.emergentmind.com/topics/yoshikawa-s-manipulability-index); [capability maps for grasp/placement selection, combining reachability with local dexterity quality](https://link.springer.com/article/10.1007/s10846-025-02294-5)). Nothing about this step assumes adjacent keys share any structure — each orientation is a purely local property of that one point's kinematics.

## Step 4 — Run the packing across all fingers simultaneously

Steps 1–3 as described are per-finger. The full-hand placement runs them together, not independently, so two cross-finger effects can actually bind:

- **Physical keycap clearance** is finger-agnostic: a slot claimed by one finger excludes nearby slots for any other finger, not just its own.
- **Cross-finger kinematic blocking**, once `scanning.md` §5's paired drag/block trial data exists: a candidate slot for finger A that requires finger B to be in a jointly-unreachable configuration (per the measured `(θ_i, θ_j)` prohibited-region data) gets excluded too — this is where that data becomes load-bearing for _placement_, distinct from its role in `scan_utility_evaluation.md` as an _evaluation_ metric.

Running all fingers' candidate clouds through one shared greedy selection (rather than per-finger, then reconciling afterward) is what lets the final arrangement legitimately come out looking like anything — including something that doesn't cleanly decompose into "one region per finger" at all, if the real kinematics don't support that clean a separation.

## What this deliberately leaves undetermined

- **Total key count**, per finger and overall, is not chosen anywhere in this algorithm — it's whatever the cost-threshold-bounded greedy packing produces. If a threshold produces too few or too many keys for a practical keyboard, that's a signal to adjust the threshold (accept a slightly worse cost per key), not something this algorithm decides on its own.
- **No assumption about resulting shape.** The doc's own name for this is deliberately "key point selection," not "column generation" or "dish fitting" — whatever geometric pattern the selected points trace is something to observe after running this on real scan data, not something engineered in.
- **Keycap footprint clearance vs. finger-blocking** stays the distinction `scanning.md` already draws: the exclusion radius in step 2 is pure geometry (cap dimensions), while the cross-finger exclusion in step 4 is kinematic (measured joint-angle-pair infeasibility) — different mechanisms, both needed, not to be conflated.

## Data prerequisites, and what's usable today

Everything in steps 1–4 is expressible against `SolvedHand`'s existing API (`fkBy`, `worldPositions`) plus the numerical-Jacobian addition already scoped in `scan_utility_evaluation.md` — no new FK/IK machinery is required. What's still missing is data, in the same order `scan_utility_evaluation.md` already lays out:

| Needed for                                                     | Status                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Step 1's cost field (position + joint-angles + manipulability) | Buildable today — same sampling as the evaluation harness                             |
| Step 1's neutral-deviation term                                | Blocked on real neutral-pose capture (`scanning.md` §2) — placeholder/flat until then |
| Step 1's comfortable-vs-full tier weighting                    | Blocked on `scanning.md` §4's two-tier ROM capture                                    |
| Step 4's cross-finger blocking exclusion                       | Blocked on `scanning.md` §5's paired drag/block trials                                |

Practically: steps 1–3 can be implemented and exercised (with the neutral-deviation term flat/placeholder, same honesty convention used throughout this project's docs) as soon as _any_ per-joint ROM bound exists — even the literature/guessed placeholder range discussed in earlier sessions is enough to bound the sampling. Step 4's cross-finger term is the one piece with no meaningful placeholder — it can only be a no-op (no exclusion) until real paired-trial data exists.

## Relationship to other docs

- **Builds directly on `scan_utility_evaluation.md`**'s Category 2 sampling/cost/manipulability machinery — that doc frames it as a report; this doc uses the identical computation as a selection input. Implementing the sampling once and using it for both purposes is the efficient path, not two separate pipelines.
- **Operationalizes `problems.md` §3**'s joint-cost-minimization framing into an actual selection procedure, rather than leaving it as a scoring principle with no generator attached.
- **Consumes `scanning.md`**'s neutral-pose, ROM, and enslaving/blocking data exactly where each is needed, per the table above — this doc adds no new scanning requirements beyond what `scanning.md` already scopes.
- **Feeds `pre-development-work.md` §3**'s constraint-based placement UI: this algorithm produces the raw candidate key datums that UI would let a user review/adjust, not a replacement for that UI's interactive layer.

## Sources

- [Fast Poisson Disk Sampling in Arbitrary Dimensions — Bridson, SIGGRAPH 2007](https://www.cs.ubc.ca/~rbridson/docs/bridson-siggraph07-poissondisk.pdf)
- [Density-Aware Farthest Point Sampling — arXiv](https://arxiv.org/html/2509.13213v2)
- [Gabriel Peyré — farthest point sampling as greedy density-defined sampling](https://twitter.com/gabrielpeyre/status/1028159124004134912)
- [Yoshikawa's Manipulability Index / manipulability ellipsoid — overview](https://www.emergentmind.com/topics/yoshikawa-s-manipulability-index)
- [Modeling the Reachability Space of Robotic Manipulators through Ellipsoid Equations — Journal of Intelligent & Robotic Systems](https://link.springer.com/article/10.1007/s10846-025-02294-5)
- [Capturing Robot Workspace Structure: Representing Robot Capabilities (capability maps)](https://www.researchgate.net/publication/224296369_Capturing_Robot_Workspace_Structure_Representing_Robot_Capabilities)

See also `docs/thumbs/scan_utility_evaluation.md` (the shared sampling/cost/manipulability machinery this doc consumes), `docs/thumbs/problems.md` §3 (the cost-minimization principle this operationalizes), and `docs/thumbs/scanning.md` §2–5 (the capture phases the data-prerequisites table above depends on).
