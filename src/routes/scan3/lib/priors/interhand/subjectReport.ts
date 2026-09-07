/**
 * Runs the bone-length and ROM extraction (Stage 3a/3d of `docs/thumbs/interhand-2-average.md`)
 * against one real InterHand2.6M subject and prints a side-by-side report against the current
 * `handModelData.ts` seed -- Stage 4's human-review report, for one subject. Nothing here writes to
 * `handModelData.ts`; that's a deliberate later, reviewed step.
 *
 * Run with: bun run src/routes/scan3/lib/priors/interhand/subjectReport.ts [subjectId]
 */

import { FINGERS } from '$lib/hand'
import { HAND_PRIOR_SEED } from '../handModelData'
import { fitBoneLengths } from './fitBoneLengths'
import { fitRom } from './fitRom'
import { loadSubjectFrames } from './loadFrames'

const SUBJECT_ID = process.argv[2] ?? '0'

function pct(x: number): string {
  return (x * 100).toFixed(2) + '%'
}

async function main() {
  const frames = await loadSubjectFrames('train', SUBJECT_ID, 'right')
  const seqs = new Set(frames.map(f => f.seq))
  console.log(`Subject ${SUBJECT_ID}: ${frames.length} valid right-hand frames across ${seqs.size} pose sequences.\n`)

  // --- Bone lengths ---
  const bones = fitBoneLengths(frames)
  console.log('=== Bone-length ratios (candidate vs. current handModelData.ts seed) ===')
  console.log(
    'segment'.padEnd(24),
    'candidate'.padStart(10),
    'current'.padStart(10),
    'delta'.padStart(9),
    'within-subj SD'.padStart(15),
  )
  const currentHandLength = HAND_PRIOR_SEED.boneLengths.handLength.mean
  for (const finger of FINGERS) {
    const candidate = bones.fingers[finger]
    const current = HAND_PRIOR_SEED.boneLengths.fingers[finger]
    candidate.segments.forEach((seg, i) => {
      const currentIdx = (current.segments as string[]).indexOf(seg)
      const currentRatio = currentIdx >= 0 ? current.mean[currentIdx] : undefined
      const candidateRatio = candidate.mean[i]
      const sd = Math.sqrt(candidate.variance[i])
      const label = `${finger}:${seg}`
      const delta = currentRatio !== undefined ? candidateRatio - currentRatio : undefined
      console.log(
        label.padEnd(24),
        pct(candidateRatio).padStart(10),
        (currentRatio !== undefined ? pct(currentRatio) : 'NO PRIOR').padStart(10),
        (delta !== undefined ? (delta >= 0 ? '+' : '') + pct(delta) : '--').padStart(9),
        pct(sd / candidateRatio).padStart(15),
      )
    })
  }
  console.log(
    `\nhandLength: candidate ${bones.handLengthMM.mean.toFixed(1)}mm (subject-specific absolute size, not comparable`,
    `to the population-average ${currentHandLength.toFixed(1)}mm current seed value directly)`,
  )

  // --- ROM ---
  const rom = fitRom(frames)
  console.log('\n=== ROM: observed bend-angle envelope, tagged by how directly it maps to its target field ===')
  console.log('clean-hinge         : the bend angle IS the target field -- treat as a real candidate.')
  console.log('flex-abd-combined   : one real joint, but flex+ab/ad combined into one number -- upper bound')
  console.log('                      on flexExtRom alone, NOT a candidate mean/SD for it on its own.')
  console.log('joint-stacked       : TWO separate joints (ring/pinky base flex + true MCP) on one landmark')
  console.log('                      -- not comparable to either target field individually at all.')
  console.log('declaredSd inflates the raw within-subject SD by the directness multiplier -- see fitRom.ts.')
  console.log('excl.: frames dropped for THIS joint because an adjacent segment failed the length-consistency')
  console.log('check (segmentConsistency.ts) -- a foreshortened/occluded landmark, not real motion.\n')
  console.log(
    'joint'.padEnd(18),
    'directness'.padEnd(19),
    'obs min'.padStart(7),
    'mean'.padStart(6),
    'max'.padStart(7),
    'raw sd'.padStart(7),
    'decl. sd'.padStart(9),
    'n'.padStart(5),
    'excl.'.padStart(6),
    '  current'.padStart(24),
  )
  for (const r of rom) {
    let currentRange = 'NO PRIOR'
    if (r.jointName === 'pip') {
      currentRange = `pipDipRom.pip: ${HAND_PRIOR_SEED.pipDipRom.pip[r.finger as NonThumbFingerKey].minDeg}/${HAND_PRIOR_SEED.pipDipRom.pip[r.finger as NonThumbFingerKey].maxDeg}`
    } else if (r.jointName === 'dip') {
      currentRange = `pipDipRom.dip: ${HAND_PRIOR_SEED.pipDipRom.dip[r.finger as NonThumbFingerKey].minDeg}/${HAND_PRIOR_SEED.pipDipRom.dip[r.finger as NonThumbFingerKey].maxDeg}`
    } else if (r.finger === 'thumb' && r.jointName === 'cmc') {
      const m = HAND_PRIOR_SEED.cmcMobility.thumb.flexExtRom
      currentRange = `cmcMobility.thumb (flexExt only): ${m.minDeg}/${m.maxDeg}`
    } else if (r.directness === 'flex-abd-combined') {
      const m = HAND_PRIOR_SEED.mcpAxes[r.finger as NonThumbFingerKey].flexExtRom
      currentRange = `mcpAxes.${r.finger} (flexExt only): ${m.minDeg}/${m.maxDeg}`
    } else if (r.directness === 'joint-stacked') {
      currentRange = `NOT COMPARABLE (stacks cmcMobility.${r.finger}.flexionRom + mcpAxes.${r.finger})`
    }
    console.log(
      `${r.finger}:${r.jointName}`.padEnd(18),
      r.directness.padEnd(19),
      r.minDeg.toFixed(1).padStart(7),
      r.meanDeg.toFixed(1).padStart(6),
      r.maxDeg.toFixed(1).padStart(7),
      r.sdDeg.toFixed(1).padStart(7),
      r.declaredSdDeg.toFixed(1).padStart(9),
      String(r.n).padStart(5),
      String(r.excludedByBadSegment).padStart(6),
      `  ${currentRange}`,
    )
  }
}

type NonThumbFingerKey = 'indexFinger' | 'middleFinger' | 'ringFinger' | 'pinky'

main()
