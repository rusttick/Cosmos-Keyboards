import { describe, expect, test } from 'bun:test'
import { CONCAVE_BONES, CONVEX_BONES, forwardKinematics } from './fk'

const toDeg = (rad: number) => (rad * 180) / Math.PI

// Reference values from docs/thumbs/key-arrangement-in-3d.md section 6.4, computed for
// B=18.2, w1=14, hf=9.5, hs=6.5, h1=16, w2=14, h2=10, m=0.5 -- the exact numeric cross-check
// the doc's own text and this file's header claim was done, now locked in as a regression test.

describe('CONVEX_BONES', () => {
  test('matches the doc-cited bone constants', () => {
    expect(CONVEX_BONES.L0).toBeCloseTo(18.7, 2)
    expect(toDeg(CONVEX_BONES.psi0)).toBeCloseTo(0, 2)
    expect(CONVEX_BONES.L1).toBeCloseTo(10.218, 3)
    expect(CONVEX_BONES.L2).toBeCloseTo(10.218, 3)
    expect(toDeg(CONVEX_BONES.psi1)).toBeCloseTo(-78.14, 1)
    expect(toDeg(CONVEX_BONES.psi2)).toBeCloseTo(101.86, 1)
  })

  test('alpha_cvx (phi1Max) matches the doc-cited closed form', () => {
    expect(toDeg(CONVEX_BONES.phi1Max)).toBeCloseTo(26.434, 2)
  })

  test('phi1Max + phi2Max is exactly 90 degrees', () => {
    expect(toDeg(CONVEX_BONES.phi1Max + CONVEX_BONES.phi2Max)).toBeCloseTo(90, 6)
  })
})

describe('CONCAVE_BONES', () => {
  test('matches the doc-cited bone constants', () => {
    expect(CONCAVE_BONES.L0).toBeCloseTo(19.797, 3)
    expect(toDeg(CONCAVE_BONES.psi0)).toBeCloseTo(19.17, 1)
    expect(CONCAVE_BONES.L1).toBeCloseTo(9.729, 3)
    expect(toDeg(CONCAVE_BONES.psi1)).toBeCloseTo(77.54, 1)
    expect(CONCAVE_BONES.L2).toBeCloseTo(16.137, 3)
    expect(toDeg(CONCAVE_BONES.psi2)).toBeCloseTo(-97.48, 1)
  })

  test('alpha_ccv (phi1Max) matches the doc-cited closed-form root', () => {
    // The closed form has two roots (+/- acos); only the smaller positive one (the first
    // crossing of |D0 + R(gamma)*u| = m as gamma increases from 0) is the physically correct
    // pivot angle. This pins down that fk.ts picked the right sign, not just a valid one.
    expect(toDeg(CONCAVE_BONES.phi1Max)).toBeCloseTo(24.93, 1)
  })

  test('alpha_ccv is the smallest positive angle solving the defining distance condition', () => {
    // Brute-force the actual condition section 6.4 defines alpha_ccv by (|D0 + R(gamma)*u| = m)
    // and confirm the closed form's root is the first crossing, independent of the closed-form
    // derivation itself -- an independent check, not a restatement of the formula under test.
    const B = 18.2, w1 = 14, hf = 9.5, m = 0.5
    const u = { x: (B - w1) / 2, y: hf }
    const D0 = { x: (B - w1) / 2 + m, y: -hf }
    function rot(v: { x: number; y: number }, g: number) {
      const c = Math.cos(g), s = Math.sin(g)
      return { x: c * v.x - s * v.y, y: s * v.x + c * v.y }
    }
    let bruteForceGamma = NaN
    for (let i = 0; i <= 200000; i++) {
      const g = (i / 200000) * (Math.PI / 2)
      const ru = rot(u, g)
      const d = Math.hypot(D0.x + ru.x, D0.y + ru.y)
      if (Math.abs(d - m) < 0.001) {
        bruteForceGamma = g
        break
      }
    }
    expect(bruteForceGamma).not.toBeNaN()
    expect(toDeg(CONCAVE_BONES.phi1Max)).toBeCloseTo(toDeg(bruteForceGamma), 1)
  })

  test('phi1Max + phi2Max is exactly 90 degrees', () => {
    expect(toDeg(CONCAVE_BONES.phi1Max + CONCAVE_BONES.phi2Max)).toBeCloseTo(90, 6)
  })
})

describe('forwardKinematics', () => {
  test('convex, phi1=phi2=0 (Flat Case) places key 2 at (B+m, 0), unrotated', () => {
    const pose = forwardKinematics('convex', 0, 0)
    expect(pose.x).toBeCloseTo(18.7, 6)
    expect(pose.z).toBeCloseTo(0, 6)
    expect(pose.angle).toBeCloseTo(0, 6)
  })

  test('concave, phi1=phi2=0 (Flat Case) places key 2 at the same point as convex', () => {
    // Both bend directions start from the same rigid Flat Case placement -- the 3-bone chain
    // is a different decomposition of the same starting geometry, so phi1=phi2=0 must agree.
    const convex = forwardKinematics('convex', 0, 0)
    const concave = forwardKinematics('concave', 0, 0)
    expect(concave.x).toBeCloseTo(convex.x, 6)
    expect(concave.z).toBeCloseTo(convex.z, 6)
  })

  test('orientation is exactly linear in the joint angles (T(i+1) = Ti + sign*(phi1+phi2))', () => {
    const phi1 = 0.2, phi2 = 0.15
    const convex = forwardKinematics('convex', phi1, phi2)
    const concave = forwardKinematics('concave', phi1, phi2)
    expect(convex.angle).toBeCloseTo(-(phi1 + phi2), 9) // convex sign = -1 (clockwise)
    expect(concave.angle).toBeCloseTo(phi1 + phi2, 9) // concave sign = +1 (counter-clockwise)
  })

  test('convex, full range (phi1=phi1Max, phi2=phi2Max) reaches the documented 90 degree total rotation', () => {
    const pose = forwardKinematics('convex', CONVEX_BONES.phi1Max, CONVEX_BONES.phi2Max)
    expect(toDeg(pose.angle)).toBeCloseTo(-90, 6)
  })

  test('concave, full range (phi1=phi1Max, phi2=phi2Max) reaches the documented 90 degree total rotation', () => {
    const pose = forwardKinematics('concave', CONCAVE_BONES.phi1Max, CONCAVE_BONES.phi2Max)
    expect(toDeg(pose.angle)).toBeCloseTo(90, 6)
  })
})
