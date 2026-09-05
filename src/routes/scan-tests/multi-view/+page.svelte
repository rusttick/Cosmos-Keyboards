<script lang="ts">
  import { onDestroy } from 'svelte'
  import createDetector, { type Detector } from '../lib/detector'
  import { type Handedness } from '../lib/orientation'
  import {
    drawAxisTriad,
    drawAxisTriadOverlay,
    drawHandOverlay,
    drawSkeletonView,
    lookAtBasis,
  } from '../lib/overlay'
  import { DEFAULT_ONE_EURO_OPTIONS } from '../lib/landmarkFilter'
  import { palmBasisAxes } from '$lib/hand'
  import { Vector3 } from 'three'

  // The center tile is the real video + overlay (like thumb-cmc's normal arrow); the 8 side tiles are
  // pure reconstructed-skeleton views, no video, so a monocular depth-estimation error that's
  // invisible looking down the same axis the camera measures along shows up as an implausible shape
  // from another angle. See docs/thumbs/test_results.md's denoising/multi-view design entry.
  //
  // View naming/geometry follows FreeCAD's Standard Views convention (View > Standard views, keyboard
  // shortcuts 0/1-6: Isometric, Front, Top, Right, Rear, Bottom, Left -- confirmed against
  // wiki.freecad.org/Std_View_Menu and Std_ViewFront's own doc, 2026-09). The live palm-plane normal
  // `N` plays the role of that reference frame's local Z (up) axis -- so, matching how a real
  // FreeCAD/engineering-drawing view cube behaves, N renders pointing straight up in Front/Rear/
  // Right/Left (all four are "elevation" views where the model's up axis is vertical on screen),
  // toward the viewer in Top (looking down at the object from above, its up axis pokes out of the
  // page), and away from the viewer in Bottom (looking up from below, up axis recedes into the page).
  // Dimetric fills the 8th grid slot FreeCAD itself doesn't assign a numeric shortcut to. The
  // reference frame's X/Y axes are the hand's own `palmBasisAxes().left`/`.up` (not an arbitrary
  // externally-referenced pair) -- see tileViewBases's doc comment for why that's what keeps all 3
  // drawn axes fixed in every view, not just the normal.
  const STALL_RESET_SECONDS = 3

  let video: HTMLVideoElement
  let centerCanvas: HTMLCanvasElement
  let tile0: HTMLCanvasElement
  let tile1: HTMLCanvasElement
  let tile2: HTMLCanvasElement
  let tile3: HTMLCanvasElement
  let tile4: HTMLCanvasElement
  let tile5: HTMLCanvasElement
  let tile6: HTMLCanvasElement
  let tile7: HTMLCanvasElement
  $: tileCanvases = [tile0, tile1, tile2, tile3, tile4, tile5, tile6, tile7]

  let stream: MediaStream | undefined
  let detector: Detector | undefined

  let handedness: Handedness = 'Right'
  let running = false
  let error: Error | undefined
  let startTime = 0
  let elapsed = 0
  let lastFrameAt: number | undefined
  let rid: number
  let staleResetAttempted = false

  // Numeric display refresh, same rate/reasoning as flexion-sweep and thumb-cmc -- this page has no
  // tuning UI of its own, so it reads landmarkFilter.ts's canonical default directly.
  const displayRefreshIntervalSeconds = 1 / DEFAULT_ONE_EURO_OPTIONS.minCutoff
  let lastDisplayUpdate = 0
  let currentScore: number | undefined

  $: noHandDetected = running && (lastFrameAt === undefined ? elapsed > 1 : elapsed - lastFrameAt > 1)

  /** One entry per tile: FreeCAD's own name/shortcut number (undefined for Dimetric, which FreeCAD
   * itself doesn't assign a digit to), the viewing direction as coefficients on the local {X, Y, Z=N}
   * frame built in tileViewBases, and whether the normal degenerates to a point in this view (Top and
   * Bottom look straight down/up the Z=N axis itself). Grid position mirrors an "unfolded cube net"
   * around the center (real-camera) tile: Top above it, Bottom below, Left/Right beside it, the four
   * corners for Front/Rear/Isometric/Dimetric -- see the template below for which tile index lands
   * where in the 3x3 grid. */
  // `degenerate` marks the 2 views where the normal looks straight along its own axis (Top/Bottom) --
  // documentation only now that drawAxisTriad handles every axis' near-zero-length case generically
  // (a small dot instead of an arrow with an undefined direction), rather than drawSkeletonView's
  // normal-specific throughScreen glyph this page used before adding the other 2 axes.
  const VIEWS: { number?: number; name: string; xyz: [number, number, number]; degenerate?: boolean }[] =
    [
      { number: undefined, name: 'Isometric*', xyz: [-1, 1, -1] }, // tile0, top-left corner
      { number: 2, name: 'Top', xyz: [0, 0, -1], degenerate: true }, // tile1, above center
      { number: 1, name: 'Front', xyz: [0, 1, 0] }, // tile2, top-right corner
      { number: 6, name: 'Left', xyz: [1, 0, 0] }, // tile3, left of center
      { number: 3, name: 'Right', xyz: [-1, 0, 0] }, // tile4, right of center
      { number: 4, name: 'Rear', xyz: [0, -1, 0] }, // tile5, bottom-left corner
      { number: 5, name: 'Bottom', xyz: [0, 0, 1], degenerate: true }, // tile6, below center
      { number: undefined, name: 'Dimetric*', xyz: [1, -1, 0.5] }, // tile7, bottom-right corner
    ]

  /** 8 camera bases, one per VIEWS entry, all locked to the hand's *entire* live orientation frame --
   * not just its normal -- so nothing in the view rotates as the hand rotates, matching how FreeCAD's
   * Standard Views are fixed relative to a part's own local placement, not the world.
   *
   * First attempt only locked Z to the live normal and built X/Y from it plus an arbitrary,
   * externally-fixed reference vector (`cross(N, worldUp)` and its cross with N again). That kept the
   * normal itself pinned, but X/Y were NOT attached to any real hand-anatomy axis -- so a pure twist of
   * the hand about its own normal (real motion, N unchanged) rotated the *other* two palmBasisAxes
   * vectors (up, left) relative to that arbitrary X/Y, which is exactly the "the other two axes rotate
   * around the fixed one" symptom this fixes. The corrected version uses `axes.up`/`axes.left`
   * directly as X/Y instead of anything externally referenced -- since all 3 of {normal, up, left} are
   * already a single rigid, hand-attached orthonormal frame (see palmBasisAxes's doc comment), every
   * view's `forward` (a fixed linear combination of that frame) rotates together with the hand as a
   * unit, and so does every one of the 3 axes drawn on top by drawAxisTriad.
   *
   * `hint = axes.normal` for `lookAtBasis`, falling back to `axes.up` only for Top/Bottom (where
   * `forward` is parallel to the normal and the hint would degenerate) -- `up` is guaranteed ⟂ normal
   * by construction, so unlike the old world-fixed fallback this one can never itself degenerate. */
  function tileViewBases(axes: {
    normal: Vector3
    up: Vector3
    left: Vector3
  }): { forward: Vector3; right: Vector3; up: Vector3 }[] {
    const Z = axes.normal
    const Y = axes.up
    const X = axes.left

    return VIEWS.map(({ xyz: [x, y, z] }) => {
      const forward = X.clone().multiplyScalar(x).addScaledVector(Y, y).addScaledVector(Z, z).normalize()
      return lookAtBasis(forward, Z, Y)
    })
  }

  async function setupCamera() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('No camera access available')
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user' } })
    video.srcObject = stream
    await new Promise((r) => (video.onloadedmetadata = r))
    video.play()
    centerCanvas.width = video.videoWidth
    centerCanvas.height = video.videoHeight
  }

  function teardownCamera() {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop())
      stream = undefined
    }
  }

  async function start() {
    error = undefined
    lastFrameAt = undefined
    lastDisplayUpdate = 0
    currentScore = undefined
    staleResetAttempted = false
    try {
      detector?.dispose()
      detector = await createDetector(handedness)
      await setupCamera()
    } catch (e) {
      error = e as Error
      console.error(e)
      return
    }
    running = true
    startTime = performance.now()
    rid = requestAnimationFrame(loop)
  }

  function stop() {
    if (!running) return
    running = false
    cancelAnimationFrame(rid)
    teardownCamera()
  }

  function loop() {
    if (!running) return
    elapsed = (performance.now() - startTime) / 1000

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

        drawHandOverlay(centerCanvas, hand.hand.keypoints)
        // The 3 raw makeBasis() vectors (not hand.basis's own relabeled/permuted output -- see
        // palmBasisAxes's doc comment in $lib/hand.ts). Single source of truth for all 3 axes on
        // every tile below, center included, instead of the center tile computing its normal via a
        // separately-maintained formula (orientation.ts's handPlaneNormal(), which happens to compute
        // the same vector today, but duplicated formulas are exactly what caused the two-conventions
        // bug documented in test_results.md's 2026-09-02 entry).
        const axes = palmBasisAxes(hand.vectors, hand.handedness)
        drawAxisTriadOverlay(centerCanvas, hand.hand.keypoints, axes)

        if (elapsed - lastDisplayUpdate >= displayRefreshIntervalSeconds) {
          lastDisplayUpdate = elapsed
          currentScore = hand.score
        }

        // Roughly pose-invariant reference length (wrist -> middle MCP, a rigid palm-level span) so
        // the rendered hand stays a stable size across frames instead of auto-fitting -- and so
        // jarringly resizing -- every tile every frame.
        const refLen = hand.vectors[0].distanceTo(hand.vectors[9]) || 1
        const tileSize = Math.min(tile0?.width || 0, tile0?.height || 0) || 200
        const scale = (tileSize * 0.4) / refLen

        // drawSkeletonView draws just the skeleton here (no normal arrow of its own -- `normal` is
        // omitted) since drawAxisTriad draws all 3 axes, including the normal, uniformly across every
        // tile right after it.
        const bases = tileViewBases(axes)
        bases.forEach((cam, i) => {
          const canvas = tileCanvases[i]
          if (!canvas) return
          const view = VIEWS[i]
          const label = view.number !== undefined ? `${view.number} ${view.name}` : view.name
          drawSkeletonView(canvas, hand, undefined, cam, scale, { label })
          drawAxisTriad(canvas, hand, axes, cam)
        })
      })
      .catch((e) => console.error(e))
      .finally(() => {
        if (!running) return
        rid = requestAnimationFrame(loop)
      })
  }

  onDestroy(() => {
    if (running) cancelAnimationFrame(rid)
    teardownCamera()
    detector?.dispose()
  })
</script>

<svelte:body class="bg-slate-900 text-gray-50" />

<main class="w-full my-8 px-4">
  <div class="max-w-3xl">
    <h1 class="text-2xl font-semibold mb-4">Multi-View: FreeCAD-Style Palm-Normal-Locked Views</h1>
    <p class="mb-6 text-sm text-gray-300">
      The video-overlay skeleton looks smooth and plausible, but a monocular reconstruction error
      (especially in depth, MediaPipe's weakest axis) can be invisible from the same angle the camera
      measures along and obvious from any other. The center tile is the real video + overlay, exactly
      like the other capture pages. The 8 surrounding tiles render the same reconstructed 3D skeleton (<code
        >hand.vectors</code
      >) from FreeCAD's Standard Views (View &gt; Standard views, keyboard shortcuts 0/1-6) -- Isometric,
      Front, Top, Right, Rear, Bottom, Left, plus Dimetric to fill the grid -- built around the live
      palm-plane normal playing the role of that reference frame's local up (Z) axis. The whole set of
      views rotates together with the hand (locked to the live normal) rather than staying fixed relative
      to the real camera. Every tile also draws the hand's full orientation frame as a color-coded arrow
      triad (cyan = palm-plane normal, amber = the 0→5 axis, pink = their cross product), rooted at the
      wrist -- watch whether it stays rigidly attached to the visible hand motion (a stable orientation
      frame) or visibly twists on its own (the frame itself drifting).
    </p>

    {#if error}
      <div class="mb-4 bg-red-400/30 px-4 py-3 rounded" role="alert">
        Error: {error.message}
      </div>
    {/if}

    <div class="grid grid-cols-2 gap-4 mb-4">
      <label class="flex flex-col gap-1">
        <span class="text-sm">Handedness</span>
        <select bind:value={handedness} disabled={running} class="text-black rounded px-2 py-1">
          <option value="Right">Right</option>
          <option value="Left">Left</option>
        </select>
      </label>
    </div>
  </div>

  <div class="grid grid-cols-3 gap-2 mb-4">
    <div class="relative bg-black aspect-video rounded overflow-hidden">
      <canvas bind:this={tile0} width="480" height="270" class="w-full h-full" />
    </div>
    <div class="relative bg-black aspect-video rounded overflow-hidden">
      <canvas bind:this={tile1} width="480" height="270" class="w-full h-full" />
    </div>
    <div class="relative bg-black aspect-video rounded overflow-hidden">
      <canvas bind:this={tile2} width="480" height="270" class="w-full h-full" />
    </div>

    <div class="relative bg-black aspect-video rounded overflow-hidden">
      <canvas bind:this={tile3} width="480" height="270" class="w-full h-full" />
    </div>
    <div class="relative bg-black aspect-video rounded overflow-hidden">
      <!-- svelte-ignore a11y-media-has-caption -->
      <video bind:this={video} playsinline muted class="w-full h-full object-contain -scale-x-100" />
      <canvas
        bind:this={centerCanvas}
        class="absolute inset-0 w-full h-full object-contain pointer-events-none"
      />
    </div>
    <div class="relative bg-black aspect-video rounded overflow-hidden">
      <canvas bind:this={tile4} width="480" height="270" class="w-full h-full" />
    </div>

    <div class="relative bg-black aspect-video rounded overflow-hidden">
      <canvas bind:this={tile5} width="480" height="270" class="w-full h-full" />
    </div>
    <div class="relative bg-black aspect-video rounded overflow-hidden">
      <canvas bind:this={tile6} width="480" height="270" class="w-full h-full" />
    </div>
    <div class="relative bg-black aspect-video rounded overflow-hidden">
      <canvas bind:this={tile7} width="480" height="270" class="w-full h-full" />
    </div>
  </div>

  <div class="max-w-3xl">
    <div class="mb-4 flex gap-2">
      {#if !running}
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
      <p class:text-amber-400={noHandDetected}>
        Current confidence: {currentScore !== undefined ? currentScore.toFixed(3) : '—'}
      </p>
      <p class="text-xs text-gray-400">
        Numeric display refreshes at ~{DEFAULT_ONE_EURO_OPTIONS.minCutoff.toFixed(2)} Hz -- tied to the One
        Euro min cutoff (this page has no tuning UI; see flexion-sweep for that). The 8 side tiles redraw
        every frame regardless -- they're visual renders, not numeric readouts.
      </p>
      {#if noHandDetected}
        <p class="text-amber-400 font-semibold">
          No {handedness} hand detected in the last second — check that it's in frame.
          {#if staleResetAttempted}(tracking reset attempted — still nothing seen){/if}
        </p>
      {/if}
    </div>
  </div>
</main>
