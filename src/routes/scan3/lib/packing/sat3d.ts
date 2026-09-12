/**
 * General convex-polytope SAT in 3D, per `docs/thumbs/capability-packing.md`'s "Pairwise overlap test:
 * separating axis theorem (SAT)" -- extended here from the 2D-oriented-box case (`sat2d.ts`) to the
 * real 6-DOF two-piece key shape (`keyPolytope.ts`). Candidate separating axes are every face normal of
 * both polytopes plus every cross-product of an edge from each -- the standard convex-polytope SAT,
 * not the 15-axis OBB-only shortcut (this shape isn't a box: the taper faces' normals aren't among
 * either box's own 3 axes).
 */
import * as THREE from 'three'
import { clearanceCorridorPiece, type ConvexPiece, keycapPiece, wireBoxPiece } from './keyPolytope'

export interface Pose3D {
  position: THREE.Vector3
  quaternion: THREE.Quaternion
}

interface TransformedPolytope {
  vertices: THREE.Vector3[]
  faceNormals: THREE.Vector3[]
  edges: [THREE.Vector3, THREE.Vector3][]
}

const SEPARATION_EPSILON = 1e-6

function faceNormal(vertices: THREE.Vector3[], face: number[], centroid: THREE.Vector3): THREE.Vector3 {
  const a = vertices[face[0]]
  const b = vertices[face[1]]
  const c = vertices[face[2]]
  const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize()
  // Faces aren't authored with a guaranteed outward winding (see `keyPolytope.ts`) -- orient every
  // normal away from the polytope's own centroid instead of trusting vertex order.
  if (n.dot(new THREE.Vector3().subVectors(centroid, a)) > 0) n.negate()
  return n
}

function transformPolytope(piece: ConvexPiece, pose: Pose3D): TransformedPolytope {
  const vertices = piece.vertices.map(([x, y, z]) => new THREE.Vector3(x, y, z).applyQuaternion(pose.quaternion).add(pose.position))

  const centroid = new THREE.Vector3()
  for (const v of vertices) centroid.add(v)
  centroid.multiplyScalar(1 / vertices.length)

  const faceNormals = piece.faces.map((face) => faceNormal(vertices, face, centroid))

  const seen = new Set<string>()
  const edges: [THREE.Vector3, THREE.Vector3][] = []
  for (const face of piece.faces) {
    for (let i = 0; i < face.length; i++) {
      const a = face[i]
      const b = face[(i + 1) % face.length]
      const key = a < b ? `${a}-${b}` : `${b}-${a}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push([vertices[a], vertices[b]])
    }
  }

  return { vertices, faceNormals, edges }
}

function projectExtent(vertices: THREE.Vector3[], axis: THREE.Vector3): [number, number] {
  let min = Infinity
  let max = -Infinity
  for (const v of vertices) {
    const d = v.dot(axis)
    if (d < min) min = d
    if (d > max) max = d
  }
  return [min, max]
}

// How aligned a candidate axis has to be with `avoidAxis` before it's excluded from MTV selection
// (see `polytopeOverlap`'s doc comment) -- 0.9 ~= within ~25 degrees of straight-on.
const AVOID_AXIS_ALIGNMENT = 0.9

/**
 * The MTV to move `a` by so it clears `b` by at least `minGap`, or `null` if it already does. Mirrors
 * `sat2d.ts`'s `overlapObb` (same penetration-per-axis logic), generalized to a polytope's own face
 * normals and edge set instead of a box's fixed 4 axes.
 *
 * `avoidAxis`, when given, is the surface normal at the key being corrected: candidate axes closely
 * aligned with it are skipped when choosing *which* axis to correct along (falling back to them only
 * if every axis is that aligned). Plain global-minimum-penetration MTV picks whichever axis needs the
 * *shortest* push, and for this key shape (height comparable to width) that's frequently straight up
 * along the surface normal, not sideways -- confirmed directly (two keys overlapping side-by-side
 * returned a pure-vertical MTV). That's a correct SAT answer but a useless one for surface packing:
 * `surfacePacking.ts` re-snaps each key onto the surface every pass anyway, discarding any normal-ish
 * component, so preferring a tangential axis up front is what actually produces a lateral separation
 * instead of a push that gets silently thrown away. This never changes *whether* two shapes are found
 * to overlap (every axis, including near-normal ones, is still checked for the separating-axis
 * short-circuit below) -- only which axis is reported once real overlap is established.
 */
function polytopeOverlap(
  a: TransformedPolytope,
  b: TransformedPolytope,
  minGap: number,
  avoidAxis?: THREE.Vector3,
): THREE.Vector3 | null {
  const candidateAxes: THREE.Vector3[] = [...a.faceNormals, ...b.faceNormals]

  for (const [ea0, ea1] of a.edges) {
    const da = new THREE.Vector3().subVectors(ea1, ea0)
    for (const [eb0, eb1] of b.edges) {
      const db = new THREE.Vector3().subVectors(eb1, eb0)
      const axis = new THREE.Vector3().crossVectors(da, db)
      if (axis.lengthSq() > 1e-10) candidateAxes.push(axis.normalize())
    }
  }

  let minPenetrationAny = Infinity
  let mtvAxisAny: THREE.Vector3 | null = null
  let minPenetrationTangential = Infinity
  let mtvAxisTangential: THREE.Vector3 | null = null

  for (const axis of candidateAxes) {
    const [minA, maxA] = projectExtent(a.vertices, axis)
    const [minB, maxB] = projectExtent(b.vertices, axis)
    const overlap = Math.min(maxA, maxB) - Math.max(minA, minB)
    const penetration = overlap - minGap
    if (penetration <= SEPARATION_EPSILON) return null // a separating axis -- shapes already clear

    const centerA = (minA + maxA) / 2
    const centerB = (minB + maxB) / 2
    // Push `a` away from `b` along this axis.
    const signedAxis = centerA < centerB ? axis.clone().negate() : axis.clone()

    if (penetration < minPenetrationAny) {
      minPenetrationAny = penetration
      mtvAxisAny = signedAxis
    }
    if (avoidAxis && Math.abs(axis.dot(avoidAxis)) < AVOID_AXIS_ALIGNMENT && penetration < minPenetrationTangential) {
      minPenetrationTangential = penetration
      mtvAxisTangential = signedAxis
    }
  }

  if (mtvAxisTangential) return mtvAxisTangential.multiplyScalar(minPenetrationTangential)
  return mtvAxisAny ? mtvAxisAny.multiplyScalar(minPenetrationAny) : null
}

/**
 * Whether two full keys conflict, and if so, the MTV to move `a` by to clear `b`. Three kinds of
 * conflict are checked, all resolved the same way (move `a` away from `b`):
 *
 * - **Physical overlap** -- each key's keycap+housing piece and wire-clearance box, per
 *   `capability-packing.md`'s "4 pairs" (frustum-vs-frustum, frustum-vs-box, box-vs-frustum,
 *   box-vs-box).
 * - **`a`'s press corridor blocked by `b`'s body** -- `a` can't be pressed with `b` sitting where it is.
 * - **`b`'s press corridor blocked by `a`'s body** -- resolved the same way (moving `a` away from `b`
 *   clears `a`'s material out of `b`'s corridor too), so this stays a single per-pair correction.
 *
 * Deliberately excluded: corridor-vs-corridor. Two neighbors' press corridors are expected to overlap
 * each other -- only a corridor overlapping actual material is a real conflict (see
 * `keyPolytope.ts`'s `clearanceCorridorPiece` doc comment for why body-vs-body alone misses this).
 *
 * Among every checked piece-pair, returns the one requiring the largest push -- resolving the worst
 * conflict first is a reasonable single correction per pair per pass, matching the one-MTV-per-key-pair
 * shape `sat2d.ts`'s caller (`relax.ts`) already expects.
 *
 * `avoidAxis` (typically `a`'s own surface normal, when packing on a curved surface) is passed straight
 * through to `polytopeOverlap` -- see its doc comment for why a tangential axis is preferred over the
 * true global-minimum one once real overlap is established. It never changes whether a pair is found to
 * overlap, only which direction the correction is reported in.
 */
export function keyOverlap3D(a: Pose3D, b: Pose3D, minGap = 0, avoidAxis?: THREE.Vector3): THREE.Vector3 | null {
  const bodyA = [transformPolytope(keycapPiece, a), transformPolytope(wireBoxPiece, a)]
  const bodyB = [transformPolytope(keycapPiece, b), transformPolytope(wireBoxPiece, b)]
  const corridorA = transformPolytope(clearanceCorridorPiece, a)
  const corridorB = transformPolytope(clearanceCorridorPiece, b)

  let worst: THREE.Vector3 | null = null
  const consider = (pa: TransformedPolytope, pb: TransformedPolytope) => {
    const mtv = polytopeOverlap(pa, pb, minGap, avoidAxis)
    if (mtv && (!worst || mtv.length() > worst.length())) worst = mtv
  }

  for (const pa of bodyA) for (const pb of bodyB) consider(pa, pb) // physical collision
  for (const pb of bodyB) consider(corridorA, pb) // a's press corridor blocked by b's body
  for (const pa of bodyA) consider(pa, corridorB) // b's press corridor blocked by a's body

  return worst
}
