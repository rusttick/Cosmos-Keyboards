/**
 * A field pointing toward a fixed center point, per `capability-packing.md`'s "Staged field progression"
 * (originally its "spherical field intersecting the plane" stage, promoted ahead of the uniform-gradient
 * one -- see `relax.ts`'s doc comment for why: a constant direction applied to `clusterInit.ts`'s
 * symmetric starting cluster just translates it rigidly, with no internal rearrangement to observe at
 * all, confirmed live). Unlike a uniform gradient, every square here feels a genuinely different pull
 * direction depending on its own position relative to `center` -- opposite sides of the cluster are
 * pulled toward each other, not in parallel, so relaxation actually has to reorganize the pack, not just
 * carry it along.
 */

/** Cost increases with distance from `center` -- "downhill" means moving toward it. */
export function radialCost(x: number, y: number, center: [number, number]): number {
  return Math.hypot(x - center[0], y - center[1])
}

/** A `directionAt` function (for `relax.ts`'s `RelaxOptions`) pointing from any position toward `center`.
 * Returns the zero vector exactly at the center, since there's nowhere further downhill to go from
 * there. */
export function radialDirectionAt(center: [number, number]): (x: number, y: number) => [number, number] {
  return (x, y) => {
    const dx = center[0] - x
    const dy = center[1] - y
    const len = Math.hypot(dx, dy)
    return len > 1e-9 ? [dx / len, dy / len] : [0, 0]
  }
}
