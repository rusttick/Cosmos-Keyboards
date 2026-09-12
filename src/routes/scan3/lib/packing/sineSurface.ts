/**
 * A flat plane bent into a sine wave along x, flat (unconstrained) along y --
 * `z = amplitude * sin(2*pi*x / wavelength)`. The first real implementation of
 * `capability-packing.md`'s "sine-wave field" test stage (previously untried -- its own doc lists it
 * among the "two of the doc's staged fields [that] haven't been tried at all"), now with the field
 * embedded directly as the surface's own shape rather than a synthetic in-plane cost, per the user's
 * framing: "the packing vector is along the surface toward the trough."
 *
 * `project` is a graph-surface approximation -- it keeps the point's own (x, y) and only recomputes
 * z -- not the true closest point on the curved surface (that needs solving a transcendental equation
 * in x). Fine for a first pass; a real "nearest point on the curve" projection is a follow-up if the
 * approximation turns out to matter.
 */
import * as THREE from 'three'
import type { Surface } from './surface'

export interface SineParams {
  /** Peak-to-center height. */
  amplitude: number
  /** Distance between troughs, along the bend axis (x). */
  wavelength: number
}

export function makeSineSurface(params: SineParams): Surface {
  const k = (2 * Math.PI) / params.wavelength
  const heightAt = (x: number) => params.amplitude * Math.sin(k * x)
  const slopeAt = (x: number) => params.amplitude * k * Math.cos(k * x)

  return {
    project(point) {
      return new THREE.Vector3(point.x, point.y, heightAt(point.x))
    },
    normalAt(point) {
      // Local +z is the true surface normal (not toward/away from any special point) -- the
      // outward-facing side of the bent sheet, per the user's "key direction is normal to the
      // surface." tangentX = (1, 0, slope); tangentY = (0, 1, 0) (the sheet doesn't curve along y).
      const tangentX = new THREE.Vector3(1, 0, slopeAt(point.x))
      const tangentY = new THREE.Vector3(0, 1, 0)
      return new THREE.Vector3().crossVectors(tangentX, tangentY).normalize()
    },
    downhillAt(point) {
      // Steepest-descent direction along the curve itself (the 3D tangent, not just -x/+x in the
      // flat parameter plane) -- zero at a trough or crest, where there's nothing to descend toward.
      const slope = slopeAt(point.x)
      if (Math.abs(slope) < 1e-9) return new THREE.Vector3(0, 0, 0)
      const tangentX = new THREE.Vector3(1, 0, slope).normalize()
      return slope > 0 ? tangentX.negate() : tangentX
    },
  }
}
