/**
 * Stage 7 follow-up (docs/thumbs/representing-keyboard-build-inputs.md): a "neutral" pose for the rest
 * skeleton, using each joint's own fitted `meanDeg` from `HandPriorState`'s `BetaRom` -- the dataset's
 * own notion of a typical angle (the same value `postureCost.ts`'s Gaussian penalty is centered on) --
 * rather than an assumed straight/fully-extended pose.
 *
 * Joints with no modeled prior at all are held at 0 (straight): the thumb's un-modeled MCP/IP hinges
 * (`sampleThumbCmcSweep.ts`'s own doc comment -- a real, already-identified schema gap, not invented
 * here) and every non-thumb finger's fixed metacarpal (`degree: 0`, no DOF to have a mean in the first
 * place). Ring/pinky's own base-joint flexion (`$lib/hand.ts`'s `degreesFor` gives them `degree: 1` at
 * joint index 0, unlike index/middle's fixed `degree: 0`) does have a real prior
 * (`cmcMobility.ring/pinky.flexionRom`) and uses it.
 *
 * DIP is NOT read from `pipDipRom.dip[finger].meanDeg` directly, even though that field exists --
 * `sampleFingerSweep.ts` never treats DIP as independently sourced either; it's always derived from
 * PIP via `dipPipCoupling` (`dip ≈ slope·pip + intercept`, clamped to DIP's own fitted bounds). Using
 * `pipDipRom.dip`'s own mean here instead was a real bug (caught live): for the index finger it produced
 * a DIP angle 10 degrees off from what the coupling predicts at PIP's own mean, so the resulting
 * fingertip was a pose `sampleFingerSweep` could never actually produce, and visibly didn't sit among
 * its own capability cloud. Deriving DIP the same way here as everywhere else fixes that.
 */
import type { Finger } from '$lib/hand'
import type { HandPriorState } from '../priors/handModel'

const DEG2RAD = Math.PI / 180

/** `[angleZ, angleY]` in radians for `finger`'s joint `jointIndex`, matching `SolvedHand.fkBy`'s own
 * `(i) => [angleZ, angleY]` callback shape -- pass this directly as (or wrap it into) that callback. */
export function neutralPoseAngleRad(prior: HandPriorState, finger: Finger, jointIndex: number): [number, number] {
  if (finger === 'thumb') {
    if (jointIndex === 1) {
      const cmc = prior.cmcMobility.thumb
      return [cmc.flexExtRom.meanDeg * DEG2RAD, cmc.abAdRom.meanDeg * DEG2RAD]
    }
    return [0, 0] // joint 0 (metacarpal stub, degree: 0) and joints 2/3 (no prior modeled yet)
  }

  if (jointIndex === 0) {
    if (finger === 'ringFinger') return [prior.cmcMobility.ring.flexionRom.meanDeg * DEG2RAD, 0]
    if (finger === 'pinky') return [prior.cmcMobility.pinky.flexionRom.meanDeg * DEG2RAD, 0]
    return [0, 0] // index/middle's metacarpal is fixed (degree: 0) -- no DOF to have a mean
  }
  if (jointIndex === 1) {
    const mcp = prior.mcpAxes[finger]
    return [mcp.flexExtRom.meanDeg * DEG2RAD, mcp.abAdRom.meanDeg * DEG2RAD]
  }
  if (jointIndex === 2) {
    return [prior.pipDipRom.pip[finger].meanDeg * DEG2RAD, 0]
  }
  if (jointIndex === 3) {
    const pipMeanDeg = prior.pipDipRom.pip[finger].meanDeg
    const dipRom = prior.pipDipRom.dip[finger]
    const [slope, intercept] = prior.dipPipCoupling[finger].mean
    const dipDeg = Math.min(dipRom.maxDeg, Math.max(dipRom.minDeg, slope * pipMeanDeg + intercept))
    return [dipDeg * DEG2RAD, 0]
  }
  return [0, 0]
}
