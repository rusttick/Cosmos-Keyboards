import type { Hand } from '$lib/hand'
import { Vector3 } from 'three'

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

/** Angle (degrees) between the palm's normal and the camera's forward axis.
 * ~0deg = palm-facing, ~180deg = palm-away, ~90deg = lateral/edge-on.
 * Left/Right hands have opposite chirality, so the normal is negated for
 * Right hands to keep the convention consistent across handedness
 * (verified against real capture data: raw Right-hand angles mirror Left's). */
export function palmAngleDeg(hand: Hand): number {
  const wrist = hand.vectors[0]
  const indexMcp = hand.vectors[5]
  const pinkyMcp = hand.vectors[17]
  const v1 = new Vector3().subVectors(indexMcp, wrist)
  const v2 = new Vector3().subVectors(pinkyMcp, wrist)
  const normal = new Vector3().crossVectors(v1, v2).normalize()
  if (hand.handedness === 'Right') normal.negate()
  return (normal.angleTo(FORWARD) * 180) / Math.PI
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
