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
    signedJointAngle,
  } from '$lib/hand'
  import type { NonThumbFinger } from '../../scan3/lib/priors/handModel'
  import { type DipPipFit, fitDipPipCoupling } from '../../scan3/lib/phases/flexion'
  import { DEFAULT_ONE_EURO_OPTIONS } from '../lib/landmarkFilter'
  import { fitEnslavingAll } from '../../scan3/lib/phases/pairedSweep'
  import {
    type FlexionSweepFragment,
    HANDEDNESSES,
    mergeFlexionSweepFragment,
    myHandPrior,
    resetMyHandPrior,
    serializeMyHandPriorModule,
  } from '../../scan3/lib/priors/myHandStore'
  import type { PartialHandPriorState } from '../../scan3/lib/priors/priorSource'

  type Phase = 'idle' | 'recording'

  // One store, both hands inside it (myHandStore.ts's own doc comment: never pooled into one shared
  // belief -- this project's own capture data already found real per-hand asymmetry in DIP/PIP
  // coupling). Both shown below regardless of which hand is currently selected for capture, so
  // progress on both is visible at a glance. `?? {}` so the template can index either side safely even
  // before it's ever been swept.
  let myHandByHandedness: Record<Handedness, PartialHandPriorState>
  $: myHandByHandedness = {
    Right: $myHandPrior.Right ?? {},
    Left: $myHandPrior.Left ?? {},
  }

  const NON_THUMB_FINGERS = FINGERS.filter((f): f is NonThumbFinger => f !== 'thumb')
  const BIN_WIDTH_DEG = 10
  const BIN_COUNT = 9 // 0-10, 10-20, ..., 80-90 -- palm-facing (0deg) through full lateral (90deg)
  // Only these low bins (nearest true palm-facing, the orientation capture-protocol.md actually
  // specifies for flexion elicitation) feed `myHandPrior` -- the rest exist purely for the
  // orientation-bias diagnostic table below, since Test 4 already found confidence/noise degrading well
  // before 90deg. Originally just bin 0 (0-10deg) alone -- widened to 0-2 (0-30deg) after real capture
  // showed bin 0 staying empty for entire sweeps (a real hand rarely holds dead-on 0deg palm angle for
  // 2+ consecutive frames while also actively flexing/extending), which silently starved ROM of any
  // data every single run while DIP/PIP coupling and enslaving -- pooled across ALL bins regardless of
  // angle -- kept populating normally. 0-30deg is still comfortably inside the low-bias range Test 4's
  // degradation was gradual through, not a return to the original single-bin strictness.
  const PRIOR_SOURCE_MAX_BIN = 2
  const CONFIDENCE_THRESHOLD = 0.7
  const STALL_RESET_SECONDS = 3

  // fitNorms/calculateJoints take an explicit bone-length reference ("means") purely to populate
  // Joint.length — irrelevant here, since only V/Vinv/degree/axisConfidence are used. A placeholder
  // avoids needing a separate bone-length calibration pass before this test can run.
  const DUMMY_MEANS: Record<Finger, number[]> = objectFromFingers(() => [1, 1, 1, 1])

  interface Bin {
    index: number
    history: Hand[]
    acceptedFrames: number
    romMin: number[]
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

  /** Pools raw frames across every bin from 0 to PRIOR_SOURCE_MAX_BIN (see that constant's own doc
   * comment for why a single bin starved this in practice) and computes a real BetaRom directly from
   * them, rather than trying to combine per-bin Welford accumulators. */
  function romFromFrames(frames: Hand[], f: Finger, joint: 0 | 1 | 2, source: string) {
    if (frames.length < 2) return undefined
    const angles = frames.map((h) => signedJointAngle(h, f, joint))
    const meanDeg = angles.reduce((a, b) => a + b, 0) / angles.length
    const variance = angles.reduce((s, a) => s + (a - meanDeg) ** 2, 0) / (angles.length - 1)
    return {
      minDeg: Math.min(...angles),
      maxDeg: Math.max(...angles),
      meanDeg,
      sdDeg: Math.max(Math.sqrt(variance), 0.1),
      source,
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
  let lastFrameAt: number | undefined
  let rid: number
  let loopTicks = 0
  let staleResetAttempted = false
  let totalAcceptedFrames = 0
  let lastFragment: FlexionSweepFragment | undefined

  // Numeric displays (palm angle, thumb depth, confidence) and the tables below refresh at this rate
  // rather than every frame -- tied to the One Euro filter's own min cutoff so the on-screen numbers
  // change at roughly the rate the filter itself considers "real" motion (below that, it's smoothing
  // it away as noise), instead of visually jittering at full frame rate. The underlying capture (which
  // frames land in which bin, ROM extrema) is unaffected -- every accepted frame is still counted;
  // only how often the page repaints numbers from that data is throttled.
  const displayRefreshIntervalSeconds = 1 / DEFAULT_ONE_EURO_OPTIONS.minCutoff
  let lastDisplayUpdate = 0
  let lastTableRefresh = 0
  let displayedScore: number | undefined
  let displayedPalmAngle: number | undefined
  let displayedThumbDepth: number | undefined

  let bins: Bin[] = Array.from({ length: BIN_COUNT }, (_, i) => makeBin(i))
  let dipPipFit: DipPipFit | undefined
  // Every OTHER non-thumb finger's total flexion (sum of its 3 joints' signedJointAngle), one entry
  // per accepted frame, in capture order -- NOT binned by palm angle like `bins` above, since
  // fitEnslavingAll needs a real frame-to-frame time series to compute deltas from, and enslaving
  // (unlike ROM) isn't an orientation-sensitive quantity capture-protocol.md ever asked to isolate by
  // camera angle -- see its own "flexion-plane paired-finger exploration... in this same palm-facing
  // orientation" note. Only populated for the four OTHER non-thumb fingers -- the active finger's own
  // series is `activeFlexionHistory` below, and thumb is excluded (EnslavingPriors has no thumb slot).
  let otherFlexionHistory: Partial<Record<NonThumbFinger, number[]>> = {}
  let activeFlexionHistory: number[] = []

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
  // Display-only, derived from the throttled displayedPalmAngle -- the loop's own bin selection for
  // capture (below) computes its own bin index from the live per-frame angle so throttling the display
  // never affects which bin a frame is actually recorded into.
  $: currentBinIndex =
    displayedPalmAngle !== undefined &&
    displayedPalmAngle >= 0 &&
    displayedPalmAngle < BIN_COUNT * BIN_WIDTH_DEG
      ? Math.floor(displayedPalmAngle / BIN_WIDTH_DEG)
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
    lastFrameAt = undefined
    displayedScore = undefined
    displayedPalmAngle = undefined
    displayedThumbDepth = undefined
    lastDisplayUpdate = 0
    lastTableRefresh = 0
    lastKeypoints = undefined
    staleResetAttempted = false
    lastFragment = undefined
    otherFlexionHistory = Object.fromEntries(
      NON_THUMB_FINGERS.filter((f) => f !== finger).map((f) => [f, []])
    )
    activeFlexionHistory = []
    try {
      detector?.dispose()
      detector = await createDetector(handedness)
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

  function totalFlexionDeg(hand: Hand, f: Finger): number {
    return signedJointAngle(hand, f, 0) + signedJointAngle(hand, f, 1) + signedJointAngle(hand, f, 2)
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
        lastFrameAt = elapsed
        staleResetAttempted = false
        lastKeypoints = hand.hand.keypoints
        drawHandOverlay(overlayCanvas, lastKeypoints)

        // Live values used for capture -- computed every frame regardless of the display throttle
        // below, so which bin a frame lands in is never affected by how often the page repaints.
        const angle = palmAngleDeg(hand)
        const depth = thumbDepthSign(hand)
        const binIndex =
          angle >= 0 && angle < BIN_COUNT * BIN_WIDTH_DEG ? Math.floor(angle / BIN_WIDTH_DEG) : undefined

        if (elapsed - lastDisplayUpdate >= displayRefreshIntervalSeconds) {
          lastDisplayUpdate = elapsed
          displayedScore = hand.score
          displayedPalmAngle = angle
          displayedThumbDepth = depth
        }

        if (phase === 'recording' && hand.score >= CONFIDENCE_THRESHOLD && binIndex !== undefined) {
          const bin = bins[binIndex]
          bin.history.push(hand)

          const newMin = [...bin.romMin]
          const newMax = [...bin.romMax]
          for (let j = 0; j < 3; j++) {
            // Signed -- a negative reading is hyperextension past straight, not clamped into the
            // same range as ordinary flexion the way Vector3.angleTo() alone would.
            const angleDeg = signedJointAngle(hand, finger, j as 0 | 1 | 2)
            if (angleDeg < newMin[j]) newMin[j] = angleDeg
            if (angleDeg > newMax[j]) newMax[j] = angleDeg
          }
          bin.romMin = newMin
          bin.romMax = newMax
          bin.acceptedFrames++
          bins = bins

          totalAcceptedFrames++

          // Enslaving history: unbinned, every accepted frame regardless of palm angle, only when the
          // active finger is a non-thumb finger (EnslavingPriors has no thumb slot either way).
          if (finger !== 'thumb') {
            activeFlexionHistory = [...activeFlexionHistory, totalFlexionDeg(hand, finger)]
            for (const f of Object.keys(otherFlexionHistory) as NonThumbFinger[]) {
              otherFlexionHistory[f] = [...(otherFlexionHistory[f] ?? []), totalFlexionDeg(hand, f)]
            }
          }
        }

        // Tables refresh at the same throttled rate as the numeric displays above -- the underlying
        // bin/history data they're computed from is still updated every accepted frame regardless.
        if (elapsed - lastTableRefresh >= displayRefreshIntervalSeconds) {
          lastTableRefresh = elapsed
          refitAll()
          refitDipPip()
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

  /** Builds this sweep's contribution to `myHandPrior` and folds it in -- see myHandStore.ts's own
   * doc comment for why this is a fuse, not an overwrite. Thumb sweeps produce nothing here (no
   * `pipDipRom`/`dipPipCoupling`/`enslaving` destination field exists for the thumb yet -- the same
   * schema gap `test-results.md`'s 2026-09-06 entry already identified). */
  function buildFragment(): FlexionSweepFragment | undefined {
    if (finger === 'thumb') return undefined
    const romFrames = bins.slice(0, PRIOR_SOURCE_MAX_BIN + 1).flatMap((b) => b.history)
    const sourceLabel = `${handedness}, live capture, 0-${
      (PRIOR_SOURCE_MAX_BIN + 1) * BIN_WIDTH_DEG
    }deg palm angle, n=${romFrames.length}`

    const fragment: FlexionSweepFragment = { handedness, finger }
    fragment.mcpFlexExt = romFromFrames(romFrames, finger, 0, sourceLabel)
    fragment.pip = romFromFrames(romFrames, finger, 1, sourceLabel)
    fragment.dip = romFromFrames(romFrames, finger, 2, sourceLabel)

    const allFrames = bins.flatMap((b) => b.history)
    if (allFrames.length >= 2) {
      const fit = fitDipPipCoupling(allFrames, finger)
      fragment.dipPipCoupling = {
        mean: [fit.slope, fit.intercept],
        covariance: fit.covariance,
        source: sourceLabel,
      }
    }

    if (activeFlexionHistory.length >= 3) {
      const angles: Partial<Record<Finger, number[]>> = {
        [finger]: activeFlexionHistory,
        ...otherFlexionHistory,
      }
      try {
        const fits = fitEnslavingAll(finger, angles)
        const enslavingAgainst: FlexionSweepFragment['enslavingAgainst'] = {}
        for (const [f, fit] of Object.entries(fits) as [
          NonThumbFinger,
          { coefficient: number; variance: number }
        ][]) {
          enslavingAgainst[f] = { coefficient: fit.coefficient, variance: fit.variance }
        }
        if (Object.keys(enslavingAgainst).length > 0) fragment.enslavingAgainst = enslavingAgainst
      } catch {
        // No i-dominant segment found this run -- fine, just contributes nothing to enslaving.
      }
    }

    return fragment
  }

  function stop() {
    if (phase === 'idle') return
    phase = 'idle'
    cancelAnimationFrame(rid)
    teardownCamera()
    refitAll()
    refitDipPip()

    lastFragment = buildFragment()
    if (lastFragment) mergeFlexionSweepFragment(lastFragment)
  }

  function downloadMyHandPrior() {
    const text = serializeMyHandPriorModule($myHandPrior)
    const blob = new Blob([text], { type: 'text/typescript' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'my-hand.ts'
    a.click()
    URL.revokeObjectURL(url)
  }

  onDestroy(() => {
    if (phase !== 'idle') cancelAnimationFrame(rid)
    teardownCamera()
    detector?.dispose()
  })
</script>

<svelte:body class="bg-slate-900 text-gray-50" />

<main class="max-w-3xl mx-auto my-8 px-4">
  <h1 class="text-2xl font-semibold mb-4">Flexion Sweep: Personal Prior Capture</h1>
  <p class="mb-6 text-sm text-gray-300">
    Start near palm-facing (0°) and slowly rotate toward the full lateral roll (~90°) over the course of
    the recording, continuously flexing and extending the selected finger throughout — but only the 0-{(PRIOR_SOURCE_MAX_BIN +
      1) *
      BIN_WIDTH_DEG}° (near-palm-facing) range feeds your saved prior below; the rest of the sweep is a
    diagnostic (does confidence/ROM hold up as the angle changes), same as before. Every non-thumb
    finger's flexion is tracked throughout, regardless of which one is "active," so a coupling and
    enslaving fit come out of the same recording for free.
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
          Thumb tracking has a known systematic bias off palm-facing (see test_results.md, 2026-08-31),
          and there's no HandPriorState field yet for its own MCP/IP or for thumb enslaving — this run's
          tables below will still show, but nothing will be saved to "my hand."
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

  <div class="mb-4 flex gap-2">
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
      Palm angle: {displayedPalmAngle !== undefined ? displayedPalmAngle.toFixed(0) + '°' : '—'}
      {#if currentBinIndex !== undefined}
        (bin {currentBinIndex * BIN_WIDTH_DEG}-{(currentBinIndex + 1) * BIN_WIDTH_DEG}°)
      {:else if displayedPalmAngle !== undefined}
        (outside 0-{BIN_COUNT * BIN_WIDTH_DEG}° range — not counted)
      {/if}
    </p>
    <p>Thumb depth sign: {displayedThumbDepth !== undefined ? displayedThumbDepth.toFixed(3) : '—'}</p>
    <p class:text-amber-400={noHandDetected}>
      Current confidence: {displayedScore !== undefined ? displayedScore.toFixed(3) : '—'}
    </p>
    <p class="text-xs text-gray-400">
      Numeric displays and tables refresh at ~{DEFAULT_ONE_EURO_OPTIONS.minCutoff.toFixed(2)} Hz ({displayRefreshIntervalSeconds.toFixed(
        2
      )}s between updates) -- tied to the One Euro filter's min cutoff.
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
              <tr class:text-emerald-400={bin.index <= PRIOR_SOURCE_MAX_BIN}>
                <td class="pr-4"
                  >{bin.index * BIN_WIDTH_DEG}-{(bin.index + 1) * BIN_WIDTH_DEG}°{bin.index <=
                  PRIOR_SOURCE_MAX_BIN
                    ? ' (saved)'
                    : ''}</td
                >
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

  {#if lastFragment}
    <div class="mb-4">
      <h2 class="text-lg font-semibold mb-2">Last sweep's contribution to "my hand"</h2>
      <ul class="text-xs text-gray-300 list-disc list-inside space-y-1">
        <li>
          MCP flexExt: {lastFragment.mcpFlexExt
            ? `mean ${lastFragment.mcpFlexExt.meanDeg.toFixed(
                1
              )}°, sd ${lastFragment.mcpFlexExt.sdDeg.toFixed(1)}°`
            : 'not enough frames in the saved bin'}
        </li>
        <li>
          PIP: {lastFragment.pip
            ? `mean ${lastFragment.pip.meanDeg.toFixed(1)}°, sd ${lastFragment.pip.sdDeg.toFixed(1)}°`
            : 'not enough frames in the saved bin'}
        </li>
        <li>
          DIP: {lastFragment.dip
            ? `mean ${lastFragment.dip.meanDeg.toFixed(1)}°, sd ${lastFragment.dip.sdDeg.toFixed(1)}°`
            : 'not enough frames in the saved bin'}
        </li>
        <li>
          DIP/PIP coupling: {lastFragment.dipPipCoupling
            ? `slope ${lastFragment.dipPipCoupling.mean[0].toFixed(3)}`
            : 'not fit'}
        </li>
        <li>
          Enslaving (this finger active): {lastFragment.enslavingAgainst &&
          Object.keys(lastFragment.enslavingAgainst).length > 0
            ? Object.entries(lastFragment.enslavingAgainst)
                .map(([f, fit]) => `${f}=${fit.coefficient.toFixed(3)}`)
                .join(', ')
            : 'no i-dominant segment found this run'}
        </li>
      </ul>
    </div>
  {/if}

  <div class="mb-6 border-t border-gray-700 pt-4">
    <h2 class="text-lg font-semibold mb-2">My hand (one source, both hands independent inside it)</h2>
    <p class="text-xs text-gray-400 mb-2">
      Persisted in this browser (localStorage) — survives a reload, cleared if you clear site data. Every
      completed non-thumb sweep above fuses into ITS OWN hand's half, narrowing rather than overwriting
      on a repeat — Right and Left are never pooled together automatically, since this project's own
      capture data already found real per-hand differences (e.g. DIP/PIP coupling, test-results.md
      2026-09-01). Appears as ONE checkable source in <code>multi-view</code> (matching every other source
      there being a Right+Left pair) once you've swept at least one finger on either hand; fusing there fuses
      the matching hand from every checked source together, never Right with Left.
    </p>
    <div class="grid grid-cols-2 gap-4">
      {#each HANDEDNESSES as h}
        <div>
          <h3 class="text-sm font-semibold mb-1">{h}</h3>
          <ul class="text-xs text-gray-300 list-disc list-inside space-y-1 mb-3">
            {#each NON_THUMB_FINGERS as f}
              <li>
                {f}: pip {myHandByHandedness[h].pipDipRom?.pip?.[f] ? '✓' : '—'}, dip {myHandByHandedness[
                  h
                ].pipDipRom?.dip?.[f]
                  ? '✓'
                  : '—'}, mcp {myHandByHandedness[h].mcpAxes?.[f]?.flexExtRom ? '✓' : '—'}, coupling {myHandByHandedness[
                  h
                ].dipPipCoupling?.[f]
                  ? '✓'
                  : '—'}
              </li>
            {/each}
            <li>
              Enslaving matrix: {myHandByHandedness[h].enslaving?.coefficients
                ? 'has some entries'
                : 'not started'}
            </li>
          </ul>
          <button
            class="bg-red-900 px-3 py-1.5 rounded text-xs"
            on:click={() =>
              confirm(`Reset the accumulated ${h}-hand half? This cannot be undone.`) &&
              resetMyHandPrior(h)}
          >
            Reset {h}
          </button>
        </div>
      {/each}
    </div>
    <div class="mt-3">
      <button class="bg-slate-700 px-4 py-2 rounded text-sm" on:click={downloadMyHandPrior}>
        Download my-hand.ts (both hands)
      </button>
    </div>
    <p class="text-xs text-gray-500 mt-2">
      Downloading saves a file, not a repo commit — a browser page can't write into the repo directly.
      Drop the downloaded file into <code>src/routes/scan3/lib/priors/fitted/</code>
      and add one line to <code>registry.ts</code> (or hand it to Claude to do that step).
    </p>
  </div>

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
        number says. Only bins 0-{PRIOR_SOURCE_MAX_BIN} feed "my hand" below, for exactly this reason — pooled
        together their ROM/mean/SD are a real, if noisy, near-palm-facing measurement; the other bins' numbers
        are a diagnostic, not a candidate. (Widened from bin 0 alone after real capture showed a single 10°-wide
        bin routinely getting too few frames to produce anything at all.)
      </p>
      <p>
        Palm angle is unsigned (0-180°) and can't by itself distinguish the two lateral roll directions —
        only thumb-away's direction is reliably reachable near 90° on this rig (thumb-toward was dropped;
        see docs/thumbs/test_results.md, 2026-08-31), so bins approaching 90° implicitly assume you're
        rolling that way. The live thumb-depth-sign readout is there to check you're rolling in the
        expected direction, not used to gate binning here.
      </p>
      <p>
        Enslaving uses `fitEnslavingAll`'s own dominance filter (|Δactive| ≥ 3°, and ≥ 2x the other
        finger's |Δ|) over the whole recording's frame-to-frame deltas, unbinned — the same method
        `paired-sweep`'s abduction-plane capture already validated on real data, applied here to the
        flexion-plane motion this page already produces, per capture-protocol.md's own "flexion-plane
        paired-finger exploration... in this same palm-facing orientation" note.
      </p>
    </div>
  </details>
</main>
