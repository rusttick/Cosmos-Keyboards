/**
 * Oriented-square overlap for the 2D testbed, per `docs/thumbs/capability-packing.md`'s "Incremental
 * validation" section. Squares now carry a rotation `theta` -- per the user's own follow-up: rather than
 * only asking for non-overlapping and tightly packed, orient each square so one of its two axes points
 * along the local field gradient, then pack. `theta` is never a free variable a correction step adjusts
 * (see `relax.ts`): it's always set directly from the field's own local direction, the same "orientation
 * is derived, never independently manipulated" principle `capability-packing.md`'s main algorithm uses
 * the Jacobian for. Only position is ever corrected here.
 *
 * For two oriented rectangles in 2D, the general convex-polytope SAT test "Pairwise overlap test:
 * separating axis theorem (SAT), not GJK, not mesh collision" describes reduces to checking exactly 4
 * candidate axes (each box's own two face normals) -- no edge cross-products are needed in 2D the way
 * they are in 3D.
 */

export interface Square2D {
  x: number
  y: number
  halfSize: number
  /** Rotation in radians. A square's appearance repeats every 90 degrees, so only `theta mod 90deg`
   * is ever visually distinct -- nothing below relies on a canonical range for it. */
  theta: number
}

export interface Overlap2D {
  /** The minimum translation vector to move `a` by (added to its position) so it no longer overlaps `b`. */
  mtv: [number, number]
}

/**
 * A small positive tolerance, in mm: an overlap at or below this magnitude counts as "not really
 * overlapping" (floating-point noise from repeated corrections, not a real conflict). Deliberately NOT
 * added as a bias to the pushed-apart distance below -- an earlier version pushed `overlap + epsilon`
 * every correction, which seemed like the standard "push past exactly zero" fix, but confirmed live to
 * do the opposite of what was intended: with many squares in simultaneous contact, each pair's own epsilon
 * bias compounds, and the whole system converges to a *persistent* residual overlap proportional to
 * epsilon (not to zero) instead of the intended small gap. Pushing the exact overlap, with epsilon used
 * only as the "close enough to zero" cutoff, avoids that compounding.
 */
const SEPARATION_EPSILON = 1e-6

type Vec2 = [number, number]

function localAxes(theta: number): [Vec2, Vec2] {
  return [[Math.cos(theta), Math.sin(theta)], [-Math.sin(theta), Math.cos(theta)]]
}

function dot(a: Vec2, b: Vec2): number {
  return a[0] * b[0] + a[1] * b[1]
}

/** How far a square's projection onto axis `l` extends from its own center, in either direction. */
function projectedRadius(s: Square2D, axes: [Vec2, Vec2], l: Vec2): number {
  return s.halfSize * (Math.abs(dot(axes[0], l)) + Math.abs(dot(axes[1], l)))
}

/**
 * Returns the MTV to separate `a` from `b` (by at least `minGap`) along whichever of the 4 candidate axes
 * has the smaller required correction, or `null` if they already satisfy `minGap` (including exactly at
 * `minGap`, treated as a stable end state, not one this function keeps trying to correct).
 *
 * `minGap` (default 0, i.e. plain touching-allowed overlap) is `key-arrangement-in-3d.md`'s `m` --
 * required clearance is folded into the same SAT projections computed anyway, rather than inflating the
 * squares' own geometry to fake a margin. That choice matters beyond convenience: the real key shape
 * (`key-arrangement-in-3d.md`'s "Vertex numbering" two-piece frustum/box) is anisotropic, so a uniform
 * shape inflation would need a real Minkowski-sum-with-a-disk offset (rounding every corner by the gap
 * radius) to stay geometrically honest -- real 3D geometry work that would also distort the taper if done
 * naively. Requiring `minGap` of separation along each already-computed SAT axis needs no shape changes at
 * all and generalizes to any convex shape pair, square or two-piece key alike.
 */
export function overlapObb(a: Square2D, b: Square2D, minGap = 0): Overlap2D | null {
  const axesA = localAxes(a.theta)
  const axesB = localAxes(b.theta)
  const candidateAxes: Vec2[] = [axesA[0], axesA[1], axesB[0], axesB[1]]
  const delta: Vec2 = [a.x - b.x, a.y - b.y]

  let minOverlap = Infinity
  let minAxis: Vec2 = [1, 0]

  for (const axis of candidateAxes) {
    const rA = projectedRadius(a, axesA, axis)
    const rB = projectedRadius(b, axesB, axis)
    const d = dot(delta, axis)
    const overlap = rA + rB + minGap - Math.abs(d)
    if (overlap <= SEPARATION_EPSILON) return null

    if (overlap < minOverlap) {
      minOverlap = overlap
      minAxis = d < 0 ? [-axis[0], -axis[1]] : axis
    }
  }

  return { mtv: [minAxis[0] * minOverlap, minAxis[1] * minOverlap] }
}

/**
 * An approximate (but always non-negative, and exact when the two squares share the same `theta`)
 * surface-to-surface gap: the largest per-axis separation among the same 4 SAT axes `overlapObb` checks,
 * or 0 when they overlap. Good enough for a "touching within this tolerance" contact test
 * (`diagnostics.ts`'s coordination number); not a true minimum Euclidean distance between two arbitrarily
 * rotated rectangles.
 *
 * Deliberately takes no `minGap` -- this is the plain physical distance between two shapes, not a policy
 * question. A caller that cares whether a pair is sitting at the *required* gap (rather than at zero)
 * should compare `obbGap(...) - minGap` against its own tolerance, the way `diagnostics.ts`'s
 * `coordinationNumbers` does.
 */
export function obbGap(a: Square2D, b: Square2D): number {
  const axesA = localAxes(a.theta)
  const axesB = localAxes(b.theta)
  const candidateAxes: Vec2[] = [axesA[0], axesA[1], axesB[0], axesB[1]]
  const delta: Vec2 = [a.x - b.x, a.y - b.y]

  let maxSeparation = 0
  for (const axis of candidateAxes) {
    const rA = projectedRadius(a, axesA, axis)
    const rB = projectedRadius(b, axesB, axis)
    const separation = Math.abs(dot(delta, axis)) - (rA + rB)
    if (separation > maxSeparation) maxSeparation = separation
  }
  return maxSeparation
}

/** Whether `s` lies fully inside a domain of the given `width`/`height`, centered at the origin. Uses
 * `s.halfSize` as a conservative axis-aligned bound regardless of rotation (the true rotated footprint
 * is smaller in the axis-aligned sense, up to `halfSize * sqrt(2)` at a 45-degree rotation) -- a
 * deliberate simplification for this prototype, not a tight bound. */
export function insideDomain(s: Square2D, width: number, height: number): boolean {
  const halfW = width / 2
  const halfH = height / 2
  return (
    s.x - s.halfSize >= -halfW
    && s.x + s.halfSize <= halfW
    && s.y - s.halfSize >= -halfH
    && s.y + s.halfSize <= halfH
  )
}

/** Clamps `s` (in place conceptually -- returns a new square) so it lies fully inside the domain, per the
 * same conservative bound `insideDomain` uses. */
export function clampToDomain(s: Square2D, width: number, height: number): Square2D {
  const halfW = width / 2
  const halfH = height / 2
  return {
    ...s,
    x: Math.min(halfW - s.halfSize, Math.max(-halfW + s.halfSize, s.x)),
    y: Math.min(halfH - s.halfSize, Math.max(-halfH + s.halfSize, s.y)),
  }
}
