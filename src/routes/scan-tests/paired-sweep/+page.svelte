<script lang="ts">
  import { onDestroy } from 'svelte'
  import createDetector, { type Detector } from '../lib/detector'
  import { type Handedness } from '../lib/orientation'
  import { drawHandOverlay } from '../lib/overlay'
  import { FINGERS, objectFromFingers, type Finger, type Hand, signedJointAngle } from '$lib/hand'
  import {
    coverageFraction,
    type CoverageGridState,
    isCoverageComplete,
    makeCoverageGrid,
    updateCoverageGrid,
  } from '../../scan3/lib/completion/coverageGrid'
  import { type Enslaving, fitEnslavingAll } from '../../scan3/lib/phases/pairedSweep'

  type Phase = 'idle' | 'recording'

  const CONFIDENCE_THRESHOLD = 0.7
  const STALL_RESET_SECONDS = 3
  const STATS_UPDATE_EVERY = 10 // accepted frames between enslaving refits

  let video: HTMLVideoElement
  let overlayCanvas: HTMLCanvasElement
  let stream: MediaStream | undefined
  let detector: Detector | undefined

  // "Active" finger -- the one you deliberately move more. All 5 fingers are recorded every frame
  // regardless, so a single session yields E[fingerI][j] against every other finger at once (closer
  // to the literature's own "move only finger i, watch every finger's response" method than a
  // one-pair-per-session design would be) -- see docs/thumbs/test_results.md, 2026-09-01.
  let fingerI: Finger = 'indexFinger'
  // The coverage grid is inherently pairwise (a geometric-blocking question between two specific
  // fingers), so it still needs one finger picked out from the rest.
  let coverageFinger: Finger = 'middleFinger'
  let handedness: Handedness = 'Right'
  let sessionDuration = 30
  let boundsMin = 0
  let boundsMax = 90
  let gridResolution = 9

  let phase: Phase = 'idle'
  let error: Error | undefined
  let startTime = 0
  let elapsed = 0
  let currentScore: number | undefined
  let lastFrameAt: number | undefined
  let rid: number
  let loopTicks = 0
  let staleResetAttempted = false

  let angleHistories: Record<Finger, number[]> = objectFromFingers(() => [])
  let currentAngles: Partial<Record<Finger, number>> = {}
  let acceptedFrames = 0
  let grid: CoverageGridState = makeCoverageGrid(
    [
      [0, 90],
      [0, 90],
    ],
    9
  )
  let enslavingAll: Partial<Record<Finger, Enslaving>> = {}

  $: noHandDetected =
    phase !== 'idle' && (lastFrameAt === undefined ? elapsed > 1 : elapsed - lastFrameAt > 1)
  $: sameFingerSelected = fingerI === coverageFinger
  $: otherFingers = FINGERS.filter((f) => f !== fingerI)

  /** A terse, self-contained text block meant to be selected and pasted elsewhere -- kept separate
   * from the coverage-grid visualization below, which is a lot of markup but carries no information
   * a pasted-in reader needs beyond the coverage percentage already in this summary. */
  $: resultSummary = [
    `active: ${fingerI}, ${handedness}, ${acceptedFrames} frames`,
    ...otherFingers.map((f) => {
      const e = enslavingAll[f]
      return e
        ? `E[${fingerI}][${f}] ~= ${e.coefficient.toFixed(3)}, R2 = ${e.r2.toFixed(3)}`
        : `E[${fingerI}][${f}]: not ready yet`
    }),
    `coverage (${fingerI} x ${coverageFinger}): ${(coverageFraction(grid) * 100).toFixed(0)}% of ${
      gridResolution * gridResolution
    } cells${isCoverageComplete(grid) ? ' (>=70%, complete)' : ''}`,
  ].join('\n')

  /** PIP-equivalent signed flexion angle -- same `signedJointAngle(hand, finger, 1)` convention
   * flexion-sweep and flexion.ts's DIP/PIP fit already use, so this reads finger flexion the same way
   * everywhere in this test suite. Signed so a finger pair whose enslaving relationship spans
   * hyperextension isn't folded into ordinary flexion's numbers. */
  function flexionAngle(hand: Hand, finger: Finger): number {
    return signedJointAngle(hand, finger, 1)
  }

  function refitEnslaving() {
    if (angleHistories[fingerI].length < 3) {
      enslavingAll = {}
      return
    }
    // fitEnslavingAll omits any finger with no i-dominant segment yet rather than throwing, so
    // this always succeeds once the active finger has at least a few frames.
    enslavingAll = fitEnslavingAll(fingerI, angleHistories)
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
    if (sameFingerSelected) {
      error = new Error('Active finger and coverage finger must be different')
      return
    }
    error = undefined
    angleHistories = objectFromFingers(() => [])
    acceptedFrames = 0
    currentAngles = {}
    enslavingAll = {}
    grid = makeCoverageGrid(
      [
        [boundsMin, boundsMax],
        [boundsMin, boundsMax],
      ],
      gridResolution
    )
    currentScore = undefined
    lastFrameAt = undefined
    staleResetAttempted = false
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
        drawHandOverlay(overlayCanvas, hand.hand.keypoints)

        const angles = objectFromFingers((f) => flexionAngle(hand, f))
        currentAngles = angles

        if (phase === 'recording' && hand.score >= CONFIDENCE_THRESHOLD) {
          for (const f of FINGERS) angleHistories[f].push(angles[f])
          grid = updateCoverageGrid(
            grid,
            [angles[fingerI], angles[coverageFinger]],
            hand.score,
            CONFIDENCE_THRESHOLD
          )
          acceptedFrames++

          if (acceptedFrames % STATS_UPDATE_EVERY === 0) refitEnslaving()
        }
      })
      .catch((e) => console.error(e))
      .finally(() => {
        if (phase === 'idle') return
        if (phase === 'recording' && elapsed >= sessionDuration) {
          stop()
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
    refitEnslaving()
  }

  onDestroy(() => {
    if (phase !== 'idle') cancelAnimationFrame(rid)
    teardownCamera()
    detector?.dispose()
  })
</script>

<svelte:body class="bg-slate-900 text-gray-50" />

<main class="max-w-3xl mx-auto my-8 px-4">
  <h1 class="text-2xl font-semibold mb-4">Paired Sweep: Enslaving Coefficient &amp; Coverage Grid</h1>
  <p class="mb-6 text-sm text-gray-300">
    All 5 fingers are tracked at once. Move the active finger deliberately while letting the rest move
    however they naturally do -- no separate "keep everything else still" instruction needed, just bias
    toward moving the active one more. The enslaving fit only uses segments where the active finger's
    motion clearly dominates a given other finger's, which this naturally passes through (Test 9), and
    yields E[i][j] against every other finger from one recording. The coverage grid separately tracks how
    much of the (θᵢ, θⱼ) space gets visited for one chosen pair (Test 12's algorithm, not its resolution
    tuning).
  </p>

  {#if error}
    <div class="mb-4 bg-red-400/30 px-4 py-3 rounded" role="alert">
      Error: {error.message}
    </div>
  {/if}

  <div class="grid grid-cols-2 gap-4 mb-4">
    <label class="flex flex-col gap-1">
      <span class="text-sm">Active finger (i) — move this one deliberately</span>
      <select bind:value={fingerI} disabled={phase !== 'idle'} class="text-black rounded px-2 py-1">
        {#each FINGERS as f}
          <option value={f}>{f}</option>
        {/each}
      </select>
      <span class="text-xs text-gray-400">
        All 5 fingers are tracked every frame — E[{fingerI}][j] is fit against every other finger from
        this one recording.
      </span>
    </label>

    <label class="flex flex-col gap-1">
      <span class="text-sm">Coverage-grid partner finger</span>
      <select
        bind:value={coverageFinger}
        disabled={phase !== 'idle'}
        class="text-black rounded px-2 py-1"
      >
        {#each FINGERS as f}
          <option value={f}>{f}</option>
        {/each}
      </select>
      <span class="text-xs text-gray-400">
        The (θᵢ, θⱼ) coverage grid is pairwise — pick which other finger to pair the active finger
        against for it.
      </span>
    </label>

    <label class="flex flex-col gap-1">
      <span class="text-sm">Handedness</span>
      <select bind:value={handedness} disabled={phase !== 'idle'} class="text-black rounded px-2 py-1">
        <option value="Right">Right</option>
        <option value="Left">Left</option>
      </select>
    </label>

    <label class="flex flex-col gap-1">
      <span class="text-sm">Session duration (seconds)</span>
      <input
        type="number"
        min="10"
        bind:value={sessionDuration}
        disabled={phase !== 'idle'}
        class="text-black rounded px-2 py-1"
      />
    </label>

    <label class="flex flex-col gap-1">
      <span class="text-sm">Grid bounds (deg, both axes)</span>
      <div class="flex gap-2">
        <input
          type="number"
          bind:value={boundsMin}
          disabled={phase !== 'idle'}
          class="text-black rounded px-2 py-1 w-full"
        />
        <input
          type="number"
          bind:value={boundsMax}
          disabled={phase !== 'idle'}
          class="text-black rounded px-2 py-1 w-full"
        />
      </div>
    </label>

    <label class="flex flex-col gap-1">
      <span class="text-sm">Grid resolution (cells per axis)</span>
      <input
        type="number"
        min="2"
        bind:value={gridResolution}
        disabled={phase !== 'idle'}
        class="text-black rounded px-2 py-1"
      />
    </label>
  </div>

  {#if sameFingerSelected}
    <p class="text-amber-400 text-sm mb-4">Active finger and coverage-grid partner must be different.</p>
  {/if}

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
      {#if phase !== 'idle'}(loop tick {loopTicks}, {elapsed.toFixed(1)}s / {sessionDuration}s){/if}
    </p>
    <p>
      {#each FINGERS as f, i}{#if i > 0}&nbsp;|&nbsp;{/if}<span class:font-semibold={f === fingerI}
          >{f}: {currentAngles[f] !== undefined ? currentAngles[f]?.toFixed(1) + '°' : '—'}</span
        >{/each}
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

  <div class="mb-4">
    <h2 class="text-lg font-semibold mb-2">Result summary (select and copy this)</h2>
    <pre class="text-xs bg-black/40 rounded p-3 whitespace-pre-wrap select-all">{resultSummary}</pre>
  </div>

  <details class="mb-4">
    <summary class="cursor-pointer select-none text-sm text-gray-400">
      Coverage grid (visual only — not needed for a pasted result)
    </summary>
    <div class="mt-2">
      <div
        class="grid gap-px bg-slate-700 w-fit mb-2"
        style="grid-template-columns: repeat({gridResolution}, 14px)"
      >
        {#each [...grid.visited].reverse() as row}
          {#each row as cell}
            <div class="w-3.5 h-3.5" class:bg-purple-500={cell} class:bg-slate-900={!cell} />
          {/each}
        {/each}
      </div>
      <p class="text-xs text-gray-500">
        Rows are {fingerI} angle (bottom = {boundsMin}°, top = {boundsMax}°); columns are {coverageFinger}
        angle (left = {boundsMin}°, right = {boundsMax}°). Purple = at least one confidence-passing
        sample landed in that cell.
      </p>
    </div>
  </details>

  <details class="text-xs text-gray-500 mt-6">
    <summary class="cursor-pointer select-none">Methodology notes</summary>
    <div class="mt-2 space-y-2">
      <p>
        Every finger's angle uses the same signed PIP-equivalent flexion angle `flexion-sweep`/
        `flexion.ts` already use (`signedJointAngle(hand, finger, 1)`, in `$lib/hand.ts`), so this test's
        numbers are directly comparable to Test 8's. Negative readings are hyperextension past straight,
        not clamped into the same range as ordinary flexion — if you or the person being captured has a
        finger that naturally hyperextends, that's expected to show up as negative rather than as a small
        positive number indistinguishable from slight flexion.
      </p>
      <p>
        All 5 fingers are recorded every frame, not just the active one — E[{fingerI}][j] is fit
        independently against each other finger from the same recording, closer to the literature's own
        "move only finger i, watch every finger's response" method than a one-pair-per-session design
        would be (see docs/thumbs/test_results.md, 2026-09-01). The enslaving fit only uses
        frame-to-frame deltas where the active finger's change is at least 3° and at least 2× the other
        finger's change (`fitEnslaving`'s defaults) — the freeform-sweep stand-in for the "keep the other
        fingers relaxed" instruction. A finger with no such i-dominant segment yet shows "not ready"
        rather than a fit; try exaggerating "mostly move {fingerI}" for a few seconds if one stays
        unready.
      </p>
      <p>
        Grid bounds are fixed at Start, not grown adaptively — unlike Phase 4's abduction capture, which
        has no prior ROM to anchor to, Phase 5 normally runs after Phases 3/4 have already established
        each finger's ROM. If a lot of samples fall outside the configured bounds, widen them and restart
        rather than expecting the grid to expand mid-session. `boundsMin` can be negative — set it below
        0 if either finger's comfortable range includes hyperextension, otherwise those samples will
        silently fall outside the grid and be dropped rather than counted.
      </p>
    </div>
  </details>
</main>
