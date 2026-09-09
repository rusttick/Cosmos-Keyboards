<script lang="ts">
  /**
   * Stage 2: a chain of N keys (key 0 fixed at the origin; every key after it placed by its own
   * joint -- chain.ts's `chainPoses`), each independently draggable via the same solve-backward
   * flow as the 2-key version. Add or remove keys by changing `initialJoints`' length; nothing
   * else needs to change -- chain.ts and the {#each} below are already N-key-general.
   *
   * All keys stay in one 2D plane (the FK's (x,z) bend plane, y=0 always) -- enforced both by
   * chain.ts's math (it only ever produces y=0 poses) and by TransformControls' showY={false}
   * (so dragging can't leave that plane in the first place).
   */
  import { T } from '@threlte/core'
  import { Grid, HTML, TransformControls } from '@threlte/extras'
  import { browser } from '$app/environment'
  import type { Object3D } from 'three'
  import Viewer from '../../beta/lib/viewers/Viewer.svelte'
  import KeyPrimitive from './KeyPrimitive.svelte'
  import { h1 } from './keyDims'
  import { boneSetFor } from './fk'
  import { solveTowardTarget } from './fkSolve'
  import { chainPoses, worldToLocal, type JointState } from './chain'

  // One entry per joint (key i+1 relative to key i). Add more entries for more keys -- the
  // {#each} below and chain.ts handle any length.
  let joints: JointState[] = [
    { direction: 'convex', theta: 0 },
    { direction: 'convex', theta: 0 },
  ]

  $: poses = chainPoses(joints)
  const toDeg = (rad: number) => (rad * 180) / Math.PI

  function onDrag(jointIndex: number, ref: Object3D) {
    const parent = poses[jointIndex] // poses[0] = key 0 (fixed); joints[i] is relative to poses[i]
    const localTarget = worldToLocal(parent, { x: ref.position.x, z: ref.position.z })
    const solved = solveTowardTarget(localTarget)
    joints[jointIndex] = { direction: solved.direction, theta: solved.theta }
    joints = joints // trigger the $: poses recompute
    // Snap the dragged object back onto the FK-valid pose immediately, so it never rests at the
    // raw (unconstrained) drag position, even for a single frame. Downstream keys (if any) pick
    // up the change reactively via `poses`.
    const newPose = poses[jointIndex + 1]
    ref.position.set(newPose.x, 0, newPose.z)
    ref.rotation.set(0, -newPose.angle, 0)
  }
</script>

<div class="fixed inset-0 bg-gray-100 dark:bg-gray-900">
  {#if browser}
    <Viewer enableRotate enableZoom enablePan cameraPosition={[70, -110, 70]}>
      <T.AmbientLight intensity={0.6} />
      <T.DirectionalLight position={[100, -100, 200]} intensity={0.8} />
      <T.DirectionalLight position={[-100, 100, -50]} intensity={0.2} />

      <!-- z-up, per Viewer.svelte's camera `up={[0, 0, 1]}` convention -- the grid lies in the xy
           plane and is the mounting plate (z=0), matching the doc's convention. -->
      <Grid
        plane="xy"
        cellSize={5}
        cellThickness={0.5}
        sectionSize={20}
        sectionThickness={1}
        gridSize={[200, 200]}
        fadeDistance={300}
      />
      <T.AxesHelper args={[20]} />

      {#each poses as pose, i (i)}
        {#if i === 0}
          <!-- key 0: fixed at the origin -->
          <KeyPrimitive />
        {:else}
          <T.Group position={[pose.x, 0, pose.z]} rotation={[0, -pose.angle, 0]} let:ref>
            <KeyPrimitive />
            <TransformControls
              object={ref}
              mode="translate"
              showY={false}
              size={0.7}
              on:objectChange={() => onDrag(i - 1, ref)}
            />
          </T.Group>

          <HTML position={[pose.x, 0, h1 + 10]} pointerEvents="none" center>
            <span
              class="text-xs font-mono text-amber-700 dark:text-amber-400 select-none whitespace-pre bg-white/70 dark:bg-black/50 px-1 rounded"
            >
              joint {i - 1}: {joints[i - 1].direction} theta={toDeg(joints[i - 1].theta).toFixed(1)} deg (max
              {toDeg(
                boneSetFor(joints[i - 1].direction).phi1Max + boneSetFor(joints[i - 1].direction).phi2Max
              ).toFixed(1)})
            </span>
          </HTML>
        {/if}
      {/each}
    </Viewer>
  {/if}
</div>
