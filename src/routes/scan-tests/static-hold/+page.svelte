<script lang="ts">
  import { onDestroy } from 'svelte'
  import createDetector, { type Detector } from '../lib/detector'
  import {
    type Handedness,
    inTargetRange,
    type Orientation,
    ORIENTATION_DESCRIPTIONS,
    ORIENTATION_TARGET_DESCRIPTIONS,
    palmAngleDeg,
    thumbDepthSign,
  } from '../lib/orientation'
  import { drawHandOverlay } from '../lib/overlay'
  import { CONNECTIONS, type Finger } from '$lib/hand'

  type Phase = 'idle' | 'positioning' | 'recording'

  const FINGERS = Object.keys(CONNECTIONS) as Finger[]
  const CONFIDENCE_THRESHOLD = 0.7
  const DWELL_SECONDS = 0.5 // continuous time in the target angle range before "positioning" -> "recording"
  const STATS_UPDATE_EVERY = 10 // accepted frames between live-table refreshes

  /** Running mean/stdev via Welford's online algorithm — O(1) memory per accumulator. */
  class OnlineStat {
    n = 0
    mean = 0
    private m2 = 0
    push(x: number) {
      this.n++
      const delta = x - this.mean
      this.mean += delta / this.n
      this.m2 += delta * (x - this.mean)
    }
    get stdev() {
      return this.n > 1 ? Math.sqrt(this.m2 / this.n) : 0
    }
    get cv() {
      return this.mean !== 0 ? (this.stdev / Math.abs(this.mean)) * 100 : 0
    }
  }

  interface BoneRow {
    finger: Finger
    bone: number
    mean: number
    stdev: number
    cv: number
  }
  interface JointRow {
    finger: Finger
    joint: number
    meanDeg: number
    stdevDeg: number
  }

  interface CaptureResult {
    orientation: Orientation
    handedness: Handedness
    acceptedFrames: number
    boneRows: BoneRow[]
  }

  interface AgreementRow {
    finger: Finger
    bone: number
    meanA: number
    meanB: number
    expectedB: number // meanA scaled by the fitted scale factor — what B "should" be if only scale changed
    diff: number // meanB - expectedB: leftover difference after removing the shared scale factor
    diffPct: number
    z: number
    flagged: boolean
  }

  interface Agreement {
    scaleFactor: number // least-squares fit of B ~= scaleFactor * A across all bones
    rows: AgreementRow[]
  }

  const AGREEMENT_Z_THRESHOLD = 3 // flag a bone as disagreeing beyond noise if |diff| exceeds this many combined standard errors

  let video: HTMLVideoElement
  let overlayCanvas: HTMLCanvasElement
  let stream: MediaStream | undefined
  let detector: Detector | undefined
  let lastKeypoints: { x: number; y: number }[] | undefined

  let orientation: Orientation = 'palm-facing'
  let handedness: Handedness = 'Right'
  let holdDuration = 20

  let phase: Phase = 'idle'
  let error: Error | undefined
  let startTime = 0
  let recordingStartElapsed = 0
  let elapsed = 0
  let currentScore: number | undefined
  let lastFrameAt: number | undefined
  let palmAngle: number | undefined
  let thumbDepth: number | undefined
  let rangeEnteredAt: number | undefined
  let rid: number
  let loopTicks = 0
  let staleResetAttempted = false

  const STALL_RESET_SECONDS = 3

  let boneStats: Record<Finger, OnlineStat[]> = objectFromFingers(() => [])
  let jointStats: Record<Finger, OnlineStat[]> = objectFromFingers(() => [])
  let acceptedFrames = 0
  let boneRows: BoneRow[] = []
  let jointRows: JointRow[] = []

  let lastResult: CaptureResult | undefined
  let agreement: Agreement | undefined
  let agreementAgainst: CaptureResult | undefined

  function objectFromFingers<U>(f: () => U): Record<Finger, U> {
    return Object.fromEntries(FINGERS.map((finger) => [finger, f()])) as Record<Finger, U>
  }

  $: noHandDetected =
    phase !== 'idle' && (lastFrameAt === undefined ? elapsed > 1 : elapsed - lastFrameAt > 1)
  $: recordingElapsed = phase === 'recording' ? elapsed - recordingStartElapsed : 0
  $: targetDescription = ORIENTATION_TARGET_DESCRIPTIONS[orientation]
  $: meanBoneCv = boneRows.length ? boneRows.reduce((a, r) => a + r.cv, 0) / boneRows.length : undefined
  $: meanJointStdev = jointRows.length
    ? jointRows.reduce((a, r) => a + r.stdevDeg, 0) / jointRows.length
    : undefined

  function resetStats() {
    boneStats = objectFromFingers(() => [])
    jointStats = objectFromFingers(() => [])
    for (const finger of FINGERS) {
      boneStats[finger] = CONNECTIONS[finger].map(() => new OnlineStat())
      jointStats[finger] = CONNECTIONS[finger].slice(1).map(() => new OnlineStat())
    }
    acceptedFrames = 0
    boneRows = []
    jointRows = []
  }

  /** Per-bone agreement between two completed captures of the same hand in different orientations.
   * Compares means using standard error (stdev / sqrt(n)), not raw stdev — the question is whether
   * the estimated mean bone length differs, not whether individual frames overlap. */
  function buildAgreement(a: CaptureResult, b: CaptureResult): Agreement {
    const pairs = a.boneRows.map((rowA) => {
      const rowB = b.boneRows.find((r) => r.finger === rowA.finger && r.bone === rowA.bone)!
      return { rowA, rowB }
    })

    // A distance change between captures can't be avoided by careful positioning alone (confirmed —
    // manual repositioning can't reliably hold camera distance constant), and it scales every bone by
    // roughly the same factor (closer camera => uniformly bigger hand). Since we actually want to know
    // whether bone *proportions* changed, not absolute size, fit that shared scale factor out first —
    // before comparing — so what's left over is a genuine shape/proportion difference, not a distance
    // artifact. Uses the median of per-bone B/A ratios rather than a least-squares fit: least squares
    // lets one genuinely-changed bone pull the fit toward itself, leaking spurious residual "diff" into
    // every other (unchanged) bone; the median is robust to that — confirmed against a synthetic case
    // with one planted proportion change on top of a uniform scale drift, where least squares leaked
    // noise into all the unrelated bones and the median isolated only the one that actually changed.
    // This still treats the scale factor as a fixed nuisance parameter for simplicity — its own
    // estimation uncertainty isn't propagated into the z-scores below, consistent with the "rough
    // ranking, not a rigorous test" caveat already called out in the UI.
    const ratios = pairs.map(({ rowA, rowB }) => rowB.mean / rowA.mean).sort((x, y) => x - y)
    const mid = Math.floor(ratios.length / 2)
    const scaleFactor = ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2

    const rows = pairs.map(({ rowA, rowB }) => {
      const semA = a.acceptedFrames > 0 ? rowA.stdev / Math.sqrt(a.acceptedFrames) : 0
      const semB = b.acceptedFrames > 0 ? rowB.stdev / Math.sqrt(b.acceptedFrames) : 0
      const combinedSem = Math.sqrt(semA * semA + semB * semB)
      const expectedB = scaleFactor * rowA.mean
      const diff = rowB.mean - expectedB
      const z = combinedSem > 0 ? Math.abs(diff) / combinedSem : Infinity
      return {
        finger: rowA.finger,
        bone: rowA.bone,
        meanA: rowA.mean,
        meanB: rowB.mean,
        expectedB,
        diff,
        diffPct: expectedB !== 0 ? (diff / expectedB) * 100 : 0,
        z,
        flagged: z > AGREEMENT_Z_THRESHOLD,
      }
    })

    return { scaleFactor, rows }
  }

  function snapshotStats() {
    boneRows = FINGERS.flatMap((finger) =>
      CONNECTIONS[finger].map((_, bone) => {
        const s = boneStats[finger][bone]
        return { finger, bone, mean: s.mean, stdev: s.stdev, cv: s.cv }
      })
    )
    jointRows = FINGERS.flatMap((finger) =>
      CONNECTIONS[finger].slice(1).map((_, joint) => {
        const s = jointStats[finger][joint]
        return { finger, joint, meanDeg: s.mean, stdevDeg: s.stdev }
      })
    )
  }

  async function setupCamera() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('No camera access available')
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user' } })
    video.srcObject = stream
    await new Promise((r) => (video.onloadedmetadata = r))
    video.play()
    // Match the canvas's internal pixel size to the video's native resolution so the overlay draws
    // crisply; CSS (object-contain, same as the video) handles fitting it into the display box.
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
    resetStats()
    currentScore = undefined
    lastFrameAt = undefined
    palmAngle = undefined
    thumbDepth = undefined
    lastKeypoints = undefined
    rangeEnteredAt = undefined
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

    phase = 'positioning'
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
      // Tracking may have genuinely lost the hand (not just a pending call) — reset the detector's
      // internal region-of-interest so it re-attempts a fresh full-frame palm detection instead of
      // waiting indefinitely on a track that may never resume on its own.
      staleResetAttempted = true
      detector!.reset()
    }

    // Only one estimateHands() call may be in flight at a time — MediaPipe's Hands.send() isn't
    // safe to call concurrently, and under a harder pose (slower inference) firing a new call every
    // rAF tick regardless of whether the previous one resolved can pile up and wedge the WASM graph,
    // which reads as "detection permanently stops" right when rotating into a harder orientation.
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

        if (phase === 'positioning') {
          if (inTargetRange(orientation, palmAngle, thumbDepth)) {
            if (rangeEnteredAt === undefined) rangeEnteredAt = elapsed
            if (elapsed - rangeEnteredAt >= DWELL_SECONDS) {
              phase = 'recording'
              recordingStartElapsed = elapsed
            }
          } else {
            rangeEnteredAt = undefined
          }
        } else if (phase === 'recording' && hand.score >= CONFIDENCE_THRESHOLD) {
          for (const finger of FINGERS) {
            CONNECTIONS[finger].forEach((_, i) =>
              boneStats[finger][i].push(hand.limbs[finger][i].length())
            )
            CONNECTIONS[finger].slice(1).forEach((_, j) => {
              const angleDeg = (hand.limbs[finger][j].angleTo(hand.limbs[finger][j + 1]) * 180) / Math.PI
              jointStats[finger][j].push(angleDeg)
            })
          }
          acceptedFrames++
          if (acceptedFrames % STATS_UPDATE_EVERY === 0) snapshotStats()
        }
      })
      .catch((e) => console.error(e))
      .finally(() => {
        if (phase === 'idle') return
        if (phase === 'recording' && elapsed - recordingStartElapsed >= holdDuration) {
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
    snapshotStats()

    if (boneRows.length > 0) {
      const result: CaptureResult = { orientation, handedness, acceptedFrames, boneRows }
      if (lastResult && lastResult.handedness === handedness && lastResult.orientation !== orientation) {
        agreementAgainst = lastResult
        agreement = buildAgreement(lastResult, result)
      } else {
        agreementAgainst = undefined
        agreement = undefined
      }
      lastResult = result
    }
  }

  function clearComparison() {
    lastResult = undefined
    agreementAgainst = undefined
    agreement = undefined
  }

  onDestroy(() => {
    if (phase !== 'idle') cancelAnimationFrame(rid)
    teardownCamera()
    detector?.dispose()
  })
</script>

<svelte:body class="bg-slate-900 text-gray-50" />

<main class="max-w-2xl mx-auto my-8 px-4">
  <h1 class="text-2xl font-semibold mb-4">Static Hold Capture</h1>
  <p class="mb-6 text-sm text-gray-300">
    Rotate into the target orientation; recording starts automatically once you're holding it, and the
    bone-length / joint-angle noise stats update live below — no file to download or script to run.
  </p>

  {#if error}
    <div class="mb-4 bg-red-400/30 px-4 py-3 rounded" role="alert">
      Error: {error.message}
    </div>
  {/if}

  <div class="grid grid-cols-2 gap-4 mb-4">
    <label class="flex flex-col gap-1 col-span-2">
      <span class="text-sm">Orientation</span>
      <select bind:value={orientation} disabled={phase !== 'idle'} class="text-black rounded px-2 py-1">
        <option value="palm-facing">Palm-facing</option>
        <option value="palm-away">Palm-away</option>
        <option value="thumb-away">Thumb-away</option>
        <option value="thumb-toward">Thumb-toward</option>
      </select>
      <span class="text-xs text-gray-400">{ORIENTATION_DESCRIPTIONS[orientation]}</span>
    </label>

    <label class="flex flex-col gap-1">
      <span class="text-sm">Handedness</span>
      <select bind:value={handedness} disabled={phase !== 'idle'} class="text-black rounded px-2 py-1">
        <option value="Right">Right</option>
        <option value="Left">Left</option>
      </select>
    </label>

    <label class="flex flex-col gap-1">
      <span class="text-sm">Hold duration (seconds)</span>
      <input
        type="number"
        min="1"
        bind:value={holdDuration}
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
      {#if phase !== 'idle'}(loop tick {loopTicks}){/if}
    </p>
    <p>
      Palm angle: {palmAngle !== undefined ? palmAngle.toFixed(0) + '°' : '—'} (target {targetDescription})
    </p>
    {#if orientation === 'thumb-away' || orientation === 'thumb-toward'}
      <p>
        Thumb depth sign: {thumbDepth !== undefined ? thumbDepth.toFixed(3) : '—'}
        (positive = thumb closer to camera than pinky — unverified convention, check this matches your actual
        pose)
      </p>
    {/if}
    {#if phase === 'positioning'}
      <p class="text-purple-300">
        Rotate into position and hold — recording starts automatically after {DWELL_SECONDS}s in range.
      </p>
    {:else if phase === 'recording'}
      <p class="text-purple-300">
        Recording: {recordingElapsed.toFixed(1)}s / {holdDuration}s — {acceptedFrames} accepted frames
      </p>
    {/if}
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

  {#if boneRows.length}
    <div class="mb-4">
      <h2 class="text-lg font-semibold mb-2">
        Noise so far {#if meanBoneCv !== undefined}(mean bone CV {meanBoneCv.toFixed(2)}%, mean joint
          stdev {meanJointStdev?.toFixed(2)}°){/if}
      </h2>

      <div class="overflow-x-auto mb-3">
        <table class="text-xs text-left w-full">
          <thead class="text-gray-400">
            <tr>
              <th class="pr-4">Finger</th>
              <th class="pr-4">Bone</th>
              <th class="pr-4">Mean</th>
              <th class="pr-4">Stdev</th>
              <th>CV (%)</th>
            </tr>
          </thead>
          <tbody>
            {#each boneRows as r}
              <tr>
                <td class="pr-4">{r.finger}</td>
                <td class="pr-4">{r.bone}</td>
                <td class="pr-4">{r.mean.toFixed(4)}</td>
                <td class="pr-4">{r.stdev.toFixed(4)}</td>
                <td>{r.cv.toFixed(2)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <div class="overflow-x-auto">
        <table class="text-xs text-left w-full">
          <thead class="text-gray-400">
            <tr>
              <th class="pr-4">Finger</th>
              <th class="pr-4">Joint</th>
              <th class="pr-4">Mean (deg)</th>
              <th>Stdev (deg)</th>
            </tr>
          </thead>
          <tbody>
            {#each jointRows as r}
              <tr>
                <td class="pr-4">{r.finger}</td>
                <td class="pr-4">{r.joint}</td>
                <td class="pr-4">{r.meanDeg.toFixed(3)}</td>
                <td>{r.stdevDeg.toFixed(3)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}

  {#if agreement && agreementAgainst && lastResult}
    <div class="mb-4">
      <h2 class="text-lg font-semibold mb-2">
        Bone-proportion agreement: {agreementAgainst.orientation} vs {lastResult.orientation} ({lastResult.handedness})
        — scale factor {agreement.scaleFactor.toFixed(4)}×
        <button class="text-xs underline hover:text-gray-200 font-normal" on:click={clearComparison}
          >Clear comparison</button
        >
      </h2>
      <div class="overflow-x-auto">
        <table class="text-xs text-left w-full">
          <thead class="text-gray-400">
            <tr>
              <th class="pr-4">Finger</th>
              <th class="pr-4">Bone</th>
              <th class="pr-4">Mean A</th>
              <th class="pr-4">Mean B</th>
              <th class="pr-4">Expected B</th>
              <th class="pr-4">Diff</th>
              <th class="pr-4">Diff (%)</th>
              <th>z (σ)</th>
            </tr>
          </thead>
          <tbody>
            {#each agreement.rows as r}
              <tr class:text-amber-400={r.flagged} class:font-semibold={r.flagged}>
                <td class="pr-4">{r.finger}</td>
                <td class="pr-4">{r.bone}</td>
                <td class="pr-4">{r.meanA.toFixed(4)}</td>
                <td class="pr-4">{r.meanB.toFixed(4)}</td>
                <td class="pr-4">{r.expectedB.toFixed(4)}</td>
                <td class="pr-4">{r.diff >= 0 ? '+' : ''}{r.diff.toFixed(4)}</td>
                <td class="pr-4">{r.diffPct >= 0 ? '+' : ''}{r.diffPct.toFixed(2)}</td>
                <td>{r.z === Infinity ? '∞' : r.z.toFixed(2)}</td>
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
        Bone-proportion agreement compares this capture against the immediately preceding completed
        capture for the same hand. Manual repositioning can't hold camera distance constant between
        captures, and distance biases every bone's apparent length by roughly the same factor — so a
        shared scale factor (the median B/A ratio across all 20 bones, robust to any single bone that
        genuinely changed) is removed before comparing, isolating whether bone proportions changed rather
        than overall size. Diff is <code>meanB − scaleFactor·meanA</code>, in combined standard errors
        (stdev / √n per orientation) — flagged rows disagree by more than {AGREEMENT_Z_THRESHOLD}σ.
      </p>
      <p>
        Treat z as a rough ranking, not a rigorous significance test: accepted frames within one hold
        aren't independent samples (consecutive video frames of a mostly-static pose are highly
        autocorrelated), so n overstates how much independent information there really is, and the fitted
        scale factor's own uncertainty isn't propagated into z either — a flagged row is worth a second
        look, not proof of a real bias.
      </p>
    </div>
  </details>
</main>
