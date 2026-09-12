<script lang="ts">
  /**
   * 3D packing tests, per `docs/thumbs/capability-packing.md`: real two-piece key models
   * (`keyPolytope.ts`, shared with `sat3d.ts`'s collision test -- no separate hand-authored mesh to
   * drift from the collision shape) packed onto a curved `Surface` (`surface.ts`) instead of squares on
   * a plane. Two surfaces so far -- a spherical shell (`sphereSurface.ts`) and a plane bent into a sine
   * wave (`sineSurface.ts`) -- selectable below; "assume more coming" per the user's own framing, which
   * is why the packing logic (`surfacePacking.ts`) is written against the generic `Surface` interface,
   * not sphere-specific math.
   *
   * A key's orientation is always a pure function of its position (`Surface.normalAt`, never touched
   * by overlap correction) -- so a key can never end up "reversed or sideways" the way a free 6-DOF
   * pose could. The sphere has no cost field (a bounded shell already gives a well-posed "spread until
   * no overlap" result on its own); the sine surface does (`downhillAt`, walking each key toward the
   * nearest trough) -- the first real implementation of the doc's "sine-wave field" test stage.
   */
  import { T } from '@threlte/core'
  import { Grid } from '@threlte/extras'
  import { browser } from '$app/environment'
  import * as THREE from 'three'
  import Viewer from '../../beta/lib/viewers/Viewer.svelte'
  import { m as DEFAULT_GAP } from '../key-arrangement/keyDims'
  import {
    clearanceCorridorPiece,
    keycapPiece,
    pieceToGeometry,
    wireBoxPiece,
  } from '../../scan3/lib/packing/keyPolytope'
  import { keyOverlap3D, type Pose3D } from '../../scan3/lib/packing/sat3d'
  import { makeSphereSurface } from '../../scan3/lib/packing/sphereSurface'
  import { makeSineSurface } from '../../scan3/lib/packing/sineSurface'
  import { makeSine2DSurface } from '../../scan3/lib/packing/sine2dSurface'
  import type { Surface } from '../../scan3/lib/packing/surface'
  import {
    surfaceClusterInit,
    surfaceRandomInit,
    surfaceRelaxStep,
  } from '../../scan3/lib/packing/surfacePacking'

  type Shape = 'sphere' | 'sine' | 'sine2d'

  const KEY_COUNT = 20
  // Tangent-plane offset in mm for both surfaces (`surfaceClusterInit` adds this straight to a 3D
  // point before projecting onto the surface -- never radians, for the sphere or otherwise), well
  // under the keys' own footprint so the seed cluster deliberately overlaps, same rationale as
  // `clusterInit.ts`'s 2D one.
  const SPHERE_SEED_SPACING = 6
  const SINE_DOMAIN_DEPTH = 200 // mm, along y (the sheet's flat axis) -- the wireframe's own extent
  const sineDomainWidth = (wl: number) => Math.max(240, wl * 4) // mm, along x -- the wireframe's own extent
  // The random seed scatter deliberately covers much less than the wireframe's full extent -- one
  // trough's neighborhood, not several -- so packing stays local instead of spreading keys across
  // multiple peaks before relaxation even starts.
  const SINE_SEED_DOMAIN_DEPTH = 50
  const sineSeedDomainWidth = (wl: number) => wl * 1.2

  const keycapGeometry = pieceToGeometry(keycapPiece)
  const wireBoxGeometry = pieceToGeometry(wireBoxPiece)
  const corridorGeometry = pieceToGeometry(clearanceCorridorPiece)

  let showCorridors = true

  let shape: Shape = 'sphere'

  // Sphere params.
  let centerX = 0
  let centerY = 0
  let centerZ = 70
  let radius = 55

  // Sine params (shared amplitude between the 1-axis and 2-axis surfaces).
  let amplitude = 20
  let wavelength = 60 // 1-axis: bends along x, flat along y
  let seedX = wavelength / 4 // off-trough on purpose, so "Step" visibly walks it downhill
  let wavelength2d = 100 // 2-axis: bends along both x and y ("egg carton")

  let minGap = DEFAULT_GAP

  let poses: Pose3D[] = []
  let iteration = 0

  function seedPoint(): THREE.Vector3 {
    if (shape === 'sphere') return new THREE.Vector3(centerX, centerY, centerZ - radius) // underside of the sphere
    if (shape === 'sine2d') {
      const x = wavelength2d / 4
      const y = wavelength2d / 4
      const k = (2 * Math.PI) / wavelength2d
      return new THREE.Vector3(x, y, amplitude * Math.sin(k * x) * Math.sin(k * y))
    }
    return new THREE.Vector3(seedX, 0, amplitude * Math.sin((2 * Math.PI * seedX) / wavelength))
  }

  function currentSurface(): Surface {
    // The sphere's `downhillAt` gently spreads keys tangentially away from the seed point, across
    // the shell -- without it (as originally built), correction alone fully resolves overlap in one
    // click and nothing happens on any click after that; every other surface gives relaxation
    // ongoing, visible work across many clicks, and the sphere should too.
    if (shape === 'sphere') {
      return makeSphereSurface(
        { center: new THREE.Vector3(centerX, centerY, centerZ), radius },
        seedPoint()
      )
    }
    if (shape === 'sine2d') return makeSine2DSurface({ amplitude, wavelength: wavelength2d })
    return makeSineSurface({ amplitude, wavelength })
  }

  function initialize() {
    // Both sine surfaces start from a random scatter rather than a single tight cluster -- with
    // multiple troughs across the domain, a single local seed only ever explores the one nearest it
    // (see `surfaceRandomInit`'s doc comment) -- but confined to one trough's own neighborhood
    // (`sineSeedDomainWidth`/`SINE_SEED_DOMAIN_DEPTH`), much smaller than the wireframe's full
    // extent, so packing stays local instead of scattering keys across several peaks before
    // relaxation even starts. The 2-axis surface uses the same-size box in both x and y, since it's
    // periodic in both directions now, not just x.
    if (shape === 'sine') {
      poses = surfaceRandomInit(KEY_COUNT, currentSurface(), seedPoint(), {
        width: sineSeedDomainWidth(wavelength),
        height: SINE_SEED_DOMAIN_DEPTH,
      })
    } else if (shape === 'sine2d') {
      poses = surfaceRandomInit(KEY_COUNT, currentSurface(), seedPoint(), {
        width: sineSeedDomainWidth(wavelength2d),
        height: sineSeedDomainWidth(wavelength2d),
      })
    } else {
      poses = surfaceClusterInit(KEY_COUNT, currentSurface(), seedPoint(), SPHERE_SEED_SPACING)
    }
    iteration = 0
  }

  function step() {
    const stepSize = shape === 'sphere' ? 2 : 4
    poses = surfaceRelaxStep(poses, currentSurface(), { minGap, stepSize })
    iteration += 1
  }

  initialize()

  $: overlappingPairs = (() => {
    let count = 0
    for (let i = 0; i < poses.length; i++) {
      for (let j = i + 1; j < poses.length; j++) {
        if (keyOverlap3D(poses[i], poses[j], minGap)) count++
      }
    }
    return count
  })()

  // Wireframe visualization of the sine surface -- a plane subdivided finely along x (where it
  // actually curves) and coarsely along y (where it doesn't), with each vertex's z set from the same
  // `heightAt` the surface itself uses.
  function buildSineWireframe(amp: number, wl: number): THREE.BufferGeometry {
    const width = sineDomainWidth(wl)
    const depth = SINE_DOMAIN_DEPTH
    const xSegments = 80
    const ySegments = 2
    const geometry = new THREE.PlaneGeometry(width, depth, xSegments, ySegments)
    const pos = geometry.attributes.position
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      pos.setZ(i, amp * Math.sin((2 * Math.PI * x) / wl))
    }
    pos.needsUpdate = true
    geometry.computeVertexNormals()
    return geometry
  }

  // Wireframe visualization of the 2-axis sine surface -- a plane subdivided finely along both x and
  // y (it curves in both directions now), with each vertex's z set the same way `sine2dSurface.ts`
  // computes it.
  function buildSine2DWireframe(amp: number, wl: number): THREE.BufferGeometry {
    const size = sineDomainWidth(wl)
    const segments = 60
    const geometry = new THREE.PlaneGeometry(size, size, segments, segments)
    const pos = geometry.attributes.position
    const k = (2 * Math.PI) / wl
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const y = pos.getY(i)
      pos.setZ(i, amp * Math.sin(k * x) * Math.sin(k * y))
    }
    pos.needsUpdate = true
    geometry.computeVertexNormals()
    return geometry
  }

  $: sineWireframeGeometry =
    shape === 'sine'
      ? buildSineWireframe(amplitude, wavelength)
      : shape === 'sine2d'
      ? buildSine2DWireframe(amplitude, wavelength2d)
      : null
</script>

<div class="fixed inset-0 bg-gray-100 dark:bg-gray-900">
  {#if browser}
    <Viewer enableRotate enableZoom enablePan cameraPosition={[150, -180, 120]}>
      <T.AmbientLight intensity={0.6} />
      <T.DirectionalLight position={[100, -100, 200]} intensity={0.8} />
      <T.DirectionalLight position={[-100, 100, -50]} intensity={0.2} />

      <!-- z-up, plate at z=0 -- same Grid/AxesHelper convention as the other scan-tests pages. -->
      <Grid
        plane="xy"
        cellSize={10}
        cellThickness={0.5}
        sectionSize={50}
        sectionThickness={1}
        gridSize={[300, 300]}
        fadeDistance={600}
      />
      <T.AxesHelper args={[30]} />

      {#if shape === 'sphere'}
        <!-- The gradient sphere itself: center + radius, both inputs (sliders below). -->
        <T.Mesh position={[centerX, centerY, centerZ]}>
          <T.SphereGeometry args={[radius, 32, 20]} />
          <T.MeshBasicMaterial color="#16a34a" wireframe transparent opacity={0.3} />
        </T.Mesh>
        <T.Mesh position={[centerX, centerY, centerZ]}>
          <T.SphereGeometry args={[3, 16, 12]} />
          <T.MeshStandardMaterial color="#16a34a" />
        </T.Mesh>
      {:else if sineWireframeGeometry}
        <T.Mesh geometry={sineWireframeGeometry}>
          <T.MeshBasicMaterial color="#16a34a" wireframe transparent opacity={0.3} />
        </T.Mesh>
      {/if}

      {#each poses as pose, i (i)}
        <!-- Threlte's `quaternion` prop calls `target.quaternion.set(value)` when `value` isn't an
             array -- THREE.Quaternion.set() expects (x, y, z, w) scalars, not a Quaternion instance,
             so a bare `pose.quaternion` here silently corrupts the mesh transform (nothing renders).
             `toArray()` makes it take the array branch, which spreads correctly (same reason
             src/lib/3d/Keyboard.svelte passes a `Vector4Tuple`, not a live Quaternion, to this prop). -->
        <T.Mesh
          position={[pose.position.x, pose.position.y, pose.position.z]}
          quaternion={pose.quaternion.toArray()}
          geometry={keycapGeometry}
        >
          <T.MeshStandardMaterial color="#d8d2c2" side={THREE.DoubleSide} flatShading />
        </T.Mesh>
        <T.Mesh
          position={[pose.position.x, pose.position.y, pose.position.z]}
          quaternion={pose.quaternion.toArray()}
          geometry={wireBoxGeometry}
        >
          <T.MeshStandardMaterial
            color="#9a9484"
            side={THREE.DoubleSide}
            flatShading
            transparent
            opacity={0.85}
          />
        </T.Mesh>
        {#if showCorridors}
          <!-- The press corridor above the keycap -- deliberately shown even where it overlaps a
               neighbor's own corridor (that's expected), so it's visually obvious that only
               corridor-vs-body (a corridor poking into another key's actual material) is the real
               conflict `keyOverlap3D` now checks for. -->
          <T.Mesh
            position={[pose.position.x, pose.position.y, pose.position.z]}
            quaternion={pose.quaternion.toArray()}
            geometry={corridorGeometry}
          >
            <T.MeshBasicMaterial color="#3b82f6" wireframe transparent opacity={0.25} />
          </T.Mesh>
        {/if}
      {/each}
    </Viewer>

    <div
      class="absolute top-4 left-4 flex flex-col gap-2 rounded bg-white/90 dark:bg-gray-800/90 p-3 text-sm text-gray-800 dark:text-gray-100 shadow w-72"
    >
      <div class="font-semibold">3D packing: keys on a curved surface</div>

      <label class="flex items-center gap-2">
        Surface
        <select
          bind:value={shape}
          on:change={initialize}
          class="flex-1 rounded border px-1 py-0.5 bg-white dark:bg-gray-700"
        >
          <option value="sphere">Sphere</option>
          <option value="sine">Sine wave</option>
          <option value="sine2d">Sine wave (2 axis)</option>
        </select>
      </label>

      {#if shape === 'sphere'}
        <label class="flex items-center gap-2">
          Center X
          <input type="range" min="-100" max="100" step="5" bind:value={centerX} class="flex-1" />
          <span class="w-10 text-right font-mono">{centerX}</span>
        </label>
        <label class="flex items-center gap-2">
          Center Y
          <input type="range" min="-100" max="100" step="5" bind:value={centerY} class="flex-1" />
          <span class="w-10 text-right font-mono">{centerY}</span>
        </label>
        <label class="flex items-center gap-2">
          Center Z
          <input type="range" min="0" max="150" step="5" bind:value={centerZ} class="flex-1" />
          <span class="w-10 text-right font-mono">{centerZ}</span>
        </label>
        <label class="flex items-center gap-2">
          Radius
          <input type="range" min="20" max="120" step="5" bind:value={radius} class="flex-1" />
          <span class="w-10 text-right font-mono">{radius}</span>
        </label>
      {:else}
        <label class="flex items-center gap-2">
          Amplitude
          <input type="range" min="2" max="40" step="1" bind:value={amplitude} class="flex-1" />
          <span class="w-10 text-right font-mono">{amplitude}</span>
        </label>
        {#if shape === 'sine'}
          <label class="flex items-center gap-2">
            Wavelength
            <input type="range" min="20" max="150" step="5" bind:value={wavelength} class="flex-1" />
            <span class="w-10 text-right font-mono">{wavelength}</span>
          </label>
        {:else}
          <label class="flex items-center gap-2">
            Wavelength
            <input type="range" min="50" max="200" step="5" bind:value={wavelength2d} class="flex-1" />
            <span class="w-10 text-right font-mono">{wavelength2d}</span>
          </label>
        {/if}
      {/if}

      <label class="flex items-center gap-2">
        Gap (m)
        <input type="range" min="0" max="5" step="0.25" bind:value={minGap} class="flex-1" />
        <span class="w-10 text-right font-mono">{minGap}</span>
      </label>
      <label class="flex items-center gap-2">
        <input type="checkbox" bind:checked={showCorridors} />
        show press corridors
      </label>

      <div class="flex gap-2">
        <button
          class="flex-1 rounded bg-blue-600 text-white px-2 py-1 hover:bg-blue-700"
          on:click={step}
        >
          Step
        </button>
        <button
          class="flex-1 rounded bg-gray-500 text-white px-2 py-1 hover:bg-gray-600"
          on:click={initialize}
        >
          Reset
        </button>
      </div>

      <div class="font-mono text-xs pt-1 border-t border-gray-300 dark:border-gray-600">
        <div>iteration: {iteration}</div>
        <div>keys placed: {poses.length}</div>
        <div>overlapping pairs: {overlappingPairs}</div>
      </div>
    </div>
  {/if}
</div>
