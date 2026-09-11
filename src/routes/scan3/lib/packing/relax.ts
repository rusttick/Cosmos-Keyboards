/**
 * One relaxation sweep, per `capability-packing.md`'s "Iteration and convergence": every square takes a
 * small step downhill (toward lower cost, per whatever field `directionAt` encodes) and is oriented so one
 * of its two axes points along that same local downhill direction; then overlap is resolved by repeated
 * Gauss-Seidel MTV correction passes (`resolveOverlaps` below) until no pair overlaps or `maxPasses` is
 * reached. The domain boundary acts as a wall (clamped, not wrapped) so squares queue up against it rather
 * than leaving the candidate region entirely.
 *
 * **A single correction pass is not enough to guarantee overlap-free output, and was confirmed live to let
 * real overlap through.** Correcting square `i` against `j` can reintroduce an overlap with some earlier
 * `k` that a prior correction in the same pass had already cleared, and a single pass never re-checks `k`
 * afterward. `resolveOverlaps` fixes this by repeating full passes over every pair until a pass changes
 * nothing (or the pass budget runs out) rather than doing exactly one -- the standard fix in iterative
 * contact solvers (e.g. position-based dynamics), which run several solver iterations per step for exactly
 * this reason, not one.
 *
 * `theta` is set directly from the field's local direction, never adjusted by overlap correction -- the
 * same "orientation is derived, never independently manipulated to escape a conflict" principle the real
 * algorithm uses the Jacobian for (`capability-packing.md`'s "Correction: SAT's MTV mapped through the
 * Jacobian, not applied as a raw Cartesian move"). Only position is ever corrected.
 *
 * `directionAt` is a function of each square's own position, not a single constant vector -- a uniform
 * (linear-gradient) field's `directionAt` just ignores its arguments and returns the same vector
 * everywhere, but `radialField.ts`'s field needs the per-square direction toward its center, which
 * genuinely differs square to square. This matters beyond API convenience: a constant direction applied
 * to a translationally-symmetric starting cluster (`clusterInit.ts`) produces a rigid translation with no
 * internal rearrangement at all -- confirmed live, not just reasoned about (see `capability-packing.md`'s
 * "Staged field progression" note on why a center-point field replaced the flat-edge one as the first
 * live demonstration).
 *
 * This is the step a UI "step" button calls once per click (`capability-packing.md`'s "Step through,
 * don't auto-run") -- this module does not loop across separate clicks on its own.
 */
import type { Domain } from './linearField'
import { clampToDomain, overlapObb, type Square2D } from './sat2d'

export interface RelaxOptions {
  directionAt: (x: number, y: number) => [number, number]
  stepSize: number
  domain: Domain
  /** Maximum number of full Gauss-Seidel correction passes to run per `relaxStep` call. Default 300 --
   * generous, since each pass is cheap (O(n^2) on a testbed-sized square count) and stopping early the
   * moment a pass resolves nothing means most calls finish in far fewer passes than this cap. */
  maxCorrectionPasses?: number
  /** Required minimum gap between any two squares -- `key-arrangement-in-3d.md`'s `m`, threaded straight
   * into `overlapObb`'s own SAT projections rather than inflating the squares' geometry (see that
   * function's doc comment for why). Default 0 (plain touching-allowed packing). */
  minGap?: number
}

/**
 * Repeated full Gauss-Seidel sweeps: each pass corrects every square against every other square's
 * *current* position (including corrections already applied earlier in the same pass), same as before --
 * but now the whole pass repeats until one changes nothing (every pairwise SAT test already clears) or
 * `maxPasses` is reached, instead of running exactly once.
 */
// Applying the full MTV every pass can produce an exact, persistent back-and-forth cycle between two or
// more squares in a symmetric multi-body jam (confirmed live: a residual overlap that never fully
// cleared even after hundreds of passes at full correction). Under-correcting by this factor each pass
// still converges (each pass still reduces total overlap whenever one exists) but stops the exact
// repeated cancellation that a full-strength correction can fall into -- the standard fix for oscillation
// in iterative contact solvers.
const CORRECTION_DAMPING = 0.5

function resolveOverlaps(squares: Square2D[], domain: Domain, maxPasses: number, minGap: number): Square2D[] {
  let current = squares

  for (let pass = 0; pass < maxPasses; pass++) {
    const next = current.map((s) => ({ ...s }))
    let anyOverlap = false

    for (let i = 0; i < next.length; i++) {
      let s = next[i]
      for (let j = 0; j < next.length; j++) {
        if (j === i) continue
        const overlap = overlapObb(s, next[j], minGap)
        if (overlap) {
          anyOverlap = true
          s = {
            ...s,
            x: s.x + overlap.mtv[0] * CORRECTION_DAMPING,
            y: s.y + overlap.mtv[1] * CORRECTION_DAMPING,
          }
        }
      }
      // Clamp once, after all of this square's pairwise corrections for the pass, not after each one --
      // clamping mid-way through fights with the next neighbor correction and was a real source of
      // non-convergence (confirmed live: a residual overlap that never fully cleared even after many
      // passes), not just theoretical.
      next[i] = clampToDomain(s, domain.width, domain.height)
    }

    current = next
    if (!anyOverlap) break
  }

  return current
}

export function relaxStep(squares: Square2D[], opts: RelaxOptions): Square2D[] {
  const moved = squares.map((s) => {
    const [dx, dy] = opts.directionAt(s.x, s.y)
    let next = { ...s, x: s.x + dx * opts.stepSize, y: s.y + dy * opts.stepSize }
    next = clampToDomain(next, opts.domain.width, opts.domain.height)

    // Re-orient to the local field direction at the (post-move) position, not the pre-move one --
    // this is only ever a function of position, never of the overlap correction that follows.
    const [fx, fy] = opts.directionAt(next.x, next.y)
    if (fx !== 0 || fy !== 0) next = { ...next, theta: Math.atan2(fy, fx) }

    return next
  })

  return resolveOverlaps(moved, opts.domain, opts.maxCorrectionPasses ?? 300, opts.minGap ?? 0)
}
