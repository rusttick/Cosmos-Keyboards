/**
 * Running-extremum convergence (Phases 3, 4, 6a — see docs/thumbs/scan3.md).
 *
 * scan_procedure.md's spec: track the running min/max for every joint being swept (not just the
 * phase's nominal target — DIP's own extremum has to converge too, not just PIP's), and declare the
 * sweep complete once the last two repetitions each fail to extend any joint's range by more than a
 * small threshold. If the requested rep count runs out first, prompt for more reps rather than
 * accepting an unconverged bound.
 *
 * Reps are detected from the "primary" joint (angles[0] on every push()) via a hysteresis-based peak
 * detector: a rep completes each time the primary signal rises to a local maximum (a flex apex) and
 * then falls back by more than `peakHysteresis`, confirming the peak wasn't just noise. Troughs don't
 * count as rep boundaries on their own — a full flex-then-extend cycle is one rep, counted at the flex
 * apex, matching the "flex to max, then extend" instruction this detector is built around.
 */

export interface PlateauOptions {
  jointCount: number
  /** Same units as the pushed angles (scan_procedure.md's example is 2deg, so callers pushing radians
   * should convert their threshold accordingly). A rep "converges" a joint if it fails to grow that
   * joint's running range by more than this amount. */
  convergenceThreshold: number
  /** How many of the most recent reps must all show non-growing ranges (every joint) to declare
   * convergence. scan_procedure.md's default is 2. */
  requiredStableReps?: number
  /** Dead-band the primary-joint peak detector must reverse by before confirming a peak/trough, so
   * ordinary frame-to-frame jitter doesn't get counted as a rep boundary. Same units as pushed angles. */
  peakHysteresis: number
}

type Direction = 'unknown' | 'rising' | 'falling'

export class PlateauDetector {
  private min: number[]
  private max: number[]
  /** Range (max-min) snapshots taken after each completed rep. Seeded with an all-zero snapshot so the
   * very first rep's delta is computable without a special case. */
  private repRanges: number[][]
  private direction: Direction = 'unknown'
  private lastPrimary: number | undefined
  private extremePrimary: number | undefined

  constructor(private options: PlateauOptions) {
    this.min = new Array(options.jointCount).fill(Infinity)
    this.max = new Array(options.jointCount).fill(-Infinity)
    this.repRanges = [new Array(options.jointCount).fill(0)]
  }

  push(angles: number[]) {
    for (let i = 0; i < angles.length; i++) {
      if (angles[i] < this.min[i]) this.min[i] = angles[i]
      if (angles[i] > this.max[i]) this.max[i] = angles[i]
    }
    this.updatePeakDetector(angles[0])
  }

  private updatePeakDetector(primary: number) {
    if (this.lastPrimary === undefined) {
      this.lastPrimary = primary
      this.extremePrimary = primary
      return
    }
    if (this.direction === 'unknown') {
      this.direction = primary >= this.lastPrimary ? 'rising' : 'falling'
      this.extremePrimary = primary
    } else if (this.direction === 'rising') {
      if (primary > this.extremePrimary!) {
        this.extremePrimary = primary
      } else if (this.extremePrimary! - primary > this.options.peakHysteresis) {
        this.completeRep() // confirmed peak at extremePrimary -> one flex-to-max cycle done
        this.direction = 'falling'
        this.extremePrimary = primary
      }
    } else {
      if (primary < this.extremePrimary!) {
        this.extremePrimary = primary
      } else if (primary - this.extremePrimary! > this.options.peakHysteresis) {
        this.direction = 'rising' // confirmed trough; doesn't count as a rep boundary itself
        this.extremePrimary = primary
      }
    }
    this.lastPrimary = primary
  }

  private completeRep() {
    this.repRanges.push(this.max.map((m, i) => m - this.min[i]))
  }

  get repCount(): number {
    return this.repRanges.length - 1
  }

  get ranges(): { min: number[]; max: number[] } {
    return { min: [...this.min], max: [...this.max] }
  }

  isConverged(): boolean {
    const n = this.options.requiredStableReps ?? 2
    if (this.repCount < n) return false
    for (let i = this.repRanges.length - n; i < this.repRanges.length; i++) {
      const grew = this.repRanges[i].some((v, j) => v - this.repRanges[i - 1][j] > this.options.convergenceThreshold)
      if (grew) return false
    }
    return true
  }
}
