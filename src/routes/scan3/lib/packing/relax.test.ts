import { describe, expect, test } from 'bun:test'
import { clusterInit } from './clusterInit'
import { greedyPlace } from './greedyInit'
import { constantDirectionAt, directionAtAngle, sampleCandidateGrid } from './linearField'
import { radialDirectionAt } from './radialField'
import { relaxStep } from './relax'
import { insideDomain, obbGap, overlapObb, type Square2D } from './sat2d'

// An iterative, floating-point positional solver can't guarantee an exact mathematical zero -- only an
// overlap below some tolerance (`sat2d.ts`'s own `SEPARATION_EPSILON` already treats a small-enough
// overlap as resolved internally). 1e-3mm is four orders of magnitude below the square sizes these tests
// use (9mm half-size) -- comfortably "not a real overlap" without demanding literal floating-point zero.
const NEGLIGIBLE_OVERLAP_MM = 1e-3

function expectNoRealOverlap(a: Square2D, b: Square2D, minGap = 0) {
  const overlap = overlapObb(a, b, minGap)
  if (overlap) expect(Math.hypot(overlap.mtv[0], overlap.mtv[1])).toBeLessThan(NEGLIGIBLE_OVERLAP_MM)
}

describe('relaxStep with a uniform (linear-gradient) direction', () => {
  const domain = { width: 100, height: 100 }
  const halfSize = 9
  const direction = directionAtAngle(0)
  const directionAt = constantDirectionAt(direction)

  function initial() {
    const candidates = sampleCandidateGrid(domain, direction, 3)
    return greedyPlace(candidates, halfSize, 12, domain)
  }

  test('never leaves two squares overlapping after one sweep', () => {
    let squares = initial()
    for (let step = 0; step < 20; step++) {
      squares = relaxStep(squares, { directionAt, stepSize: 1, domain })
      for (let i = 0; i < squares.length; i++) {
        for (let j = i + 1; j < squares.length; j++) {
          expectNoRealOverlap(squares[i], squares[j])
        }
      }
    }
  })

  test('never pushes a square outside the domain', () => {
    let squares = initial()
    for (let step = 0; step < 20; step++) {
      squares = relaxStep(squares, { directionAt, stepSize: 1, domain })
      for (const s of squares) expect(insideDomain(s, domain.width, domain.height)).toBe(true)
    }
  })

  test('the pack moves downhill over repeated steps, then stops advancing once jammed', () => {
    let squares = initial()
    const meanX = (sqs: typeof squares) => sqs.reduce((sum, s) => sum + s.x, 0) / sqs.length
    const before = meanX(squares)

    for (let step = 0; step < 5; step++) squares = relaxStep(squares, { directionAt, stepSize: 1, domain })
    const afterFew = meanX(squares)
    expect(afterFew).toBeGreaterThan(before)

    for (let step = 0; step < 100; step++) squares = relaxStep(squares, { directionAt, stepSize: 1, domain })
    const afterMany = meanX(squares)
    const veryFinal = meanX(relaxStep(squares, { directionAt, stepSize: 1, domain }))
    // Once jammed against the domain's downhill wall, one more sweep shouldn't move the pack further.
    expect(Math.abs(veryFinal - afterMany)).toBeLessThan(1e-6)
  })

  test('a symmetric starting cluster just translates rigidly -- confirmed live, and why the interactive page moved to a radial field', () => {
    // Every square feels the exact same direction, so a perfectly regular seed (`clusterInit`) has
    // nothing to break its own internal symmetry -- it should end up translated, not rearranged.
    const squares = clusterInit(9, 9, 20) // spacing 20 > 2*halfSize (18): already non-overlapping
    let relaxed = squares
    for (let step = 0; step < 10; step++) {
      relaxed = relaxStep(relaxed, { directionAt, stepSize: 1, domain: { width: 400, height: 400 } })
    }
    // Every square's displacement from its own start should be identical (a rigid translation), not
    // just similar -- overlap correction never has anything to do here, since spacing already exceeds
    // the square width.
    const displacements = relaxed.map((s, i) => [s.x - squares[i].x, s.y - squares[i].y])
    for (const [dx, dy] of displacements) {
      expect(dx).toBeCloseTo(displacements[0][0], 5)
      expect(dy).toBeCloseTo(displacements[0][1], 5)
    }
  })
})

describe('relaxStep leaves no overlap, even under heavy multi-body contention', () => {
  test('many squares converging on one center point end up fully non-overlapping', () => {
    // Deliberately adversarial for a single-pass corrector: every square is pulled toward the same
    // point, so lots of squares contend for the same small region simultaneously -- exactly the
    // situation where correcting against one neighbor can reintroduce an overlap with another that a
    // single Gauss-Seidel pass already "fixed" earlier in that same pass.
    const domain = { width: 300, height: 300 }
    const directionAt = radialDirectionAt([0, 0])
    let squares = clusterInit(30, 9, 9) // heavily overlapping to start

    for (let step = 0; step < 15; step++) {
      squares = relaxStep(squares, { directionAt, stepSize: 4, domain })
    }

    for (let i = 0; i < squares.length; i++) {
      for (let j = i + 1; j < squares.length; j++) {
        expectNoRealOverlap(squares[i], squares[j])
      }
    }
  })

  test('a low maxCorrectionPasses budget can still leave overlap -- confirming what the higher default fixes', () => {
    const domain = { width: 300, height: 300 }
    const directionAt = radialDirectionAt([0, 0])
    let squares = clusterInit(30, 9, 9)

    for (let step = 0; step < 15; step++) {
      squares = relaxStep(squares, { directionAt, stepSize: 4, domain, maxCorrectionPasses: 1 })
    }

    const anyOverlap = squares.some((a, i) => squares.some((b, j) => i !== j && overlapObb(a, b) !== null))
    expect(anyOverlap).toBe(true)
  })
})

describe('relaxStep with a required minGap', () => {
  test('a settled pack ends up at least minGap apart everywhere, not just non-overlapping', () => {
    const domain = { width: 300, height: 300 }
    const directionAt = radialDirectionAt([0, 0])
    const minGap = 3
    let squares = clusterInit(30, 9, 9)

    for (let step = 0; step < 15; step++) {
      squares = relaxStep(squares, { directionAt, stepSize: 4, domain, minGap })
    }

    for (let i = 0; i < squares.length; i++) {
      for (let j = i + 1; j < squares.length; j++) {
        expectNoRealOverlap(squares[i], squares[j], minGap)
      }
    }
  })

  test('a nonzero minGap makes the pack measurably less tight than minGap=0, given the same field', () => {
    const domain = { width: 300, height: 300 }
    const directionAt = radialDirectionAt([0, 0])

    function settle(minGap: number) {
      let squares = clusterInit(30, 9, 9)
      for (let step = 0; step < 15; step++) {
        squares = relaxStep(squares, { directionAt, stepSize: 4, domain, minGap })
      }
      return squares
    }

    const meanGap = (squares: Square2D[]) => {
      let total = 0
      let count = 0
      for (let i = 0; i < squares.length; i++) {
        for (let j = i + 1; j < squares.length; j++) {
          total += obbGap(squares[i], squares[j])
          count++
        }
      }
      return total / count
    }

    expect(meanGap(settle(3))).toBeGreaterThan(meanGap(settle(0)))
  })
})

describe('relaxStep with a radial (center-point) direction', () => {
  test('a symmetric starting cluster does NOT just translate rigidly -- squares on opposite sides move toward each other', () => {
    const domain = { width: 400, height: 400 }
    // Off-center on purpose: a center coinciding with the cluster's own centroid would keep the whole
    // setup symmetric under the field's own reflection symmetry, which could still hide real
    // rearrangement behind an accidental residual symmetry.
    const center: [number, number] = [40, -25]
    const directionAt = radialDirectionAt(center)
    const squares = clusterInit(9, 9, 20) // 3x3 grid, already non-overlapping (spacing > 2*halfSize)

    let relaxed = squares
    for (let step = 0; step < 10; step++) {
      relaxed = relaxStep(relaxed, { directionAt, stepSize: 1, domain })
    }

    const displacements = squares.map((s, i) => [relaxed[i].x - s.x, relaxed[i].y - s.y])
    const allSame = displacements.every(
      ([dx, dy]) => Math.abs(dx - displacements[0][0]) < 1e-6 && Math.abs(dy - displacements[0][1]) < 1e-6,
    )
    expect(allSame).toBe(false)
  })
})
