/**
 * Grid/region-visitation convergence (Phases 5, 6b — see docs/thumbs/scan3.md).
 *
 * scan_procedure.md's Phase 5 spec: bin the (θ_i, θ_j) space into a grid; wherever the trajectory,
 * despite otherwise broad coverage, never visited a region, that gap is the measured constraint —
 * geometric blocking and passive mechanical coupling both show up this way, with no finger-width
 * guess needed. Completion is declared once a minimum fraction of cells (e.g. 70%) have at least one
 * confidence-passing sample.
 *
 * Bounds are fixed at grid creation, not grown adaptively — by the time Phase 5 runs, each finger's
 * own ROM is already established from Phases 3/4, so the (θ_i, θ_j) extent is known going in. This is
 * a narrower scope than scan_procedure.md's Phase 4 abduction capture (which does grow its bounds
 * live, since it has no prior ROM to anchor to) — deliberately not replicated here since Phase 5 does
 * have that anchor.
 */

export interface CoverageGridState {
  visited: boolean[][] // [row][col], row = axis i, col = axis j
  bounds: [[number, number], [number, number]] // [[iMin, iMax], [jMin, jMax]]
}

export function makeCoverageGrid(bounds: [[number, number], [number, number]], resolution: number): CoverageGridState {
  if (resolution < 1) throw new Error('makeCoverageGrid needs a resolution of at least 1')
  return {
    visited: Array.from({ length: resolution }, () => new Array(resolution).fill(false)),
    bounds,
  }
}

/** Marks the cell containing `sample` as visited, if the sample clears `confidenceThreshold` and
 * falls within the grid's bounds (out-of-bounds samples are silently dropped rather than clamped
 * into an edge cell, since a value outside the established ROM is more likely a bad frame than a
 * genuine new extreme once Phase 5 has anchored bounds to Phases 3/4's results). Returns a new state
 * (existing `visited` rows are not mutated) so callers can use it in a reactive/Svelte context the
 * same way `PlateauDetector`'s sibling functions in this directory do. */
export function updateCoverageGrid(
  state: CoverageGridState,
  sample: [number, number],
  confidence: number,
  confidenceThreshold = 0.7,
): CoverageGridState {
  if (confidence < confidenceThreshold) return state

  const [[iMin, iMax], [jMin, jMax]] = state.bounds
  const [i, j] = sample
  if (i < iMin || i > iMax || j < jMin || j > jMax) return state

  const resolution = state.visited.length
  const row = Math.min(resolution - 1, Math.floor(((i - iMin) / (iMax - iMin)) * resolution))
  const col = Math.min(resolution - 1, Math.floor(((j - jMin) / (jMax - jMin)) * resolution))

  if (state.visited[row][col]) return state // already visited -- no new array needed

  const visited = state.visited.map((r) => [...r])
  visited[row][col] = true
  return { ...state, visited }
}

export function coverageFraction(state: CoverageGridState): number {
  let visitedCount = 0
  let total = 0
  for (const row of state.visited) {
    total += row.length
    visitedCount += row.filter(Boolean).length
  }
  return total === 0 ? 0 : visitedCount / total
}

/** scan_procedure.md's completion criterion: a minimum fraction of cells (default 70%) visited. */
export function isCoverageComplete(state: CoverageGridState, requiredFraction = 0.7): boolean {
  return coverageFraction(state) >= requiredFraction
}
