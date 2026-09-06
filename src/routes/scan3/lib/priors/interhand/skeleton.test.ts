import { describe, expect, test } from 'bun:test'
import { existsSync } from 'fs'
import { buildHandSkeleton, parseSkeleton } from './skeleton'

// Literal copy of external-data/interhand26m/skeleton.txt, embedded so the parser/validator logic is
// checked unconditionally -- without requiring the (gitignored, multi-megabyte-adjacent) external
// download to be present, e.g. in CI or a fresh clone.
const SKELETON_FIXTURE = `
# keypoint name, keypoint index, parent index
r_thumb4 0 1
r_thumb3 1 2
r_thumb2 2 3
r_thumb1 3 20
r_index4 4 5
r_index3 5 6
r_index2 6 7
r_index1 7 20
r_middle4 8 9
r_middle3 9 10
r_middle2 10 11
r_middle1 11 20
r_ring4 12 13
r_ring3 13 14
r_ring2 14 15
r_ring1 15 20
r_pinky4 16 17
r_pinky3 17 18
r_pinky2 18 19
r_pinky1 19 20
r_wrist 20 -1
l_thumb4 21 22
l_thumb3 22 23
l_thumb2 23 24
l_thumb1 24 41
l_index4 25 26
l_index3 26 27
l_index2 27 28
l_index1 28 41
l_middle4 29 30
l_middle3 30 31
l_middle2 31 32
l_middle1 32 41
l_ring4 33 34
l_ring3 34 35
l_ring2 35 36
l_ring1 36 41
l_pinky4 37 38
l_pinky3 38 39
l_pinky2 39 40
l_pinky1 40 41
l_wrist 41 -1
`

describe('parseSkeleton', () => {
  test('parses every non-comment line into a node', () => {
    const nodes = parseSkeleton(SKELETON_FIXTURE)
    expect(nodes.length).toBe(42)
    expect(nodes[0]).toEqual({ name: 'r_thumb4', index: 0, parentIndex: 1 })
    expect(nodes.at(-1)).toEqual({ name: 'l_wrist', index: 41, parentIndex: -1 })
  })
})

describe('buildHandSkeleton', () => {
  const nodes = parseSkeleton(SKELETON_FIXTURE)

  test('right hand: wrist-first, base-to-tip remap, derived from the parent chain', () => {
    const { remap, wristIndex } = buildHandSkeleton(nodes, 'r')
    expect(wristIndex).toBe(20)
    // project order: [wrist, thumb(base..tip), index(base..tip), middle(..), ring(..), pinky(..)]
    // -- verified by hand against skeleton.txt's own parent pointers in docs/thumbs/interhand-2-average.md.
    expect(remap).toEqual([
      20, // wrist
      3,
      2,
      1,
      0, // thumb: base(1) -> tip(4)
      7,
      6,
      5,
      4, // index
      11,
      10,
      9,
      8, // middle
      15,
      14,
      13,
      12, // ring
      19,
      18,
      17,
      16, // pinky
    ])
  })

  test('left hand: same shape, offset by 21', () => {
    const { remap, wristIndex } = buildHandSkeleton(nodes, 'l')
    expect(wristIndex).toBe(41)
    expect(remap).toEqual([41, 24, 23, 22, 21, 28, 27, 26, 25, 32, 31, 30, 29, 36, 35, 34, 33, 40, 39, 38, 37])
  })

  test('throws rather than guessing when a parent pointer disagrees with the node names', () => {
    const corrupted = parseSkeleton(SKELETON_FIXTURE).map(n => n.name === 'r_index2' ? { ...n, parentIndex: 999 } : n)
    expect(() => buildHandSkeleton(corrupted, 'r')).toThrow()
  })

  test('throws on a missing node instead of silently producing a short remap', () => {
    const truncated = parseSkeleton(SKELETON_FIXTURE).filter(n => n.name !== 'r_pinky4')
    expect(() => buildHandSkeleton(truncated, 'r')).toThrow()
  })
})

describe('against the real downloaded skeleton.txt, if present', () => {
  const path = 'external-data/interhand26m/skeleton.txt'
  const present = existsSync(path)

  test.skipIf(!present)('parses and validates without throwing, matching the fixture-derived remap', async () => {
    const text = await Bun.file(path).text()
    const nodes = parseSkeleton(text)
    const real = buildHandSkeleton(nodes, 'r')
    const fixture = buildHandSkeleton(parseSkeleton(SKELETON_FIXTURE), 'r')
    expect(real.remap).toEqual(fixture.remap)
    expect(real.wristIndex).toEqual(fixture.wristIndex)
  })

  if (!present) {
    test.skip('external-data/interhand26m/skeleton.txt not present locally -- skipped', () => {})
  }
})
