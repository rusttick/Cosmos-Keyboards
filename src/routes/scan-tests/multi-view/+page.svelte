<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import createDetector, { type Detector } from '../lib/detector'
  import { type Handedness } from '../lib/orientation'
  import {
    drawAxisTriad,
    drawAxisTriadOverlay,
    drawHandOverlay,
    drawSkeletonView,
    lookAtBasis,
    projectCorrectedOntoKeypoints,
  } from '../lib/overlay'
  import { DEFAULT_ONE_EURO_OPTIONS } from '../lib/landmarkFilter'
  import { palmBasisAxes } from '$lib/hand'
  import { Vector3 } from 'three'
  import {
    buildDefaultSkeleton,
    buildRestExtensionPose,
    buildRestExtensionSkeleton,
    poseConfidenceSdDeg,
    poseToLandmarkVectors,
    solvePose,
  } from '../../scan3/lib/priors/ikSolve'
  import { fuseHandPriorState } from '../../scan3/lib/priors/fuseSources'
  import type { PriorSource } from '../../scan3/lib/priors/priorSource'
  import PriorSourceChecklist from '../lib/PriorSourceChecklist.svelte'

  // The center tile is the real video with the corrected/model-solved hand projected on top of it (an
  // orthographic approximation -- see projectCorrectedOntoKeypoints's doc comment -- since this
  // project has no real camera projection to invert), so it answers "does the solved model look like
  // the real hand" directly, at the actual video frame. tile0 (top-left) is a fixed, never-tracked
  // "model rest" reference -- the prior's bone lengths and ROM alone, in a static maximum-extension
  // pose, for auditing those by eye independent of any live capture (see restSkeleton/restPose below).
  // The remaining 7 tiles are pure reconstructed-skeleton views of the live corrected model, no video,
  // so a monocular depth-estimation error that's invisible looking down the same axis the camera
  // measures along shows up as an implausible shape from another angle. See
  // docs/thumbs/test_results.md's denoising/multi-view design entry.
  //
  // Those 7 live tiles' naming/geometry follows FreeCAD's Standard Views convention (View > Standard
  // views, keyboard shortcuts 1-6: Front, Top, Right, Rear, Bottom, Left, plus Dimetric to fill the
  // grid -- confirmed against wiki.freecad.org/Std_View_Menu and Std_ViewFront's own doc, 2026-09).
  // The live palm-plane normal `N` plays the role of that reference frame's local Z (up) axis -- so,
  // matching how a real FreeCAD/engineering-drawing view cube behaves, N renders pointing straight up
  // in Front/Rear/Right/Left (all four are "elevation" views where the model's up axis is vertical on
  // screen), toward the viewer in Top (looking down at the object from above, its up axis pokes out of
  // the page), and away from the viewer in Bottom (looking up from below, up axis recedes into the
  // page). The reference frame's X/Y axes are the hand's own `palmBasisAxes().left`/`.up` (not an
  // arbitrary externally-referenced pair) -- see tileViewBases's doc comment for why that's what keeps
  // all 3 drawn axes fixed in every view, not just the normal.
  const STALL_RESET_SECONDS = 3

  // average-hand.md Stage 6: this page never writes to HandPriorState -- what's loaded here is always
  // a fused, in-memory SNAPSHOT (see fuseSources.ts), never a mutation of any registered source.
  // `selected` tracks which of ALL_PRIOR_SOURCES (registry.ts) are currently checked; every source is
  // an equal, independent peer (fuseSources.ts's whole point) -- there's no privileged "base" source,
  // the literature seed included, so checking/unchecking it behaves exactly like any subject's box.
  // Starts with just the literature seed checked (closest to this page's original fixed behavior), but
  // nothing stops unchecking it entirely once other sources exist. `skeleton` has no per-user
  // calibration behind it either way (see buildDefaultSkeleton's own doc comment) -- this page is meant
  // for watching how the *model* constrains a frame, not for judging a specific hand's fit.
  // Prior-source checklist factored into a shared component (PriorSourceChecklist.svelte) so this page
  // and /bones always offer the exact same registered sources -- see that component's own doc comment.
  let selectedSources: PriorSource[] = []
  // Fused separately per hand from the SAME selection -- `handedness` (declared below, the page's own
  // "which real hand am I tracking" selector) picks which half of every selected source's pair feeds
  // the live solve/rest-tile below; it never mixes a source's Right half with another's Left half.
  $: priorSnapshot = fuseHandPriorState(selectedSources, handedness)
  const MAX_SD_DEG_FOR_OPACITY = 60
  const UNMODELED_OPACITY = 0.25
  function opacityFromSdDeg(sdDeg: number | undefined): number {
    if (sdDeg === undefined) return UNMODELED_OPACITY
    return Math.max(0.15, 1 - sdDeg / MAX_SD_DEG_FOR_OPACITY)
  }

  // Fixed camera basis, chosen directly in the rest skeleton's own local axes -- NOT derived from any
  // live `axes`/tileViewBases, since this tile is defined to never move regardless of the live tracked
  // hand. At `restPose` (every flex angle at its own ROM minimum, i.e. maximally extended), every
  // landmark's reach direction has zero Y-component (flexion is the only DOF that moves a landmark
  // into Y -- see `trackedPose`'s angleZ/angleY convention in ikSolve.ts), so the whole hand lies in
  // the local X-Z plane; looking along Y views that plane face-on, palm-first. `right`/`up`'s
  // handedness (`cross(right, up)` = +Y) is chosen so that a positive MCP flexion angle -- which
  // rotates the reach direction toward +Y, per the same convention -- curls fingers toward the camera,
  // i.e. +Y is the palmar side: BEST-GUESS SIGN CONVENTION, not yet verified against a real capture
  // (same caveat as `$lib/hand.ts`'s `signedJointAngle` doc comment) -- if this renders back-of-hand
  // instead of palm, flip `right`'s sign here, nothing else. Unrelated to `handedness` (Left/Right) --
  // this is the camera's own fixed viewing basis, never mirrored.
  const REST_VIEW_BASIS = { right: new Vector3(0, 0, 1), up: new Vector3(1, 0, 0) }

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
  let currentResidual: number | undefined

  $: noHandDetected = running && (lastFrameAt === undefined ? elapsed > 1 : elapsed - lastFrameAt > 1)

  // `skeleton` must be built with the REAL tracked hand's own handedness -- buildDefaultSkeleton's
  // joint-0 splay is chirality-dependent (see its own doc comment: confirmed live, 2026-09-06, a real
  // Right hand solved against the wrong fixed convention put the thumb on the pinky side). `handedness`
  // here is exactly the value used to select `hands[handedness]` in the capture loop below, so this
  // always matches whichever hand is actually being solved.
  $: skeleton = buildDefaultSkeleton(priorSnapshot, handedness)
  // Confidence doesn't change frame to frame (this page never updates the prior) beyond following
  // `skeleton`'s own handedness switch, so it's a reactive derivation rather than a per-frame one.
  $: confidenceSdDeg = poseConfidenceSdDeg(skeleton, priorSnapshot)
  // Same opacity mapping for every landmark: more confident (lower sdDeg) draws more solid, an
  // unmodeled joint (undefined) draws at a fixed dim opacity distinct from both ends, so it reads as
  // "no belief here" rather than "very confident" or "very uncertain." 60deg is this page's own
  // chosen reference scale, not a cited threshold -- live-tune like every other display constant in
  // this project's test pages if it doesn't read clearly against real capture.
  $: landmarkOpacity = confidenceSdDeg.map(opacityFromSdDeg)

  // The static "model rest" tile (replacing the old live Isometric view): a fixed, never-tracked
  // rendering of the prior model itself -- bone lengths and joint ROM, not any particular captured
  // frame -- for auditing those in isolation from live-tracking noise or orientation. `handedness` is
  // the one thing that can change these: mirrored to the opposite hand's shape (see
  // buildRestExtensionSkeleton/Pose's own doc comments -- a left hand really is a right hand's mirror
  // image), and only when the dropdown changes (never mid-track, never per-frame). Unlike every other
  // tile, this one needs `buildRestExtensionSkeleton`, not the shared `skeleton` -- see that function's
  // own doc comment for why `buildDefaultSkeleton` alone (identity per-joint splay) can't produce a
  // legible palm shape no matter which pose is fed to it (confirmed directly in ikSolve.test.ts).
  $: restSkeleton = buildRestExtensionSkeleton(priorSnapshot, handedness)
  $: restPose = buildRestExtensionPose(priorSnapshot, handedness)
  $: restVectors = poseToLandmarkVectors(restSkeleton, restPose)
  $: restHand = { vectors: restVectors }
  $: restAxes = palmBasisAxes(restVectors, handedness)

  // Fixed real-world height for the model-rest tile, so different loaded priors' actual hand SIZE is
  // visually comparable (a bigger fitted hand renders bigger, a smaller one smaller) instead of each
  // auto-normalizing to fill the same fraction of the tile regardless of its real length -- the auto-fit
  // scale every other (live) tile still uses. `poseToLandmarkVectors`/`SolvedHand.worldPositions()`'s
  // default `scale=100` means 1mm of real bone length becomes 100 vector units, so converting a desired
  // millimeter height into a pixels-per-unit scale needs that *100 factored in below. 180mm is a rough
  // "about as tall as a real adult hand, wrist to fingertip" pick, not a cited figure -- adjust directly
  // if a specific prior's hand runs off the tile or renders too small to read.
  const MODEL_REST_FIXED_HEIGHT_MM = 180
  const WORLD_POSITIONS_UNITS_PER_MM = 100

  function drawRestTile() {
    if (!tile0) return
    const scale = tile0.height / (MODEL_REST_FIXED_HEIGHT_MM * WORLD_POSITIONS_UNITS_PER_MM)
    // At `restPose` every finger reaches away from the wrist in only one screen direction (up, given
    // REST_VIEW_BASIS.up = local +X, the reach axis) -- same one-directional-extent issue the live
    // Top/Bottom tiles have, fixed the same way: pin the wrist near the bottom edge instead of dead
    // center, so the whole tile height is available to the fingers' one actual direction of travel.
    const origin = { x: tile0.width / 2, y: tile0.height - 10 }
    drawSkeletonView(tile0, restHand, undefined, REST_VIEW_BASIS, scale, {
      label: 'Model rest (fixed)',
      landmarkOpacity,
      origin,
    })
    drawAxisTriad(tile0, restHand, restAxes, REST_VIEW_BASIS, origin)
  }
  onMount(drawRestTile)
  // Redraws only on a handedness change (via restAxes), never on a live-tracking frame -- this tile is
  // defined to never move once drawn, per multi-view's static-reference requirement.
  $: if (tile0) {
    restAxes
    drawRestTile()
  }

  /** One entry per LIVE tile (tile0 is the fixed "model rest" reference, handled separately -- see
   * `restSkeleton`/`drawRestTile` above/below): FreeCAD's own name/shortcut number (undefined for
   * Dimetric, which FreeCAD itself doesn't assign a digit to), the viewing direction as coefficients
   * on the local {X, Y, Z=N} frame built in tileViewBases, and whether the normal degenerates to a
   * point in this view (Top and Bottom look straight down/up the Z=N axis itself). Grid position
   * mirrors an "unfolded cube net" around the center (real-camera) tile: Top above it, Bottom below,
   * Left/Right beside it, the four corners for the fixed rest tile/Front/Rear/Dimetric -- see the
   * template below for which tile index lands where in the 3x3 grid. Index `i` here maps to
   * `tileCanvases[i + 1]` (tile0 is not one of these 7).*/
  // `degenerate` marks the 2 views where the normal looks straight along its own axis (Top/Bottom) --
  // documentation only now that drawAxisTriad handles every axis' near-zero-length case generically
  // (a small dot instead of an arrow with an undefined direction), rather than drawSkeletonView's
  // normal-specific throughScreen glyph this page used before adding the other 2 axes.
  const VIEWS: { number?: number; name: string; xyz: [number, number, number]; degenerate?: boolean }[] =
    [
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
    currentResidual = undefined
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

        // average-hand.md Stage 6: what every tile renders (center included, as of this comparison
        // pass) is always this model-constrained solve against `priorSnapshot`, never the raw tracked
        // frame directly -- the whole point of this page is watching whether the model keeps a
        // corrupted or occluded frame from visibly distorting the displayed hand, which isn't visible
        // if the raw reading is what's drawn.
        const solved = solvePose(skeleton, priorSnapshot, hand)
        const correctedVectors = poseToLandmarkVectors(skeleton, solved.pose)
        const axes = palmBasisAxes(correctedVectors, hand.handedness)

        // Center tile: raw MediaPipe keypoints in blue, BEHIND the corrected/model-solved hand in
        // yellow/purple on top -- so the two can be visually compared directly (how far the model's
        // correction actually pulls the pose from what was tracked), not just inferred from the
        // residual number below. Raw keypoints are already in the same normalized image-space
        // `drawHandOverlay` expects, no projection needed (unlike the corrected layer, which has to go
        // through `projectCorrectedOntoKeypoints`'s orthographic approximation since it starts in 3D
        // model space). Raw layer clears the canvas (`clear` defaults true); the corrected layer is
        // drawn with `clear: false` so it layers on top instead of erasing the raw one first.
        drawHandOverlay(centerCanvas, hand.hand.keypoints, { color: '#38bdf8' })

        const correctedKeypoints = projectCorrectedOntoKeypoints(
          hand,
          correctedVectors,
          centerCanvas.width,
          centerCanvas.height
        )
        drawHandOverlay(centerCanvas, correctedKeypoints, { clear: false })
        drawAxisTriadOverlay(centerCanvas, correctedKeypoints, axes)

        if (elapsed - lastDisplayUpdate >= displayRefreshIntervalSeconds) {
          lastDisplayUpdate = elapsed
          currentScore = hand.score
          currentResidual = solved.residual
        }

        // Roughly pose-invariant reference length (wrist -> middle MCP, a rigid palm-level span) so
        // the rendered hand stays a stable size across frames instead of auto-fitting -- and so
        // jarringly resizing -- every tile every frame.
        const refLen = correctedVectors[0].distanceTo(correctedVectors[9]) || 1
        const tileSize = Math.min(tile1?.width || 0, tile1?.height || 0) || 200
        const scale = (tileSize * 0.4) / refLen

        // drawSkeletonView draws just the skeleton here (no normal arrow of its own -- `normal` is
        // omitted) since drawAxisTriad draws all 3 axes, including the normal, uniformly across every
        // tile right after it. `landmarkOpacity` is Stage 6's confidence-visibility requirement: a
        // joint sitting near its own converged, tight prior renders solid; one near a wide,
        // unconverged prior renders faint -- so a corrupted frame's pose staying bounded doesn't read
        // the same whether that was a confident correction or a coincidence.
        const correctedHand = { vectors: correctedVectors }
        const bases = tileViewBases(axes)
        bases.forEach((cam, i) => {
          // VIEWS[i] maps to tileCanvases[i + 1] -- tile0 is the fixed "model rest" reference, not one
          // of these 7 live views (see restSkeleton/drawRestTile above).
          const canvas = tileCanvases[i + 1]
          if (!canvas) return
          const view = VIEWS[i]
          const label = view.number !== undefined ? `${view.number} ${view.name}` : view.name
          // Top and Bottom look straight down/up the palm normal, so every finger projects toward one
          // side of a wrist-centered origin and the other half of the tile sits empty -- worse, a
          // reasonably-sized hand's fingers get clipped against the edge they extend toward. Pinning
          // the wrist ~10px above the bottom edge instead gives the whole tile height to the fingers'
          // one actual direction of travel in these two views only; every other view keeps the
          // wrist-centered default, where the hand extends in both directions from it.
          const origin = view.degenerate ? { x: canvas.width / 2, y: canvas.height - 10 } : undefined
          drawSkeletonView(canvas, correctedHand, undefined, cam, scale, {
            label,
            landmarkOpacity,
            origin,
          })
          drawAxisTriad(canvas, correctedHand, axes, cam, origin)
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

    <div class="mb-4">
      <PriorSourceChecklist bind:selectedSources />
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
      <p>
        Model correction residual: {currentResidual !== undefined ? currentResidual.toFixed(2) : '—'}
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
