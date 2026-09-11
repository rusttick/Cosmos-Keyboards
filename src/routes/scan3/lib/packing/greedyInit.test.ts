import { describe, expect, test } from 'bun:test'
import { greedyPlace } from './greedyInit'
import { directionAtAngle, sampleCandidateGrid } from './linearField'
import { insideDomain, overlapObb } from './sat2d'

describe('greedyPlace', () => {
  const domain = { width: 100, height: 100 }
  const halfSize = 9

  test('never places two overlapping squares', () => {
    const candidates = sampleCandidateGrid(domain, directionAtAngle(0), 3)
    const placed = greedyPlace(candidates, halfSize, 20, domain)

    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        expect(overlapObb(placed[i], placed[j])).toBeNull()
      }
    }
  })

  test('every placed square lies fully inside the domain', () => {
    const candidates = sampleCandidateGrid(domain, directionAtAngle(0), 3)
    const placed = greedyPlace(candidates, halfSize, 20, domain)
    for (const s of placed) expect(insideDomain(s, domain.width, domain.height)).toBe(true)
  })

  test('placed squares favor the downhill (lowest-cost) side of the domain', () => {
    const direction = directionAtAngle(0) // downhill = +x
    const candidates = sampleCandidateGrid(domain, direction, 3)
    const placed = greedyPlace(candidates, halfSize, 10, domain)
    const meanX = placed.reduce((sum, s) => sum + s.x, 0) / placed.length
    expect(meanX).toBeGreaterThan(0)
  })

  test('stops early, without error, if the domain cannot fit the requested count', () => {
    const candidates = sampleCandidateGrid(domain, directionAtAngle(0), 3)
    const placed = greedyPlace(candidates, halfSize, 1000, domain)
    expect(placed.length).toBeLessThan(1000)
    expect(placed.length).toBeGreaterThan(0)
  })
})
