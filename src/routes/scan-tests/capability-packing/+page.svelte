<script lang="ts">
  /**
   * Stage 1 of `docs/thumbs/capability-packing.md`'s "Incremental validation: a 2D square-packing
   * testbed": squares on the grid plane, packed toward a cost field over a bounded domain, one relaxation
   * sweep per "Step" click, with the crystallization diagnostics from "Diagnosing accidental
   * crystallization" recomputed live after each step. Reuses the same `Viewer`/`Grid`/`AxesHelper` scene
   * convention `scan-tests/capability-field` already established (z-up, grid in the xy plane), not
   * `scan-tests/key-arrangement`'s upright bend-plane convention -- squares here represent flat key
   * footprints on the mounting plane, not standing keycap profiles.
   *
   * A radial (center-point) field, not the originally-planned uniform (linear-gradient) one, drives this
   * page -- confirmed live: a constant direction applied to `clusterInit.ts`'s symmetric starting cluster
   * just translates it rigidly, with no internal rearrangement to watch across "Step" clicks at all (see
   * `relax.ts`'s and `radialField.ts`'s doc comments). A radial field gives different squares genuinely
   * different pull directions, so relaxation has to actually reorganize the pack.
   *
   * Each square is also oriented so one of its two axes points along the local field direction at its own
   * position (`relax.ts` sets `theta` directly from the field, every sweep) -- confirmed live as a second
   * follow-up: with squares locked to `theta=0`, the first overlap-free state necessarily showed every
   * square unrotated, which wasn't a meaningful "no rotation needed" result, just the only option
   * available. `theta` is never adjusted by the overlap-correction step, only position is -- the same
   * "orientation is derived, never used to escape a conflict" principle the real algorithm uses the
   * Jacobian for.
   *
   * Deliberately NOT included at this stage (see the doc's "Simplify the field" / "Still open"): the real
   * Jacobian/orientation-preservation machinery itself (there's no hand behind a synthetic field, so
   * nothing to stay kinematically reachable with respect to) -- `theta` here is a direct copy of the
   * field's own direction, not derived through any per-square manipulability weighting.
   */
  import { T } from '@threlte/core'
  import { Grid } from '@threlte/extras'
  import { browser } from '$app/environment'
  import Viewer from '../../beta/lib/viewers/Viewer.svelte'
  import { clusterInit } from '../../scan3/lib/packing/clusterInit'
  import type { Domain } from '../../scan3/lib/packing/linearField'
  import { radialDirectionAt } from '../../scan3/lib/packing/radialField'
  import { relaxStep } from '../../scan3/lib/packing/relax'
  import type { Square2D } from '../../scan3/lib/packing/sat2d'
  import {
    coordinationNumbers,
    delaunayNeighbors,
    meanOf,
    peakStructureFactor,
    psi6,
    radialDistribution,
    structureFactor,
    toPoints,
    voronoiSideCounts,
  } from '../../scan3/lib/packing/diagnostics'

  // Roughly keycap scale (`B` in key-arrangement-in-3d.md), in mm.
  const HALF_SIZE = 9
  const DOMAIN: Domain = { width: 220, height: 160 }
  const SQUARE_COUNT = 26
  // Deliberately less than 2*HALF_SIZE -- see `clusterInit.ts`'s doc comment: the starting cluster is
  // meant to overlap heavily, so relaxation has real, visible work to do across many "Step" clicks.
  const CLUSTER_SPACING = HALF_SIZE
  const STEP_SIZE = 3
  // "Touching" tolerance for coordination number -- well under one relaxation step's motion, so it only
  // counts contacts that are actually load-bearing right now, not merely nearby.
  const CONTACT_EPSILON = 0.05

  // Off-center on purpose (not the cluster's own centroid, which sits at the origin) -- a center
  // coinciding with the seed's centroid would keep the whole setup symmetric under the field's own
  // reflection symmetry, which could still hide real rearrangement behind an accidental residual
  // symmetry. Draggable via the sliders below if you want to try other offsets.
  let centerX = 60
  let centerY = -40
  // Required minimum gap between any two squares -- `key-arrangement-in-3d.md`'s `m`, threaded straight
  // into the SAT overlap test rather than a bigger collision shape (see `sat2d.ts`'s `overlapObb` doc
  // comment for why that generalizes correctly to the real, anisotropic key shape and shape-inflation
  // wouldn't).
  let minGap = 0

  let squares: Square2D[] = []
  let iteration = 0

  function initialize() {
    squares = clusterInit(SQUARE_COUNT, HALF_SIZE, CLUSTER_SPACING)
    iteration = 0
  }

  function step() {
    const directionAt = radialDirectionAt([centerX, centerY])
    squares = relaxStep(squares, { directionAt, stepSize: STEP_SIZE, domain: DOMAIN, minGap })
    iteration += 1
  }

  initialize()

  $: points = toPoints(squares)
  $: neighbors = delaunayNeighbors(points)
  $: psi6Values = psi6(points, neighbors)
  $: meanPsi6 = meanOf(psi6Values)
  $: coordination = coordinationNumbers(squares, neighbors, CONTACT_EPSILON, minGap)
  $: meanCoordination = meanOf(coordination)
  $: gr = radialDistribution(points, DOMAIN, 2 * HALF_SIZE * 0.3, 2 * HALF_SIZE * 4)
  $: sk = structureFactor(points, 0.6, 14)
  $: peakSk = peakStructureFactor(sk)
  $: voronoiSides = voronoiSideCounts(points, DOMAIN)
  $: voronoiHistogram = voronoiSides.reduce<Record<number, number>>((hist, n) => {
    if (n !== null) hist[n] = (hist[n] ?? 0) + 1
    return hist
  }, {})

  function psi6Color(v: number): string {
    const clamped = Math.max(0, Math.min(1, v))
    const hue = 240 * (1 - clamped) // 0 (disordered) -> blue, 1 (ordered) -> red
    return `hsl(${hue}, 70%, 50%)`
  }
</script>

<div class="fixed inset-0 bg-gray-100 dark:bg-gray-900">
  {#if browser}
    <Viewer enableRotate enableZoom enablePan cameraPosition={[0, -260, 220]}>
      <T.AmbientLight intensity={0.6} />
      <T.DirectionalLight position={[100, -100, 200]} intensity={0.8} />
      <T.DirectionalLight position={[-100, 100, -50]} intensity={0.2} />

      <!-- z-up, per Viewer.svelte's camera `up={[0, 0, 1]}` convention -- the grid lies in the xy
           plane, matching `scan-tests/capability-field`'s convention (flat footprints), not
           `scan-tests/key-arrangement`'s upright bend-plane one. -->
      <Grid
        plane="xy"
        cellSize={10}
        cellThickness={0.5}
        sectionSize={50}
        sectionThickness={1}
        gridSize={[DOMAIN.width + 40, DOMAIN.height + 40]}
        fadeDistance={600}
      />
      <T.AxesHelper args={[30]} />

      <!-- The field's center point -- everything is pulled toward here. -->
      <T.Mesh position={[centerX, centerY, 2]}>
        <T.SphereGeometry args={[2.5, 16, 12]} />
        <T.MeshStandardMaterial color="#16a34a" />
      </T.Mesh>

      {#each squares as s, i (i)}
        <T.Mesh position={[s.x, s.y, 1]} rotation={[0, 0, s.theta]}>
          <T.BoxGeometry args={[2 * s.halfSize, 2 * s.halfSize, 2]} />
          <T.MeshStandardMaterial color={psi6Color(psi6Values[i] ?? 0)} />
        </T.Mesh>
      {/each}
    </Viewer>

    <div
      class="absolute top-4 left-4 flex flex-col gap-2 rounded bg-white/90 dark:bg-gray-800/90 p-3 text-sm text-gray-800 dark:text-gray-100 shadow w-72"
    >
      <div class="font-semibold">Stage 1: radial-field packing</div>

      <label class="flex items-center gap-2">
        Center X
        <input type="range" min="-100" max="100" step="5" bind:value={centerX} class="flex-1" />
        <span class="w-10 text-right font-mono">{centerX}</span>
      </label>
      <label class="flex items-center gap-2">
        Center Y
        <input type="range" min="-70" max="70" step="5" bind:value={centerY} class="flex-1" />
        <span class="w-10 text-right font-mono">{centerY}</span>
      </label>
      <label class="flex items-center gap-2">
        Spacing (m)
        <input type="range" min="0" max="10" step="0.5" bind:value={minGap} class="flex-1" />
        <span class="w-10 text-right font-mono">{minGap}</span>
      </label>

      <div class="flex gap-2">
        <button
          class="flex-1 rounded bg-blue-600 text-white px-2 py-1 hover:bg-blue-700"
          on:click={step}
        >
          Step
        </button>
        <button
          class="flex-1 rounded bg-gray-500 text-white px-2 py-1 hover:bg-gray-600"
          on:click={initialize}
        >
          Reset
        </button>
      </div>

      <div class="font-mono text-xs pt-1 border-t border-gray-300 dark:border-gray-600">
        <div>iteration: {iteration}</div>
        <div>squares placed: {squares.length}</div>
        <div>mean |psi6|: {meanPsi6.toFixed(3)}</div>
        <div>mean coordination: {meanCoordination.toFixed(2)}</div>
        <div>peak S(k) (k != 0): {peakSk.toFixed(2)}</div>
        <div>
          Voronoi sides: {Object.entries(voronoiHistogram)
            .sort(([a], [b]) => Number(a) - Number(b))
            .map(([sides, count]) => `${sides}:${count}`)
            .join(' ')}
        </div>
      </div>

      <details class="font-mono text-xs">
        <summary class="cursor-pointer select-none">g(r) (first {Math.min(gr.length, 8)} bins)</summary>
        {#each gr.slice(0, 8) as bin}
          <div>r={bin.r.toFixed(1)}: g={bin.g.toFixed(2)}</div>
        {/each}
      </details>
    </div>
  {/if}
</div>
