# Track A: Literature-ROM hand-model → thumb key placement

## Context

Cosmos's thumb-cluster placement is entirely manual today — the config UI has no auto-fit for it (unlike the 4 fingers, which `HandFitView.svelte` already auto-stages from scan data). The user's goal is a highly-tented board with 3 well-placed thumb keys, and they want the _input_ to placement to be a kinematic hand model rather than hand-tuned curvature numbers. The current hand model (`src/lib/hand.ts`, populated from `/scan`) has good scan-derived bone lengths and joint rotation axes, but **no range-of-motion (ROM) data** — only `MAX_PAN` (30-40°), a generic hardcoded constant, exists today.

Track A's purpose is a proof-of-concept: show that literature-typical ROM values, combined with the scanned bone lengths/joint axes, can drive defensible thumb key placement — before investing in scanning _personalized_ ROM (Track B). Finger placement is out of scope here since it's already handled reasonably by the existing stagger auto-fit.

**Known ceiling (accept, don't try to fix):** this hand model fixes the CMC joint (thumb's saddle joint, real source of opposition) at degree-0/no-rotation, per `hand.ts`'s documented simplification. So the thumb's computed reachable workspace will be a cone anchored at whatever orientation was captured at scan time — not a true opposition arc. Better ROM numbers can't fix this; it's a modeling limitation to state explicitly in the script's output, not solve in Track A.

## Approach

Standalone script, `src/scripts/handKeyPlacement.ts`, run via `bun run src/scripts/handKeyPlacement.ts <hands.json> --side <left|right>`. Reuses `$lib/hand`'s pure-math API directly (confirmed zero DOM/browser deps) — bun resolves the `$lib` alias natively as long as `.svelte-kit/tsconfig.json` exists (run `bunx svelte-kit sync` first if missing).

### 1. Literature ROM table (hardcoded constant, clearly flagged as a placeholder for Track B)

Per this model's joint-index/DOF layout (index 0 = metacarpal/fixed, then joints with degree 1 or 2):

- Fingers: MCP (degree 2) flex 0–90°, abduction ±20°; PIP (degree 1) flex 0–100°; DIP (degree 1) flex 0–80°.
- Thumb: joint 1 (degree 1) flex 0–55°; joint 2 (degree 2) flex 0–80°, abduction ±20° (this is the joint standing in for the missing CMC motion — see ceiling above); joint 3 (degree 1) flex 0–90°.

### 2. FK sweep utility

Reuse the existing idiomatic pattern from `Viewer3D.svelte:58-63` verbatim (don't invent a new sweep style):

```ts
for (let i = 0; i <= steps; i++) {
  const t = i / steps
  solvedHand.fkBy(finger, j => [-scale[j] * t, pan[j] * t])
  positions.push(solvedHand.worldPositions(finger)[4])
}
```

`scale[j]`/`pan[j]` come from the ROM table above. `SolvedHand.position` (the world anchor) is set to **identity** — the script outputs a flat (tenting=0) local layout. Global tenting stays fully decoupled: it's applied downstream as an existing separate cluster-level rotation (`config.ts:871`), so it must not be baked into the script's math.

### 3. Thumb key selection — explicit heuristic, not an optimizer

Per Plan-agent review: skip farthest-point sampling (overkill/fragile for 3 points on a possibly-sparse set). Use 3 fixed curl fractions along the coupled-curl sweep at pan=0: **20% (extended/outer), 55% (neutral/middle), 85% (flexed/inner)**. If the resulting points are too close together (assert a minimum pairwise distance, e.g. half the keycap pitch), fall back to spreading pan too (-10°/0°/+10°) rather than complicating curl selection. Script should error loudly (not silently emit overlapping keys) if the scan data produces a degenerate/near-zero-length thumb chain.

### 4. Key orientation — skip for Track A

Emit identity rotation for all 3 keys. Deriving rotation from the FK tangent was considered and rejected (Plan-agent review): the tangent at a single curl sample is fingertip _travel_ direction, not contact-pad normal, and would compound the CMC-ceiling problem into worse-looking output than flat. Let the user hand-tune tilt afterward in the existing Visual Editor, same as today's manual workflow.

### 5. Output — Expert-mode TS source, not raw numbers

There is no per-key freeform XYZ/rotation field in the Visual Editor UI (it only exposes row/column/curvature params) and no file-upload/paste-JSON import for `/beta` generally. The only practical injection point is the Monaco "Expert mode" code editor (`src/routes/beta/lib/editor/CodeEditor.svelte`), which executes literal `Key[]` TS source with `Trsf`-chain positions (`src/lib/runner/api.ts:5-14`).

Model the script's stdout on `toCode.ts`'s actual generator output format (confirmed via `src/routes/beta/lib/editor/toCode.ts` and `transformation-ext.ts`'s `Operation` type) so it's copy-paste compatible:

```ts
const thumbsRight: Key[] = [
  { position: new Trsf().translate(x1, y1, z1), cluster: 'thumbs', ... },
  { position: new Trsf().translate(x2, y2, z2), cluster: 'thumbs', ... },
  { position: new Trsf().translate(x3, y3, z3), cluster: 'thumbs', ... },
]
```

Units: convert scan meters → mm before emitting `.translate()` values (explicit unit conversion step, called out to avoid a silent scale bug). The user pastes this block into `/beta`'s Expert editor, replacing the existing `thumbsRight`/`thumbsLeft` array, keeping everything else (`options`, finger arrays, plane transforms) from the app's own Expert-mode export as the starting point.

### Left/right handling

Script takes `--side` and processes whichever hand chain is requested; do not assume a naive coordinate mirror is correct without checking `hands.json`'s `left`/`right` sign convention against Cosmos's own `mirrorCluster` (`config.cosmos.ts`) — safest is to run the script once per side against that side's own scan data rather than mirroring output.

## Files touched

- **New:** `src/scripts/handKeyPlacement.ts` (the script itself — ROM table, FK sweep, key selection, Trsf-chain code generation).
- **Read-only references during implementation:** `src/lib/hand.ts` (FK/SolvedHand API), `src/routes/beta/lib/editor/toCode.ts` + `src/lib/worker/modeling/transformation-ext.ts` (exact `Trsf`/`Operation` syntax to match), `src/routes/beta/lib/viewers/Viewer3D.svelte` (sweep precedent).

## Verification

1. Run the script against your two downloaded `hands.json` files; sanity-check output — finite numbers, thumb points roughly hand-sized apart (10–25mm), no assertion failures.
2. Paste the generated `thumbsRight`/`thumbsLeft` block into `/beta`'s Expert editor (alongside the rest of that mode's existing export) and visually confirm the 3 thumb keys render in plausible positions relative to the finger cluster.
3. `npm run check` for type-check cleanliness on the new script.

## Explicit non-goals for Track A (deferred to Track B or later)

- Personalized ROM (min/max angles actually measured during a scan) — Track B.
- Fixing the CMC degree-0 simplification.
- Finger-cluster placement (already handled by existing stagger auto-fit).
- Key rotation/tilt derivation.
- Any change to tenting math — stays fully decoupled.
