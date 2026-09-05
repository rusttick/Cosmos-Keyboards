/** Despike + One Euro filtering for MediaPipe's raw per-frame landmark output.
 *
 * Meant to be applied once, upstream of makeHand() (in detector.ts), so every consumer -- the overlay,
 * bone lengths, joint angles, orientation -- benefits from one filter instead of each capture page
 * inventing its own page-local smoother over a derived angle (see docs/thumbs/test_results.md's several
 * duplicated `makeSmoother()` instances this replaces). The scanning motion this is built for is slow
 * and full-range-of-motion, which is the favorable case for heavy smoothing: there's little real
 * high-frequency signal to lose, so cutoffs can be biased low without costing much lag.
 */

/** Exponential low-pass filter with a caller-supplied alpha each call (so the "One Euro" adaptive
 * cutoff above it can vary alpha frame to frame). */
class LowPass {
  private y = 0
  private initialized = false

  filter(value: number, alpha: number): number {
    this.y = this.initialized ? alpha * value + (1 - alpha) * this.y : value
    this.initialized = true
    return this.y
  }

  get last(): number | undefined {
    return this.initialized ? this.y : undefined
  }

  reset() {
    this.initialized = false
  }
}

export interface OneEuroOptions {
  /** Minimum cutoff frequency (Hz) -- lower means heavier smoothing when the signal is nearly still.
   * Biased low by default since the intended scanning motion is slow; needs live tuning against real
   * capture like every other threshold in this project, not trusted as a final answer. */
  minCutoff?: number
  /** How much the cutoff opens up as estimated speed increases -- higher tracks fast motion more
   * faithfully at the cost of less smoothing while it's happening. */
  beta?: number
  /** Cutoff for the derivative estimate used to drive beta. Rarely needs tuning. */
  derivativeCutoff?: number
}

// Live-tuned against real capture on flexion-sweep, 2026-09-04 -- not a first-principles guess.
// Exported so a page without its own tuning UI (e.g. thumb-cmc) can derive things like a display
// refresh rate from the same canonical value instead of duplicating the number.
export const DEFAULT_ONE_EURO_OPTIONS: Required<OneEuroOptions> = {
  minCutoff: 2,
  beta: 0.1,
  derivativeCutoff: 1,
}
const DEFAULT_OPTIONS = DEFAULT_ONE_EURO_OPTIONS

/** The "1€ Filter" (Casiez, Roussel, Vogel 2012): a low-pass filter whose cutoff adapts to estimated
 * speed, so it smooths hard when a signal is nearly still and loosens up when it's moving fast enough
 * that smoothing would introduce visible lag. Uses real elapsed time between samples (not an assumed
 * fixed frame rate) so a dropped-frame gap doesn't get misread as a burst of fast motion. */
export class OneEuroFilter {
  private readonly opts: Required<OneEuroOptions>
  private readonly xFilter = new LowPass()
  private readonly dxFilter = new LowPass()
  private lastTime: number | undefined

  constructor(opts: OneEuroOptions = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts }
  }

  private alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff)
    return 1 / (1 + tau / dt)
  }

  /** `t` is a timestamp in seconds on any monotonic clock (e.g. elapsed session time) -- only
   * differences between successive calls matter. */
  filter(value: number, t: number): number {
    if (this.lastTime === undefined) {
      this.lastTime = t
      return this.xFilter.filter(value, 1)
    }
    const dt = Math.max(t - this.lastTime, 1e-6)
    this.lastTime = t
    const prev = this.xFilter.last
    const dvalue = prev === undefined ? 0 : (value - prev) / dt
    const edvalue = this.dxFilter.filter(dvalue, this.alpha(this.opts.derivativeCutoff, dt))
    const cutoff = this.opts.minCutoff + this.opts.beta * Math.abs(edvalue)
    return this.xFilter.filter(value, this.alpha(cutoff, dt))
  }

  reset() {
    this.xFilter.reset()
    this.dxFilter.reset()
    this.lastTime = undefined
  }
}

/** Rejects a single-sample spike by outputting the median of the last 3 raw samples instead of the
 * newest one directly -- a lone bad frame (a not-uncommon MediaPipe glitch at fast or unusual poses;
 * see test_results.md's several "one bad frame corrupts a running max forever" findings) gets outvoted
 * by its two neighbors instead of passed straight through into the One Euro filter's state. Adds one
 * sample of lag, negligible given how slow the intended scanning motion is. */
class Despike {
  private buf: number[] = []

  push(value: number): number {
    this.buf.push(value)
    if (this.buf.length > 3) this.buf.shift()
    if (this.buf.length < 3) return value
    const [a, b, c] = this.buf
    return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c))
  }

  reset() {
    this.buf = []
  }
}

class CoordinateFilter {
  private readonly despike = new Despike()
  private readonly euro: OneEuroFilter
  private lastUpdateTime: number | undefined

  constructor(opts: OneEuroOptions, private readonly maxGapSeconds: number) {
    this.euro = new OneEuroFilter(opts)
  }

  update(value: number, t: number): number {
    if (this.lastUpdateTime !== undefined && t - this.lastUpdateTime > this.maxGapSeconds) {
      this.despike.reset()
      this.euro.reset()
    }
    this.lastUpdateTime = t
    return this.euro.filter(this.despike.push(value), t)
  }

  reset() {
    this.despike.reset()
    this.euro.reset()
    this.lastUpdateTime = undefined
  }
}

export interface LandmarkFilterOptions extends OneEuroOptions {
  /** A gap since a landmark's last update longer than this resets its despike/One-Euro state instead
   * of filtering the resumed signal against stale history -- the same "reset rather than fight a gap"
   * pattern as detector.reset() after a stall. Default is roughly 3 dropped frames at 30fps; needs live
   * tuning like every other threshold in this project. */
  maxGapSeconds?: number
}

/** Despike + One Euro filtering applied per-landmark, per-coordinate. One instance should be created
 * per landmark set (`keypoints` vs `keypoints3D`) per hand-tracking session and reused frame to frame
 * -- it's stateful, not a pure function. */
export class LandmarkFilter {
  private readonly maxGapSeconds: number
  private readonly opts: OneEuroOptions
  private coords: CoordinateFilter[][] = [] // [landmarkIndex][xyz]

  constructor(opts: LandmarkFilterOptions = {}) {
    const { maxGapSeconds = 0.15, ...rest } = opts
    this.maxGapSeconds = maxGapSeconds
    this.opts = rest
  }

  private ensureSize(n: number) {
    while (this.coords.length < n) {
      this.coords.push([
        new CoordinateFilter(this.opts, this.maxGapSeconds),
        new CoordinateFilter(this.opts, this.maxGapSeconds),
        new CoordinateFilter(this.opts, this.maxGapSeconds),
      ])
    }
  }

  /** Returns a new array of landmarks with x/y/z despiked and One-Euro filtered; `t` is a timestamp in
   * seconds shared across the whole landmark list (they're all sampled at the same instant). */
  filter<T extends { x: number; y: number; z: number }>(landmarks: T[], t: number): T[] {
    this.ensureSize(landmarks.length)
    return landmarks.map((lm, i) => ({
      ...lm,
      x: this.coords[i][0].update(lm.x, t),
      y: this.coords[i][1].update(lm.y, t),
      z: this.coords[i][2].update(lm.z, t),
    }))
  }

  reset() {
    for (const [x, y, z] of this.coords) {
      x.reset()
      y.reset()
      z.reset()
    }
  }
}
