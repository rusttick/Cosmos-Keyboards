/**
 * Parses InterHand2.6M's `skeleton.txt` into a joint tree and derives, per hand, the reindexing from
 * InterHand2.6M's own raw joint order (tip-to-base per finger, wrist last) to this project's landmark
 * order (`$lib/hand.ts`'s `CONNECTIONS`: wrist first, each finger base-to-tip) -- see
 * `docs/thumbs/interhand-2-average.md` Stage 1. The mapping is derived from the file's
 * (name, index, parentIndex) triples and validated against the parent-chain structure, not hardcoded
 * from having read the file once -- a stale or differently-ordered re-download can't silently produce
 * a wrong remap without `buildHandSkeleton` throwing first.
 */

import { type Finger, FINGERS } from '$lib/hand'

export interface SkeletonNode {
  name: string
  index: number
  parentIndex: number
}

export function parseSkeleton(text: string): SkeletonNode[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
    .map(line => {
      const [name, indexStr, parentStr] = line.split(/\s+/)
      return { name, index: Number(indexStr), parentIndex: Number(parentStr) }
    })
}

/** InterHand2.6M's own name for each `Finger`, per `skeleton.txt` (`r_thumb1`..`r_thumb4`, etc.). */
const INTERHAND_FINGER_NAME: Record<Finger, string> = {
  thumb: 'thumb',
  indexFinger: 'index',
  middleFinger: 'middle',
  ringFinger: 'ring',
  pinky: 'pinky',
}

export interface HandSkeleton {
  /** `remap[projectIndex] = interhandRawIndex` for this hand -- project order is `$lib/hand.ts`'s
   * (landmark 0 = wrist, then each finger's 4 joints base-to-tip, finger order = `FINGERS`). */
  remap: number[]
  wristIndex: number
}

/** Validates and derives one hand's (`'l'` or `'r'`) remap. Throws on any structural mismatch --
 * missing nodes, a broken parent chain, a name that doesn't parse as expected -- rather than silently
 * producing a mapping that's wrong in a way nothing downstream would ever detect. */
export function buildHandSkeleton(nodes: SkeletonNode[], handPrefix: 'l' | 'r'): HandSkeleton {
  const handNodes = nodes.filter(n => n.name.startsWith(`${handPrefix}_`))
  if (handNodes.length !== 21) {
    throw new Error(`expected 21 nodes for hand '${handPrefix}', got ${handNodes.length}`)
  }

  const wristNodes = handNodes.filter(n => n.name === `${handPrefix}_wrist`)
  if (wristNodes.length !== 1) {
    throw new Error(`expected exactly one '${handPrefix}_wrist' node, got ${wristNodes.length}`)
  }
  const wrist = wristNodes[0]
  if (wrist.parentIndex !== -1) {
    throw new Error(`'${handPrefix}_wrist' should have parentIndex -1, got ${wrist.parentIndex}`)
  }

  const remap = new Array<number>(21).fill(-1)
  remap[0] = wrist.index

  let projectIndex = 1
  for (const finger of FINGERS) {
    const ihName = INTERHAND_FINGER_NAME[finger]
    const chain: SkeletonNode[] = []
    for (let depth = 1; depth <= 4; depth++) {
      const name = `${handPrefix}_${ihName}${depth}`
      const node = handNodes.find(n => n.name === name)
      if (!node) throw new Error(`missing node '${name}'`)
      chain.push(node)
    }
    // chain[0] is the base joint (depth 1, closest to the wrist), chain[3] the tip (depth 4) --
    // verify the parent chain actually agrees with what the names claim, rather than trusting the
    // names alone: each depth's parent must be the previous depth's node, and depth 1's parent must
    // be the wrist.
    if (chain[0].parentIndex !== wrist.index) {
      throw new Error(`'${chain[0].name}' should have the wrist as its parent`)
    }
    for (let depth = 1; depth < 4; depth++) {
      if (chain[depth].parentIndex !== chain[depth - 1].index) {
        throw new Error(`'${chain[depth].name}' should have '${chain[depth - 1].name}' as its parent`)
      }
    }
    // project order is base-to-tip (chain[0]..chain[3]), matching CONNECTIONS' [0,1],[1,2],[2,3],[3,4]
    for (const node of chain) {
      remap[projectIndex] = node.index
      projectIndex++
    }
  }

  if (projectIndex !== 21 || remap.some(i => i === -1)) {
    throw new Error(`internal error: remap did not fill all 21 project-order slots`)
  }
  return { remap, wristIndex: wrist.index }
}
