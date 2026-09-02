import { describe, expect, test } from 'bun:test'
import { coverageFraction, isCoverageComplete, makeCoverageGrid, updateCoverageGrid } from './coverageGrid'

describe('coverageGrid', () => {
  test('starts empty', () => {
    const grid = makeCoverageGrid(
      [
        [0, 90],
        [0, 90],
      ],
      10,
    )
    expect(coverageFraction(grid)).toBe(0)
    expect(isCoverageComplete(grid)).toBe(false)
  })

  test('marks the correct cell for a sample and does not mutate the input state', () => {
    let grid = makeCoverageGrid(
      [
        [0, 100],
        [0, 100],
      ],
      10,
    )
    const before = grid
    grid = updateCoverageGrid(grid, [25, 75], 1)
    expect(before.visited[2][7]).toBe(false) // original state untouched
    expect(grid.visited[2][7]).toBe(true)
    expect(coverageFraction(grid)).toBeCloseTo(1 / 100, 5)
  })

  test('drops samples below the confidence threshold', () => {
    let grid = makeCoverageGrid(
      [
        [0, 10],
        [0, 10],
      ],
      5,
    )
    grid = updateCoverageGrid(grid, [5, 5], 0.5, 0.7)
    expect(coverageFraction(grid)).toBe(0)
  })

  test('drops out-of-bounds samples instead of clamping them into an edge cell', () => {
    let grid = makeCoverageGrid(
      [
        [0, 10],
        [0, 10],
      ],
      5,
    )
    grid = updateCoverageGrid(grid, [-5, 5], 1)
    expect(coverageFraction(grid)).toBe(0)
    grid = updateCoverageGrid(grid, [15, 5], 1)
    expect(coverageFraction(grid)).toBe(0)
  })

  test('covering every cell reaches 100% and passes the default 70% completion threshold', () => {
    let grid = makeCoverageGrid(
      [
        [0, 2],
        [0, 2],
      ],
      2,
    )
    for (const i of [0.5, 1.5]) {
      for (const j of [0.5, 1.5]) {
        grid = updateCoverageGrid(grid, [i, j], 1)
      }
    }
    expect(coverageFraction(grid)).toBe(1)
    expect(isCoverageComplete(grid)).toBe(true)
  })

  test('partial coverage below the required fraction does not count as complete', () => {
    let grid = makeCoverageGrid(
      [
        [0, 10],
        [0, 10],
      ],
      10,
    )
    // Visit only 5 of 100 cells.
    for (let k = 0; k < 5; k++) grid = updateCoverageGrid(grid, [k + 0.5, k + 0.5], 1)
    expect(coverageFraction(grid)).toBeCloseTo(0.05, 5)
    expect(isCoverageComplete(grid, 0.7)).toBe(false)
  })
})
