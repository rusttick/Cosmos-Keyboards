/**
 * Deterministic initialization for the stage-1 testbed, per `capability-packing.md`'s "The field needs
 * an actual gradient, or there's nothing to pack toward": reuses `key-point-selection.md`'s own Step 3-4
 * greedy-selection logic (take the lowest-cost remaining candidate, place it if it doesn't conflict with
 * anything already placed, otherwise reject and move on -- "Infeasibility is a rejection, not a forced
 * solution") rather than a random scatter. `candidates` must already be sorted ascending by cost (see
 * `sampleCandidateGrid`).
 */
import type { Candidate, Domain } from './linearField'
import { insideDomain, overlapObb, type Square2D } from './sat2d'

/** Axis-aligned (theta=0) placement -- this module predates the rotation DOF `sat2d.ts`'s `overlapObb`
 * added; nothing here needs a square to be oriented toward a field, so it stays unrotated. */
export function greedyPlace(
  candidates: Candidate[],
  halfSize: number,
  count: number,
  domain: Domain,
): Square2D[] {
  const placed: Square2D[] = []

  for (const c of candidates) {
    if (placed.length >= count) break

    const candidateSquare: Square2D = { x: c.x, y: c.y, halfSize, theta: 0 }
    if (!insideDomain(candidateSquare, domain.width, domain.height)) continue

    const conflicts = placed.some((p) => overlapObb(candidateSquare, p) !== null)
    if (!conflicts) placed.push(candidateSquare)
  }

  return placed
}
