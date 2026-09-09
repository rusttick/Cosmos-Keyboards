import * as THREE from 'three'

/**
 * A square-footprint frustum (truncated pyramid): baseSize x baseSize at z=0, tapering to
 * topSize x topSize at z=height. Used for the keycap taper in KeyPrimitive.svelte -- the real
 * geometry from key-arrangement-in-3d.md section 1 ("Claim K1"), not a stand-in shape.
 */
export function makeFrustumGeometry(baseSize: number, topSize: number, height: number): THREE.BufferGeometry {
  const b = baseSize / 2
  const t = topSize / 2

  // prettier-ignore
  const positions = new Float32Array([
    -b,
    -b,
    0,
    b,
    -b,
    0,
    b,
    b,
    0,
    -b,
    b,
    0, // bottom (0-3)
    -t,
    -t,
    height,
    t,
    -t,
    height,
    t,
    t,
    height,
    -t,
    t,
    height, // top (4-7)
  ])

  // prettier-ignore
  const indices = [
    0,
    2,
    1,
    0,
    3,
    2, // bottom cap (outward normal -z)
    4,
    5,
    6,
    4,
    6,
    7, // top cap (outward normal +z)
    0,
    1,
    5,
    0,
    5,
    4, // side, -y
    1,
    2,
    6,
    1,
    6,
    5, // side, +x
    2,
    3,
    7,
    2,
    7,
    6, // side, +y
    3,
    0,
    4,
    3,
    4,
    7, // side, -x
  ]

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}
