import { describe, expect, test } from 'bun:test'
import { clusterInit } from './clusterInit'
import { overlapObb } from './sat2d'

describe('clusterInit', () => {
  test('produces the requested count', () => {
    expect(clusterInit(26, 9, 9).length).toBe(26)
  })

  test('is deliberately overlapping when spacing is less than the full square width', () => {
    const squares = clusterInit(9, 9, 9) // spacing 9 < 2*halfSize (18) -> real overlap
    let anyOverlap = false
    for (let i = 0; i < squares.length; i++) {
      for (let j = i + 1; j < squares.length; j++) {
        if (overlapObb(squares[i], squares[j])) anyOverlap = true
      }
    }
    expect(anyOverlap).toBe(true)
  })

  test('is centered at the origin', () => {
    const squares = clusterInit(25, 9, 9)
    const meanX = squares.reduce((sum, s) => sum + s.x, 0) / squares.length
    const meanY = squares.reduce((sum, s) => sum + s.y, 0) / squares.length
    expect(meanX).toBeCloseTo(0, 5)
    expect(meanY).toBeCloseTo(0, 5)
  })
})
