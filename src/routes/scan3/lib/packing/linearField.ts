/**
 * Stage 1's field, per `capability-packing.md`'s "Simplify the field" / "The field needs an actual
 * gradient, or there's nothing to pack toward": a linear (constant-gradient) cost over a bounded domain,
 * standing in for a real finger's finite reachable workspace. Cost decreases moving along `direction` --
 * "downhill" -- and is otherwise perfectly flat, so the only asymmetry in the whole test comes from this
 * one global direction, not from anything per-square.
 */

export interface Domain {
  /** Full extent along x, centered at the origin. */
  width: number
  /** Full extent along y, centered at the origin. */
  height: number
}

export interface Candidate {
  x: number
  y: number
  cost: number
}

/** Cost at a point: lower (more negative) further along `direction`, a unit vector. */
export function linearCost(x: number, y: number, direction: [number, number]): number {
  return -(direction[0] * x + direction[1] * y)
}

/**
 * A dense regular grid of candidate points across `domain`, each scored by `linearCost`, sorted
 * ascending (lowest cost -- furthest downhill -- first). `spacing` controls candidate density; it should
 * be finer than the square size so the greedy placement in `greedyInit.ts` has real choice about where to
 * land, not just one candidate per eventual square.
 */
export function sampleCandidateGrid(domain: Domain, direction: [number, number], spacing: number): Candidate[] {
  const halfW = domain.width / 2
  const halfH = domain.height / 2
  const candidates: Candidate[] = []

  for (let x = -halfW; x <= halfW; x += spacing) {
    for (let y = -halfH; y <= halfH; y += spacing) {
      candidates.push({ x, y, cost: linearCost(x, y, direction) })
    }
  }

  return candidates.sort((a, b) => a.cost - b.cost)
}

/** A unit vector at `angleDeg`, measured from +x, for sweeping the gradient's direction (per
 * "Staged field progression"'s tilt-angle follow-on within stage 1). */
export function directionAtAngle(angleDeg: number): [number, number] {
  const rad = (angleDeg * Math.PI) / 180
  return [Math.cos(rad), Math.sin(rad)]
}

/** Wraps a single constant vector as a `directionAt` function, for `relax.ts`'s `RelaxOptions` -- this
 * field's direction genuinely doesn't depend on position, unlike `radialField.ts`'s. */
export function constantDirectionAt(direction: [number, number]): (x: number, y: number) => [number, number] {
  return () => direction
}
