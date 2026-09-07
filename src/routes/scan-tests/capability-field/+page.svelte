<script lang="ts">
  /**
   * Stages 0-7 of docs/thumbs/representing-keyboard-build-inputs.md.
   *
   * Stage 0: an empty, lit, navigable 3D scene -- confirms the Threlte stack renders in a new route
   * with real camera control before any capability-field content exists.
   *
   * Stage 1 (superseded by Stage 2/3's clouds below, kept only as the scale-convention note): one
   * primitive, at the right scale (mm, matching `$lib/hand.ts`'s conventions -- see `sampleMcpSweep.ts`
   * for a real unit-scale pitfall this stage was meant to head off, and which Stage 3 still hit: the
   * live-tracking fit path's `worldPositions(finger, scale=100)` default assumes `joint.length` is a
   * plain ratio, but `buildDefaultSkeleton`'s population-prior skeleton bakes lengths as already-
   * absolute mm, so it needs `scale=1` instead -- confirmed live, not caught by this stage alone).
   *
   * Stage 2 (superseded by Stage 3's real samples below): a synthetic point cloud settled
   * `CapabilityCloud.svelte`'s visual API (marker size/density, colormap) before any real data existed.
   *
   * Stage 3 (superseded by Stage 4's fuller sweep below): the first real capability samples --
   * `sampleMcpSweep` (grid-samples one finger's MCP across its own fitted ROM, `fkBy`, world positions)
   * on the smallest slice (index finger, MCP only, every other joint held straight). This traces a 2D
   * shell, not a volume -- 2 free angles generically sweep a surface, confirmed live.
   *
   * Stage 4 (superseded by Stage 5's four-finger version below): the full index-finger chain --
   * `sampleFingerSweep` adds PIP flexion as a third free angle (DIP derived from PIP via the fitted
   * `dipPipCoupling` posterior, not independently sampled, per `goals.md`). 3 free angles fill a
   * genuine 3D volume instead of tracing a shell.
   *
   * Stage 5 (extended, not superseded, by Stage 6's thumb below): the same sweep, generalized across
   * all four non-thumb fingers, each in its own fixed identity color via `CapabilityCloud`'s `color`
   * prop -- reusing the exact finger/color convention `src/routes/scan/lib/PoseCanvas.svelte` already
   * established, rather than inventing a new one.
   *
   * Stage 6: the thumb's saddle joint (CMC), isolated in its own sampler
   * (`sampleThumbCmcSweep.ts`) since its `degree: 3`/conjunct-rotation structure is genuinely
   * different, and this project's own test history found more ways to get this joint wrong than any
   * other. Deliberately a 2-DOF shell, not a filled volume -- `HandPriorState` has no prior yet for the
   * thumb's other two joints (a real, already-identified schema gap; see the sampler's own doc
   * comment), so they're held straight rather than swept with invented numbers. Landmark-0 still reuses
   * `PLACEHOLDER_LANDMARK0_POSITION`. Coloring stays identity-only -- real
   * posture/manipulability/uncertainty costs don't start until Stage 8.
   *
   * Stage 7: full-hand context -- a plain skeleton (`RestSkeleton.svelte`: joints as spheres, bones as
   * lines), built from the exact same `skeleton`/`PLACEHOLDER_LANDMARK0_POSITION` the clouds above
   * already use (see `restSkeletonLandmarks.ts`'s doc comment for why `ikSolve.ts`'s own
   * `buildRestExtensionSkeleton`/`poseToLandmarkVectors` -- tuned for a different page's mirrored-video
   * overlay -- would visibly misalign with these clouds instead). Posed via `neutralPoseAngleRad`
   * (`neutralPose.ts`): each joint's own fitted `meanDeg` from the fused prior -- a real "typical
   * posture" value already in `HandPriorState`, not an assumed straight/fully-extended pose. Joints
   * with no modeled prior (the thumb's un-modeled MCP/IP hinges) fall back to straight. Deliberately not
   * the rigged GLB hand mesh, so no specific hand shape is implied.
   *
   * Stage 8: real per-sample costs -- posture, manipulability, positional variance (`postureCost.ts`/
   * `manipulability.ts`/`positionalUncertainty.ts`, computed inline by `sampleFingerSweep`/
   * `sampleThumbCmcSweep`) -- as selectable channels, per `key-point-selection.md`'s Step 2. Two
   * independent selectors: "color by" (identity, or one cost through the colormap) and "brightness by"
   * (none, or a second cost dimming `CapabilityCloud`'s color -- see that component's own doc comment
   * for why brightness, not transparency, was the practical second channel to add). Both can be set
   * independently, so e.g. posture cost can drive hue while positional uncertainty simultaneously
   * drives brightness on the same cloud.
   */
  import { T } from '@threlte/core'
  import { Grid, HTML } from '@threlte/extras'
  import { browser } from '$app/environment'
  import Viewer from '../../beta/lib/viewers/Viewer.svelte'
  import CapabilityCloud from './CapabilityCloud.svelte'
  import RestSkeleton from './RestSkeleton.svelte'
  import { buildDefaultSkeleton } from '../../scan3/lib/priors/ikSolve'
  import { fuseHandPriorState } from '../../scan3/lib/priors/fuseSources'
  import { ALL_PRIOR_SOURCES } from '../../scan3/lib/priors/registry'
  import { sampleFingerSweep, type FingerSweepSample } from '../../scan3/lib/keypoints/sampleFingerSweep'
  import {
    sampleThumbCmcSweep,
    type ThumbCmcSweepSample,
  } from '../../scan3/lib/keypoints/sampleThumbCmcSweep'
  import { restSkeletonLandmarks } from '../../scan3/lib/keypoints/restSkeletonLandmarks'
  import { neutralPoseAngleRad } from '../../scan3/lib/keypoints/neutralPose'
  import { PLACEHOLDER_LANDMARK0_POSITION } from '../../scan3/lib/keypoints/sampleMcpSweep'
  import type { NonThumbFinger } from '../../scan3/lib/priors/handModel'

  const HANDEDNESS = 'Right'

  // Same finger/color convention as `src/routes/scan/lib/PoseCanvas.svelte`'s `COLORS`.
  const NON_THUMB_FINGER_COLORS: Record<NonThumbFinger, string> = {
    indexFinger: '#ffa500',
    middleFinger: '#00ff00',
    ringFinger: '#0000ff',
    pinky: '#8b00ff',
  }
  const NON_THUMB_FINGERS = Object.keys(NON_THUMB_FINGER_COLORS) as NonThumbFinger[]
  const THUMB_COLOR = '#ff0000'

  const fusedPrior = fuseHandPriorState(ALL_PRIOR_SOURCES, HANDEDNESS)
  const skeleton = buildDefaultSkeleton(fusedPrior, HANDEDNESS)
  const fingerSamples = NON_THUMB_FINGERS.map((finger) => ({
    finger,
    color: NON_THUMB_FINGER_COLORS[finger],
    samples: sampleFingerSweep(skeleton, finger, fusedPrior, 8),
  }))
  const thumbSamples = sampleThumbCmcSweep(skeleton, fusedPrior, 24)
  const restLandmarks = restSkeletonLandmarks(
    skeleton,
    PLACEHOLDER_LANDMARK0_POSITION,
    (finger, jointIndex) => neutralPoseAngleRad(fusedPrior, finger, jointIndex)
  )

  type CostMode = 'identity' | 'posture' | 'manipulability' | 'uncertainty'
  type BrightnessMode = 'none' | 'posture' | 'manipulability' | 'uncertainty'
  let colorMode: CostMode = 'identity'
  let brightnessMode: BrightnessMode = 'none'

  function costValues(
    mode: CostMode | BrightnessMode,
    samples: (FingerSweepSample | ThumbCmcSweepSample)[]
  ): number[] {
    if (mode === 'posture') return samples.map((s) => s.postureCost)
    if (mode === 'manipulability') return samples.map((s) => s.manipulability)
    if (mode === 'uncertainty') return samples.map((s) => s.positionalVariance)
    return []
  }

  $: fingerClouds = fingerSamples.map((f) => ({
    finger: f.finger,
    points: f.samples.map((s) => s.position),
    color: colorMode === 'identity' ? f.color : undefined,
    scalar: colorMode === 'identity' ? [] : costValues(colorMode, f.samples),
    brightness: brightnessMode === 'none' ? [] : costValues(brightnessMode, f.samples),
  }))
  $: thumbCloudPoints = thumbSamples.map((s) => s.position)
  $: thumbColor = colorMode === 'identity' ? THUMB_COLOR : undefined
  $: thumbScalar = colorMode === 'identity' ? [] : costValues(colorMode, thumbSamples)
  $: thumbBrightness = brightnessMode === 'none' ? [] : costValues(brightnessMode, thumbSamples)

  /** Scale-reference labels on the grid plane, at 1cm and 10cm along the x axis (matching
   * `T.AxesHelper`'s red x-arm) -- so a screenshot alone conveys the grid's real-world scale, not just
   * "small cells, big cells." Rendered as plain (non-interactive) DOM text via `@threlte/extras`'s
   * `HTML` component rather than a WebGL text mesh (`Text`/troika-three-text) -- `Text` also wires
   * itself into Threlte's raycasting/pointer-event system and starts an async font-load, which was
   * found live to make `OrbitControls`' drag-to-rotate stop responding; a plain, `pointerEvents="none"`
   * DOM overlay carries none of that. */
  const SCALE_MARKS: { label: string; x: number }[] = [
    { label: '1cm', x: 10 },
    { label: '10cm', x: 100 },
  ]
</script>

<div class="fixed inset-0 bg-gray-100 dark:bg-gray-900">
  {#if browser}
    <Viewer enableRotate enableZoom enablePan cameraPosition={[150, -150, 150]}>
      <T.AmbientLight intensity={0.6} />
      <T.DirectionalLight position={[100, -100, 200]} intensity={0.8} />
      <T.DirectionalLight position={[-100, 100, -50]} intensity={0.2} />

      <!-- z-up, per Viewer.svelte's camera `up={[0, 0, 1]}` convention -- the grid lies in the xy plane. -->
      <Grid
        plane="xy"
        cellSize={10}
        cellThickness={0.5}
        sectionSize={100}
        sectionThickness={1}
        gridSize={[400, 400]}
        fadeDistance={600}
      />
      <T.AxesHelper args={[50]} />

      {#each SCALE_MARKS as mark (mark.label)}
        <HTML position={[mark.x, -4, 0.2]} pointerEvents="none" center>
          <span class="text-xs font-mono text-amber-700 dark:text-amber-400 select-none">
            {mark.label}
          </span>
        </HTML>
      {/each}

      {#each fingerClouds as cloud (cloud.finger)}
        <CapabilityCloud
          points={cloud.points}
          color={cloud.color}
          scalar={cloud.scalar}
          brightness={cloud.brightness}
          markerRadiusMM={2.5}
        />
      {/each}
      <CapabilityCloud
        points={thumbCloudPoints}
        color={thumbColor}
        scalar={thumbScalar}
        brightness={thumbBrightness}
        markerRadiusMM={2.5}
      />

      <RestSkeleton landmarks={restLandmarks} />
    </Viewer>

    <div
      class="absolute top-4 left-4 flex flex-col gap-2 rounded bg-white/90 dark:bg-gray-800/90 p-3 text-sm text-gray-800 dark:text-gray-100 shadow"
    >
      <label class="flex items-center gap-2">
        Color by
        <select bind:value={colorMode} class="rounded border px-1 py-0.5 dark:bg-gray-700">
          <option value="identity">finger identity</option>
          <option value="posture">posture cost</option>
          <option value="manipulability">manipulability</option>
          <option value="uncertainty">positional uncertainty</option>
        </select>
      </label>
      <label class="flex items-center gap-2">
        Brightness by
        <select bind:value={brightnessMode} class="rounded border px-1 py-0.5 dark:bg-gray-700">
          <option value="none">none</option>
          <option value="posture">posture cost</option>
          <option value="manipulability">manipulability</option>
          <option value="uncertainty">positional uncertainty</option>
        </select>
      </label>
    </div>
  {/if}
</div>
