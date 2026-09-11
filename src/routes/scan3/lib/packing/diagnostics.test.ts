import { describe, expect, test } from 'bun:test'
import { coordinationNumbers, delaunayNeighbors, meanOf, type Point2D, psi6, voronoiSideCounts } from './diagnostics'

/** A finite patch of a perfect triangular (hexagonal-coordination) lattice, spacing `a`. */
function hexLattice(rows: number, cols: number, a: number): Point2D[] {
  const points: Point2D[] = []
  const dy = (a * Math.sqrt(3)) / 2
  for (let row = 0; row < rows; row++) {
    const offset = row % 2 === 0 ? 0 : a / 2
    for (let col = 0; col < cols; col++) {
      points.push([col * a + offset, row * dy])
    }
  }
  return points
}

/** Indices of points at least `margin` rows/cols from the patch's edge -- a finite lattice's Delaunay
 * triangulation adds real (not just numerical-error) extra edges near the convex hull boundary to close
 * the triangulation, which aren't part of the true infinite lattice's connectivity; excluding a margin
 * avoids that boundary artifact rather than papering over it with a loose tolerance. */
function interiorIndices(rows: number, cols: number, margin: number): number[] {
  const indices: number[] = []
  for (let row = margin; row < rows - margin; row++) {
    for (let col = margin; col < cols - margin; col++) {
      indices.push(row * cols + col)
    }
  }
  return indices
}

/** Deterministic PRNG (mulberry32) so the "disordered" comparison case isn't flaky. */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomScatter(n: number, extent: number, seed: number): Point2D[] {
  const rand = mulberry32(seed)
  return Array.from({ length: n }, (): Point2D => [(rand() - 0.5) * extent, (rand() - 0.5) * extent])
}

describe('psi6', () => {
  test('is exactly 1 for the interior points of a perfect hex lattice', () => {
    // e^(6i * k * 60deg) = 1 for any integer k, so every term in the psi6 sum for a perfect hex
    // lattice is exactly 1 for any point whose neighbors are all real lattice neighbors -- true
    // regardless of how many neighbors a given interior point has.
    const rows = 9
    const cols = 9
    const points = hexLattice(rows, cols, 10)
    const neighbors = delaunayNeighbors(points)
    const values = psi6(points, neighbors)
    for (const i of interiorIndices(rows, cols, 2)) expect(values[i]).toBeCloseTo(1, 5)
  })

  test('is markedly lower for a random scatter than for a hex lattice of the same size', () => {
    const rows = 9
    const cols = 9
    const lattice = hexLattice(rows, cols, 10)
    const scatter = randomScatter(lattice.length, 80, 12345)
    const interior = interiorIndices(rows, cols, 2)

    const latticeValues = psi6(lattice, delaunayNeighbors(lattice))
    const scatterValues = psi6(scatter, delaunayNeighbors(scatter))
    const latticeInteriorMean = meanOf(interior.map((i) => latticeValues[i]))
    const scatterMean = meanOf(scatterValues)

    expect(latticeInteriorMean).toBeCloseTo(1, 5)
    expect(scatterMean).toBeLessThan(latticeInteriorMean)
    expect(scatterMean).toBeLessThan(0.6)
  })
})

describe('coordinationNumbers', () => {
  test('counts only neighbors within contactEpsilon, not every Delaunay neighbor', () => {
    // Three points on a line: 0 and 1 touch (10 apart, halfSize 5 each); 1 and 2 are far apart.
    const points: Point2D[] = [[0, 0], [10, 0], [100, 0]]
    const squares = points.map(([x, y]) => ({ x, y, halfSize: 5, theta: 0 }))
    const neighbors = delaunayNeighbors(points)
    const coordination = coordinationNumbers(squares, neighbors, 1e-6)
    expect(coordination[0]).toBe(1)
    expect(coordination[2]).toBe(0)
  })
})

describe('voronoiSideCounts', () => {
  test('a perfect hex lattice gives hexagonal (6-sided) interior cells', () => {
    const points = hexLattice(7, 7, 10)
    const domain = { width: 200, height: 200 }
    const sides = voronoiSideCounts(points, domain)
    // The exact center point of an odd-sized hex patch is a true interior point -- its cell should be
    // a hexagon. (Boundary cells get clipped by the domain and won't generally be hexagons.)
    const centerIndex = Math.floor(points.length / 2)
    expect(sides[centerIndex]).toBe(6)
  })
})
