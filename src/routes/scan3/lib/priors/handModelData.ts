/**
 * `HAND_PRIOR_SEED`: starting numbers for `HandPriorState` -- a stand-in "average hand" to use before
 * any real measurement of a specific person exists. Every value below has a `source` field saying
 * where it came from: a specific cited paper with real numbers, a rough figure with no named source,
 * or an explicit placeholder with no data behind it at all. Treat anything not citing a specific paper
 * as provisional -- it's there so the model has *a* number to start from, not because it's trustworthy.
 *
 * Bone lengths (below) are backed by a real published measurement table. Most range-of-motion figures
 * are round numbers with no specific paper attached. Two relationships (how bent fingers drag their
 * neighbors along, and how the two outer finger joints move together) have no usable published numbers
 * at all -- see those sections for what was actually checked and why it came up empty.
 */

import { FINGERS } from '$lib/hand'
import type {
  BetaRom,
  BoneLengthPriors,
  CmcMobilityPriors,
  DipPipCouplingPriors,
  EnslavingPriors,
  FingerBoneLengths,
  HandPriorState,
  McpAxisPriors,
  NonThumbFinger,
  PipDipRomPriors,
  ScalarPrior,
  WristForearmPriors,
} from './handModel'

const NON_THUMB_FINGERS = FINGERS.filter((f): f is NonThumbFinger => f !== 'thumb')

// ---------------------------------------------------------------------------------------------------
// Bone lengths
//
// Numbers below are from: Buryanov, A. & Kotiuk, V. "Proportions of Hand Segments." Int. J. Morphol.,
// 28(3):755-758, 2010 -- an X-ray study of 66 adult hands, reporting the mean and standard deviation
// of each phalanx and metacarpal's length in millimeters, for all five fingers.
//
// A more commonly-cited paper (Buchholz, Armstrong & Goldstein 1992, Ergonomics 35(3):261-273) is the
// usual reference for "how well does one finger segment's length predict another's" (their R² ranges
// from 0.49 to 0.99 depending on the segment pair), but that paper's actual measurement table sits
// behind a journal paywall and couldn't be read here. Buryanov & Kotiuk's paper is openly available and
// does publish a full table, so it's the one actually transcribed below; Buchholz's R² range is just
// useful context for how much segment lengths do or don't predict each other.
//
// This project measures a finger as a chain of straight-line segments between hand-tracking landmarks
// (wrist, knuckle, and each finger joint), which isn't quite the same thing an X-ray study measures:
// - The two middle segments of each finger (knuckle-to-middle-joint and middle-joint-to-last-joint)
//   line up cleanly -- both this project and the X-ray study measure joint-center to joint-center.
// - The last segment (last joint to fingertip) doesn't quite line up: the hand-tracking fingertip
//   point sits on the *skin*, not the bone. Buryanov & Kotiuk separately measured the soft tissue past
//   the bone tip, so that value is added to the bone length here to match what tracking actually sees.
// - The first segment (wrist to knuckle) is the one real mismatch: the tracked "wrist" point sits
//   further back than where the metacarpal bone actually starts, so the true segment is longer than
//   just the metacarpal bone Buryanov & Kotiuk measured. The bone-only length is used here anyway, as
//   a known-too-short placeholder -- this segment is one this project can measure directly and
//   reliably from its own capture process, so the literature gap matters less here than elsewhere.
// - The thumb has one extra segment (wrist to the base of the thumb) that doesn't correspond to any
//   real bone at all -- it's an artifact of how the tracked thumb is represented with one more point
//   than it has independently-moving parts. No source measures this, so it's seeded as an explicitly
//   made-up small placeholder value.
//
// The reference "hand length" everything else is a ratio of (the standard measurement from the wrist
// to the middle fingertip) is built by adding up Buryanov & Kotiuk's own middle-finger segments, which
// carries the same wrist-segment shortfall described above -- so it's a slight underestimate too.
//
// Every finger's segments are treated as independent of each other (a diagonal covariance): the paper
// only reports each segment's own mean/SD, not how one finger's segments vary together, so there's
// nothing to base a stronger correlation on yet.

interface RawSegmentMM {
  mean: number
  sd: number
}

function combineSoftTissue(bone: RawSegmentMM, softTissue: RawSegmentMM): RawSegmentMM {
  return { mean: bone.mean + softTissue.mean, sd: Math.sqrt(bone.sd ** 2 + softTissue.sd ** 2) }
}

function vectorPriorFromRatios(segments: FingerBoneLengths['segments'], handLengthMean: number, raw: RawSegmentMM[]): FingerBoneLengths {
  const mean = raw.map(r => r.mean / handLengthMean)
  const covariance = mean.map((m, i) => mean.map((_, j) => (i === j ? (raw[i].sd / handLengthMean) ** 2 : 0)))
  return { segments, mean, covariance, source: 'Buryanov & Kotiuk 2010, Table I (see comment above for how these segments map onto tracked landmarks)' }
}

// Buryanov & Kotiuk Table I, mm (mean ± SD), right hand.
const TIP = { thumb: { mean: 5.67, sd: 0.61 }, indexFinger: { mean: 3.84, sd: 0.59 }, middleFinger: { mean: 3.95, sd: 0.61 }, ringFinger: { mean: 3.95, sd: 0.60 }, pinky: { mean: 3.73, sd: 0.62 } }
const PD = {
  thumb: { mean: 21.67, sd: 1.60 },
  indexFinger: { mean: 15.82, sd: 2.26 },
  middleFinger: { mean: 17.40, sd: 1.85 },
  ringFinger: { mean: 17.30, sd: 2.22 },
  pinky: { mean: 15.96, sd: 2.45 },
}
const PM = { indexFinger: { mean: 22.38, sd: 2.51 }, middleFinger: { mean: 26.33, sd: 3.00 }, ringFinger: { mean: 25.65, sd: 3.29 }, pinky: { mean: 18.11, sd: 2.54 } }
const PP = {
  thumb: { mean: 31.57, sd: 3.13 },
  indexFinger: { mean: 39.78, sd: 4.94 },
  middleFinger: { mean: 44.63, sd: 3.81 },
  ringFinger: { mean: 41.37, sd: 3.87 },
  pinky: { mean: 32.74, sd: 2.77 },
}
const M = { thumb: { mean: 46.22, sd: 3.94 }, indexFinger: { mean: 68.12, sd: 6.27 }, middleFinger: { mean: 64.60, sd: 5.38 }, ringFinger: { mean: 58.00, sd: 5.06 }, pinky: { mean: 53.69, sd: 4.36 } }

const HAND_LENGTH_MM = M.middleFinger.mean + PP.middleFinger.mean + PM.middleFinger.mean + PD.middleFinger.mean + TIP.middleFinger.mean
const HAND_LENGTH_SD_MM = Math.sqrt(M.middleFinger.sd ** 2 + PP.middleFinger.sd ** 2 + PM.middleFinger.sd ** 2 + PD.middleFinger.sd ** 2 + TIP.middleFinger.sd ** 2)

const boneLengths: BoneLengthPriors = {
  handLength: {
    mean: HAND_LENGTH_MM,
    variance: HAND_LENGTH_SD_MM ** 2,
    source: 'Buryanov & Kotiuk 2010: sum of middle-finger segments -- a slight underestimate, since it inherits the wrist-to-knuckle shortfall described above',
  },
  fingers: {
    // The thumb's leading 'wristToCmc' segment has no anatomical bone and no literature source (see
    // comment above) -- it's given a small made-up mean and a wide standard deviation here, and needs
    // to be replaced by this project's own measurement before it's trusted for anything. The other
    // three segments are real Buryanov & Kotiuk transcriptions, same as every other finger.
    thumb: (() => {
      const sourced = vectorPriorFromRatios(
        ['metacarpal', 'proximal', 'distal'],
        HAND_LENGTH_MM,
        [M.thumb, PP.thumb, combineSoftTissue(PD.thumb, TIP.thumb)],
      )
      const UNSOURCED_WRIST_TO_CMC_MEAN = 0.05
      const UNSOURCED_WRIST_TO_CMC_SD = 0.03
      return {
        segments: ['wristToCmc', ...sourced.segments],
        mean: [UNSOURCED_WRIST_TO_CMC_MEAN, ...sourced.mean],
        covariance: [
          [UNSOURCED_WRIST_TO_CMC_SD ** 2, 0, 0, 0],
          ...sourced.covariance.map(row => [0, ...row]),
        ],
        source: `${sourced.source}; leading segment (wristToCmc) is a made-up placeholder, not from any source`,
      }
    })(),
    indexFinger: vectorPriorFromRatios(
      ['metacarpal', 'proximal', 'middle', 'distal'],
      HAND_LENGTH_MM,
      [M.indexFinger, PP.indexFinger, PM.indexFinger, combineSoftTissue(PD.indexFinger, TIP.indexFinger)],
    ),
    middleFinger: vectorPriorFromRatios(
      ['metacarpal', 'proximal', 'middle', 'distal'],
      HAND_LENGTH_MM,
      [M.middleFinger, PP.middleFinger, PM.middleFinger, combineSoftTissue(PD.middleFinger, TIP.middleFinger)],
    ),
    ringFinger: vectorPriorFromRatios(
      ['metacarpal', 'proximal', 'middle', 'distal'],
      HAND_LENGTH_MM,
      [M.ringFinger, PP.ringFinger, PM.ringFinger, combineSoftTissue(PD.ringFinger, TIP.ringFinger)],
    ),
    pinky: vectorPriorFromRatios(
      ['metacarpal', 'proximal', 'middle', 'distal'],
      HAND_LENGTH_MM,
      [M.pinky, PP.pinky, PM.pinky, combineSoftTissue(PD.pinky, TIP.pinky)],
    ),
  },
}

// ---------------------------------------------------------------------------------------------------
// Range-of-motion figures for PIP/DIP, MCP, CMC, and the wrist/forearm/elbow below are round numbers
// (e.g. "MCP flexes about 90 degrees") that this project has used as working assumptions, not numbers
// checked against a specific named paper. Where only a range was known (e.g. a standard deviation
// somewhere between 6 and 17 degrees), one representative value was picked and the source field says so.

function rom(minDeg: number, maxDeg: number, meanDeg: number, sdDeg: number, source: string): BetaRom {
  return { minDeg, maxDeg, meanDeg, sdDeg, source }
}

const ROUGH_ROM_SOURCE = 'rough working figure, not checked against a specific named paper'

const pipDipRom: PipDipRomPriors = {
  pip: Object.fromEntries(NON_THUMB_FINGERS.map(f => [f, rom(0, 110, 90, 10, ROUGH_ROM_SOURCE)])) as PipDipRomPriors['pip'],
  dip: Object.fromEntries(NON_THUMB_FINGERS.map(f => [f, rom(0, 90, 47.5, 13, ROUGH_ROM_SOURCE)])) as PipDipRomPriors['dip'],
}

const mcpAxes: McpAxisPriors = Object.fromEntries(
  NON_THUMB_FINGERS.map(f => [
    f,
    {
      flexExtRom: rom(-20, 90, 90, 8, ROUGH_ROM_SOURCE),
      abAdRom: rom(
        -20,
        20,
        0,
        8,
        ROUGH_ROM_SOURCE + '; side-to-side range is known to shrink as the finger bends, but no number for how much was found anywhere -- see abAdChokeCoeff',
      ),
      // These two numbers describe real, documented effects (side-to-side range shrinking with
      // flexion; a small twist that happens automatically as the finger bends) but no source gives an
      // actual coefficient for either -- mean 0 / wide variance just means "no effect assumed, very
      // uncertain," not a real measurement.
      abAdChokeCoeff: { mean: 0, variance: 1, source: 'no numeric value found for this effect; placeholder' } as ScalarPrior,
      axialRotationWeight: {
        mean: 0,
        variance: 1,
        source: 'no numeric value found for this effect; placeholder',
      } as ScalarPrior,
    },
  ]),
) as McpAxisPriors

const cmcMobility: CmcMobilityPriors = {
  thumb: {
    flexExtRom: rom(0, 53, 53, 10, ROUGH_ROM_SOURCE),
    abAdRom: rom(0, 42, 42, 10, ROUGH_ROM_SOURCE),
    conjunctCoupling: {
      mean: [0, 0],
      covariance: [[1, 0], [0, 1]],
      source:
        "the thumb's automatic twist has a known rough size (roughly 17 degrees total, stabilized to within about 3 degrees) but no source gives the actual flexion/abduction coefficients; placeholder until this project's own thumb-fitting capture produces real ones",
    },
  },
  ring: { flexionRom: rom(0, 30, 22.5, 8, ROUGH_ROM_SOURCE) },
  pinky: { flexionRom: rom(0, 30, 22.5, 8, ROUGH_ROM_SOURCE) },
}

// ---------------------------------------------------------------------------------------------------
// DIP/PIP coupling: how much the last finger joint bends along with the middle one.
//
// A ligament (Landsmeer's ligament) is documented to link these two joints' motion, but everything
// findable about it is descriptive -- it explains *that* the joints move together and what goes wrong
// clinically when the ligament is damaged, not a number for how much one bends per degree the other
// bends. No usable measurement was found. Left as a neutral placeholder (see below) until this
// project's own capture measures it directly.
const dipPipCoupling: DipPipCouplingPriors = Object.fromEntries(
  NON_THUMB_FINGERS.map(f => [
    f,
    {
      mean: [1, 0], // slope=1, intercept=0: "the last joint tracks the middle one 1:1" -- a guess, not a fitted value
      covariance: [[1, 0], [0, 400]],
      source: "no usable published measurement found (only qualitative descriptions of the ligament involved); neutral, wide placeholder until this project's own capture measures it",
    },
  ]),
) as DipPipCouplingPriors

// ---------------------------------------------------------------------------------------------------
// Enslaving: how much flexing one finger drags its neighbors along.
//
// Checked three sources:
// - Kilbreath & Gandevia 1994, the paper that first named this effect -- a study of finger *force*,
//   not finger *angle*: subjects pressed down with one finger and the others pressed involuntarily too.
// - Zatsiorsky, Li & Latash, "Matrix analyses of interaction among fingers in static force production
//   tasks," Biol. Cybern. 2003. This one does publish actual numbers -- a table of how much force each
//   finger produces per unit of commanded force to another finger -- but sits behind a paywall, so the
//   actual numbers couldn't be read.
// - A paper on the origin of finger enslaving (PMC7814910), read in full. It only reports how much the
//   effect grows over the course of a trial (roughly 8% to 17%), not a table of finger-pair numbers.
//
// All three measure force, not joint angle: press one finger and see how hard the others push, rather
// than bend one finger and see how far the others bend -- a different physical thing than what this
// project needs from this table, from a task (pressing at a fixed position) unlike typing. Using those
// force numbers here, even loosely, would mean treating a different physical quantity as if it were
// this one. The numbers were also inaccessible outright. So this stays an honest "no usable number
// found," to be filled in only from this project's own measurements of how fingers actually move.
const enslaving: EnslavingPriors = {
  fingerOrder: NON_THUMB_FINGERS,
  // Flattened row-major n*n matrix (n = NON_THUMB_FINGERS.length): flat index k = n*i+j. Diagonal
  // entries (i===j, "finger i's own coefficient with itself") are fixed at mean 1 with near-zero
  // variance, by construction, not from data. Off-diagonal entries (the actual enslaving
  // coefficients) are mean 0 with wide/uninformative variance -- diagonal covariance across flat
  // indices, i.e. no assumed correlation between different finger-pairs' coefficients (no source for
  // that either).
  coefficients: (() => {
    const n = NON_THUMB_FINGERS.length
    const mean = Array.from({ length: n * n }, (_, k) => (Math.floor(k / n) === k % n ? 1 : 0))
    const covariance = mean.map((_, k1) =>
      mean.map((_, k2) => {
        if (k1 !== k2) return 0
        const i = Math.floor(k1 / n)
        const j = k1 % n
        return i === j ? 1e-6 : 1
      })
    )
    return {
      mean,
      covariance,
      source: "no usable published measurement found (see comment above); to be filled in only from this project's own finger-flexion capture",
    }
  })(),
}

// ---------------------------------------------------------------------------------------------------
// Wrist, forearm, and elbow -- same caveat as the range-of-motion figures above: round working numbers,
// not independently checked against a specific named paper.

const wristForearm: WristForearmPriors = {
  wristFlexExtRom: rom(-85, 85, 0, 15, ROUGH_ROM_SOURCE),
  wristRadialUlnarRom: rom(-15, 45, 0, 10, ROUGH_ROM_SOURCE),
  forearmPronationSupinationRom: rom(-90, 90, 0, 15, ROUGH_ROM_SOURCE),
  elbowFlexionRom: rom(0, 150, 100, 15, ROUGH_ROM_SOURCE + '; ~90-110deg comes from general desk-ergonomics guidance, not a typing-specific measurement'),
  // This angle isn't really a population average -- it follows a geometric rule (the forearm rotates
  // so the palm faces roughly toward the head) that has to be checked against a solved hand/wrist
  // pose, not read off as a fixed number. Kept wide and centered on zero for that reason.
  elbowSwivelAngle: {
    mean: 0,
    variance: 900,
    source: 'not a fixed value -- depends on a geometric rule evaluated against the solved pose; neutral/wide placeholder',
  },
  // No direct measurement relates forearm length to hand length; the only known relationship is that
  // both independently track a person's overall height fairly strongly. mean=1.0 (forearm roughly
  // the same length as the hand) is a rough rule of thumb, not a fitted number.
  forearmLengthRatio: {
    mean: 1.0,
    variance: 0.01,
    source: 'no direct measurement found relating forearm length to hand length; rough rule-of-thumb placeholder',
  },
  // A real, documented effect (bending the wrist back tends to curl the fingers) with no coefficient
  // published anywhere found.
  tenodesisCoupling: {
    mean: 0,
    variance: 1,
    source: 'no numeric value found for this effect; placeholder',
  },
  // Both forearm length and hand length are known to track a person's height fairly strongly on their
  // own, which is indirect evidence they relate to each other too -- but nothing publishes that
  // derived relationship as a usable number.
  forearmLengthStatureCoupling: {
    mean: 0,
    variance: 1,
    source: 'no direct measurement found; placeholder inferred only from both lengths separately tracking height',
  },
  // This isn't really a fittable coefficient at all -- it's a geometric rule that should be computed
  // directly from the solved pose rather than approximated as a fixed number here.
  swivelWristForearmCoupling: {
    mean: 0,
    variance: 1,
    source: 'not a fitted coefficient -- should be computed from the geometric rule directly; placeholder',
  },
}

export const HAND_PRIOR_SEED: HandPriorState = {
  boneLengths,
  pipDipRom,
  mcpAxes,
  cmcMobility,
  dipPipCoupling,
  enslaving,
  wristForearm,
}
