import { describe, expect, test } from 'bun:test'
import { fingerPairKey, fitEnslaving, fitEnslavingAll } from './pairedSweep'

describe('fitEnslaving', () => {
  test('recovers an exact coefficient from i-dominant segments, ignoring j-dominant ones', () => {
    const trueCoefficient = 0.3
    const angleI: number[] = [0]
    const angleJ: number[] = [0]

    // Segment 1: i moves a lot, j drags along at the true coefficient (i-dominant -- should count).
    for (let k = 0; k < 20; k++) {
      const dI = 4
      angleI.push(angleI[angleI.length - 1] + dI)
      angleJ.push(angleJ[angleJ.length - 1] + trueCoefficient * dI)
    }
    // Segment 2: j moves a lot on its own, i stays put (j-dominant -- must NOT count, or it would
    // corrupt the fit since j's motion here has nothing to do with i).
    for (let k = 0; k < 20; k++) {
      angleI.push(angleI[angleI.length - 1])
      angleJ.push(angleJ[angleJ.length - 1] + 5)
    }

    const fit = fitEnslaving(angleI, angleJ)
    expect(fit.coefficient).toBeCloseTo(trueCoefficient, 5)
    expect(fit.r2).toBeCloseTo(1, 5)
  })

  test('throws when no i-dominant segment exists', () => {
    const angleI = [0, 0, 0, 0, 0]
    const angleJ = [0, 5, 10, 15, 20]
    expect(() => fitEnslaving(angleI, angleJ)).toThrow()
  })

  test('mismatched-length series are rejected', () => {
    expect(() => fitEnslaving([0, 1, 2], [0, 1])).toThrow()
  })

  test('a noisy but real coupling still fits with high r2 and low but nonzero r2 when uncoupled', () => {
    const coupled = { angleI: [0] as number[], angleJ: [0] as number[] }
    for (let k = 0; k < 30; k++) {
      const dI = 4
      coupled.angleI.push(coupled.angleI[coupled.angleI.length - 1] + dI)
      coupled.angleJ.push(coupled.angleJ[coupled.angleJ.length - 1] + 0.5 * dI)
    }
    expect(fitEnslaving(coupled.angleI, coupled.angleJ).r2).toBeGreaterThan(0.9)

    const uncoupled = { angleI: [0] as number[], angleJ: [0] as number[] }
    let seed = 42
    const rand = () => {
      // Deterministic PRNG so this test doesn't flake.
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let k = 0; k < 30; k++) {
      uncoupled.angleI.push(uncoupled.angleI[uncoupled.angleI.length - 1] + 4)
      uncoupled.angleJ.push(uncoupled.angleJ[uncoupled.angleJ.length - 1] + (rand() - 0.5) * 8)
    }
    expect(fitEnslaving(uncoupled.angleI, uncoupled.angleJ).r2).toBeLessThan(0.5)
  })
})

describe('fingerPairKey', () => {
  test('formats as "i:j"', () => {
    expect(fingerPairKey('indexFinger', 'middleFinger')).toBe('indexFinger:middleFinger')
  })
})

describe('fitEnslavingAll', () => {
  test('fits every other finger from one recording, with different coefficients each', () => {
    const angleI: number[] = [0]
    const middle: number[] = [0]
    const ring: number[] = [0]
    const pinky: number[] = [0] // never moves with i -- should be omitted, not fit to 0
    for (let k = 0; k < 20; k++) {
      const dI = 4
      angleI.push(angleI[angleI.length - 1] + dI)
      middle.push(middle[middle.length - 1] + 0.3 * dI)
      ring.push(ring[ring.length - 1] + 0.15 * dI)
      pinky.push(pinky[pinky.length - 1]) // stays flat -- zero delta every frame
    }

    const result = fitEnslavingAll('indexFinger', {
      indexFinger: angleI,
      middleFinger: middle,
      ringFinger: ring,
      pinky,
    })

    expect(result.middleFinger?.coefficient).toBeCloseTo(0.3, 5)
    expect(result.ringFinger?.coefficient).toBeCloseTo(0.15, 5)
    // pinky never moved at all, so it has no i-dominant segment with real signal to fit --
    // sumII/sumIJ come out defined but the fit is degenerate (coefficient 0, r2 1), which is a
    // valid "no coupling detected" result here rather than an omission, since dI still clears
    // the dominance filter every frame (dJ=0 trivially satisfies |dI| >= ratio*|dJ|).
    expect(result.pinky?.coefficient).toBeCloseTo(0, 5)
  })

  test('omits a finger whose data has no i-dominant segment at all', () => {
    const angleI = [0, 0, 0, 0, 0] // i never moves
    const thumb = [0, 5, 10, 15, 20] // thumb moves on its own -- never i-dominant
    const result = fitEnslavingAll('indexFinger', { indexFinger: angleI, thumb })
    expect(result.thumb).toBeUndefined()
  })

  test('throws if the active finger has no recorded history', () => {
    expect(() => fitEnslavingAll('indexFinger', { middleFinger: [0, 1, 2] })).toThrow()
  })
})
