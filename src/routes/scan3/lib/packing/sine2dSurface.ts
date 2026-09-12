/**
 * A flat plane bent into a sine wave along BOTH x and y -- the two-axis generalization of
 * `sineSurface.ts`'s single-axis bend: `z = amplitude * sin(2*pi*x/wavelength) * sin(2*pi*y/wavelength)`,
 * an "egg carton" surface with isolated peaks and troughs (rather than ridges running the length of
 * one axis) in both directions, so a key can be pulled downhill from any direction, not just along x.
 *
 * `project` is the same graph-surface approximation as the 1-axis case -- keeps the point's own
 * (x, y), only recomputes z. Not the true closest point on the curved surface; fine for this pass.
 */
import * as THREE from 'three'
import type { Surface } from './surface'

export interface Sine2DParams {
  amplitude: number
  /** Shared by both axes -- one period length, not independently tunable per axis (yet). */
  wavelength: number
}

export function makeSine2DSurface(params: Sine2DParams): Surface {
  const k = (2 * Math.PI) / params.wavelength
  const heightAt = (x: number, y: number) => params.amplitude * Math.sin(k * x) * Math.sin(k * y)
  const gradAt = (x: number, y: number): [number, number] => [
    params.amplitude * k * Math.cos(k * x) * Math.sin(k * y),
    params.amplitude * k * Math.sin(k * x) * Math.cos(k * y),
  ]

  return {
    project(point) {
      return new THREE.Vector3(point.x, point.y, heightAt(point.x, point.y))
    },
    normalAt(point) {
      const [dzdx, dzdy] = gradAt(point.x, point.y)
      // Same construction as the 1-axis surface's normal (there, dzdy is always 0): the raw cross
      // product of tangentX=(1,0,dzdx) and tangentY=(0,1,dzdy) is (-dzdx, -dzdy, 1).
      return new THREE.Vector3(-dzdx, -dzdy, 1).normalize()
    },
    downhillAt(point) {
      const [dzdx, dzdy] = gradAt(point.x, point.y)
      const gradMagSq = dzdx * dzdx + dzdy * dzdy
      if (gradMagSq < 1e-12) return new THREE.Vector3(0, 0, 0)
      const gradMag = Math.sqrt(gradMagSq)
      // Steepest-descent direction in the (x, y) parameter plane, embedded as the true 3D surface
      // tangent along it (same "tangent, not just the flat -gx/-gy" treatment the 1-axis surface uses).
      const gx = -dzdx / gradMag
      const gy = -dzdy / gradMag
      return new THREE.Vector3(gx, gy, dzdx * gx + dzdy * gy).normalize()
    },
  }
}
