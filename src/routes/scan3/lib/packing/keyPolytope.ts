/**
 * The two-piece key shape from `docs/thumbs/key-arrangement-in-3d.md` sections 1/6.1 (frustum-on-box
 * above the plate, straight box below it), as explicit convex polytopes -- vertices + planar faces --
 * rather than a Three.js mesh. `sat3d.ts` needs face/edge data to do real SAT, not just something to
 * render.
 *
 * Centered on the plate (x=0, y=0), unlike `scan-tests/key-arrangement/keyGeometry.ts`'s point-1-corner
 * convention: packing on a sphere cares about a key's *center*, not which base corner touches a chain
 * neighbor, so there's no reason to carry that offset into this doc's shape.
 */
import * as THREE from 'three'
import { B, h1, h2, hs, w1, w2 } from '../../../scan-tests/key-arrangement/keyDims'

export interface ConvexPiece {
  vertices: [number, number, number][]
  /** Each face is an ordered (not necessarily outward-winding -- `sat3d.ts` auto-orients via the
   * polytope's own centroid) loop of vertex indices. All faces here are planar quads. */
  faces: number[][]
}

const hb = B / 2
const ht = w1 / 2

/** Keycap + switch-housing piece: a straight box (z: 0 to hs) with a tapering frustum on top
 * (z: hs to h1), matching `key-arrangement-in-3d.md`'s "frustum on rectangle" model. */
export const keycapPiece: ConvexPiece = {
  vertices: [
    [-hb, -hb, 0],
    [hb, -hb, 0],
    [hb, hb, 0],
    [-hb, hb, 0], // 0-3: plate ring
    [-hb, -hb, hs],
    [hb, -hb, hs],
    [hb, hb, hs],
    [-hb, hb, hs], // 4-7: taper-root ring
    [-ht, -ht, h1],
    [ht, -ht, h1],
    [ht, ht, h1],
    [-ht, ht, h1], // 8-11: keycap-top ring
  ],
  faces: [
    [0, 3, 2, 1], // bottom
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7], // housing sides
    [4, 5, 9, 8],
    [5, 6, 10, 9],
    [6, 7, 11, 10],
    [7, 4, 8, 11], // taper sides
    [8, 9, 10, 11], // keycap top
  ],
}

const hw = w2 / 2

/** Wire-clearance box, below the plate (z: -h2 to 0). No taper -- a plain box. */
export const wireBoxPiece: ConvexPiece = {
  vertices: [
    [-hw, -hw, 0],
    [hw, -hw, 0],
    [hw, hw, 0],
    [-hw, hw, 0], // 0-3: plate ring
    [-hw, -hw, -h2],
    [hw, -hw, -h2],
    [hw, hw, -h2],
    [-hw, hw, -h2], // 4-7: bottom
  ],
  faces: [
    [0, 1, 2, 3], // top (at the plate)
    [0, 4, 5, 1],
    [1, 5, 6, 2],
    [2, 6, 7, 3],
    [3, 7, 4, 0], // sides
    [7, 6, 5, 4], // bottom
  ],
}

/**
 * The press corridor above the keycap -- the airspace a finger needs, along this key's own local +z,
 * to reach down and press it. Not part of the key's physical body: it exists so `sat3d.ts` can check
 * that no *other* key's material has been placed inside it, which plain body-vs-body SAT can't catch
 * (see the "kinematic model didn't allow one key to block a neighbor's press" discussion in
 * `docs/thumbs/capability-packing.md` -- the chain model's bounded bend angle gave this for free; a
 * key packed onto a general surface, with an independently chosen orientation, doesn't). Two
 * neighbors' corridors are expected and allowed to overlap each other -- only corridor-vs-body is a
 * real violation, so `sat3d.ts` deliberately never tests corridor-vs-corridor.
 *
 * Reuses the keycap-top footprint (`ht`) as the corridor's cross-section (a finger contacts roughly
 * that area) and extends it a generous, fixed distance above `h1` -- not meant to model a specific
 * finger's real reach, just enough clearance that "is anything at all in the way" is a meaningful
 * question.
 */
const CORRIDOR_HEIGHT = 20

export const clearanceCorridorPiece: ConvexPiece = {
  vertices: [
    [-ht, -ht, h1],
    [ht, -ht, h1],
    [ht, ht, h1],
    [-ht, ht, h1], // 0-3: keycap-top ring
    [-ht, -ht, h1 + CORRIDOR_HEIGHT],
    [ht, -ht, h1 + CORRIDOR_HEIGHT],
    [ht, ht, h1 + CORRIDOR_HEIGHT],
    [-ht, ht, h1 + CORRIDOR_HEIGHT], // 4-7: top
  ],
  faces: [
    [0, 1, 2, 3], // bottom (at the keycap top)
    [0, 4, 5, 1],
    [1, 5, 6, 2],
    [2, 6, 7, 3],
    [3, 7, 4, 0], // sides
    [7, 6, 5, 4], // top
  ],
}

/** Triangulates a convex piece (fan triangulation -- valid since every face here is a planar convex
 * quad) into a renderable `BufferGeometry`, so the exact shape used for collision is also the exact
 * shape drawn -- no separate hand-authored mesh to drift out of sync with it. Face winding isn't
 * guaranteed outward-consistent (that's only resolved for collision purposes, via centroid-facing in
 * `sat3d.ts`), so callers should render with `DoubleSide` material rather than trust backface culling. */
export function pieceToGeometry(piece: ConvexPiece): THREE.BufferGeometry {
  const positions: number[] = []
  for (const face of piece.faces) {
    for (let i = 1; i < face.length - 1; i++) {
      positions.push(...piece.vertices[face[0]], ...piece.vertices[face[i]], ...piece.vertices[face[i + 1]])
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
  geometry.computeVertexNormals()
  return geometry
}
