/**
 * Loads real frames for one InterHand2.6M subject from a local `external-data/interhand26m/` split
 * file and returns them in this project's landmark order (via `skeleton.ts`'s remap) -- millimeters,
 * un-aligned (no rigid transform applied; segment lengths and joint angles are invariant to that, and
 * alignment is only needed for rendering, see `interhand-2-average.md` Stage 1 check 3).
 */

import { Vector3 } from 'three'
import { buildHandSkeleton, parseSkeleton } from './skeleton'

export type Split = 'train' | 'val' | 'test'

interface RawFrame {
  world_coord: [number, number, number][]
  joint_valid: [number][]
  hand_type: 'right' | 'left' | 'interacting'
  hand_type_valid: boolean
  seq: string
}

export interface InterhandFrame {
  frameId: string
  seq: string
  /** 21 points, project order (wrist=0, then each finger base-to-tip), millimeters. */
  points: Vector3[]
}

function splitPath(split: Split): string {
  const cap = split[0].toUpperCase() + split.slice(1)
  return `external-data/interhand26m/${split}/InterHand2.6M_${split}_joint_3d.json`
}

/** Loads every frame for one subject where the requested hand is present, valid at every one of its
 * 21 landmarks, and not part of a two-hand ('interacting') frame -- a simpler starting filter than
 * this project will eventually want (a frame with one occluded fingertip still has 20 good landmarks),
 * but the right conservative default for the Stage 1 sanity checks, which need clean data to be a
 * meaningful check of the *remap*, not a check confounded by partially-invalid frames too. */
export async function loadSubjectFrames(split: Split, subjectId: string, hand: 'right' | 'left'): Promise<InterhandFrame[]> {
  const text = await Bun.file(splitPath(split)).text()
  const data = JSON.parse(text) as Record<string, Record<string, RawFrame>>
  const subject = data[subjectId]
  if (!subject) throw new Error(`subject '${subjectId}' not found in ${split} split`)

  const skeletonNodes = parseSkeleton(await Bun.file('external-data/interhand26m/skeleton.txt').text())
  const { remap } = buildHandSkeleton(skeletonNodes, hand === 'right' ? 'r' : 'l')

  const frames: InterhandFrame[] = []
  for (const [frameId, frame] of Object.entries(subject)) {
    if (frame.hand_type !== hand) continue
    const allValid = remap.every(rawIndex => frame.joint_valid[rawIndex][0] === 1)
    if (!allValid) continue
    const points = remap.map(rawIndex => {
      const [x, y, z] = frame.world_coord[rawIndex]
      return new Vector3(x, y, z)
    })
    frames.push({ frameId, seq: frame.seq, points })
  }
  return frames
}
