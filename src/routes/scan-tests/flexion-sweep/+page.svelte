<script lang="ts">
  import { onDestroy } from 'svelte'
  import createDetector, { type Detector } from '../lib/detector'
  import { type Handedness, palmAngleDeg, thumbDepthSign } from '../lib/orientation'
  import { drawHandOverlay } from '../lib/overlay'
  import {
    calculateJoints,
    FINGERS,
    type Finger,
    type Hand,
    type Joint,
    objectFromFingers,
  } from '$lib/hand'
  import { type DipPipFit, fitDipPipCoupling } from '../../scan3/lib/phases/flexion'

  type Phase = 'idle' | 'recording'

  const BIN_WIDTH_DEG = 10
  const BIN_COUNT = 9 // 0-10, 10-20, ..., 80-90 -- palm-facing (0deg) through full lateral (90deg)
  const CONFIDENCE_THRESHOLD = 0.7
  const STALL_RESET_SECONDS = 3
  const STATS_UPDATE_EVERY = 10 // total accepted frames (across all bins) between refits

  // fitNorms/calculateJoints take an explicit bone-length reference ("means") purely to populate
  // Joint.length — irrelevant here, since only V/Vinv/degree/axisConfidence are used. A placeholder
  // avoids needing a separate bone-length calibration pass before this test can run.
  const DUMMY_MEANS: Record<Finger, number[]> = objectFromFingers(() => [1, 1, 1, 1])

  interface Bin {
    index: number // 0..BIN_COUNT-1; covers [index*BIN_WIDTH_DEG, (index+1)*BIN_WIDTH_DEG) degrees
    history: Hand[] // full per-frame Hand objects — calculateJoints needs the whole batch, not a running stat
    acceptedFrames: number
    romMin: number[] // per joint (1, 2, 3)
    romMax: number[]
    axisConfidence: number | undefined
  }

  function makeBin(index: number): Bin {
    return {
      index,
      history: [],
      acceptedFrames: 0,
      romMin: [Infinity, Infinity, Infinity],
      romMax: [-Infinity, -Infinity, -Infinity],
      axisConfidence: undefined,
    }
  }

  let video: HTMLVideoElement
  let overlayCanvas: HTMLCanvasElement
  let stream: MediaStream | undefined
  let detector: Detector | undefined
  let lastKeypoints: { x: number; y: number }[] | undefined

  let finger: Finger = 'indexFinger'
  let handedness: Handedness = 'Right'
  let sessionDuration = 30

  let phase: Phase = 'idle'
  let error: Error | undefined
  let startTime = 0
  let elapsed = 0
  let currentScore: number | undefined
  let lastFrameAt: number | undefined
  let palmAngle: number | undefined
  let thumbDepth: number | undefined
  let rid: number
  let loopTicks = 0
  let staleResetAttempted = false
  let totalAcceptedFrames = 0

  let bins: Bin[] = Array.from({ length: BIN_COUNT }, (_, i) => makeBin(i))
  let dipPipFit: DipPipFit | undefined

  interface ResidualBucket {
    pipLo: number
    pipHi: number
    count: number
    meanAbsResidual: number
  }

  /** Buckets samples by PIP angle into equal-width ranges and averages |residual| within each, so a
   * systematic curve near the ROM extremes (Test 8, scan_tests.md) shows up as a trend across
   * buckets rather than needing to eyeball hundreds of individual points. */
  function residualBuckets(fit: DipPipFit, bucketCount = 8): ResidualBucket[] {
    if (fit.samples.length === 0) return []
    const pips = fit.samples.map((s) => s.pip)
    const lo = Math.min(...pips)
    const hi = Math.max(...pips)
    const width = (hi - lo) / bucketCount || 1

    const buckets: { sum: number; count: number }[] = Array.from({ length: bucketCount }, () => ({
      sum: 0,
      count: 0,
    }))
    for (const s of fit.samples) {
      const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((s.pip - lo) / width)))
      buckets[idx].sum += Math.abs(s.residual)
      buckets[idx].count++
    }

    return buckets.map((b, i) => ({
      pipLo: lo + i * width,
      pipHi: lo + (i + 1) * width,
      count: b.count,
      meanAbsResidual: b.count === 0 ? NaN : b.sum / b.count,
    }))
  }

  /** Pools every accepted frame across all palm-angle bins — unlike axis-fit confidence and ROM
   * (which are compared bin-by-bin against palm angle), the DIP/PIP coupling question is about the
   * finger's full-tier sweep as a whole, not about camera orientation. */
  function refitDipPip() {
    const allFrames = bins.flatMap((b) => b.history)
    dipPipFit = allFrames.length >= 2 ? fitDipPipCoupling(allFrames, finger) : undefined
  }

  $: noHandDetected =
    phase !== 'idle' && (lastFrameAt === undefined ? elapsed > 1 : elapsed - lastFrameAt > 1)
  $: currentBinIndex =
    palmAngle !== undefined && palmAngle >= 0 && palmAngle < BIN_COUNT * BIN_WIDTH_DEG
      ? Math.floor(palmAngle / BIN_WIDTH_DEG)
      : undefined

  function jointConfidence(j: Joint): number | undefined {
    return j.degree === 0 ? undefined : j.axisConfidence
  }

  /** Refits every bin with any accumulated frames. calculateJoints's three non-metacarpal joint fits
   * for one finger all operate on the same pooled bone-direction data (only the coordinate frame
   * rotates between them), so their singular-value-ratio confidence comes out numerically identical
   * across joints — confirmed against synthetic data, see docs/thumbs/test_results.md. One confidence
   * number per bin, not three independent per-joint ones. */
  function refitAll() {
    for (const bin of bins) {
      if (bin.history.length === 0) continue
      const joints = calculateJoints(bin.history, DUMMY_MEANS)
      bin.axisConfidence = jointConfidence(joints[finger][1])
    }
    bins = bins
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
    bins = Array.from({ length: BIN_COUNT }, (_, i) => makeBin(i))
    dipPipFit = undefined
    totalAcceptedFrames = 0
    currentScore = undefined
    lastFrameAt = undefined
    palmAngle = undefined
    thumbDepth = undefined
    lastKeypoints = undefined
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
        palmAngle = palmAngleDeg(hand)
        thumbDepth = thumbDepthSign(hand)
        lastKeypoints = hand.hand.keypoints
        drawHandOverlay(overlayCanvas, lastKeypoints)

        if (
          phase === 'recording' &&
          hand.score >= CONFIDENCE_THRESHOLD &&
          currentBinIndex !== undefined
        ) {
          const bin = bins[currentBinIndex]
          bin.history.push(hand)

          const limbs = hand.limbs[finger]
          const newMin = [...bin.romMin]
          const newMax = [...bin.romMax]
          for (let j = 0; j < 3; j++) {
            const angleDeg = (limbs[j].angleTo(limbs[j + 1]) * 180) / Math.PI
            if (angleDeg < newMin[j]) newMin[j] = angleDeg
            if (angleDeg > newMax[j]) newMax[j] = angleDeg
          }
          bin.romMin = newMin
          bin.romMax = newMax
          bin.acceptedFrames++
          bins = bins

          totalAcceptedFrames++
          if (totalAcceptedFrames % STATS_UPDATE_EVERY === 0) {
            refitAll()
            refitDipPip()
          }
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
    refitAll()
    refitDipPip()
  }

  onDestroy(() => {
    if (phase !== 'idle') cancelAnimationFrame(rid)
    teardownCamera()
    detector?.dispose()
  })
</script>

<svelte:body class="bg-slate-900 text-gray-50" />

<main class="max-w-3xl mx-auto my-8 px-4">
  <h1 class="text-2xl font-semibold mb-4">Flexion Sweep: Axis-Fit vs. Palm Angle</h1>
  <p class="mb-6 text-sm text-gray-300">
    Start near palm-facing (0°) and slowly rotate toward the full lateral roll (~90°) over the course of
    the recording, continuously flexing and extending the selected finger throughout. Frames are
    automatically grouped into {BIN_WIDTH_DEG}° palm-angle bins live below — the goal is finding the
    angle where axis-fit confidence and ROM stop looking trustworthy, not just comparing two fixed
    endpoints.
  </p>

  {#if error}
    <div class="mb-4 bg-red-400/30 px-4 py-3 rounded" role="alert">
      Error: {error.message}
    </div>
  {/if}

  <div class="grid grid-cols-2 gap-4 mb-4">
    <label class="flex flex-col gap-1">
      <span class="text-sm">Finger</span>
      <select bind:value={finger} disabled={phase !== 'idle'} class="text-black rounded px-2 py-1">
        {#each FINGERS as f}
          <option value={f}>{f}</option>
        {/each}
      </select>
      {#if finger === 'thumb'}
        <span class="text-xs text-amber-400">
          Thumb tracking has a known systematic bias off palm-facing (see test_results.md, 2026-08-31) —
          start with a non-thumb finger first if this is your first run.
        </span>
      {/if}
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
      {#if phase !== 'idle'}(loop tick {loopTicks}, {elapsed.toFixed(1)}s / {sessionDuration}s){/if}
    </p>
    <p>
      Palm angle: {palmAngle !== undefined ? palmAngle.toFixed(0) + '°' : '—'}
      {#if currentBinIndex !== undefined}
        (bin {currentBinIndex * BIN_WIDTH_DEG}-{(currentBinIndex + 1) * BIN_WIDTH_DEG}°)
      {:else if palmAngle !== undefined}
        (outside 0-{BIN_COUNT * BIN_WIDTH_DEG}° range — not counted)
      {/if}
    </p>
    <p>Thumb depth sign: {thumbDepth !== undefined ? thumbDepth.toFixed(3) : '—'}</p>
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

  {#if totalAcceptedFrames > 0}
    <div class="mb-4">
      <h2 class="text-lg font-semibold mb-2">
        {finger}, {handedness} — confidence and ROM by palm angle
      </h2>
      <div class="overflow-x-auto">
        <table class="text-xs text-left w-full">
          <thead class="text-gray-400">
            <tr>
              <th class="pr-4">Bin</th>
              <th class="pr-4">Frames</th>
              <th class="pr-4">Confidence</th>
              <th class="pr-4">J1 ROM</th>
              <th class="pr-4">J2 ROM</th>
              <th>J3 ROM</th>
            </tr>
          </thead>
          <tbody>
            {#each bins as bin}
              <tr>
                <td class="pr-4">{bin.index * BIN_WIDTH_DEG}-{(bin.index + 1) * BIN_WIDTH_DEG}°</td>
                <td class="pr-4">{bin.acceptedFrames}</td>
                <td class="pr-4"
                  >{bin.axisConfidence === undefined ? '—' : bin.axisConfidence.toFixed(2)}</td
                >
                {#each [0, 1, 2] as j}
                  <td class="pr-4">
                    {bin.romMin[j] === Infinity
                      ? '—'
                      : `${bin.romMin[j].toFixed(1)} to ${bin.romMax[j].toFixed(1)}`}
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}

  {#if dipPipFit}
    <div class="mb-4">
      <h2 class="text-lg font-semibold mb-2">
        {finger}, {handedness} — DIP/PIP coupling (Test 8, pooled across all bins, {dipPipFit.samples
          .length}
        frames)
      </h2>
      <p class="text-sm mb-2">
        dip ≈ {dipPipFit.slope.toFixed(3)} × pip + {dipPipFit.intercept.toFixed(2)}°, R² = {dipPipFit.r2.toFixed(
          3
        )}
      </p>
      <p class="text-xs text-gray-400 mb-2">
        Mean |residual| by PIP-angle range — a flat row-to-row trend means the linear fit holds
        throughout; residuals growing toward the first/last rows means the coupling curves near the ROM
        extremes.
      </p>
      <div class="overflow-x-auto">
        <table class="text-xs text-left w-full">
          <thead class="text-gray-400">
            <tr>
              <th class="pr-4">PIP range</th>
              <th class="pr-4">Frames</th>
              <th>Mean |residual|</th>
            </tr>
          </thead>
          <tbody>
            {#each residualBuckets(dipPipFit) as bucket}
              <tr>
                <td class="pr-4">{bucket.pipLo.toFixed(0)}-{bucket.pipHi.toFixed(0)}°</td>
                <td class="pr-4">{bucket.count}</td>
                <td>{bucket.count === 0 ? '—' : bucket.meanAbsResidual.toFixed(2) + '°'}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}

  <details class="text-xs text-gray-500 mt-6">
    <summary class="cursor-pointer select-none">Methodology notes</summary>
    <div class="mt-2 space-y-2">
      <p>
        One confidence number per bin, not three independent per-joint ones — see the code comment on
        refitAll(). ROM per bin is a snapshot of however much the joint moved while the palm happened to
        be rotating through that 10° slice, not the finger's full range of motion — it's only comparable
        across bins if the flex/extend cycle is happening fast enough, relative to how slowly you're
        rotating, that each bin captures a comparable fraction of a cycle. A narrow bin with very few
        frames (check the Frames column) will have an unreliable confidence fit regardless of what the
        number says.
      </p>
      <p>
        Palm angle is unsigned (0-180°) and can't by itself distinguish the two lateral roll directions —
        only thumb-away's direction is reliably reachable near 90° on this rig (thumb-toward was dropped;
        see docs/thumbs/test_results.md, 2026-08-31), so bins approaching 90° implicitly assume you're
        rolling that way. The live thumb-depth-sign readout is there to check you're rolling in the
        expected direction, not used to gate binning here.
      </p>
    </div>
  </details>
</main>
