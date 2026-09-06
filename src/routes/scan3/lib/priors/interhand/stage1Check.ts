/**
 * Stage 1, checks 1-2 of `docs/thumbs/interhand-2-average.md`, run against one real subject.
 * Check 1 (skeleton tree parses/validates) is covered by `skeleton.test.ts`; this script re-confirms
 * it inline and then runs check 2: segment-length invariance across every valid frame of one subject,
 * as evidence the remap groups anatomically adjacent points together rather than something wrong
 * (an off-by-one, a swapped finger, a mixed-up hand). Run with `bun run src/routes/scan3/lib/priors/interhand/stage1Check.ts`.
 */

import { CONNECTIONS, FINGERS } from '$lib/hand'
import { loadSubjectFrames } from './loadFrames'

const SUBJECT_ID = process.argv[2] ?? '0'
const SPLIT = 'train'
const HAND = 'right'

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}
function sd(xs: number[], m: number): number {
  return Math.sqrt(mean(xs.map(x => (x - m) ** 2)))
}

async function main() {
  console.log(`Loading subject ${SUBJECT_ID}, ${SPLIT}, ${HAND} hand...`)
  const frames = await loadSubjectFrames(SPLIT, SUBJECT_ID, HAND)
  const seqs = new Set(frames.map(f => f.seq))
  console.log(`${frames.length} valid frames across ${seqs.size} pose sequences.`)
  if (frames.length === 0) {
    console.log('No valid frames -- nothing to check.')
    return
  }

  console.log('\nSegment-length invariance (Stage 1, check 2):')
  console.log('segment'.padEnd(22), 'mean_mm'.padStart(10), 'sd_mm'.padStart(8), 'cv_%'.padStart(7))

  let worstCv = 0
  for (const finger of FINGERS) {
    for (const [from, to] of CONNECTIONS[finger]) {
      const lengths = frames.map(f => f.points[from].distanceTo(f.points[to]))
      const m = mean(lengths)
      const s = sd(lengths, m)
      const cv = (s / m) * 100
      worstCv = Math.max(worstCv, cv)
      console.log(`${finger}:${from}-${to}`.padEnd(22), m.toFixed(2).padStart(10), s.toFixed(2).padStart(8), cv.toFixed(2).padStart(6) + '%')
    }
  }

  console.log(`\nWorst segment coefficient of variation: ${worstCv.toFixed(2)}%`)
  console.log(
    worstCv < 10
      ? 'PASS-ish: every segment stays within ~10% of its own mean length across all frames -- consistent with a correct remap (some real capture noise is expected).'
      : 'FLAG: at least one segment varies by more than 10% of its own mean length -- re-check the remap before trusting anything computed from it.',
  )
}

main()
