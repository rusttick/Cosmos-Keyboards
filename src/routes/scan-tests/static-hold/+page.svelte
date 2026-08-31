<script lang="ts">
  import { onDestroy } from 'svelte'
  import createDetector, { type Detector } from '../lib/detector'
  import { CONNECTIONS, type Finger, type Hand } from '$lib/hand'
  import { Vector3 } from 'three'

  type Orientation = 'palm-facing' | 'palm-away' | 'thumb-away' | 'thumb-toward'
  type Handedness = 'Left' | 'Right'
  type Phase = 'idle' | 'positioning' | 'recording'

  const ORIENTATION_DESCRIPTIONS: Record<Orientation, string> = {
    'palm-facing':
      'Palm facing straight down toward the camera (the well-trained, well-textured MediaPipe case).',
    'palm-away':
      "Back of the hand facing the camera — the orientation scan_procedure.md documents as MediaPipe's weak case.",
    'thumb-away':
      'Palms-facing-each-other posture, rolled so the thumb lifts up and away from the camera and the pinky/ulnar edge faces toward it. Known structurally self-occluding for a fingers-together hold — see docs/thumbs/scan_tests.md.',
    'thumb-toward':
      'Palms-facing-each-other posture, rolled the opposite way: thumb/radial edge faces toward the camera and the pinky lifts away. Same self-occlusion caveat as thumb-away.',
  }

  const FINGERS = Object.keys(CONNECTIONS) as Finger[]
  const CONFIDENCE_THRESHOLD = 0.7
  const DWELL_SECONDS = 0.5 // continuous time in the target angle range before "positioning" -> "recording"
  const STATS_UPDATE_EVERY = 10 // accepted frames between live-table refreshes
  const FORWARD = new Vector3(0, 0, 1)

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

  let video: HTMLVideoElement
  let stream: MediaStream | undefined
  let detector: Detector | undefined

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

  function objectFromFingers<U>(f: () => U): Record<Finger, U> {
    return Object.fromEntries(FINGERS.map((finger) => [finger, f()])) as Record<Finger, U>
  }

  $: noHandDetected =
    phase !== 'idle' && (lastFrameAt === undefined ? elapsed > 1 : elapsed - lastFrameAt > 1)
  $: recordingElapsed = phase === 'recording' ? elapsed - recordingStartElapsed : 0
  $: targetDescription = {
    'palm-facing': 'angle < 30°',
    'palm-away': 'angle > 150°',
    'thumb-away': '60-120°, thumb farther from camera than pinky',
    'thumb-toward': '60-120°, thumb closer to camera than pinky',
  }[orientation]
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

  /** Angle (degrees) between the palm's normal and the camera's forward axis.
   * ~0deg = palm-facing, ~180deg = palm-away, ~90deg = lateral/edge-on.
   * Left/Right hands have opposite chirality, so the normal is negated for
   * Right hands to keep the convention consistent across handedness
   * (verified against real capture data: raw Right-hand angles mirror Left's). */
  function palmAngleDeg(hand: Hand): number {
    const wrist = hand.vectors[0]
    const indexMcp = hand.vectors[5]
    const pinkyMcp = hand.vectors[17]
    const v1 = new Vector3().subVectors(indexMcp, wrist)
    const v2 = new Vector3().subVectors(pinkyMcp, wrist)
    const normal = new Vector3().crossVectors(v1, v2).normalize()
    if (hand.handedness === 'Right') normal.negate()
    return (normal.angleTo(FORWARD) * 180) / Math.PI
  }

  /** Depth (raw camera-space z) of the thumb's base relative to the pinky's base, hand-vector index
   * 1 (thumb CMC) vs. 17 (pinky MCP), both measured from the wrist. Distinguishes the two lateral
   * rolls, which the palm angle alone can't — both reach ~90deg regardless of which way you rolled.
   * Sign convention (positive = thumb closer to camera) is a best-effort guess pending live
   * verification; the live "thumb depth" readout in positioning mode is there to check it against
   * an actual thumb-toward/thumb-away hold and flip the sign here if it's backwards. */
  function thumbDepthSign(hand: Hand): number {
    const wrist = hand.vectors[0]
    const thumbBase = hand.vectors[1]
    const pinkyMcp = hand.vectors[17]
    return -(thumbBase.z - wrist.z - (pinkyMcp.z - wrist.z))
  }

  function inTargetRange(angle: number, thumbDepthValue: number | undefined): boolean {
    switch (orientation) {
      case 'palm-facing':
        return angle < 30
      case 'palm-away':
        return angle > 150
      case 'thumb-away':
        return angle > 60 && angle < 120 && thumbDepthValue !== undefined && thumbDepthValue < 0
      case 'thumb-toward':
        return angle > 60 && angle < 120 && thumbDepthValue !== undefined && thumbDepthValue > 0
    }
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

        if (phase === 'positioning') {
          if (inTargetRange(palmAngle, thumbDepth)) {
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

  <div class="mb-4 rounded overflow-hidden bg-black aspect-video">
    <!-- svelte-ignore a11y-media-has-caption -->
    <video bind:this={video} playsinline muted class="w-full h-full object-contain -scale-x-100" />
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
</main>
