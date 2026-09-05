# Sweep-region preview: a read-only viewer for fingertip reachable-surface data

`pre-development-work.md` scoped the constraint-based placement UI (§3) as the least-designed, highest-risk piece of the whole project, and explicitly deferred it. This doc is a smaller, earlier step: a **read-only** page that takes today's scanned hand model and draws each finger's reachable-surface as a 3D object, so scan-quality improvements (ROM, per-tier comfortable/full ranges, enslaving, once they land per `scanning.md`) have somewhere to be _seen_ immediately, without waiting on any placement algorithm to exist. No editing, no key placement, no persistence beyond what already exists — just visualization.

## What already exists to build on

There is real prior art for exactly this, one abstraction level short of what's wanted:

- **`SolvedHand`** (`src/lib/hand.ts:256-415`) is the FK engine. Two methods matter:
  - `fkBy(finger, fn)` (`hand.ts:310-320`) sets a pose: `fn(i)` returns `[angleZ, angleY]` per joint `i` (0=CMC/metacarpal root … 3=DIP), and angles get zeroed based on that joint's `degree` (0/1/2 DOF, see below) before being baked into a rotation matrix.
  - `worldPositions(finger, scale=100)` (`hand.ts:349-365`) reads back world-space `Vector3[]` for all 5 joint positions (index 4 = fingertip) given whatever pose `fkBy` last set.

  Together, `fkBy` + `worldPositions(finger)[4]` is already the exact "set joint angles, get fingertip position" primitive a sweep surface needs — nothing new has to be built here.

- **`Pose.svelte`** (`src/routes/scan/lib/Pose.svelte:52-65`) already does a _1-parameter_ version of this: it sweeps a single synthetic flexion parameter `i` from 0–100 across all of a finger's joints simultaneously (scaled by each joint's `degree`-weighted share of a hardcoded `extent` angle) and collects the resulting fingertip positions into a polyline (`degPts`), rendered via `@threlte/extras`'s `MeshLineGeometry`/`MeshLineMaterial` in `PoseCanvas.svelte`. It also builds a fingertip **point cloud** the same way real captured poses are turned into `SphereGeometry` instances merged with `mergeGeometries` (`Pose.svelte:32-49`). This is a curve through the workspace, not a surface, and its "extent" is an arbitrary demo constant — but it's the closest existing code to what's being proposed, and the point-cloud pattern is directly reusable.

- **The scanned hand is already rendered** as a mesh, not primitives: `HandModel.svelte` (`src/lib/3d/HandModel.svelte`, duplicated at `src/routes/scan/lib/HandModel.svelte`) loads a rigged GLB (`$assets/hand.glb`), and each frame calls `hand.localTransforms(baseMatrix, scale)` to decompose per-bone matrices onto the GLB's named armature nodes (`finger + i`). A sweep-region page would render this alongside the sweep surface for context — same component, just dropped into a new scene.

- **`Viewer.svelte`** (`src/routes/beta/lib/viewers/Viewer.svelte`) is the reusable Canvas/camera/controls shell already used by `/beta`: a Threlte `<Canvas>` wrapping `<Interactivity>`, a `<T.PerspectiveCamera>` with `<OrbitControls>`, camera-fit-to-bounding-box logic (`resize`/`updateSuggestedSize`), and a bare `<slot/>` for scene content. It has no opinion about what's inside it. A new preview page can mount this directly and pass it a hand + sweep meshes — no need to build a new Canvas/camera/lighting stack, and no need to route through `Viewer3D.svelte` (which additionally wires up keyboard/import-model/transform-gizmo state this page doesn't need).

- **What does _not_ exist today**: any code that samples the _full_ multi-DOF joint-angle space and unions the results into a surface. `viewer3dHelpers.ts`'s `keyReachable`/`reachability()` (lines ~424-452) — the thing `Keyboard.svelte` currently uses to gray out unreachable keys — is a single max-reach-sphere distance check (`distance(keyPos, wristOrigin) <= sum of bone lengths`), not a swept-volume computation. This preview page would be the first real swept-volume visualization in the codebase.

## The kinematic model, as it constrains sampling

Per finger, 4 `Joint`s (`hand.ts:127-131`), each with a `degree: 0 | 1 | 2` and a `V`/`Vinv` local rotation basis (Z = flexion axis, Y = abduction axis, X = along the bone), fit per-scan via PCA/SVD over the user's own captured motion (`fitNorms`, `hand.ts:215-243`) — not hardcoded axes. Today's DOF assignment:

| Joint (index)           | Non-thumb     | Thumb         |
| ----------------------- | ------------- | ------------- |
| 0 — CMC/metacarpal root | 0 DOF (fixed) | 0 DOF (fixed) |
| 1 — MCP                 | 2 DOF         | 1 DOF         |
| 2 — PIP                 | 1 DOF         | 2 DOF         |
| 3 — DIP                 | 1 DOF         | 1 DOF         |

A full sweep therefore means varying `angleZ` for every joint with `degree >= 1` and `angleY` for every joint with `degree == 2`, independently, across whatever range each joint's data supports — 3 free angles for non-thumb fingers (MCP-Z, MCP-Y, PIP-Z; DIP-Z is usually treated as coupled to PIP rather than independently sampled, see below), 3 for the thumb (MCP-Z, PIP-Z, PIP-Y).

**The range problem is the real blocker, and it's a data problem, not a code problem.** Per `problems.md` §2 and `scanning.md`, no ROM data exists in the scan today — `readHands()`/`calculateJoints` produce bone lengths and mean joint orientation, nothing about how far a joint can rotate. The only ROM-shaped number in the codebase is `Pose.svelte:56`'s `extent = finger == 'thumb' ? Math.PI/3 : Math.PI/1.5`, an arbitrary demo constant, and the disabled `MAX_PAN` limits in `hand.ts:118-125` (thumb 40°, others 30°, currently short-circuited to `Infinity`). This is exactly why the preview should be built now, against a placeholder range, rather than waiting: it gives a visible target that gets _more accurate_, not restructured, as `scanning.md`'s ROM capture phases land. Concretely, start with a literature/guessed symmetric range per joint (something in the neighborhood of the disabled `MAX_PAN` constants, or the `Pose.svelte` extents) as an explicit, clearly-labeled placeholder, and swap it for real per-joint comfortable/full-ROM data (§3/§4 of `scanning.md`) as a pure data change once that capture phase exists — no re-architecture of the sampling or rendering code required, since both already key off `SolvedHand.fkBy`'s existing angle-in/position-out interface.

## Proposed approach

**1. Sampling.** For each finger, grid- or Sobol-sample the free-angle space within the (placeholder, later real) per-joint range, call `fkBy` once per sample, read `worldPositions(finger)[4]`, collect into a point cloud. A coarse grid (e.g. 8–12 steps per free angle) is enough for a first surface — 3 free angles × 10 steps = 1000 fingertip samples per finger, 5000 total, trivially fast for `fkBy`'s matrix math and fine for a `BufferGeometry` point count. This is a direct generalization of `Pose.svelte`'s existing 1-parameter sweep to the joint's actual DOF count, reusing the same `fkBy`/`worldPositions` calls.

**2. Turning samples into a displayable surface.** Two options, in increasing complexity, and only the first is needed for a first version:

- **Point cloud** (simplest, matches existing precedent exactly): render sampled fingertip positions as instanced spheres or a `THREE.Points` cloud, same technique `Pose.svelte:32-49` already uses for captured-pose point clouds via `SphereGeometry` + `mergeGeometries`. This alone answers "does the shape/size of this reachable region look right as scan quality changes" — the stated goal — without needing a meshed hull at all.
- **Convex hull / alpha-shape surface** (optional follow-up, not needed for v1): if a solid, shaded surface reads better than a point cloud, `three/examples/jsm/geometries/ConvexGeometry` (already reachable via the same `three/examples/jsm/...` import path `mergeGeometries` uses) can wrap the sampled points into a hull mesh. Worth noting explicitly this would overstate the reachable region wherever the true shape is non-convex (e.g. the DOF coupling gaps `scanning.md` §5 describes) — fine for a v1 visual approximation, should be labeled as such if used, and is exactly the kind of accuracy gap that motivates keeping this page around as the model improves.

**3. Scene assembly.** A new route (e.g. `src/routes/scan/sweep/+page.svelte`, alongside the existing `/scan` flow rather than under `/beta`, since this has nothing to do with keyboard config) that:

- loads a `HandData` via the existing `readHands()` (`src/lib/handhelpers.ts:10-28`) — the same `localStorage['cosmosHands']` entry `/scan`'s own `Recording.svelte` (`Recording.svelte:138-139`) already writes after either a live webcam capture or a video-file upload (`Recording.svelte:200`), so no new persistence or file format is needed. (`/scan2` is a separate, phone-camera-oriented flow with its own certificate/HTTPS requirements for phone-to-browser video streaming — not needed here, and not assumed as a data source for this page.);
- builds one `SolvedHand` per hand side;
- mounts `Viewer.svelte` for the Canvas/camera/controls shell;
- inside its slot, renders `<HandModel hand={solvedHand}>` (`src/lib/3d/HandModel.svelte`) for the posed mesh, plus one point-cloud (or hull) mesh per finger, using per-finger color to keep the five sweep regions visually distinct.

**4. No interactivity beyond camera orbit.** Per the stated goal, this page needs no key placement, no tweaking, no editable state — `Viewer.svelte`'s existing `OrbitControls` (rotate/zoom/pan already wired) is the entire interaction surface. This keeps the page genuinely small: sampling + two existing render components + one new point-cloud/hull component.

## Sample data caveat

No `HandData`/scan JSON is committed to the repo as a fixture — but that's less of a blocker in practice than it sounds: `/scan` (via the USB webcam path) has already been used this project to capture several real scans, sitting in that browser's `localStorage['cosmosHands']` right now. `readHands()` reads whatever's most recent there, so this page needs no new capture work to be testable — just load `/scan/sweep` in the same browser profile the `/scan` captures were made in. The only real gap is a **committed** fixture for anyone else (a fresh clone, CI, a different machine): that would mean exporting one of the existing scans via `/scan`'s own "download the data" button (`Recording.svelte:123-128`, `downloadHands()` → `hands.json`) and checking that file in under something like `src/routes/scan/sweep/` for local dev seeding — worth doing once the page exists, not a prerequisite for building it.

## Suggested sequencing

This slots naturally as an early, low-risk item in `pre-development-work.md` §4's sequencing — it depends only on today's _existing_ `HandData`/`SolvedHand`, not on any of the new capture phases or schema extensions, so it can be built and merged before step 1 (schema-only) even lands, and then simply gets more accurate for free as steps 1–4 (ROM schema, then real ROM capture) are completed. Recommend:

1. Point-cloud version only, placeholder per-joint angle ranges, single new route reusing `Viewer.svelte` + `HandModel.svelte`. Small enough to be one PR, per `contributing.md`'s branch-per-change convention noted in `pre-development-work.md` §2.
2. Once `scanning.md`'s ROM capture phases exist, swap the placeholder ranges for real per-joint comfortable/full-ROM values — a data change, not a rendering change.
3. Convex-hull surface as an optional visual upgrade, if the point cloud proves hard to read.
