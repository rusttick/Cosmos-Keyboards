<script lang="ts">
  /**
   * Stage 2: a chain of N keys (key 0 fixed at the origin; every key after it placed by its own
   * joint -- chain.ts's `chainPoses`), each independently draggable via the same solve-backward
   * flow as the 2-key version. Add or remove keys by changing `rightJoints`/`leftJoints`'s length;
   * nothing else needs to change -- chain.ts and the {#each} blocks below are already N-key-general.
   *
   * Two independent chains grow from the same fixed key 0: `rightJoints` toward +x, `leftJoints`
   * toward -x. fk.ts/chain.ts only ever model growth toward +x, so the left chain is computed with
   * the exact same (unmirrored) machinery as the right one and rendered inside a
   * `<T.Group position={[B,0,0]} scale={[-1,1,1]}>` wrapper, which mirrors it across x=B/2 --
   * key 0's OWN center, not x=0 -- for display.
   *
   * That mirror is a real Three.js reflection (negative-determinant transform), not a rotation --
   * mirroring a rotated rigid body is NOT expressible as any single rotation angle (confirmed
   * directly: for a rotation by theta, the mirror image would need cos(theta')=-cos(theta) AND
   * sin(theta')=+sin(theta) simultaneously for every local direction, which only one specific
   * theta' can satisfy for a single axis at a time, not both x and z basis directions at once --
   * an earlier version of this code tried a `-sign*angle` scalar trick per-pose and was wrong for
   * exactly this reason). Letting Three.js's own matrix composition do the reflection avoids
   * re-deriving that trig by hand, and keeps the drag handle's local position (read inside
   * `onDrag`) in the SAME unmirrored frame `chainPoses`/`chainHandlePoses` already produce, since
   * Three.js Object3D position is always local to the immediate parent -- so the left chain's
   * drag-solve logic is identical to the right chain's, just reading/writing `leftJoints` instead.
   *
   * The mirror axis matters: `chainPoses`'s root (poses[0]) is v1 (key 0's own TRAILING edge,
   * per fk.ts's convention -- the corner facing whatever comes before it), and every bone is
   * measured v1-to-v1. Mirroring about x=0 (that v1) reflects key 0's own [0,B] body span into
   * [-B,0], a purely virtual span nothing real occupies -- the first left key would end up a full
   * B+m away from key 0's actual left edge, not touching it (confirmed live: the first attempt at
   * this feature had exactly this bug). Key 0's body is bilaterally symmetric about its own center
   * (x=B/2), so mirroring THERE reflects key 0's real [0,B] span back onto itself, which is what
   * makes the first left key land flush against key 0's real edge with the intended m gap --
   * confirmed independently in a scratch script before touching this file, not just by inspection.
   *
   * All keys stay in one 2D plane (the FK's (x,z) bend plane, y=0 always) -- enforced both by
   * chain.ts's math (it only ever produces y=0 poses) and by TransformControls' showY={false}
   * (so dragging can't leave that plane in the first place).
   *
   * The drag HANDLE (the TransformControls gizmo, drawn as a small sphere) sits at each key's
   * keycap top center, not at the FK-tracked pivot (v1, a plate-level corner) -- grabbing right at
   * the pivot put the gizmo uncomfortably close to the neighboring key and to the pivot's own
   * rotation center. The pivot is still what chain.ts's curve is defined in terms of, so the
   * handle is a SEPARATE object (`chainHandlePoses`) rigidly offset from the key, positioned
   * independently rather than nested inside the key's own T.Group -- nesting it would only let it
   * slide relative to the key when dragged, not move the key itself. `solveTowardTarget`'s
   * `offset` param solves for the theta that puts THAT point, not the pivot, under the drag target
   * -- see fkSolve.ts's header for why the offset has to be threaded through the search itself
   * rather than just added/subtracted at the end.
   *
   * The key's own T.Group is never touched by TransformControls (only the handle is), so its
   * position/rotation stay purely reactive (bound to `poses`) -- no manual snap-back is needed for
   * it the way the original single-object version needed one; only the handle, which IS driven
   * imperatively by TransformControls during a drag, needs snapping back onto the solved pose.
   */
  import { T } from '@threlte/core'
  import { Grid, HTML, TransformControls } from '@threlte/extras'
  import { browser } from '$app/environment'
  import type { Object3D } from 'three'
  import Viewer from '../../beta/lib/viewers/Viewer.svelte'
  import KeyPrimitive from './KeyPrimitive.svelte'
  import { B, h1 } from './keyDims'
  import { boneSetFor } from './fk'
  import { solveTowardTarget } from './fkSolve'
  import { chainHandlePoses, chainPoses, worldToLocal, type JointState } from './chain'

  type Side = 'right' | 'left'

  // Keycap top center, in each key's own local frame (origin at v1, the plate-level pivot corner).
  const HANDLE_OFFSET = { x: B / 2, z: h1 }
  const HANDLE_RADIUS = 1.8

  // One entry per joint (key i+1 relative to key i). Add more entries for more keys -- the
  // {#each} blocks below and chain.ts handle any length.
  let rightJoints: JointState[] = [
    { direction: 'convex', theta: 0 },
    { direction: 'convex', theta: 0 },
  ]
  let leftJoints: JointState[] = [
    { direction: 'convex', theta: 0 },
    { direction: 'convex', theta: 0 },
    { direction: 'convex', theta: 0 },
  ]

  $: rightPoses = chainPoses(rightJoints)
  $: leftPoses = chainPoses(leftJoints)
  $: rightHandlePoses = chainHandlePoses(rightJoints, HANDLE_OFFSET)
  $: leftHandlePoses = chainHandlePoses(leftJoints, HANDLE_OFFSET)
  const toDeg = (rad: number) => (rad * 180) / Math.PI

  function onDrag(side: Side, jointIndex: number, handleRef: Object3D) {
    const joints = side === 'right' ? rightJoints : leftJoints
    const poses = side === 'right' ? rightPoses : leftPoses
    const parent = poses[jointIndex] // poses[0] = key 0 (fixed); joints[i] is relative to poses[i]
    const localTarget = worldToLocal(parent, { x: handleRef.position.x, z: handleRef.position.z })
    const solved = solveTowardTarget(localTarget, HANDLE_OFFSET)
    joints[jointIndex] = { direction: solved.direction, theta: solved.theta }
    if (side === 'right') rightJoints = rightJoints // trigger the $: poses/handlePoses recompute
    else leftJoints = leftJoints
    // Snap the handle back onto its FK-valid pose immediately, so it never rests at the raw
    // (unconstrained) drag position, even for a single frame. The key itself picks up the change
    // reactively via `poses` -- see header note on why it needs no manual snap of its own.
    const newHandlePose = (side === 'right' ? rightHandlePoses : leftHandlePoses)[jointIndex]
    handleRef.position.set(newHandlePose.x, 0, newHandlePose.z)
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

      <!-- key 0: fixed at the origin, shared by both chains -->
      <KeyPrimitive />

      <!-- right chain: grows toward +x, unmirrored -- fk.ts/chain.ts's native convention. -->
      {#each rightPoses as pose, i (i)}
        {#if i > 0}
          <T.Group position={[pose.x, 0, pose.z]} rotation={[0, -pose.angle, 0]}>
            <KeyPrimitive />
          </T.Group>
          <T.Group
            position={[rightHandlePoses[i - 1].x, 0, rightHandlePoses[i - 1].z]}
            let:ref={handleRef}
          >
            <T.Mesh>
              <T.SphereGeometry args={[HANDLE_RADIUS, 16, 12]} />
              <T.MeshStandardMaterial color="#2563eb" />
            </T.Mesh>
            <TransformControls
              object={handleRef}
              mode="translate"
              showY={false}
              size={0.7}
              on:objectChange={() => onDrag('right', i - 1, handleRef)}
            />
          </T.Group>

          <HTML position={[pose.x, 0, h1 + 10]} pointerEvents="none" center>
            <span
              class="text-xs font-mono text-amber-700 dark:text-amber-400 select-none whitespace-pre bg-white/70 dark:bg-black/50 px-1 rounded"
            >
              joint R{i - 1}: {rightJoints[i - 1].direction} theta={toDeg(
                rightJoints[i - 1].theta
              ).toFixed(1)} deg (max
              {toDeg(
                boneSetFor(rightJoints[i - 1].direction).phi1Max +
                  boneSetFor(rightJoints[i - 1].direction).phi2Max
              ).toFixed(1)})
            </span>
          </HTML>
        {/if}
      {/each}

      <!-- left chain: grows toward -x -- same unmirrored math as the right chain (positions,
           rotations computed exactly the same way), reflected across x=B/2 (key 0's own center,
           not x=0 -- see header note) for display by wrapping in a shifted negative-x-scale group.
           This can't be done with a scalar angle trick the way position/rotation are otherwise
           handled in this file; see header note. -->
      <T.Group position={[B, 0, 0]} scale={[-1, 1, 1]}>
        {#each leftPoses as pose, i (i)}
          {#if i > 0}
            <T.Group position={[pose.x, 0, pose.z]} rotation={[0, -pose.angle, 0]}>
              <KeyPrimitive />
            </T.Group>
            <T.Group
              position={[leftHandlePoses[i - 1].x, 0, leftHandlePoses[i - 1].z]}
              let:ref={handleRef}
            >
              <T.Mesh>
                <T.SphereGeometry args={[HANDLE_RADIUS, 16, 12]} />
                <T.MeshStandardMaterial color="#2563eb" />
              </T.Mesh>
              <TransformControls
                object={handleRef}
                mode="translate"
                showY={false}
                size={0.7}
                on:objectChange={() => onDrag('left', i - 1, handleRef)}
              />
            </T.Group>

            <HTML position={[pose.x, 0, h1 + 10]} pointerEvents="none" center>
              <span
                class="text-xs font-mono text-amber-700 dark:text-amber-400 select-none whitespace-pre bg-white/70 dark:bg-black/50 px-1 rounded"
              >
                joint L{i - 1}: {leftJoints[i - 1].direction} theta={toDeg(
                  leftJoints[i - 1].theta
                ).toFixed(1)} deg (max
                {toDeg(
                  boneSetFor(leftJoints[i - 1].direction).phi1Max +
                    boneSetFor(leftJoints[i - 1].direction).phi2Max
                ).toFixed(1)})
              </span>
            </HTML>
          {/if}
        {/each}
      </T.Group>
    </Viewer>
  {/if}
</div>
