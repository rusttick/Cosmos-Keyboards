<script lang="ts">
  import { onDestroy } from 'svelte'
  import createDetector, { type Detector } from '../lib/detector'
  import { type Handedness } from '../lib/orientation'
  import { drawHandOverlay } from '../lib/overlay'
  import { CONNECTIONS, FINGERS, type Finger } from '$lib/hand'
  import {
    findStillWindow,
    type StillWindowResult,
    type StillWindowSample,
  } from '../../scan3/lib/completion/stillWindow'
  import { PlateauDetector } from '../../scan3/lib/completion/plateau'

  type Mode = 'still-window' | 'plateau'
  type Phase = 'idle' | 'recording'

  const CONFIDENCE_THRESHOLD = 0.7
  const STALL_RESET_SECONDS = 3
  const RAD2DEG = 180 / Math.PI

  let video: HTMLVideoElement
  let overlayCanvas: HTMLCanvasElement
  let stream: MediaStream | undefined
  let detector: Detector | undefined
  let lastKeypoints: { x: number; y: number }[] | undefined

  let mode: Mode = 'still-window'
  let finger: Finger = 'indexFinger'
  let handedness: Handedness = 'Right'

  // Still-window params
  let holdDuration = 5
  // Empirically tuned live against real capture, not guessed — see docs/thumbs/test_results.md, 2026-08-31.
  // A longer window means more consecutive frame-pairs that all have to clear the threshold at once, so
  // shorter windows turned out MORE reliable at a given threshold, not less — 0.5s/200deg/s and
  // 0.25s/150deg/s both outperformed 1s/250deg/s in practice.
  let minDuration = 0.5
  let velocityThresholdDeg = 200 // deg/s
  let warmup = 0.5

  // Plateau params
  let convergenceThresholdDeg = 2
  let requiredStableReps = 2
  // 3deg was way too tight -- same noise-floor problem as the still-window threshold (Test 1's ~2-3deg
  // frame-to-frame delta noise crosses a 3deg reversal constantly on its own). Raised as a starting
  // point; tune live the same way. See docs/thumbs/test_results.md, 2026-08-31.
  let peakHysteresisDeg = 15

  let phase: Phase = 'idle'
  let error: Error | undefined
  let startTime = 0
  let elapsed = 0
  let currentScore: number | undefined
  let lastFrameAt: number | undefined
  let rid: number
  let loopTicks = 0
  let staleResetAttempted = false

  let stillSamples: StillWindowSample[] = []
  let stillResult: StillWindowResult | undefined

  let plateauDetector: PlateauDetector | undefined
  let plateauConverged = false
  let plateauRepCount = 0
  let plateauRanges: { min: number[]; max: number[] } | undefined

  $: noHandDetected =
    phase !== 'idle' && (lastFrameAt === undefined ? elapsed > 1 : elapsed - lastFrameAt > 1)

  function jointAngles(limbs: import('$lib/hand').Hand['limbs'][Finger]): number[] {
    return [0, 1, 2].map((j) => limbs[j].angleTo(limbs[j + 1]) * RAD2DEG)
  }

  async function setupCamera() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('No camera access available')
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user' } })
    video.srcObject = stream
    await new Promise((r) => (video.onloadedmetadata = r))
    video.play()
    overlayCanvas.width = video.videoWidth
    overlayCanvas.height = video.videoHeight
  }

  function teardownCamera() {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop())
      stream = undefined
    }
  }

  async function start() {
    error = undefined
    currentScore = undefined
    lastFrameAt = undefined
    lastKeypoints = undefined
    staleResetAttempted = false

    stillSamples = []
    stillResult = undefined
    plateauDetector = new PlateauDetector({
      jointCount: 3,
      convergenceThreshold: convergenceThresholdDeg,
      requiredStableReps,
      peakHysteresis: peakHysteresisDeg,
    })
    plateauConverged = false
    plateauRepCount = 0
    plateauRanges = undefined

    try {
      detector?.dispose()
      detector = await createDetector()
      await setupCamera()
    } catch (e) {
      error = e as Error
      console.error(e)
      return
    }

    phase = 'recording'
    startTime = performance.now()
    rid = requestAnimationFrame(loop)
  }

  function loop() {
    if (phase === 'idle') return
    elapsed = (performance.now() - startTime) / 1000
    loopTicks++

    if (video.readyState !== 4) {
      rid = requestAnimationFrame(loop)
      return
    }

    const staleFor = lastFrameAt === undefined ? elapsed : elapsed - lastFrameAt
    if (staleFor > STALL_RESET_SECONDS && !staleResetAttempted) {
      staleResetAttempted = true
      detector!.reset()
    }

    detector!
      .estimateHands(video, { flipHorizontal: true })
      .then((hands) => {
        const hand = hands[handedness]
        if (!hand) return
        currentScore = hand.score
        lastFrameAt = elapsed
        staleResetAttempted = false
        lastKeypoints = hand.hand.keypoints
        drawHandOverlay(overlayCanvas, lastKeypoints)

        if (phase === 'recording' && hand.score >= CONFIDENCE_THRESHOLD) {
          const angles = jointAngles(hand.limbs[finger])

          if (mode === 'still-window') {
            stillSamples = [...stillSamples, { t: elapsed, values: angles }]
            stillResult = findStillWindow(stillSamples, {
              minDuration,
              velocityThreshold: velocityThresholdDeg,
              warmup,
            })
            if (stillResult.found) stop()
          } else {
            plateauDetector!.push(angles)
            plateauRepCount = plateauDetector!.repCount
            plateauRanges = plateauDetector!.ranges
            plateauConverged = plateauDetector!.isConverged()
            if (plateauConverged) stop()
          }
        }
      })
      .catch((e) => console.error(e))
      .finally(() => {
        if (phase === 'idle') return
        if (mode === 'still-window' && elapsed >= holdDuration) {
          stop() // allotted hold ran out without finding a still window
        } else {
          rid = requestAnimationFrame(loop)
        }
      })
  }

  function stop() {
    if (phase === 'idle') return
    phase = 'idle'
    cancelAnimationFrame(rid)
    teardownCamera()
  }

  onDestroy(() => {
    if (phase !== 'idle') cancelAnimationFrame(rid)
    teardownCamera()
    detector?.dispose()
  })
</script>

<svelte:body class="bg-slate-900 text-gray-50" />

<main class="max-w-2xl mx-auto my-8 px-4">
  <h1 class="text-2xl font-semibold mb-4">Completion Detectors</h1>
  <p class="mb-6 text-sm text-gray-300">
    Live test of the two completion detectors from <code>src/routes/scan3/lib/completion/</code> —
    <code>stillWindow.ts</code> (Phase 2 / Phase 3 comfortable tier) and <code>plateau.ts</code>
    (Phases 3, 4, 6a) — against real per-frame joint-angle data, not synthetic input.
  </p>

  {#if error}
    <div class="mb-4 bg-red-400/30 px-4 py-3 rounded" role="alert">
      Error: {error.message}
    </div>
  {/if}

  <div class="grid grid-cols-2 gap-4 mb-4">
    <label class="flex flex-col gap-1 col-span-2">
      <span class="text-sm">Mode</span>
      <select bind:value={mode} disabled={phase !== 'idle'} class="text-black rounded px-2 py-1">
        <option value="still-window">Still-window (hold still)</option>
        <option value="plateau">Plateau (flex/extend repeatedly)</option>
      </select>
    </label>

    <label class="flex flex-col gap-1">
      <span class="text-sm">Finger</span>
      <select bind:value={finger} disabled={phase !== 'idle'} class="text-black rounded px-2 py-1">
        {#each FINGERS as f}
          <option value={f}>{f}</option>
        {/each}
      </select>
    </label>

    <label class="flex flex-col gap-1">
      <span class="text-sm">Handedness</span>
      <select bind:value={handedness} disabled={phase !== 'idle'} class="text-black rounded px-2 py-1">
        <option value="Right">Right</option>
        <option value="Left">Left</option>
      </select>
    </label>

    {#if mode === 'still-window'}
      <label class="flex flex-col gap-1">
        <span class="text-sm">Allotted hold (s)</span>
        <input
          type="number"
          min="1"
          bind:value={holdDuration}
          disabled={phase !== 'idle'}
          class="text-black rounded px-2 py-1"
        />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-sm">Min still window (s)</span>
        <input
          type="number"
          min="0.2"
          step="0.1"
          bind:value={minDuration}
          disabled={phase !== 'idle'}
          class="text-black rounded px-2 py-1"
        />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-sm">Velocity threshold (deg/s)</span>
        <input
          type="number"
          min="1"
          bind:value={velocityThresholdDeg}
          disabled={phase !== 'idle'}
          class="text-black rounded px-2 py-1"
        />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-sm">Warmup discard (s)</span>
        <input
          type="number"
          min="0"
          step="0.1"
          bind:value={warmup}
          disabled={phase !== 'idle'}
          class="text-black rounded px-2 py-1"
        />
      </label>
    {:else}
      <label class="flex flex-col gap-1">
        <span class="text-sm">Convergence threshold (deg)</span>
        <input
          type="number"
          min="0.5"
          step="0.5"
          bind:value={convergenceThresholdDeg}
          disabled={phase !== 'idle'}
          class="text-black rounded px-2 py-1"
        />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-sm">Required stable reps</span>
        <input
          type="number"
          min="1"
          bind:value={requiredStableReps}
          disabled={phase !== 'idle'}
          class="text-black rounded px-2 py-1"
        />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-sm">Peak hysteresis (deg)</span>
        <input
          type="number"
          min="0.5"
          step="0.5"
          bind:value={peakHysteresisDeg}
          disabled={phase !== 'idle'}
          class="text-black rounded px-2 py-1"
        />
      </label>
    {/if}
  </div>

  <div class="mb-4 rounded overflow-hidden bg-black aspect-video relative">
    <!-- svelte-ignore a11y-media-has-caption -->
    <video bind:this={video} playsinline muted class="w-full h-full object-contain -scale-x-100" />
    <canvas
      bind:this={overlayCanvas}
      class="absolute inset-0 w-full h-full object-contain pointer-events-none"
    />
  </div>

  <div class="mb-4">
    {#if phase === 'idle'}
      <button
        class="bg-gradient-to-br from-purple-400 to-amber-600 text-lg p-1 rounded-2 shadow-lg"
        on:click={start}
      >
        <span class="block bg-slate-900 px-6 py-2 rounded-1.5 font-semibold">Start</span>
      </button>
    {:else}
      <button
        class="bg-gradient-to-br from-purple-400 to-amber-600 text-lg p-1 rounded-2 shadow-lg"
        on:click={stop}
      >
        <span class="block bg-slate-900 px-6 py-2 rounded-1.5 font-semibold">Stop</span>
      </button>
    {/if}
  </div>

  <div class="text-sm text-gray-300 mb-4">
    <p>
      Phase: <span class="font-semibold text-white">{phase}</span>
      {#if phase !== 'idle'}(loop tick {loopTicks}, {elapsed.toFixed(1)}s){/if}
    </p>
    <p class:text-amber-400={noHandDetected}>
      Current confidence: {currentScore !== undefined ? currentScore.toFixed(3) : '—'}
    </p>
    {#if noHandDetected}
      <p class="text-amber-400 font-semibold">
        No {handedness} hand detected in the last second — check that it's in frame and matches the selected
        handedness.
        {#if staleResetAttempted}(tracking reset attempted — still nothing seen){/if}
      </p>
    {/if}
  </div>

  {#if mode === 'still-window'}
    <div class="mb-4">
      <h2 class="text-lg font-semibold mb-2">Still-window search</h2>
      <p class="text-sm">Samples collected: {stillSamples.length}</p>
      {#if stillResult}
        {#if stillResult.found}
          <p class="text-green-400 font-semibold">
            Found: {stillResult.startTime.toFixed(2)}s to {stillResult.endTime.toFixed(2)}s ({(
              stillResult.endTime - stillResult.startTime
            ).toFixed(2)}s)
          </p>
          <table class="text-xs text-left mt-2">
            <thead class="text-gray-400">
              <tr><th class="pr-4">Joint</th><th>Mean (deg)</th></tr>
            </thead>
            <tbody>
              {#each stillResult.mean as m, i}
                <tr><td class="pr-4">{i + 1}</td><td>{m.toFixed(2)}</td></tr>
              {/each}
            </tbody>
          </table>
        {:else if phase === 'idle' && stillSamples.length > 0}
          <p class="text-amber-400 font-semibold">
            Not found within the allotted hold — hold stiller or lengthen the hold.
          </p>
        {/if}
      {/if}
    </div>
  {:else if plateauRanges}
    <div class="mb-4">
      <h2 class="text-lg font-semibold mb-2">Plateau detection</h2>
      <p class="text-sm">
        Reps completed: {plateauRepCount} —
        <span class:text-green-400={plateauConverged} class:font-semibold={plateauConverged}>
          {plateauConverged ? 'Converged' : 'Not converged yet'}
        </span>
      </p>
      <table class="text-xs text-left mt-2">
        <thead class="text-gray-400">
          <tr><th class="pr-4">Joint</th><th class="pr-4">Min (deg)</th><th>Max (deg)</th></tr>
        </thead>
        <tbody>
          {#each [0, 1, 2] as j}
            <tr>
              <td class="pr-4">{j + 1}</td>
              <td class="pr-4"
                >{plateauRanges.min[j] === Infinity ? '—' : plateauRanges.min[j].toFixed(2)}</td
              >
              <td>{plateauRanges.max[j] === -Infinity ? '—' : plateauRanges.max[j].toFixed(2)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  <details class="text-xs text-gray-500 mt-6">
    <summary class="cursor-pointer select-none">Methodology notes</summary>
    <div class="mt-2 space-y-2">
      <p>
        Signal fed to both detectors is the same one used throughout scan-tests: the 3 inter-bone angles
        (joint 1/2/3) for the selected finger, in degrees, via <code>Vector3.angleTo</code>. Still-window
        mode auto-stops as soon as a window is found, or when the allotted hold runs out. Plateau mode
        auto-stops as soon as it converges — the primary joint for rep detection is joint 1 (index 0 of
        the pushed angle array).
      </p>
      <p>
        These are the real library functions from <code>src/routes/scan3/lib/completion/</code>, not a
        reimplementation for this test page — verified against synthetic data before this page was built
        (see docs/thumbs/test_results.md).
      </p>
    </div>
  </details>
</main>
