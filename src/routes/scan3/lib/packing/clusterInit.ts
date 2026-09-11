/**
 * An alternative starting condition for the interactive stage-1 page, used instead of `greedyInit.ts`'s
 * `greedyPlace`. `greedyPlace` is the faithful port of `key-point-selection.md`'s own Step 3-4 selection
 * logic, but for a *single shared field* (every square scored by the same `linearCost`, unlike the real
 * algorithm's per-finger clouds) it has an awkward consequence: greedy selection already IS the final,
 * fully-resolved packing the moment it finishes, since it never accepts a conflicting candidate in the
 * first place -- there's nothing left for a relaxation loop to do afterward (confirmed live: stepping
 * after `greedyPlace` left every diagnostic unchanged). That makes it a poor initial condition for a tool
 * whose whole purpose is watching structure change *across* iterations.
 *
 * `clusterInit` instead starts every square heavily overlapping in a small, tight starting cluster,
 * deliberately unresolved, so `relax.ts`'s downhill-pull-plus-MTV-correction loop has real, visible work
 * to do over many "Step" clicks -- squares spread apart to relieve initial overlap while also drifting
 * downhill, jamming against each other and the domain wall only after enough iterations. `greedyPlace`
 * itself is left as-is (still correct, still tested, still the right choice for a single-shot,
 * non-interactive placement) -- this is a different initial condition for a different kind of question.
 */
import type { Square2D } from './sat2d'

export function clusterInit(count: number, halfSize: number, spacing: number): Square2D[] {
  const cols = Math.ceil(Math.sqrt(count))
  const squares: Square2D[] = []

  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / cols)
    const col = i % cols
    squares.push({
      x: (col - (cols - 1) / 2) * spacing,
      y: (row - (cols - 1) / 2) * spacing,
      halfSize,
      // `relax.ts` sets this to the local field direction from the first sweep onward; 0 here is just
      // an unposed starting value, not a meaningful orientation.
      theta: 0,
    })
  }

  return squares
}
