/**
 * Low-variance-window extraction (Phase 2, Phase 3 comfortable tier — see docs/thumbs/scan3.md).
 *
 * scan_procedure.md's spec: record a several-second hold, discard an initial settling period, then
 * search for a contiguous sub-window of at least `minDuration` seconds where frame-to-frame velocity
 * stays under a threshold throughout. If more than one such window exists, prefer the lowest-variance
 * one. If none exists, the hold wasn't still enough — ask for a longer or steadier hold rather than
 * silently averaging over movement.
 */

export interface StillWindowSample {
  t: number // seconds, monotonically increasing
  values: number[] // e.g. per-joint angles in radians, or any tracked vector — same length every sample
}

export interface StillWindowOptions {
  /** Minimum window duration, in seconds, to accept as "still." */
  minDuration: number
  /** Max allowed frame-to-frame velocity (units of `values` per second, Euclidean norm of the delta)
   * for two consecutive samples to count as part of the same still run. */
  velocityThreshold: number
  /** Seconds to discard from the start of `samples` before searching, since the first moments of a
   * hold are typically still-settling. Default 0.5s, matching scan_procedure.md's resting-posture spec. */
  warmup?: number
}

export type StillWindowResult =
  | {
    found: true
    startIndex: number
    endIndex: number // inclusive
    startTime: number
    endTime: number
    /** Per-component mean over the window — the value the calling phase should actually record. */
    mean: number[]
  }
  | { found: false }

/** Max per-component velocity, not a combined Euclidean-norm velocity across all tracked dimensions.
 * A combined norm scales with sqrt(dimension count), so the same "how still is this" threshold would
 * mean something different depending on how many joints happen to be tracked — max-per-component
 * doesn't have that problem, and better matches "no single joint is moving much," which is what
 * "still" actually means. (Found the hard way: an earlier combined-norm version made even genuine
 * stillness untrackable, since ordinary per-frame MediaPipe noise alone — using Test 1's own
 * established ~1.5-2.5deg per-joint noise floor — already produces a combined-norm velocity in the
 * 100+ deg/s range with 3 joints tracked, regardless of any real movement. See
 * docs/thumbs/test_results.md.) */
function velocity(a: StillWindowSample, b: StillWindowSample): number {
  const dt = b.t - a.t
  if (dt <= 0) return Infinity
  let maxAbsDelta = 0
  for (let i = 0; i < a.values.length; i++) {
    const d = Math.abs(b.values[i] - a.values[i])
    if (d > maxAbsDelta) maxAbsDelta = d
  }
  return maxAbsDelta / dt
}

function meanAndVariance(samples: StillWindowSample[], start: number, end: number): { mean: number[]; variance: number } {
  const n = end - start + 1
  const dims = samples[start].values.length
  const mean = new Array(dims).fill(0)
  for (let i = start; i <= end; i++) {
    for (let d = 0; d < dims; d++) mean[d] += samples[i].values[d] / n
  }
  let variance = 0
  for (let i = start; i <= end; i++) {
    for (let d = 0; d < dims; d++) {
      const diff = samples[i].values[d] - mean[d]
      variance += (diff * diff) / n
    }
  }
  variance /= dims // mean per-component variance, so it's comparable across different `values` lengths
  return { mean, variance }
}

/** Slides a fixed-duration (`minDuration`) window across `samples` (after discarding `warmup`),
 * keeping every placement where frame-to-frame velocity stays under `velocityThreshold` throughout,
 * and returns the lowest-variance one. */
export function findStillWindow(
  samples: StillWindowSample[],
  options: StillWindowOptions,
): StillWindowResult {
  const warmup = options.warmup ?? 0.5
  if (samples.length < 2) return { found: false }

  const t0 = samples[0].t
  const startIdx = samples.findIndex((s) => s.t - t0 >= warmup)
  if (startIdx === -1 || startIdx >= samples.length - 1) return { found: false }

  let best: { start: number; end: number; variance: number } | undefined

  for (let start = startIdx; start < samples.length; start++) {
    // Find the smallest `end` reaching minDuration from `start`.
    let end = start
    while (end < samples.length - 1 && samples[end].t - samples[start].t < options.minDuration) end++
    if (samples[end].t - samples[start].t < options.minDuration) break // ran out of samples

    // Check every consecutive pair in [start, end] stays under the velocity threshold.
    let stillThroughout = true
    for (let i = start; i < end; i++) {
      if (velocity(samples[i], samples[i + 1]) > options.velocityThreshold) {
        stillThroughout = false
        break
      }
    }
    if (!stillThroughout) continue

    const { variance } = meanAndVariance(samples, start, end)
    if (!best || variance < best.variance) best = { start, end, variance }
  }

  if (!best) return { found: false }
  const { mean } = meanAndVariance(samples, best.start, best.end)
  return {
    found: true,
    startIndex: best.start,
    endIndex: best.end,
    startTime: samples[best.start].t,
    endTime: samples[best.end].t,
    mean,
  }
}
