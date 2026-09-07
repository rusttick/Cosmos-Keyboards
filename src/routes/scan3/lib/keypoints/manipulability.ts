/**
 * Stage 8 of docs/thumbs/representing-keyboard-build-inputs.md: a numerical Jacobian and Yoshikawa's
 * manipulability index, reused as-is from `docs/thumbs/scan-utility-evaluation.md`'s own Category 2
 * machinery ("nothing in this codebase computes a Jacobian today... a numerical Jacobian -- perturb one
 * free angle by a small epsilon, re-run FK, take the finite-difference derivative -- is cheap to bolt
 * onto the same sampling loop") -- `key-point-selection.md`'s Step 2 names this doc as the source for
 * exactly this construction, so it's implemented once here rather than re-derived per sampler.
 *
 * Generic over `positionAt`, so any sampler's own FK wrapper (however it maps its particular free
 * angles -- and any derived, non-free ones like DIP -- to a fingertip position) can reuse this
 * unchanged.
 */
import type { Vector3Tuple } from 'three'

/**
 * Central-difference numerical Jacobian of `positionAt` (task space, always 3 rows here) with respect
 * to `anglesRad` (however many free joint angles the caller's FK wrapper takes). Returns a 3 x N
 * matrix, rows x/y/z, one column per free angle.
 */
export function numericalJacobian(
  positionAt: (anglesRad: number[]) => Vector3Tuple,
  anglesRad: number[],
  epsilonRad = 1e-4,
): number[][] {
  const jacobian: number[][] = [[], [], []]

  for (let col = 0; col < anglesRad.length; col++) {
    const plus = anglesRad.slice()
    plus[col] += epsilonRad
    const minus = anglesRad.slice()
    minus[col] -= epsilonRad

    const pPlus = positionAt(plus)
    const pMinus = positionAt(minus)

    for (let row = 0; row < 3; row++) {
      jacobian[row].push((pPlus[row] - pMinus[row]) / (2 * epsilonRad))
    }
  }

  return jacobian
}

function determinant3x3(m: number[][]): number {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  )
}

/**
 * Yoshikawa's manipulability index `w(q) = sqrt(det(J·Jᵀ))` -- high values mean the fingertip can move
 * freely in many directions from this pose, low values mean it's near a kinematic singularity.
 *
 * `jacobian` is always 3 rows (task space) here; `det(J·Jᵀ)` is a genuine 3x3 determinant regardless of
 * how many columns (free angles) `jacobian` has. When there are fewer than 3 free angles (Stage 3's
 * MCP-only shell, Stage 6's thumb-CMC-only shell), `J·Jᵀ` is necessarily rank-deficient and this
 * correctly returns 0 everywhere -- a genuine, not a buggy, zero: a 2-DOF mechanism truly cannot move
 * independently in all 3 task-space directions, so its local motion is confined to a 2D tangent
 * surface, not a 3D volume.
 */
export function yoshikawaManipulability(jacobian: number[][]): number {
  const jjt: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  const cols = jacobian[0]?.length ?? 0

  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let sum = 0
      for (let k = 0; k < cols; k++) sum += jacobian[i][k] * jacobian[j][k]
      jjt[i][j] = sum
    }
  }

  return Math.sqrt(Math.max(0, determinant3x3(jjt)))
}
