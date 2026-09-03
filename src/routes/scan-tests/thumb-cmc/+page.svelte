<script lang="ts">
  import { onDestroy } from 'svelte'
  import createDetector, { type Detector } from '../lib/detector'
  import {
    fingerCurlAgreesWithNormal,
    type Handedness,
    handPlaneNormal,
    type PalmTilt,
    palmTilt,
  } from '../lib/orientation'
  import {
    drawHandOverlay,
    drawPalmNormalOverlay,
    drawVectorSpaceTopView,
    drawVectorSpaceTriangle,
  } from '../lib/overlay'
  import PalmBubble from '../lib/PalmBubble.svelte'
  import { handOrientation, type Hand, type Joint } from '$lib/hand'
  import { Matrix4, Quaternion, Vector3 } from 'three'
  import {
    fitConjunctCoupling,
    fitThumbCmcAxis,
    OcclusionGuardedGrowthPlateau,
    thumbMcpIpAngles,
    type ThumbSweepStatus,
  } from '../../scan3/lib/phases/thumbCmc'

  // REVERTED: a blanket 180deg flip was tried here after live testing showed the arrow pointing out
  // the back of the wrist during large sweeps. Then `static-hold`, using the exact same unflipped
  // palmAngleDeg/handPlaneNormal formula on this same rig, was checked at a genuine static palm-facing pose
  // and read ~10-15deg -- correct, not backwards. So the sign is fine at rest, on this rig, with this
  // formula; a blanket flip would have made the rest reading wrong (~165-170deg) to fix a problem that
  // only shows up mid-sweep. The bug isn't a constant offset -- something flips it partway through
  // certain rotations specifically. Leading hypothesis: MediaPipe's handedness classification (Left/
  // Right) is a separate, imperfect prediction from landmark tracking, and handPlaneNormal() negates based
  // on it -- a brief misclassification during a hard, self-occluding rotation would flip the normal for
  // exactly those frames while leaving rest (and easy poses) correct. `handedness`/`score` are now
  // shown live (below) to check this directly: watch whether handedness changes during the same
  // rotations that showed the arrow backwards.

  type Mode = 'outer' | 'freeform'
  type Phase = 'idle' | 'recording'

  const STALL_RESET_SECONDS = 3
  const STATS_UPDATE_EVERY = 10

  let video: HTMLVideoElement
  let overlayCanvas: HTMLCanvasElement
  let stream: MediaStream | undefined
  let detector: Detector | undefined

  let mode: Mode = 'outer'
  let handedness: Handedness = 'Right'
  let sessionDuration = 30
  // Live-tunable, both still needing real tuning like every other threshold in this test suite. See
  // the methodology note for why these replaced peak hysteresis entirely. windowSeconds raised from
  // an initial 2 -- first live run converged after only 7.8-14.5 deg of swept motion, implausibly
  // small for a CMC's real range, consistent with a brief pause (natural when deciding where to move
  // next across two axes) looking identical to "found the true limit" at a short window.
  let growthWindowSeconds = 4
  let convergenceThreshold = 2
  // Floor so "stopped growing" can't be trusted as "found the true limit" below a plausible range.
  // Set relative to bone[1] (the metacarpal) now that measurement switched to it from bone[0] -- see
  // the methodology note. Live data on the (wrong) bone[0] signal found genuine motion eyeballed at
  // ~15-20 deg while bone[0] itself only read ~5 deg; bone[1] read ~38 deg for the same motion, so 15
  // is a conservative starting floor on the corrected signal, not yet re-tuned on it.
  let minPlausibleMax = 15
  // Live run flagged "possibly-occluded" with no deliberate occlusion attempted -- these were
  // hardcoded, never live-tuned. Likely too strict for the CMC specifically, which this whole test
  // suite already established as the noisiest joint to track.
  let confidenceThreshold = 0.7
  let minHealthyYield = 0.8

  let phase: Phase = 'idle'
  let error: Error | undefined
  let startTime = 0
  let elapsed = 0
  let currentScore: number | undefined
  let lastFrameAt: number | undefined
  let rid: number
  let loopTicks = 0
  let staleResetAttempted = false
  let currentTilt: PalmTilt | undefined
  // Independent check on handPlaneNormal()'s sign, from middle/ring finger curl direction rather than
  // another projection of the same landmarks -- see fingerCurlAgreesWithNormal's doc comment.
  // undefined when neither finger is flexed enough to give a usable signal.
  let currentCurlCheck: number | undefined
  // MediaPipe's own handedness classification, re-run every frame -- a separate, imperfect prediction
  // from landmark tracking. handPlaneNormal() negates based on it, so a brief misclassification during a
  // hard/self-occluding pose would flip the normal for exactly those frames. Tracked here (plus a
  // running count of how many times it's changed mid-recording) to check that hypothesis directly
  // against the arrow-points-backwards finding -- see the note above the script's top.
  let currentHandedness: 'Left' | 'Right' | undefined
  let handednessFlipCount = 0

  // --- Palm-tilt calibration --------------------------------------------------------------------
  // Live capture found a consistent ~10deg baseline offset in the bubble/totalDeg reading at true
  // physical level -- see palmTilt's `reference` doc comment. Calibrating re-zeros against a sampled
  // "level" pose instead of hardcoding that number, so it's per-session/per-rig, not baked into the
  // model. Not wired into anything the guard uses -- diagnostic/positioning aid only.
  const CALIBRATION_FRAMES = 15
  let calibrating = false
  let calibrationBuffer: Vector3[] = []
  let calibrationReference: Vector3 | undefined

  // --- Outer sweep (Phase 6a) state -----------------------------------------------------------
  const START_REFERENCE_FRAMES = 5
  let outerHistory: Hand[] = []
  // Reference is bone[1] (CMC-landmark -> MCP-landmark, the actual first metacarpal, the rigid body
  // that pivots at the CMC) -- not bone[0] (wrist -> thumb-CMC-landmark). MediaPipe models the wrist
  // as a zero-width point, so bone[0] sits too close to the CMC's own pivot to carry much real
  // rotation. Confirmed live: a real sweep read ~5 deg on bone[0] but ~38 deg on bone[1] for the same
  // motion, matching a published single-camera thumb motion capture study that explicitly avoids the
  // wrist as a CMC pivot reference for the same reason (see the methodology note).
  let startFrameBuffer: Vector3[] = [] // first few metacarpal vectors, averaged into a stable start
  let startMetacarpal: Vector3 | undefined
  // Diagnostic: whole-hand/forearm orientation change from the start reference, using the same
  // basis-derived quaternion handOrientation() already exposes. Not wired into the guard yet -- shown
  // live so a session can be checked for whole-arm rotation contaminating the swept-distance number
  // (confirmed live: a non-flexing rigid elbow rotation alone read as ~50 deg of "sweep"). See the
  // methodology note.
  let startOrientationBuffer: Quaternion[] = []
  let startOrientation: Quaternion | undefined
  let currentPalmRotation = 0 // raw per-frame value -- feeds palmRotationMax, not shown directly
  let displayedPalmRotation = 0 // heavily smoothed, for a readable live number (raw jitters too fast)
  let palmRotationMax = 0
  let outerGuard: OcclusionGuardedGrowthPlateau | undefined
  let outerStatus: ThumbSweepStatus = 'in-progress'
  let cmcJoint: Joint | undefined // set once the outer sweep's real fit has been run
  let referenceBone2: Vector3 | undefined // Phase 6b's "no twist" baseline (limb 2's direction)

  // --- Freeform sweep (Phase 6b) state --------------------------------------------------------
  let freeformHistory: Hand[] = []
  let conjunctFit: { aCoeff: number; bCoeff: number; r2: number } | undefined
  let mcpMin = Infinity
  let mcpMax = -Infinity
  let ipMin = Infinity
  let ipMax = -Infinity
  // A single-frame MediaPipe glitch (not uncommon during fast or unusual thumb configurations)
  // otherwise permanently corrupts an unbounded running min/max -- the same lesson already applied to
  // the outer-sweep proxy (see smoothedProxy above), now applied here too after live capture showed
  // physiologically implausible ROM spans (100°+) consistent with exactly this failure mode.
  let smoothedMcp = makeSmoother()
  let smoothedIp = makeSmoother()

  $: noHandDetected =
    phase !== 'idle' && (lastFrameAt === undefined ? elapsed > 1 : elapsed - lastFrameAt > 1)

  // Reported alongside both summaries so a session's numbers can always be read against whether (and
  // against what) the palm-tilt bubble was calibrated -- see palmTilt's `reference` doc comment.
  $: calibrationSummary = calibrationReference
    ? `palm-tilt calibration: reference normal (${calibrationReference.x.toFixed(
        3
      )}, ${calibrationReference.y.toFixed(3)}, ${calibrationReference.z.toFixed(3)}), ${(
        (calibrationReference.angleTo(new Vector3(0, 0, 1)) * 180) /
        Math.PI
      ).toFixed(1)}° raw offset from camera-forward at "true level"`
    : 'palm-tilt calibration: none -- readings below are raw (uncalibrated, camera-forward-relative)'
  $: currentTiltSummary = currentTilt
    ? `current palm tilt: x=${currentTilt.x.toFixed(3)}, y=${currentTilt.y.toFixed(
        3
      )}, z=${currentTilt.z.toFixed(3)}, ${currentTilt.totalDeg.toFixed(1)}° off level (${
        calibrationReference ? 'calibrated' : 'raw'
      })`
    : 'current palm tilt: no hand detected'
  // Independent, unverified hypothesis for "which side is the palm on" -- see
  // fingerCurlAgreesWithNormal's doc comment. Logged alongside the 3D-normal-based reading so a session
  // records both signals and lets them be compared after the fact, not just watched live.
  $: currentCurlCheckSummary =
    currentCurlCheck === undefined
      ? 'finger-curl check: not enough MCP flexion to check (need middle & ring both flexed)'
      : `finger-curl check (unverified): normal ${
          currentCurlCheck > 0 ? 'AGREES with' : 'DISAGREES with'
        } curl direction (dot=${currentCurlCheck.toFixed(3)})`
  $: handednessSummary =
    `handedness classification: selected ${handedness}, currently reading ${currentHandedness ?? '—'}` +
    (handednessFlipCount > 0
      ? ` -- FLIPPED to the other label ${handednessFlipCount}x this recording`
      : ' -- no flips seen this recording')

  $: outerSummary = [
    `outer sweep: ${handedness}, ${outerHistory.length} frames`,
    `status: ${outerStatus}${outerGuard ? ` (max swept: ${outerGuard.max.toFixed(1)}°)` : ''}`,
    `[diagnostic] palm/forearm rotation from start: ${displayedPalmRotation.toFixed(
      1
    )}° (max: ${palmRotationMax.toFixed(1)}°) -- should stay near 0 if only the CMC is moving`,
    cmcJoint
      ? `fitted axis confidence: ${
          'axisConfidence' in cmcJoint ? cmcJoint.axisConfidence?.toFixed(2) : '—'
        }`
      : 'axis not yet fitted -- press "Fit axis from history" once converged',
    calibrationSummary,
    currentTiltSummary,
    currentCurlCheckSummary,
    handednessSummary,
  ].join('\n')

  $: freeformSummary = [
    `freeform sweep: ${handedness}, ${freeformHistory.length} frames`,
    conjunctFit
      ? `conjunctCoupling: aCoeff=${conjunctFit.aCoeff.toFixed(3)}, bCoeff=${conjunctFit.bCoeff.toFixed(
          3
        )}, R2=${conjunctFit.r2.toFixed(3)}`
      : 'conjunctCoupling: not ready yet',
    `thumb MCP ROM (byproduct): ${
      mcpMin === Infinity ? '—' : `${mcpMin.toFixed(1)} to ${mcpMax.toFixed(1)}`
    }`,
    `thumb IP ROM (byproduct): ${
      ipMin === Infinity ? '—' : `${ipMin.toFixed(1)} to ${ipMax.toFixed(1)}`
    }`,
    calibrationSummary,
    currentTiltSummary,
    currentCurlCheckSummary,
    handednessSummary,
  ].join('\n')

  /** Unsigned magnitude for "how far has the CMC swept from its start position" -- total angular
   * distance of bone0 from `start`, direction-agnostic across both CMC axes (flexion-extension and
   * abduction-adduction). Deliberately not a signed, single-axis projection (an earlier version used
   * the same knuckle-axis convention `signedJointAngle` uses): the thumb CMC's real flexion/abduction
   * axes aren't fitted yet -- that's what this sweep produces -- and aren't anywhere near the other
   * fingers' knuckle-line axis, so projecting onto it lost most of the real motion. This magnitude
   * captures genuine motion along *either* axis, at the cost of not being able to say which -- fine
   * for "has the sweep stopped growing," the only thing the completion guard needs. See the
   * methodology note for the full live-tuning history that led here. */
  function sweepMagnitude(hand: Hand, start: Vector3): number {
    return (start.angleTo(hand.limbs.thumb[1]) * 180) / Math.PI
  }

  /** A brief moving average, still worth keeping even with a magnitude/growth-based guard: without it,
   * a single noisy MediaPipe frame that happens to spike above the true value gets baked into the
   * running max permanently (the guard only ever raises its max, never lowers it), making genuine
   * convergence harder to reach than it should be. */
  const SMOOTHING_WINDOW = 5
  /** A small moving-average smoother, factored out so both the outer-sweep proxy and the freeform
   * MCP/IP byproduct tracking (below) can each keep their own independent buffer rather than sharing
   * one -- they're unrelated signals recorded in different modes. */
  function makeSmoother(window = SMOOTHING_WINDOW) {
    const buffer: number[] = []
    return (raw: number) => {
      buffer.push(raw)
      if (buffer.length > window) buffer.shift()
      return buffer.reduce((a, b) => a + b, 0) / buffer.length
    }
  }
  let smoothedProxy = makeSmoother()
  // Much heavier window than the default -- this is purely for a human-readable live number, not fed
  // into anything else, so trading responsiveness for readability is fine (~0.7s at 30fps).
  let smoothedPalmRotationDisplay = makeSmoother(20)

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
    currentHandedness = undefined
    handednessFlipCount = 0
    if (mode === 'outer') {
      outerHistory = []
      startFrameBuffer = []
      smoothedProxy = makeSmoother()
      startMetacarpal = undefined
      startOrientationBuffer = []
      startOrientation = undefined
      currentPalmRotation = 0
      displayedPalmRotation = 0
      smoothedPalmRotationDisplay = makeSmoother(20)
      palmRotationMax = 0
      outerGuard = new OcclusionGuardedGrowthPlateau({
        windowSeconds: growthWindowSeconds,
        convergenceThreshold,
        confidenceThreshold,
        minHealthyYield,
        minPlausibleMax,
      })
      outerStatus = 'in-progress'
    } else {
      if (!cmcJoint || !referenceBone2) {
        error = new Error(
          'Run and fit the outer sweep first -- freeform decoding needs its fitted axis.'
        )
        return
      }
      freeformHistory = []
      conjunctFit = undefined
      mcpMin = Infinity
      mcpMax = -Infinity
      ipMin = Infinity
      ipMax = -Infinity
      smoothedMcp = makeSmoother()
      smoothedIp = makeSmoother()
    }
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
        if (!hand) {
          currentTilt = undefined
          currentCurlCheck = undefined
          // The selected hand vanished this frame -- if MediaPipe instead reported the *other* label,
          // that's direct evidence of a handedness misclassification (the same physical hand briefly
          // relabeled), not just a missed detection.
          const opposite = handedness === 'Left' ? 'Right' : 'Left'
          if (hands[opposite]) {
            handednessFlipCount++
            currentHandedness = opposite
          }
          return
        }
        currentScore = hand.score
        lastFrameAt = elapsed
        staleResetAttempted = false
        drawHandOverlay(overlayCanvas, hand.hand.keypoints)
        currentTilt = palmTilt(hand, calibrationReference)
        currentCurlCheck = fingerCurlAgreesWithNormal(hand)
        currentHandedness = hand.handedness as 'Left' | 'Right'
        drawPalmNormalOverlay(overlayCanvas, hand.hand.keypoints, currentTilt)
        drawVectorSpaceTriangle(overlayCanvas, hand, currentTilt)
        drawVectorSpaceTopView(overlayCanvas, hand, currentTilt)

        if (calibrating && hand.score >= 0.7) {
          calibrationBuffer.push(handPlaneNormal(hand))
          if (calibrationBuffer.length >= CALIBRATION_FRAMES) {
            calibrationReference = calibrationBuffer
              .reduce((acc, v) => acc.add(v), new Vector3())
              .normalize()
            calibrating = false
          }
        }

        if (phase !== 'recording') return

        if (mode === 'outer') {
          const metacarpal = hand.limbs.thumb[1]

          // A single first frame is itself a noisy sample -- average the first few confidence-passing
          // frames into a steadier reference before starting to push into the guard, rather than
          // anchoring "start" to whatever the very first frame happened to be.
          if (!startMetacarpal) {
            if (hand.score >= 0.7) {
              startFrameBuffer.push(metacarpal.clone().normalize())
              startOrientationBuffer.push(handOrientation(hand))
            }
            if (startFrameBuffer.length >= START_REFERENCE_FRAMES) {
              startMetacarpal = startFrameBuffer
                .reduce((acc, v) => acc.add(v), new Vector3())
                .normalize()
              // Component-sum-then-normalize averaging -- valid for quaternions this close together
              // (a brief settling hold), the same trick the Vector3 reference above uses.
              const summed = startOrientationBuffer.reduce(
                (acc, q) => new Quaternion(acc.x + q.x, acc.y + q.y, acc.z + q.z, acc.w + q.w),
                new Quaternion(0, 0, 0, 0)
              )
              startOrientation = summed.normalize()
            }
            outerHistory.push(hand)
            outerHistory = outerHistory
            return
          }

          // Every detected frame counts from here on, regardless of confidence -- the occlusion guard
          // needs to see confidence drop to distinguish a genuine plateau from occlusion, so gating
          // frames out here (the way every other page does) would hide exactly the signal it's
          // looking for.
          const sweptDeg = smoothedProxy(sweepMagnitude(hand, startMetacarpal))
          outerGuard!.push(elapsed, sweptDeg, hand.score)
          outerStatus = outerGuard!.status()

          // Diagnostic: whole-hand/forearm orientation change from start, not wired into the guard --
          // see the note by its declaration.
          currentPalmRotation = (startOrientation!.angleTo(handOrientation(hand)) * 180) / Math.PI
          if (currentPalmRotation > palmRotationMax) palmRotationMax = currentPalmRotation
          displayedPalmRotation = smoothedPalmRotationDisplay(currentPalmRotation)

          outerHistory.push(hand)
          outerHistory = outerHistory
        } else {
          if (hand.score < 0.7) return // freeform's own fits already assume confidence-gated input
          freeformHistory.push(hand)
          freeformHistory = freeformHistory

          const [rawMcp, rawIp] = thumbMcpIpAngles(hand)
          const mcp = smoothedMcp(rawMcp)
          const ip = smoothedIp(rawIp)
          if (mcp < mcpMin) mcpMin = mcp
          if (mcp > mcpMax) mcpMax = mcp
          if (ip < ipMin) ipMin = ip
          if (ip > ipMax) ipMax = ip

          if (freeformHistory.length % STATS_UPDATE_EVERY === 0) refitConjunct()
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

  function refitConjunct() {
    if (!cmcJoint || !referenceBone2 || freeformHistory.length < 3) return
    try {
      conjunctFit = fitConjunctCoupling(freeformHistory, cmcJoint, referenceBone2)
    } catch (e) {
      console.warn(e)
    }
  }

  /** Runs the real fitThumbCmcAxis fit over the outer sweep's accumulated history, and records the
   * mean bone2 direction as Phase 6b's twist reference (the thumb was held straight throughout the
   * outer sweep, so this is the "no conjunct twist" baseline orientation). Separate button rather
   * than automatic, since it's meant to run once the guard reads 'converged', not on every frame. */
  function fitAxis() {
    if (outerHistory.length < 3) return
    cmcJoint = fitThumbCmcAxis(outerHistory, 1, new Matrix4())
    referenceBone2 = outerHistory
      .reduce((acc, h) => acc.add(h.limbs.thumb[2].clone().normalize()), new Vector3())
      .normalize()
  }

  function stop() {
    if (phase === 'idle') return
    phase = 'idle'
    cancelAnimationFrame(rid)
    teardownCamera()
    currentTilt = undefined
    currentCurlCheck = undefined
    if (mode === 'freeform') refitConjunct()
  }

  /** Starts sampling handPlaneNormal() for CALIBRATION_FRAMES frames (score-gated) to average into a new
   * calibration reference -- hold the hand at the known-true-level reference pose while this runs.
   * Only meaningful while recording (that's the only time a hand is being detected at all). */
  function startCalibration() {
    if (phase !== 'recording') return
    calibrationBuffer = []
    calibrating = true
  }

  function resetCalibration() {
    calibrating = false
    calibrationBuffer = []
    calibrationReference = undefined
  }

  onDestroy(() => {
    if (phase !== 'idle') cancelAnimationFrame(rid)
    teardownCamera()
    detector?.dispose()
  })
</script>

<svelte:body class="bg-slate-900 text-gray-50" />

<main class="max-w-3xl mx-auto my-8 px-4">
  <h1 class="text-2xl font-semibold mb-4">
    Thumb CMC: Axis Fit, Occlusion Guard &amp; Conjunct Coupling
  </h1>
  <p class="mb-6 text-sm text-gray-300">
    Tests 10 and 11 (docs/thumbs/scan_tests.md). Two modes, run in order: <strong>outer sweep</strong>
    (thumb held straight, sweep the CMC only, in both directions including once until it visibly disappears
    behind the hand to test the occlusion guard) fits the CMC's flexion/abduction axis;
    <strong>freeform sweep</strong> (unconstrained thumb motion, needs the outer sweep's fitted axis
    first) regresses the conjunct twist and extracts thumb MCP/IP ROM as a byproduct, to compare against
    an isolated thumb sweep on <code>flexion-sweep</code> (pick "thumb" as the finger there).
  </p>
  <p class="mb-6 text-sm text-amber-400">
    <strong
      >Keep the palm facing the camera throughout, and avoid pointing the thumb toward the camera.</strong
    > Pointing the thumb toward the camera inflates the swept-distance number with depth-estimation noise
    rather than real motion. See the methodology note below for why the measurement itself also changed bone
    this session.
  </p>

  {#if error}
    <div class="mb-4 bg-red-400/30 px-4 py-3 rounded" role="alert">
      Error: {error.message}
    </div>
  {/if}

  <div class="grid grid-cols-2 gap-4 mb-4">
    <label class="flex flex-col gap-1">
      <span class="text-sm">Mode</span>
      <select bind:value={mode} disabled={phase !== 'idle'} class="text-black rounded px-2 py-1">
        <option value="outer">Outer sweep (Phase 6a)</option>
        <option value="freeform">Freeform sweep (Phase 6b)</option>
      </select>
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
      <span class="text-sm">Growth window, outer sweep only (sec)</span>
      <input
        type="number"
        min="0.5"
        step="0.5"
        bind:value={growthWindowSeconds}
        disabled={phase !== 'idle'}
        class="text-black rounded px-2 py-1"
      />
    </label>

    <label class="flex flex-col gap-1">
      <span class="text-sm">Growth threshold, outer sweep only (deg)</span>
      <input
        type="number"
        min="0.5"
        step="0.5"
        bind:value={convergenceThreshold}
        disabled={phase !== 'idle'}
        class="text-black rounded px-2 py-1"
      />
      <span class="text-xs text-gray-400">
        Converged once the max swept distance hasn't grown by more than this over the window above. See
        the methodology note for why this replaced a rep-counting approach entirely.
      </span>
    </label>

    <label class="flex flex-col gap-1">
      <span class="text-sm">Minimum plausible max, outer sweep only (deg)</span>
      <input
        type="number"
        min="0"
        step="1"
        bind:value={minPlausibleMax}
        disabled={phase !== 'idle'}
        class="text-black rounded px-2 py-1"
      />
      <span class="text-xs text-gray-400">
        Convergence is blocked below this swept distance regardless of how flat the growth looks --
        stopping early at an implausibly small max was a real live-tuning finding, not a hypothetical.
      </span>
    </label>

    <label class="flex flex-col gap-1">
      <span class="text-sm">Confidence threshold, outer sweep only</span>
      <input
        type="number"
        min="0"
        max="1"
        step="0.05"
        bind:value={confidenceThreshold}
        disabled={phase !== 'idle'}
        class="text-black rounded px-2 py-1"
      />
    </label>

    <label class="flex flex-col gap-1">
      <span class="text-sm">Min healthy yield, outer sweep only</span>
      <input
        type="number"
        min="0"
        max="1"
        step="0.05"
        bind:value={minHealthyYield}
        disabled={phase !== 'idle'}
        class="text-black rounded px-2 py-1"
      />
      <span class="text-xs text-gray-400">
        Both were hardcoded (0.7/0.8) until a real session flagged "possibly-occluded" with no deliberate
        occlusion attempted -- lower these if that keeps happening on ordinary sweeps.
      </span>
    </label>
  </div>

  <div class="mb-4 rounded overflow-hidden bg-black aspect-video relative">
    <!-- svelte-ignore a11y-media-has-caption -->
    <video bind:this={video} playsinline muted class="w-full h-full object-contain -scale-x-100" />
    <canvas
      bind:this={overlayCanvas}
      class="absolute inset-0 w-full h-full object-contain pointer-events-none"
    />
    {#if currentTilt}
      <div class="absolute top-2 right-2 bg-black/60 rounded-lg p-2 flex flex-col items-center gap-1">
        <PalmBubble tiltX={currentTilt.x} tiltY={currentTilt.y} totalDeg={currentTilt.totalDeg} />
        <span class="text-xs text-gray-300 font-mono">
          normal z: {currentTilt.z.toFixed(3)}
        </span>
        {#if currentCurlCheck !== undefined}
          <span
            class="text-xs font-mono"
            class:text-emerald-400={currentCurlCheck > 0}
            class:text-red-400={currentCurlCheck < 0}
          >
            curl check: {currentCurlCheck > 0 ? 'agrees' : 'DISAGREES'} ({currentCurlCheck.toFixed(3)})
          </span>
        {/if}
        <span class="text-xs font-mono" class:text-amber-400={handednessFlipCount > 0}>
          handedness: {currentHandedness ?? '—'} (selected {handedness}){handednessFlipCount > 0
            ? ` -- flipped ${handednessFlipCount}x!`
            : ''}
        </span>
        <span
          class="text-xs"
          class:text-emerald-400={!!calibrationReference}
          class:text-gray-500={!calibrationReference}
        >
          {calibrating
            ? `calibrating... ${calibrationBuffer.length}/${CALIBRATION_FRAMES}`
            : calibrationReference
            ? 'calibrated'
            : 'raw (uncalibrated)'}
        </span>
      </div>
    {/if}
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
    {#if mode === 'outer' && phase === 'idle' && outerHistory.length >= 3}
      <button
        class="bg-gradient-to-br from-emerald-400 to-teal-600 text-lg p-1 rounded-2 shadow-lg"
        on:click={fitAxis}
      >
        <span class="block bg-slate-900 px-6 py-2 rounded-1.5 font-semibold">Fit axis from history</span>
      </button>
    {/if}
    {#if phase === 'recording'}
      <button
        class="bg-gradient-to-br from-sky-400 to-blue-600 text-lg p-1 rounded-2 shadow-lg disabled:opacity-50"
        on:click={startCalibration}
        disabled={calibrating}
      >
        <span class="block bg-slate-900 px-6 py-2 rounded-1.5 font-semibold"
          >{calibrating ? 'Calibrating...' : 'Calibrate level (hold pose)'}</span
        >
      </button>
    {/if}
    {#if calibrationReference}
      <button
        class="bg-gradient-to-br from-slate-500 to-slate-700 text-lg p-1 rounded-2 shadow-lg"
        on:click={resetCalibration}
      >
        <span class="block bg-slate-900 px-6 py-2 rounded-1.5 font-semibold">Reset calibration</span>
      </button>
    {/if}
  </div>

  <div class="text-sm text-gray-300 mb-4">
    <p>
      Phase: <span class="font-semibold text-white">{phase}</span>
      {#if phase !== 'idle'}(loop tick {loopTicks}, {elapsed.toFixed(1)}s / {sessionDuration}s){/if}
    </p>
    <p class:text-amber-400={noHandDetected}>
      Current confidence: {currentScore !== undefined ? currentScore.toFixed(3) : '—'}
    </p>
    {#if mode === 'outer' && startMetacarpal}
      <p class:text-amber-400={displayedPalmRotation > 5}>
        Palm/forearm rotation from start: {displayedPalmRotation.toFixed(1)}°{displayedPalmRotation > 5
          ? ' -- watch for whole-arm rotation, not just the thumb'
          : ''}
      </p>
    {/if}
    {#if noHandDetected}
      <p class="text-amber-400 font-semibold">
        No {handedness} hand detected in the last second.
        {#if staleResetAttempted}(tracking reset attempted — still nothing seen){/if}
      </p>
    {/if}
  </div>

  <div class="mb-4">
    <h2 class="text-lg font-semibold mb-2">Result summary (select and copy this)</h2>
    <pre class="text-xs bg-black/40 rounded p-3 whitespace-pre-wrap select-all">{mode === 'outer'
        ? outerSummary
        : freeformSummary}</pre>
  </div>

  <details class="text-xs text-gray-500 mt-6">
    <summary class="cursor-pointer select-none">Methodology notes</summary>
    <div class="mt-2 space-y-2">
      <p>
        The outer sweep's live status tracks the running maximum of an <strong>unsigned</strong> swept
        distance (total angular distance of bone0 from an averaged start reference, not a live
        flexion/abduction split — that split needs the fitted axis this sweep is producing, so it can't
        exist yet mid-sweep) and declares convergence once that max hasn't grown by more than the growth
        threshold above over the trailing growth window. Once it reads "converged", press "Fit axis from
        history" to run the real <code>fitThumbCmcAxis</code> (PCA/SVD via <code>fitNorms</code>) over
        everything captured. If it instead reads "possibly-occluded", the max stopped growing at the same
        time confidence dropped in that window — likely the thumb went out of view right as it looked
        like it stopped, not that it actually reached its true limit. Keep sweeping (still recording
        counts) rather than trusting that plateau.
      </p>
      <p>
        <strong
          >This replaced an earlier rep-counting design after three rounds of live tuning failed to fix
          it</strong
        >
        — worth reading since the same trap is easy to fall into elsewhere. The original version used a signed,
        single-axis proxy (the same knuckle-axis convention `signedJointAngle` uses) fed through a hysteresis-based
        peak detector, the same mechanism Test 7 validated for finger reps. It failed for two different, compounding
        reasons: (1) the thumb CMC's real flexion/abduction axes aren't anywhere near the other fingers' knuckle-line
        axis (that axis is tuned to <em>their</em> anatomy, not the CMC's), so projecting the CMC's
        actual motion onto it lost most of the real signal — meaning even a large physical sweep only
        produced a small proxy swing, confirmed live: real motion needed to trigger a rep stayed too
        large no matter how low hysteresis went. (2) A single fixed reversal-magnitude threshold can't
        simultaneously reject a noisy single frame and trigger on modest genuine motion — lowering it to
        fix (1) let a single noise spike cross the threshold, and since
        <code>PlateauDetector</code> resets its tracked extreme to whatever value crossed it, the very next
        frame bouncing back could cross it again immediately, producing repeated false reps in a row ("if
        it triggers at all it triggers multiple times").
      </p>
      <p>
        Both problems trace back to the same root cause: trying to force a two-axis exploratory sweep
        through a mechanism (discrete rep-counting via hysteresis) built for a one-axis cyclic signal.
        Rather than continuing to patch that mechanism, the guard was rebuilt around a magnitude/growth
        criterion instead — <code>OcclusionGuardedGrowthPlateau</code>, the same "has this stopped
        changing" idea `stillWindow.ts` already uses for stillness, applied to a running maximum instead.
        This needs no axis, no sign, and no clean per-rep shape: any exploratory motion, along either CMC
        axis or both at once, just grows the tracked max until the person stops finding new extremes, at
        which point it plateaus and the guard converges. `smoothedProxy()`'s 5-frame moving average is
        still used, now purely to keep a single noisy frame from permanently inflating the running max
        (which only ever increases, never resets) rather than to feed a hysteresis threshold.
      </p>
      <p>
        Not yet re-verified live. Growth window and growth threshold are both live-tunable above for
        exactly the reason every other parameter in this test suite is — real tuning, not guessed
        defaults, is what actually converged Tests 6/7's thresholds, and there's no reason to expect this
        one to be different.
      </p>
      <p>
        <strong
          >Live run of the redesign converged reliably (no more repeated false triggers) but at an
          implausibly small max</strong
        > — 8-21° across three real sessions, well under a CMC's real range (roughly 40-60° per axis in the
        literature), even after the window was already raised from 2s to 4s. Growth plateauing is necessary
        but not sufficient for "this is a real limit": a person deciding where to move next, or moving within
        an already-explored sub-range for a few seconds, looks identical to genuine convergence to the growth
        check alone. Added a minimum-plausible-max floor — convergence is now blocked below it regardless
        of how flat the growth curve looks. This also likely explains why `conjunctCoupling` looked unstable
        across sessions (aCoeff/bCoeff swinging in magnitude and even sign): each session refits its own CMC
        axis from a small, differently-incomplete slice of real motion, so "flexion" and "abduction" don't
        consistently mean the same thing session to session, and the regression coefficients relative to those
        inconsistent frames aren't directly comparable. Expect that to stabilize once the outer sweep actually
        captures a fuller range.
      </p>
      <p>
        <strong
          >Confirmed live: pointing the thumb toward the camera inflates the swept-distance number, and
          the farther it's rotated that way, the higher the number climbs.</strong
        > MediaPipe's monocular depth (Z) estimate is inherently noisier than its image-plane (X/Y) estimate
        -- rotating a bone toward the camera changes mostly its depth component, exactly the axis least reliably
        measured. So that climb is very likely measuring depth-axis noise, not additional real rotation. Not
        patched algorithmically here -- treat toward-camera motion as suspect and avoid it deliberately (see
        the warning banner above) rather than trusting a max reached that way.
      </p>
      <p>
        <strong
          >New confound found live: a non-flexing, rigid elbow/forearm rotation alone (thumb not moving
          relative to the palm at all) read as ~50° of "sweep."</strong
        > `hand.basis` (rebuilt every frame from a few landmarks) is meant to cancel out exactly this -- express
        bone vectors in a hand-relative frame independent of how the whole arm is oriented in space -- but
        the landmarks it's built from have the same weak monocular depth estimate as everything else, so whole-arm
        rotation (which changes those landmarks' depth/foreshortening) can leak into the basis estimate itself,
        and from there into every basis-transformed limb vector, including the metacarpal this test now depends
        on. Not fixable by choosing a different bone or threshold -- it's upstream of both. Primary mitigation
        is physical, not algorithmic: brace the forearm/elbow against a fixed surface for the whole outer
        sweep so genuine whole-arm rotation is mechanically prevented rather than something software has to
        detect after the fact. As a complementary live check (not yet wired into the guard -- diagnostic only),
        the page now tracks palm/forearm orientation change from the start reference via `handOrientation()`
        (already exposed on `$lib/hand.ts`, quaternion-based), shown live during recording and in the result
        summary -- watch for it staying near 0 while sweeping; if it climbs alongside the swept-distance number,
        that session's "sweep" is at least partly whole-arm rotation, not CMC motion.
      </p>
      <p>
        <strong>Confirmed and fixed: the whole implementation was measuring the wrong bone.</strong>
        With the palm reliably facing the camera and no toward-camera rotation, live feedback found the measured
        max (~5°) badly undershooting the real, eyeballed motion (~15°) when measured off bone[0] (`hand.limbs.thumb[0]`,
        wrist landmark to the "thumb CMC" landmark) -- MediaPipe models the wrist as a zero-width single point,
        so bone[0] sits too close to the CMC joint's own pivot to carry much real rotation. A diagnostic comparing
        bone[0] against bone[1] (CMC landmark to MCP landmark, the actual first metacarpal -- the rigid body
        that pivots <em>at</em> the CMC) confirmed it decisively: 4.1° on bone[0] vs. 37.7° on bone[1] for
        the same real sweep. This also matches a published single-camera thumb motion capture study, which
        explicitly avoids the wrist as a CMC pivot reference for the same reason and reports ~2-3° mean error
        using bone[1]-equivalent measurements against a palm-level reference instead (see docs/thumbs/test_results.md,
        2026-09-01, for the full research writeup). `fitThumbCmcAxis`, the outer-sweep proxy, `flexionAbduction`,
        and `twistAngle` were all switched from bone[0]/bone[1] to bone[1]/bone[2] accordingly -- the degree-3
        CMC joint conceptually now lives at joint index 1, not 0, matching which bone actually carries the
        CMC's rotation. Not yet re-verified live on the corrected bone.
      </p>
      <p>
        Freeform mode needs the outer sweep's fitted axis and reference bone2 direction (captured via
        "Fit axis from history") before it can decode anything meaningful — flexion/abduction only make
        sense relative to that fitted frame, and twist is measured relative to the reference bone2
        direction recorded during the (thumb-held-straight) outer sweep.
      </p>
      <p>
        Thumb MCP/IP ROM here is read the same way `flexion-sweep`'s thumb option and `flexion.ts`'s
        DIP/PIP fit already do (boneIndex 1/2) — labeled MCP/IP rather than PIP/DIP for the thumb, since
        it has one fewer non-metacarpal bone than the other fingers (see flexion-sweep's own note on
        this). Compare this byproduct ROM against a dedicated `flexion-sweep` run with "thumb" selected,
        on the same session, for Test 11's actual comparison.
      </p>
      <p>
        <strong>First live run produced physiologically implausible MCP/IP spans (100°+).</strong> Traced
        to the same failure mode already found and fixed for the outer-sweep proxy: a single MediaPipe tracking
        glitch (not uncommon at unusual or fast thumb configurations) produces one wildly wrong instantaneous
        angle, and since a running min/max latches onto any value forever, one bad frame permanently corrupts
        the recorded ROM. Fixed the same way: `mcp`/`ip` are now each smoothed (5-frame moving average, via
        the same `makeSmoother()` the outer-sweep proxy uses) before updating the running extrema, rather
        than taking the raw per-frame value directly.
      </p>
      <p>
        <strong
          >Palm-tilt bubble: found reliable rotating the thumb away from the camera and wrist/finger
          extension, unreliable rotating the thumb toward the camera and wrist/finger flexion toward it</strong
        >
        — the two failure directions are exactly the ones that foreshorten the `[0, 5, 17]` landmark triangle
        toward the camera, pushing more of the fitted normal's magnitude into its depth (z) component (exposed
        live as `normal z` above) rather than the x/y the bubble displays — the same monocular-depth weakness
        this whole test suite keeps finding (see the toward-camera swept-distance note above). Also found
        a consistent <strong>~10° baseline offset</strong> at true physical level — the `[0, 5, 17]`
        triangle's normal isn't exactly the anatomical palm normal, so it never quite reads 0° even when
        level, which is expected and not itself a bug. <strong>Calibrate level</strong> re-zeros against a
        sampled reference instead of guessing that offset away: press it while holding the hand at a known-true-level
        pose, hold still for the ~15-frame sample, and every reading (bubble, `normal z`, the numeric degrees)
        becomes relative to that reference. This is a per-session/per-rig live calibration, not a hardcoded
        constant — deliberately, so a future `scan3` implementation can run the same calibration as an early
        step rather than baking today's ~10° into the model.
      </p>
    </div>
  </details>
</main>
