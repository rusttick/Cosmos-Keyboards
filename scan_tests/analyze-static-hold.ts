/**
 * Analyzes a static-hold capture (see docs/thumbs/scan_tests.md) to establish the
 * frame-to-frame noise floor for bone lengths and inter-bone angles when MediaPipe
 * tracks a completely motionless hand.
 *
 * Usage:
 *   bun run scan_tests/analyze-static-hold.ts <path-to-capture.json>
 */

import { Vector3 } from 'three'
import { CONNECTIONS, type Finger, type Hand, makeHand } from '../src/lib/hand'

const CONFIDENCE_THRESHOLD = 0.7

interface StaticHoldCapture {
  meta: {
    capturedAt: string
    orientation: 'palm-facing' | 'palm-away'
    handedness: 'Left' | 'Right'
    notes?: string
  }
  frames: Array<{
    t: number
    score: number
    keypoints: { x: number; y: number; z: number }[]
    keypoints3D: { x: number; y: number; z: number }[]
  }>
}

interface BoneStat {
  finger: Finger
  bone: number
  mean: number
  stdev: number
  cv: number
}

interface JointStat {
  finger: Finger
  joint: number
  meanDeg: number
  stdevDeg: number
}

function mean(xs: number[]) {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

function stdev(xs: number[], m = mean(xs)) {
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)))
}

function analyze(capture: StaticHoldCapture) {
  const accepted = capture.frames.filter((f) => f.score >= CONFIDENCE_THRESHOLD)
  if (accepted.length === 0) {
    throw new Error(`No frames with score >= ${CONFIDENCE_THRESHOLD} (of ${capture.frames.length} total)`)
  }

  const hands: Hand[] = accepted.map((f) =>
    makeHand({
      keypoints: f.keypoints,
      keypoints3D: f.keypoints3D,
      score: f.score,
      handedness: capture.meta.handedness,
    })
  )

  const fingers = Object.keys(CONNECTIONS) as Finger[]

  const boneStats: BoneStat[] = fingers.flatMap((finger) =>
    CONNECTIONS[finger].map((_, bone) => {
      const lengths = hands.map((h) => h.limbs[finger][bone].length())
      const m = mean(lengths)
      const sd = stdev(lengths, m)
      return { finger, bone, mean: m, stdev: sd, cv: (sd / m) * 100 }
    })
  )

  const jointStats: JointStat[] = fingers.flatMap((finger) => {
    const numBones = CONNECTIONS[finger].length
    return Array.from({ length: numBones - 1 }, (_, joint) => {
      const angles = hands.map((h) => {
        const a = h.limbs[finger][joint] as Vector3
        const b = h.limbs[finger][joint + 1] as Vector3
        return a.angleTo(b) * (180 / Math.PI)
      })
      const m = mean(angles)
      const sd = stdev(angles, m)
      return { finger, joint, meanDeg: m, stdevDeg: sd }
    })
  })

  return { accepted: accepted.length, total: capture.frames.length, boneStats, jointStats }
}

function printTable(capture: StaticHoldCapture, result: ReturnType<typeof analyze>) {
  console.log(`\nStatic hold analysis: ${capture.meta.orientation} / ${capture.meta.handedness}`)
  console.log(`Frames: ${result.accepted} accepted of ${result.total} total (score >= ${CONFIDENCE_THRESHOLD})\n`)

  console.log('Bone lengths:')
  console.log('finger'.padEnd(14) + 'bone'.padEnd(6) + 'mean'.padEnd(10) + 'stdev'.padEnd(10) + 'cv (%)')
  for (const b of result.boneStats) {
    console.log(
      b.finger.padEnd(14) + String(b.bone).padEnd(6) + b.mean.toFixed(4).padEnd(10) + b.stdev.toFixed(4).padEnd(10)
        + b.cv.toFixed(2),
    )
  }

  console.log('\nInter-bone joint angles:')
  console.log('finger'.padEnd(14) + 'joint'.padEnd(7) + 'mean (deg)'.padEnd(14) + 'stdev (deg)')
  for (const j of result.jointStats) {
    console.log(
      j.finger.padEnd(14) + String(j.joint).padEnd(7) + j.meanDeg.toFixed(3).padEnd(14) + j.stdevDeg.toFixed(3),
    )
  }
  console.log()
}

async function main() {
  const inputPath = process.argv[2]
  if (!inputPath) {
    console.error('Usage: bun run scan_tests/analyze-static-hold.ts <path-to-capture.json>')
    process.exit(1)
  }

  const file = Bun.file(inputPath)
  const capture: StaticHoldCapture = await file.json()

  const result = analyze(capture)
  printTable(capture, result)

  const summary = {
    meta: capture.meta,
    frames: { accepted: result.accepted, total: result.total, confidenceThreshold: CONFIDENCE_THRESHOLD },
    bones: result.boneStats,
    joints: result.jointStats,
  }
  const summaryPath = `${inputPath}.summary.json`
  await Bun.write(summaryPath, JSON.stringify(summary, null, 2))
  console.log(`Wrote summary to ${summaryPath}`)
}

main()
