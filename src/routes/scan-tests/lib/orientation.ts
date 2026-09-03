import { type Hand, signedJointAngle } from '$lib/hand'
import { Quaternion, Vector3 } from 'three'

export type Orientation = 'palm-facing' | 'palm-away' | 'thumb-away' | 'thumb-toward'
export type Handedness = 'Left' | 'Right'

export const ORIENTATION_DESCRIPTIONS: Record<Orientation, string> = {
  'palm-facing': 'Palm facing straight down toward the camera (the well-trained, well-textured MediaPipe case).',
  'palm-away': "Back of the hand facing the camera — the orientation scan_procedure.md documents as MediaPipe's weak case.",
  'thumb-away':
    'Palms-facing-each-other posture, rolled so the thumb lifts up and away from the camera and the pinky/ulnar edge faces toward it. The only practical lateral orientation on this rig — see docs/thumbs/test_results.md, 2026-08-31.',
  'thumb-toward':
    'Palms-facing-each-other posture, rolled the opposite way. Dropped from active testing — tracking is unstable through the whole roll on this rig; see docs/thumbs/test_results.md, 2026-08-31.',
}

export const ORIENTATION_TARGET_DESCRIPTIONS: Record<Orientation, string> = {
  'palm-facing': 'angle < 30°',
  'palm-away': 'angle > 150°',
  'thumb-away': '60-120°, thumb farther from camera than pinky',
  'thumb-toward': '60-120°, thumb closer to camera than pinky',
}

const FORWARD = new Vector3(0, 0, 1)

/** Normal vector (unit length) of the plane through landmarks [0, 5, 17] -- the same plane $lib/hand.ts's
 * basis now uses (see docs/thumbs/test_results.md, 2026-09-02). Deliberately NOT named "palm normal":
 * that name asserts it reliably points out of the palm, which live testing disproved -- it's correct at
 * rest, but flips during real motion whenever MediaPipe's handedness classification (Left/Right, a
 * separate, imperfect prediction from landmark tracking that this function's sign depends on) briefly
 * misclassifies the hand, confirmed live via a rig where the flip count climbs with movement (same doc
 * entry). So this is a geometric quantity with an unreliable sign, not a validated anatomical direction
 * -- callers that need to know "is this actually the palm side" should not assume it, and should check
 * against something independent (e.g. fingerCurlAgreesWithNormal) rather than trust this in isolation.
 *
 * The Right-hand negation keeps Left/Right internally consistent with each other (verified against real
 * capture data: raw Right-hand angles mirror Left's) -- that mirroring is real, it's the *overall*
 * front/back sign on top of it that isn't reliable. Exported so a capture page can grab a raw sample to
 * average into a calibration reference (see palmTilt's `reference` param) -- everything else in this
 * module should keep going through palmTilt/palmAngleDeg. */
export function handPlaneNormal(hand: Hand): Vector3 {
  const wrist = hand.vectors[0]
  const indexMcp = hand.vectors[5]
  const pinkyMcp = hand.vectors[17]
  const v1 = new Vector3().subVectors(indexMcp, wrist)
  const v2 = new Vector3().subVectors(pinkyMcp, wrist)
  const normal = new Vector3().crossVectors(v1, v2).normalize()
  if (hand.handedness === 'Right') normal.negate()
  return normal
}

/** Angle (degrees) between the hand-plane normal (handPlaneNormal) and the camera's forward axis.
 * ~0deg = palm-facing, ~180deg = palm-away, ~90deg = lateral/edge-on -- this labeling is validated at
 * rest and for slow/static poses (Tests 1-2's noise-pattern result: the `angle<30`-labeled group showed
 * the lower noise the literature predicts for genuine palm-facing, and this doc's 2026-09-02 entry
 * confirmed `angle` reads correctly at a static palm-facing pose even on the rig where the sign was
 * found unreliable). NOT validated through fast/large rotations -- see handPlaneNormal's doc comment
 * for why the underlying sign can flip mid-motion there. */
export function palmAngleDeg(hand: Hand): number {
  return (handPlaneNormal(hand).angleTo(FORWARD) * 180) / Math.PI
}

export interface PalmTilt {
  /** Transverse (camera x) component of the palm normal -- roughly sin(tilt angle) toward the
   * camera's right. 0 = level in this axis. */
  x: number
  /** Transverse (camera y) component of the palm normal -- roughly sin(tilt angle) upward (hand.vectors
   * is already y-up, see makeHand's `-a.y`). 0 = level in this axis. */
  y: number
  /** Same value palmAngleDeg() reports, exposed alongside x/y so one normal computation drives both a
   * directional bubble and a numeric readout. */
  totalDeg: number
  /** Raw depth (camera z) component of the palm normal, exposed as a diagnostic -- the bubble is built
   * from landmark positions whose depth (z) estimate is inherently noisier than x/y (the same
   * monocular-depth weakness documented throughout this test suite, e.g. the thumb-CMC toward-camera
   * finding). Rotations that foreshorten the [0,5,17] triangle toward the camera push more of the
   * normal's magnitude into z and less into the x/y the bubble displays, which is the suspected
   * mechanism behind the bubble reading unreliably in exactly those directions. Watching z alongside
   * the bubble should show whether "bubble stops correcting" and "z collapses/goes unstable" track
   * together -- if they do, that confirms the mechanism rather than just the symptom. */
  z: number
}

/** Palm tilt as a 2D offset from level (x, y), for a bubble/crosshair-style leveling indicator --
 * unlike palmAngleDeg's single scalar, this tells you which way to tilt to correct, not just how far
 * off you are. Sign/axis mapping is a best-guess convention (like every other one in this test suite,
 * e.g. thumbDepthSign) pending live verification against real footage: x should read positive when
 * the palm tilts toward the camera's right, y positive when it tilts up.
 *
 * `reference` re-zeros the reading against a calibrated "level" normal instead of the raw camera
 * forward axis -- live capture found a consistent ~10deg baseline offset at true physical level (the
 * [0,5,17] landmark triangle's normal isn't exactly the anatomical palm normal), which is a real,
 * repeatable bias worth calibrating out per-session rather than baking a guessed constant into the
 * model. This is a live calibration, not a hardcoded correction: a capture page should sample a few
 * handPlaneNormal() readings while the hand is held at a known-true-level reference pose, average them,
 * and pass that in here -- the same "average a short buffer, don't trust one frame" pattern used
 * throughout this test suite (e.g. thumb-cmc's start reference). `totalDeg`/`x`/`y`/`z` all become
 * relative to that reference; passing no reference falls back to the uncalibrated (raw, FORWARD-
 * relative) reading. */
export function palmTilt(hand: Hand, reference?: Vector3): PalmTilt {
  const normal = handPlaneNormal(hand)
  if (!reference) {
    return { x: normal.x, y: normal.y, totalDeg: (normal.angleTo(FORWARD) * 180) / Math.PI, z: normal.z }
  }
  const toForward = new Quaternion().setFromUnitVectors(reference, FORWARD)
  const adjusted = normal.clone().applyQuaternion(toForward)
  return { x: adjusted.x, y: adjusted.y, totalDeg: (adjusted.angleTo(FORWARD) * 180) / Math.PI, z: adjusted.z }
}

/** Direction a finger's proximal phalanx (bone1) bends away from "straight," relative to its own
 * metacarpal (bone0) -- the component of bone1 perpendicular to bone0. Computed directly from raw
 * `hand.vectors` (camera space, NOT `hand.limbs`, which is expressed in `hand.basis`'s frame -- the
 * same frame built from the very cross product whose sign is in question, so using it here would risk
 * silently inheriting that uncertainty instead of giving an independent check). */
function fingerBendDirection(hand: Hand, mcpLandmark: number, pipLandmark: number): Vector3 {
  const wrist = hand.vectors[0]
  const bone0 = new Vector3().subVectors(hand.vectors[mcpLandmark], wrist)
  const bone1 = new Vector3().subVectors(hand.vectors[pipLandmark], hand.vectors[mcpLandmark])
  const proj = bone0.clone().multiplyScalar(bone0.dot(bone1) / bone0.lengthSq())
  return bone1.sub(proj)
}

/** Independent check on handPlaneNormal()'s sign, from anatomy rather than another projection of the
 * same noisy landmarks: excluding hyperextension, a flexed middle or ring finger curls toward the
 * palm's front -- the same side a genuine palm normal should point out of. So (finger bend direction) .
 * (hand-plane normal) should be positive whenever those fingers are genuinely flexed; a negative dot
 * product means handPlaneNormal() has the wrong (back-of-hand) sign for this frame.
 *
 * Gated on real flexion at both MCPs (via signedJointAngle, which stays reliable regardless of the
 * hand-plane-normal sign question -- see its own doc comment: it's a relative angle between two
 * basis-transformed vectors, invariant to which proper rotation the shared basis happens to apply) --
 * straight or hyperextended fingers give no usable curl signal, so this returns `undefined` rather than
 * a misleading value when `minFlexionDeg` isn't cleared on both fingers.
 *
 * UNVERIFIED HYPOTHESIS, like every sign convention in this test suite -- needs live testing against
 * real footage, specifically checking whether the sign stays reliable through the same rotations that
 * broke handPlaneNormal's own sign directly (docs/thumbs/test_results.md, 2026-09-02). */
export function fingerCurlAgreesWithNormal(hand: Hand, minFlexionDeg = 15): number | undefined {
  const middleFlex = signedJointAngle(hand, 'middleFinger', 0)
  const ringFlex = signedJointAngle(hand, 'ringFinger', 0)
  if (middleFlex < minFlexionDeg || ringFlex < minFlexionDeg) return undefined

  const bend = fingerBendDirection(hand, 9, 10).add(fingerBendDirection(hand, 13, 14)).normalize()
  return bend.dot(handPlaneNormal(hand))
}

/** Depth (raw camera-space z) of the thumb's base relative to the pinky's base, hand-vector index
 * 1 (thumb CMC) vs. 17 (pinky MCP), both measured from the wrist. Distinguishes the two lateral
 * rolls, which the palm angle alone can't — both reach ~90deg regardless of which way you rolled.
 * Sign convention (positive = thumb closer to camera) confirmed against real thumb-away captures
 * (consistently negative, both hands) — see docs/thumbs/test_results.md, 2026-08-31. */
export function thumbDepthSign(hand: Hand): number {
  const wrist = hand.vectors[0]
  const thumbBase = hand.vectors[1]
  const pinkyMcp = hand.vectors[17]
  return -(thumbBase.z - wrist.z - (pinkyMcp.z - wrist.z))
}

export function inTargetRange(
  orientation: Orientation,
  angle: number,
  thumbDepthValue: number | undefined,
): boolean {
  switch (orientation) {
    case 'palm-facing':
      return angle < 30
    case 'palm-away':
      return angle > 150
    case 'thumb-away':
      return angle > 60 && angle < 120 && thumbDepthValue !== undefined && thumbDepthValue < 0
    case 'thumb-toward':
      return angle > 60 && angle < 120 && thumbDepthValue !== undefined && thumbDepthValue > 0
  }
}
