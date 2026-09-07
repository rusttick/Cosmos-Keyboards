<script lang="ts">
  /**
   * Stage 7 of docs/thumbs/representing-keyboard-build-inputs.md: renders a plain skeleton (joints as
   * small spheres, bones as lines) for full-hand context alongside the capability clouds -- deliberately
   * NOT `$lib/3d/HandModel.svelte`'s rigged GLB mesh, since a specific fleshed-out hand shape is itself
   * a visual assumption about hand shape this project is trying to stay independent of; a skeleton makes
   * clear that only the measured/prior joint geometry is being shown.
   */
  import { T } from '@threlte/core'
  import { MeshLineGeometry, MeshLineMaterial } from '@threlte/extras'
  import { Vector3, type Vector3Tuple } from 'three'
  import { restSkeletonBoneChains } from '../../scan3/lib/keypoints/restSkeletonLandmarks'

  export let landmarks: Vector3Tuple[]
  export let color = '#94a3b8' // neutral slate gray -- context, not a cost or finger-identity signal
  export let jointRadiusMM = 3

  /** Per-finger chains from `restSkeletonBoneChains` all start at the wrist (landmark 0), which for
   * index/middle/ring draws three radiating wrist-to-knuckle lines that visually clutter the palm --
   * dropped for those three (rendered from their own MCP outward instead) and replaced by one explicit
   * knuckle-row line (thumb-MCP -> index-MCP -> middle-MCP -> ring-MCP -> pinky-MCP), which reads as the
   * palm's front edge. Thumb and pinky keep their full wrist-anchored chains, so together with the
   * knuckle row the wrist/thumb-CMC/knuckle-row/pinky segments trace a closed palm outline. */
  $: fullChains = restSkeletonBoneChains(landmarks)
  $: lines = [
    { name: 'thumb', points: fullChains.thumb },
    { name: 'indexFinger', points: fullChains.indexFinger.slice(1) },
    { name: 'middleFinger', points: fullChains.middleFinger.slice(1) },
    { name: 'ringFinger', points: fullChains.ringFinger.slice(1) },
    { name: 'pinky', points: fullChains.pinky },
    {
      name: 'knuckleRow',
      points: [landmarks[2], landmarks[5], landmarks[9], landmarks[13], landmarks[17]],
    },
  ]
</script>

{#each landmarks as p, i (i)}
  <T.Mesh position={p}>
    <T.SphereGeometry args={[jointRadiusMM, 8, 8]} />
    <T.MeshStandardMaterial {color} />
  </T.Mesh>
{/each}

{#each lines as line (line.name)}
  <T.Mesh>
    <MeshLineGeometry points={line.points.map((p) => new Vector3(...p))} />
    <MeshLineMaterial worldUnits={true} {color} linewidth={1.5} />
  </T.Mesh>
{/each}
