/** The spherical-shell surface from the first 3D packing test, now expressed as a `Surface`. */
import * as THREE from 'three'
import type { Surface } from './surface'

export interface SphereParams {
  center: THREE.Vector3
  radius: number
}

/**
 * `spreadFrom`, when given, is a point on the shell (typically the seed cluster's own start point)
 * that `downhillAt` gently pushes keys tangentially away from. Without it, the sphere has no field at
 * all: correction alone fully resolves overlap and then nothing moves on further "Step" clicks, which
 * turned out to read as "stuck," not "done," once actually watched click by click -- the 2D testbed
 * and every other `Surface` implemented so far keep giving relaxation real, visible work across many
 * clicks (a field to walk downhill on), and the sphere should behave the same way for that same reason:
 * it's what makes the process something you can watch settle, pause, and go back to tune later, rather
 * than a single opaque solve.
 */
export function makeSphereSurface(sphere: SphereParams, spreadFrom?: THREE.Vector3): Surface {
  return {
    project(point) {
      const direction = point.clone().sub(sphere.center).normalize()
      return sphere.center.clone().add(direction.multiplyScalar(sphere.radius))
    },
    normalAt(point) {
      // Local +z points toward the sphere's center -- a keyboard shaped like fingers curling in
      // toward the center of a held ball, not keys standing upright on the shell's own tangent plane.
      return sphere.center.clone().sub(point).normalize()
    },
    downhillAt(point) {
      if (!spreadFrom) return new THREE.Vector3(0, 0, 0)

      const outward = point.clone().sub(sphere.center).normalize()
      const away = point.clone().sub(spreadFrom)
      // Tangential component only -- same reason `surfacePacking.ts`'s corrections stay tangential:
      // anything along `outward` gets discarded by the next re-snap onto the shell anyway.
      const tangential = away.sub(outward.clone().multiplyScalar(away.dot(outward)))
      return tangential.lengthSq() > 1e-9 ? tangential.normalize() : new THREE.Vector3(0, 0, 0)
    },
  }
}
