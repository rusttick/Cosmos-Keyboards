import { describe, expect, test } from 'bun:test'
import { resolveBoneSpan, resolveKnuckleSpan } from './boneSpan'

describe('resolveBoneSpan', () => {
  test('wrist to middle DIP (0->11) spans metacarpal/proximal/middle, not distal', () => {
    const span = resolveBoneSpan(0, 11)
    expect(span?.finger).toBe('middleFinger')
    expect(span?.segmentIndices).toEqual([0, 1, 2])
  })

  test('wrist to middle fingertip (0->12) spans all four segments', () => {
    const span = resolveBoneSpan(0, 12)
    expect(span?.finger).toBe('middleFinger')
    expect(span?.segmentIndices).toEqual([0, 1, 2, 3])
  })

  test('a single mid-chain segment (index PIP to DIP)', () => {
    const span = resolveBoneSpan(6, 7)
    expect(span?.finger).toBe('indexFinger')
    expect(span?.segmentIndices).toEqual([2])
  })

  test('thumb wristToCmc segment (0->1)', () => {
    const span = resolveBoneSpan(0, 1)
    expect(span?.finger).toBe('thumb')
    expect(span?.segmentIndices).toEqual([0])
  })

  test('reversed order (tip before base) is rejected, not silently flipped', () => {
    expect(resolveBoneSpan(12, 0)).toBeUndefined()
  })

  test('cross-finger span is rejected', () => {
    expect(resolveBoneSpan(4, 20)).toBeUndefined() // thumb tip to pinky tip
  })

  test('same landmark twice is rejected', () => {
    expect(resolveBoneSpan(5, 5)).toBeUndefined()
  })
})

describe('resolveKnuckleSpan', () => {
  test('adjacent MCP pair (index-middle)', () => {
    expect(resolveKnuckleSpan(5, 9)?.gapIndices).toEqual([0])
  })

  test('non-adjacent pair (index-pinky) spans all three gaps', () => {
    expect(resolveKnuckleSpan(5, 17)?.gapIndices).toEqual([0, 1, 2])
  })

  test('middle-pinky spans the last two gaps', () => {
    expect(resolveKnuckleSpan(9, 17)?.gapIndices).toEqual([1, 2])
  })

  test('reversed order is rejected', () => {
    expect(resolveKnuckleSpan(17, 5)).toBeUndefined()
  })

  test('a non-MCP landmark is rejected', () => {
    expect(resolveKnuckleSpan(5, 8)).toBeUndefined() // index MCP to index TIP, not an MCP
  })

  test('thumb landmark is rejected (not part of the knuckle row)', () => {
    expect(resolveKnuckleSpan(1, 5)).toBeUndefined()
  })
})
