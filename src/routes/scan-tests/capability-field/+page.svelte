<script lang="ts">
  /**
   * Stage 0 of docs/thumbs/representing-keyboard-build-inputs.md: an empty, lit, navigable 3D scene.
   * No hand, no prior, no sampled data yet -- this only confirms the Threlte stack renders in a new
   * route with real camera control before any capability-field content exists to debug alongside
   * plumbing issues.
   */
  import { T } from '@threlte/core'
  import { Grid } from '@threlte/extras'
  import { browser } from '$app/environment'
  import Viewer from '../../beta/lib/viewers/Viewer.svelte'
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
    </Viewer>
  {/if}
</div>
