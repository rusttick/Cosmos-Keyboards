<script lang="ts">
  /**
   * The 3D key envelope from key-arrangement-in-3d.md section 1/6.1: a keycap frustum (pyramid,
   * top cut off) sitting on a straight switch-housing box, plus a separate wire-clearance box
   * below the plate. z=0 is the mounting plate; +z is toward the fingertip, matching the doc's
   * convention and this scene's z-up Grid/AxesHelper.
   *
   * `position`/`rotation` place this key's own **point 1** (section 6.1: the plate-level corner
   * facing the neighbor, at local (0,0)) -- matching fk.ts's convention, since that's the point
   * every pivot in section 6.2 is measured from. The actual meshes are built symmetric about
   * local x=0 (the natural way to describe a frustum/box), so they're wrapped in an inner group
   * offset by (B/2, 0, 0) to shift that symmetric geometry into place relative to point 1.
   */
  import { T } from '@threlte/core'
  import { makeFrustumGeometry } from './keyGeometry'
  import { B, w1, hf, hs, h2, w2 } from './keyDims'

  export let position: [number, number, number] = [0, 0, 0]
  export let rotation: [number, number, number] = [0, 0, 0]

  const frustumGeometry = makeFrustumGeometry(B, w1, hf)

  const keycapColor = '#d8d2c2'
  const wireClearanceColor = '#9a9484'
</script>

<T.Group {position} {rotation}>
  <!-- shifts the symmetric-about-0 geometry below so point 1 (this group's origin) sits at its
       correct corner, matching v1=(0,0) from section 6.1 -->
  <T.Group position={[B / 2, 0, 0]}>
    <!-- switch housing: B x B footprint, z: 0 to hs -->
    <T.Mesh position={[0, 0, hs / 2]}>
      <T.BoxGeometry args={[B, B, hs]} />
      <T.MeshStandardMaterial color={keycapColor} flatShading />
    </T.Mesh>

    <!-- keycap: frustum, B x B at z=hs tapering to w1 x w1 at z=hs+hf -->
    <T.Mesh position={[0, 0, hs]} geometry={frustumGeometry}>
      <T.MeshStandardMaterial color={keycapColor} flatShading />
    </T.Mesh>

    <!-- wire clearance: w2 x w2 footprint, z: 0 to -h2 -->
    <T.Mesh position={[0, 0, -h2 / 2]}>
      <T.BoxGeometry args={[w2, w2, h2]} />
      <T.MeshStandardMaterial color={wireClearanceColor} flatShading transparent opacity={0.85} />
    </T.Mesh>
  </T.Group>
</T.Group>
