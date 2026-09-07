<script lang="ts">
  import { onMount } from 'svelte'
  import { Vector3 } from 'three'
  import { palmBasisAxes } from '$lib/hand'
  import { drawAxisTriad, drawSkeletonView } from '../lib/overlay'
  import { type Handedness } from '../lib/orientation'
  import PriorSourceChecklist from '../lib/PriorSourceChecklist.svelte'
  import { landmarkLabel } from '../lib/landmarkNames'
  import {
    buildRestExtensionPose,
    buildRestExtensionSkeleton,
    poseToLandmarkVectors,
  } from '../../scan3/lib/priors/ikSolve'
  import { fuseHandPriorState } from '../../scan3/lib/priors/fuseSources'
  import { applyCaliperMeasurement } from '../../scan3/lib/priors/caliperMeasurement'
  import type { PriorSource } from '../../scan3/lib/priors/priorSource'

  // Same shared prior-source checklist as multi-view (PriorSourceChecklist.svelte) -- this page needs
  // it for two reasons: it drives the model-rest render below exactly like multi-view's tile0 does, AND
  // its fused snapshot is the "current best belief" `caliperMeasurement.ts` uses to convert an mm
  // reading into a ratio-space observation (see that file's own doc comment for why).
  let selectedSources: PriorSource[] = []
  let handedness: Handedness = 'Right'
  $: priorSnapshot = fuseHandPriorState(selectedSources, handedness)

  // Identical to multi-view's model-rest tile -- a fixed, never-tracked rendering of the prior alone
  // (bone lengths + ROM), for auditing by eye. See multi-view/+page.svelte's own doc comments for why
  // buildRestExtensionSkeleton/Pose (not buildDefaultSkeleton) and why a fixed real-world scale.
  const REST_VIEW_BASIS = { right: new Vector3(0, 0, 1), up: new Vector3(1, 0, 0) }
  const MODEL_REST_FIXED_HEIGHT_MM = 200
  const WORLD_POSITIONS_UNITS_PER_MM = 100
  const GRID_SPACING_MM = 10 // 1cm squares
  const GRID_BOLD_EVERY = 5 // every 5th line (5cm) drawn bolder, for at-a-glance scale reading

  $: restSkeleton = buildRestExtensionSkeleton(priorSnapshot, handedness)
  $: restPose = buildRestExtensionPose(priorSnapshot, handedness)
  $: restVectors = poseToLandmarkVectors(restSkeleton, restPose)
  $: restHand = { vectors: restVectors }
  $: restAxes = palmBasisAxes(restVectors, handedness)

  let tile: HTMLCanvasElement

  /** 1cm-square grid, drawn ON TOP of the rendered hand (drawSkeletonView clears/fills the whole canvas
   * at its own start, so a grid drawn first would just get erased) -- semi-transparent so the skeleton
   * underneath stays legible. Lines are anchored through `origin` (the wrist) so a square boundary
   * always lines up with landmark 0, not an arbitrary canvas-corner offset. Every 5th line (5cm) drawn
   * bolder/more opaque as a quick-reading scale reference. */
  function drawMmGrid(canvas: HTMLCanvasElement, scale: number, origin: { x: number; y: number }) {
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const pxPerMm = scale * WORLD_POSITIONS_UNITS_PER_MM
    const step = GRID_SPACING_MM * pxPerMm
    if (step <= 0) return

    const drawLine = (x0: number, y0: number, x1: number, y1: number, bold: boolean) => {
      ctx.strokeStyle = bold ? 'rgba(148, 163, 184, 0.55)' : 'rgba(148, 163, 184, 0.22)'
      ctx.lineWidth = bold ? 1.25 : 0.75
      ctx.beginPath()
      ctx.moveTo(x0, y0)
      ctx.lineTo(x1, y1)
      ctx.stroke()
    }

    let i = Math.floor(-origin.x / step)
    for (let x = origin.x + i * step; x <= canvas.width; x += step, i++) {
      drawLine(x, 0, x, canvas.height, i % GRID_BOLD_EVERY === 0)
    }
    let j = Math.floor(-origin.y / step)
    for (let y = origin.y + j * step; y <= canvas.height; y += step, j++) {
      drawLine(0, y, canvas.width, y, j % GRID_BOLD_EVERY === 0)
    }

    // Scale reference, bottom-left corner: a short ruler segment spanning one bold (5cm) interval.
    const barMm = GRID_SPACING_MM * GRID_BOLD_EVERY
    const barPx = barMm * pxPerMm
    const barY = canvas.height - 8
    ctx.strokeStyle = '#e2e8f0'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(8, barY)
    ctx.lineTo(8 + barPx, barY)
    ctx.stroke()
    ctx.fillStyle = '#e2e8f0'
    ctx.font = '11px sans-serif'
    ctx.fillText(`${barMm}mm (grid: 1cm)`, 8, barY - 4)
  }

  function drawRestTile() {
    if (!tile) return
    const scale = tile.height / (MODEL_REST_FIXED_HEIGHT_MM * WORLD_POSITIONS_UNITS_PER_MM)
    const origin = { x: tile.width / 2, y: tile.height - 10 }
    drawSkeletonView(tile, restHand, undefined, REST_VIEW_BASIS, scale, {
      label: 'Model rest (fixed)',
      origin,
      showLandmarkNumbers: true,
    })
    drawAxisTriad(tile, restHand, restAxes, REST_VIEW_BASIS, origin, 0.5)
    drawMmGrid(tile, scale, origin)
  }
  onMount(drawRestTile)
  $: if (tile) {
    restAxes
    drawRestTile()
  }

  const LANDMARK_OPTIONS = Array.from({ length: 21 }, (_, i) => i)

  let landmarkA = 0
  let landmarkB = 11
  let mm = 30
  let uncertaintyMm = 1
  let error: string | undefined
  interface LogEntry {
    handedness: Handedness
    landmarkA: number
    landmarkB: number
    mm: number
    uncertaintyMm: number
  }
  let log: LogEntry[] = []

  function addMeasurement() {
    error = undefined
    const result = applyCaliperMeasurement({
      handedness,
      landmarkA,
      landmarkB,
      mm,
      uncertaintyMm,
      fusedSnapshot: priorSnapshot,
    })
    if (!result.ok) {
      error = result.error
      return
    }
    log = [{ handedness, landmarkA, landmarkB, mm, uncertaintyMm }, ...log]
  }
</script>

<svelte:body class="bg-slate-900 text-gray-50" />

<main class="max-w-3xl mx-auto my-8 px-4">
  <h1 class="text-2xl font-semibold mb-4">Bones: Caliper Measurement Entry</h1>
  <p class="mb-6 text-sm text-gray-300">
    Enter one caliper measurement at a time (two landmarks, in wrist-to-fingertip order, on the SAME
    finger's chain -- cross-finger spans like hand breadth aren't supported yet). Each one updates the
    active hand's "my hand" prior -- both the segments it directly spans (via Bayesian precision-weighted
    conditioning, so a confident reading pulls harder and prior uncertainty decides how much of the
    correction lands where) and, via an implied observation, the shared
    <code>handLength</code> scale every finger's ratios are denominated against. The model-rest view below
    updates after every measurement.
  </p>

  {#if error}
    <div class="mb-4 bg-red-400/30 px-4 py-3 rounded text-sm" role="alert">{error}</div>
  {/if}

  <div class="grid grid-cols-2 gap-4 mb-4">
    <label class="flex flex-col gap-1">
      <span class="text-sm">Hand being measured</span>
      <select bind:value={handedness} class="text-black rounded px-2 py-1">
        <option value="Right">Right</option>
        <option value="Left">Left</option>
      </select>
    </label>
  </div>

  <div class="mb-4">
    <PriorSourceChecklist bind:selectedSources />
  </div>

  <div class="mb-4 rounded overflow-hidden bg-black" style="aspect-ratio: 4/3;">
    <canvas bind:this={tile} width="600" height="450" class="w-full h-full" />
  </div>

  <div class="mb-4 border-t border-gray-700 pt-4">
    <h2 class="text-lg font-semibold mb-2">Add a measurement</h2>
    <div class="grid grid-cols-2 gap-4 mb-3">
      <label class="flex flex-col gap-1">
        <span class="text-sm">Landmark A (base side)</span>
        <select bind:value={landmarkA} class="text-black rounded px-2 py-1">
          {#each LANDMARK_OPTIONS as i}
            <option value={i}>{landmarkLabel(i)}</option>
          {/each}
        </select>
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-sm">Landmark B (tip side)</span>
        <select bind:value={landmarkB} class="text-black rounded px-2 py-1">
          {#each LANDMARK_OPTIONS as i}
            <option value={i}>{landmarkLabel(i)}</option>
          {/each}
        </select>
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-sm">Measurement (mm)</span>
        <input type="number" min="0" step="0.1" bind:value={mm} class="text-black rounded px-2 py-1" />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-sm">Uncertainty (± mm)</span>
        <input
          type="number"
          min="0.01"
          step="0.1"
          bind:value={uncertaintyMm}
          class="text-black rounded px-2 py-1"
        />
        <span class="text-xs text-gray-400">
          A real caliper reading's own noise, not an abstract confidence score -- tighter narrows the
          model harder, matching how every other observation in this project declares noise in real
          units.
        </span>
      </label>
    </div>
    <button
      class="bg-gradient-to-br from-purple-400 to-amber-600 text-lg p-1 rounded-2 shadow-lg"
      on:click={addMeasurement}
    >
      <span class="block bg-slate-900 px-6 py-2 rounded-1.5 font-semibold">Add measurement</span>
    </button>
  </div>

  {#if log.length > 0}
    <div class="mb-4">
      <h2 class="text-lg font-semibold mb-2">Entered this session</h2>
      <ul class="text-xs text-gray-300 list-disc list-inside space-y-1">
        {#each log as entry}
          <li>
            {entry.handedness}: {landmarkLabel(entry.landmarkA)} → {landmarkLabel(entry.landmarkB)} = {entry.mm}mm
            ± {entry.uncertaintyMm}mm
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  <details class="text-xs text-gray-500 mt-6">
    <summary class="cursor-pointer select-none">Methodology notes</summary>
    <div class="mt-2 space-y-2">
      <p>
        Only single-finger, wrist-to-fingertip-order spans are accepted (see `boneSpan.ts`) -- e.g.
        wrist→middle-DIP (0→11) spans the metacarpal/proximal/middle segments and deliberately excludes
        `distal` (DIP→tip), the one segment `handModelData.ts` already flags as combining bone length
        with soft-tissue padding, and whose tip landmark isn't a well-defined point a caliper jaw can
        land on anyway.
      </p>
      <p>
        Every finger's segments still have independent (diagonal) covariance, per `handModelData.ts`'s
        own honesty about there being no sourced cross-segment correlation to base anything stronger on
        -- so measuring one finger does NOT change another finger's own ratio. `handLength` (the shared
        absolute scale) is the one channel that does narrow across every finger, via the
        implied-observation step `caliperMeasurement.ts` performs alongside the direct ratio update.
      </p>
    </div>
  </details>
</main>
