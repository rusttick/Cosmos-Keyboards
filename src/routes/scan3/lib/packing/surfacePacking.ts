/**
 * The 3D analogue of `clusterInit.ts`/`relax.ts`, generalized from the sphere-only first version to
 * any `Surface` (`surface.ts`) -- sphere and sine-wave now, "assume more coming" per the user's ask.
 *
 * A key's orientation is always a pure function of its position (`surface.normalAt`, never touched by
 * overlap correction) -- the same "orientation is derived, never used to escape a conflict" principle
 * as the 2D testbed's `theta` and the sphere-only version's `tangentFrame`.
 */
import * as THREE from 'three'
import { keyOverlap3D, type Pose3D } from './sat3d'
import { orientationFromNormal, type Surface } from './surface'

/** An orthonormal tangent-plane basis at `point`, shared by every initializer below so "which
 * direction is `u`/`v`" is answered the same way regardless of how points are scattered within it. */
function tangentBasisAt(surface: Surface, point: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
  const normal = surface.normalAt(point)
  const worldUp = new THREE.Vector3(0, 0, 1)
  const reference = Math.abs(normal.dot(worldUp)) > 0.999 ? new THREE.Vector3(1, 0, 0) : worldUp
  const tangentX = new THREE.Vector3().crossVectors(reference, normal).normalize()
  const tangentY = new THREE.Vector3().crossVectors(normal, tangentX)
  return [tangentX, tangentY]
}

/** A tight, deliberately overlapping starting cluster near `startPoint`, laid out on a grid in the
 * tangent plane there and projected onto the surface -- the same grid `clusterInit.ts`'s 2D version
 * uses, generalized to any `Surface`. `spacing` smaller than the keys' own footprint is what makes the
 * seed overlap, so relaxation has real, visible work to do. */
export function surfaceClusterInit(
  count: number,
  surface: Surface,
  startPoint: THREE.Vector3,
  spacing: number,
): Pose3D[] {
  const [tangentX, tangentY] = tangentBasisAt(surface, startPoint)

  const cols = Math.ceil(Math.sqrt(count))
  const poses: Pose3D[] = []
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / cols)
    const col = i % cols
    const u = (col - (cols - 1) / 2) * spacing
    const v = (row - (cols - 1) / 2) * spacing
    const nearby = startPoint.clone()
      .add(tangentX.clone().multiplyScalar(u))
      .add(tangentY.clone().multiplyScalar(v))
    const position = surface.project(nearby)
    poses.push({ position, quaternion: orientationFromNormal(surface.normalAt(position)) })
  }
  return poses
}

/**
 * Scatters keys uniformly at random over a `width` x `height` box in the tangent plane at `center`,
 * then projects each onto the surface -- an alternative to `surfaceClusterInit`'s single tight seed,
 * for surfaces (like the sine wave) with more than one place a key could plausibly settle. A single
 * local cluster only ever explores the trough nearest its own seed point; a wide random scatter starts
 * keys near several different troughs at once, so relaxation has to actually sort out which key ends
 * up where rather than all converging on the one trough the seed happened to sit near.
 */
export function surfaceRandomInit(
  count: number,
  surface: Surface,
  center: THREE.Vector3,
  domain: { width: number; height: number },
): Pose3D[] {
  const [tangentX, tangentY] = tangentBasisAt(surface, center)

  const poses: Pose3D[] = []
  for (let i = 0; i < count; i++) {
    const u = (Math.random() - 0.5) * domain.width
    const v = (Math.random() - 0.5) * domain.height
    const nearby = center.clone()
      .add(tangentX.clone().multiplyScalar(u))
      .add(tangentY.clone().multiplyScalar(v))
    const position = surface.project(nearby)
    poses.push({ position, quaternion: orientationFromNormal(surface.normalAt(position)) })
  }
  return poses
}

// Same fixed-point-cycle risk `relax.ts` found and fixed the same way: full-strength MTV correction
// every pass can settle into a persistent back-and-forth in a symmetric multi-body jam.
const CORRECTION_DAMPING = 0.5

/**
 * One relaxation sweep: an optional downhill move along `surface.downhillAt` (a no-op when the
 * surface has no field -- e.g. the sphere, whose `downhillAt` is always zero, exactly reproducing the
 * no-field first version's behavior), then repeated full Gauss-Seidel correction passes (the same
 * "single pass isn't strict enough" fix `relax.ts` needed) until no pair overlaps or
 * `maxCorrectionPasses` is hit. Each key is snapped back onto the surface once per pass, after all of
 * its pairwise corrections for that pass -- not after each one, matching `relax.ts`'s own finding that
 * clamping mid-pass fights the next neighbor correction.
 */
export function surfaceRelaxStep(
  poses: Pose3D[],
  surface: Surface,
  opts: { minGap?: number; maxCorrectionPasses?: number; stepSize?: number } = {},
): Pose3D[] {
  const minGap = opts.minGap ?? 0
  const maxPasses = opts.maxCorrectionPasses ?? 60
  const stepSize = opts.stepSize ?? 0

  let current = poses.map((p) => ({ position: p.position.clone(), quaternion: p.quaternion.clone() }))

  if (stepSize !== 0) {
    current = current.map((p) => {
      const direction = surface.downhillAt(p.position)
      const moved = p.position.clone().add(direction.multiplyScalar(stepSize))
      const projected = surface.project(moved)
      return { position: projected, quaternion: orientationFromNormal(surface.normalAt(projected)) }
    })
  }

  for (let pass = 0; pass < maxPasses; pass++) {
    const next = current.map((p) => ({ position: p.position.clone(), quaternion: p.quaternion.clone() }))
    let anyOverlap = false

    for (let i = 0; i < next.length; i++) {
      let pose = next[i]
      for (let j = 0; j < next.length; j++) {
        if (j === i) continue
        // Pass this key's own surface normal as `avoidAxis` -- `sat3d.ts` then prefers a tangential
        // correction axis over the true (often near-vertical) global-minimum one, since the per-key
        // re-snap onto the surface below would otherwise discard most of a normal-ish correction
        // every pass (confirmed directly: without this, two overlapping keys barely separated across
        // many relaxation passes).
        const mtv = keyOverlap3D(pose, next[j], minGap, surface.normalAt(pose.position))
        if (mtv) {
          anyOverlap = true
          pose = { position: pose.position.clone().add(mtv.multiplyScalar(CORRECTION_DAMPING)), quaternion: pose.quaternion }
        }
      }
      const projected = surface.project(pose.position)
      next[i] = { position: projected, quaternion: orientationFromNormal(surface.normalAt(projected)) }
    }

    current = next
    if (!anyOverlap) break
  }

  return current
}
