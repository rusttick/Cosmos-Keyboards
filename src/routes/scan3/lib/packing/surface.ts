/**
 * A pluggable curved surface for the 3D packing tests (`spherePacking.ts`'s sphere generalized to any
 * shape, per the user's ask for "sphere or sine wave, selectable, assume more coming"). A `Surface` is
 * exactly the three things `surfacePacking.ts`'s relaxation loop needs from any shape: where a nearby
 * point actually belongs on it, which way a key's local +z should face there, and which way (if any)
 * is "downhill" for the packing/cost field to pull toward.
 */
import * as THREE from 'three'

export interface Surface {
  /** Snaps an arbitrary point near the surface onto it -- used after each relaxation correction, and
   * to build the tangent-plane seed cluster. Not necessarily the exact closest point; see each
   * surface's own doc comment for what approximation (if any) it uses. */
  project(point: THREE.Vector3): THREE.Vector3
  /** The key's local +z axis (its own "keycap top" direction, per `keyPolytope.ts`) at a point
   * already on the surface. Which physical direction that means (inward vs. outward) is each
   * surface's own choice, documented where it's set. */
  normalAt(point: THREE.Vector3): THREE.Vector3
  /** Unit tangent direction, at a point on the surface, toward the nearest lower-cost point (the
   * "packing gradient"). The zero vector where there's no field to descend (e.g. a bounded shell that
   * needs none) or at an exact local minimum. */
  downhillAt(point: THREE.Vector3): THREE.Vector3
}

const WORLD_UP = new THREE.Vector3(0, 0, 1) // z-up, matching this project's scene convention

/** Builds an orthonormal frame from a single normal direction -- shared by every `Surface`'s
 * `normalAt`, so "how is twist (rotation about the normal) chosen" is answered once, not per surface.
 * Degenerates only when `normal` is exactly parallel to `WORLD_UP`. */
export function orientationFromNormal(normal: THREE.Vector3): THREE.Quaternion {
  const zAxis = normal.clone().normalize()
  const reference = Math.abs(zAxis.dot(WORLD_UP)) > 0.999 ? new THREE.Vector3(1, 0, 0) : WORLD_UP
  const xAxis = new THREE.Vector3().crossVectors(reference, zAxis).normalize()
  const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis)
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis))
}
