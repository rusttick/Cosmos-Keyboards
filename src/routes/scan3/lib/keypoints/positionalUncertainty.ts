/**
 * Stage 8 of docs/thumbs/representing-keyboard-build-inputs.md: positional uncertainty -- how much
 * physical position spread is consistent with the current (possibly still-wide) posterior, per
 * `key-point-selection.md`'s Step 2 ("propagate the posterior's covariance... through the same
 * Jacobian to get the spread of physical positions consistent with the current hand-model state").
 *
 * Each joint's own variance (`sdDeg` squared, converted to radians) is propagated independently --
 * cross-joint covariance is dropped, the same per-DOF-independent simplification `postureCost.ts`'s
 * doc comment already names for this codebase. The result is summarized as one scalar (the trace of
 * the propagated 3x3 covariance, i.e. the sum of the x/y/z position-variance components) rather than a
 * full ellipsoid -- sufficient for a single color/brightness channel; a caller that later needs the
 * actual ellipsoid shape (for Step 3's exclusion-radius inflation) would want the full matrix, not
 * built here since nothing yet consumes it.
 */
const DEG2RAD = Math.PI / 180

/**
 * Propagates each free joint's own variance (`sdDeg`, in degrees) through `jacobian` (3 x N, from
 * `numericalJacobian`) via `Var(position) ≈ J · diag(σ²) · Jᵀ`, and returns the trace of that 3x3
 * result -- the total propagated positional variance (mm², summed across x/y/z), a rougher-is-fine
 * "how uncertain is this sample's position" scalar.
 */
export function propagatedPositionalVariance(jacobian: number[][], sdDeg: number[]): number {
  const varianceRad2 = sdDeg.map((sd) => (sd * DEG2RAD) ** 2)
  let trace = 0

  for (let row = 0; row < 3; row++) {
    for (let k = 0; k < varianceRad2.length; k++) {
      trace += jacobian[row][k] * jacobian[row][k] * varianceRad2[k]
    }
  }

  return trace
}
