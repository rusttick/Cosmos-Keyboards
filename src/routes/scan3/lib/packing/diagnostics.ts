/**
 * The diagnostics named in `capability-packing.md`'s "Diagnosing accidental crystallization": bond-
 * orientational order (psi6), the radial distribution function g(r), the structure factor S(k), Voronoi
 * cell side counts, and a Delaunay-neighbor-based coordination number. Neighbor-finding uses `d3-delaunay`
 * (see that doc's "Tooling" note for why a hand-rolled nearest-neighbor stand-in was rejected) rather than
 * a fixed-k or fixed-radius approximation.
 */
import { Delaunay } from 'd3-delaunay'
import type { Domain } from './linearField'
import { obbGap, type Square2D } from './sat2d'

export type Point2D = [number, number]

export function toPoints(squares: Square2D[]): Point2D[] {
  return squares.map((s): Point2D => [s.x, s.y])
}

/** Delaunay-triangulation neighbor lists, one per point, in the same order as `points`. Needs at least 3
 * points to triangulate at all. */
export function delaunayNeighbors(points: Point2D[]): number[][] {
  if (points.length < 3) return points.map(() => [])
  const delaunay = Delaunay.from(points)
  return points.map((_, i) => [...delaunay.neighbors(i)])
}

/**
 * Bond-orientational order parameter psi6 per point: `(1/N) * sum_j exp(6i * theta_j)` over point `i`'s
 * Delaunay neighbors, magnitude only. Near 1 means that point's local neighborhood is hexagonally
 * ordered; near 0 means no preferred local symmetry. See `capability-packing.md`'s citation of the
 * Halperin-Nelson (KTHNY) theory of 2D melting for what this quantity is standardly used to detect.
 */
export function psi6(points: Point2D[], neighbors: number[][]): number[] {
  return points.map((p, i) => {
    const ns = neighbors[i]
    if (ns.length === 0) return 0
    let re = 0
    let im = 0
    for (const j of ns) {
      const theta = Math.atan2(points[j][1] - p[1], points[j][0] - p[0])
      re += Math.cos(6 * theta)
      im += Math.sin(6 * theta)
    }
    return Math.hypot(re, im) / ns.length
  })
}

export function meanOf(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
}

/** Coordination number per square: how many of its Delaunay neighbors are actual, physically-touching
 * contacts, not just geometrically nearby. "Touching" means sitting at (within `contactEpsilon` of) the
 * *required* gap `minGap` (default 0), not necessarily at zero physical separation -- once a nonzero
 * `minGap` is in play (see `sat2d.ts`'s `overlapObb`), a settled, non-contending pair is expected to sit
 * exactly `minGap` apart, and that's the "touching" state this should recognize. */
export function coordinationNumbers(
  squares: Square2D[],
  neighbors: number[][],
  contactEpsilon: number,
  minGap = 0,
): number[] {
  return squares.map((s, i) => neighbors[i].filter((j) => obbGap(s, squares[j]) - minGap <= contactEpsilon).length)
}

export interface GrBin {
  r: number
  g: number
}

/**
 * The radial distribution function g(r), binned. Only points at least `rMax` from the domain boundary
 * are used as reference points ("Diagnosing accidental crystallization"'s edge-effect caveat) -- every
 * counted pair's full neighborhood shell then actually lies inside the sampled region, so g(r) isn't
 * biased low at large r purely from points running out of room near the boundary. All points (interior
 * or not) still count as potential neighbors.
 */
export function radialDistribution(points: Point2D[], domain: Domain, binWidth: number, rMax: number): GrBin[] {
  const halfW = domain.width / 2
  const halfH = domain.height / 2
  const area = domain.width * domain.height
  const rho = points.length / area

  const interior = points.filter(
    ([x, y]) => x >= -halfW + rMax && x <= halfW - rMax && y >= -halfH + rMax && y <= halfH - rMax,
  )

  const nBins = Math.max(1, Math.ceil(rMax / binWidth))
  const counts = new Array(nBins).fill(0)

  for (const [xi, yi] of interior) {
    for (const [xj, yj] of points) {
      const r = Math.hypot(xi - xj, yi - yj)
      if (r > 0 && r < rMax) counts[Math.floor(r / binWidth)]++
    }
  }

  return counts.map((count, i) => {
    const rInner = i * binWidth
    const rOuter = (i + 1) * binWidth
    const shellArea = Math.PI * (rOuter * rOuter - rInner * rInner)
    const expected = interior.length * rho * shellArea
    return { r: (i + 0.5) * binWidth, g: expected > 0 ? count / expected : 0 }
  })
}

export interface SkSample {
  kx: number
  ky: number
  s: number
}

/**
 * The (numerical) structure factor `S(k) = |sum_j exp(-i k . r_j)|^2 / N`, sampled over a regular grid
 * of wavevectors up to `kMax` (`kSteps` samples per axis, each direction). Discrete Bragg peaks at
 * specific `k` mean periodic order; a diffuse, roughly-uniform ring means isotropic disorder.
 */
export function structureFactor(points: Point2D[], kMax: number, kSteps: number): SkSample[] {
  const samples: SkSample[] = []
  const n = points.length
  if (n === 0) return samples

  for (let ix = -kSteps; ix <= kSteps; ix++) {
    for (let iy = -kSteps; iy <= kSteps; iy++) {
      const kx = (ix / kSteps) * kMax
      const ky = (iy / kSteps) * kMax
      let re = 0
      let im = 0
      for (const [x, y] of points) {
        const phase = -(kx * x + ky * y)
        re += Math.cos(phase)
        im += Math.sin(phase)
      }
      samples.push({ kx, ky, s: (re * re + im * im) / n })
    }
  }

  return samples
}

/** The largest S(k) away from the trivial k=0 peak (which is always N and carries no structural
 * information) -- one scalar summary of "how strong is the strongest non-trivial periodicity." */
export function peakStructureFactor(samples: SkSample[]): number {
  let peak = 0
  for (const s of samples) {
    if ((s.kx !== 0 || s.ky !== 0) && s.s > peak) peak = s.s
  }
  return peak
}

/** Each point's Voronoi cell side count, clipped to `domain`; `null` where the cell is degenerate (fewer
 * than 3 points, or the point falls outside the clip bounds). */
export function voronoiSideCounts(points: Point2D[], domain: Domain): (number | null)[] {
  if (points.length < 2) return points.map(() => null)
  const halfW = domain.width / 2
  const halfH = domain.height / 2
  const delaunay = Delaunay.from(points)
  const voronoi = delaunay.voronoi([-halfW, -halfH, halfW, halfH])

  return points.map((_, i) => {
    const poly = voronoi.cellPolygon(i)
    if (!poly) return null
    // `cellPolygon` returns a closed ring (first point repeated as the last) -- subtract 1 for the true
    // vertex/side count.
    return poly.length - 1
  })
}
