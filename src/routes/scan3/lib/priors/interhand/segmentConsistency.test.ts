import { describe, expect, test } from 'bun:test'
import { Vector3 } from 'three'
import type { InterhandFrame } from './loadFrames'
import { computeSegmentMedians, isSegmentTrustworthy } from './segmentConsistency'

function frameWithIndexDistalLength(len: number): InterhandFrame {
  const points = Array.from({ length: 21 }, () => new Vector3(0, 0, 0))
  points[7] = new Vector3(0, 0, 0)
  points[8] = new Vector3(len, 0, 0) // indexFinger's distal segment is CONNECTIONS.indexFinger[3] = [7, 8]
  return { frameId: '0', seq: 'synthetic', points }
}

describe('segmentConsistency', () => {
  test('a segment near the subject median is trustworthy', () => {
    const frames = [
      frameWithIndexDistalLength(20),
      frameWithIndexDistalLength(21),
      frameWithIndexDistalLength(19),
      frameWithIndexDistalLength(20.5),
    ]
    const medians = computeSegmentMedians(frames)
    expect(isSegmentTrustworthy(frames[0], 'indexFinger', 7, 8, medians)).toBe(true)
  })

  test('a segment far below the subject median (occlusion-style foreshortening) is flagged', () => {
    const normalFrames = [
      frameWithIndexDistalLength(20),
      frameWithIndexDistalLength(21),
      frameWithIndexDistalLength(19),
    ]
    const badFrame = frameWithIndexDistalLength(8) // 60% shorter than a ~20mm median
    const medians = computeSegmentMedians([...normalFrames, badFrame])
    expect(isSegmentTrustworthy(badFrame, 'indexFinger', 7, 8, medians)).toBe(false)
  })

  test('threshold is configurable', () => {
    const frames = [frameWithIndexDistalLength(20), frameWithIndexDistalLength(20)]
    const badFrame = frameWithIndexDistalLength(15) // 25% below median
    const medians = computeSegmentMedians([...frames, badFrame])
    expect(isSegmentTrustworthy(badFrame, 'indexFinger', 7, 8, medians, 0.3)).toBe(true)
    expect(isSegmentTrustworthy(badFrame, 'indexFinger', 7, 8, medians, 0.2)).toBe(false)
  })
})
