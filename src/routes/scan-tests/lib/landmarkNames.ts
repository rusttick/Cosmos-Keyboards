/** Standard MediaPipe Hands 21-point landmark names, index-matched -- used wherever a human needs to
 * pick a specific landmark by name rather than remembering the raw index (the `/bones` caliper page). */
export const LANDMARK_NAMES: string[] = [
  'Wrist',
  'Thumb CMC',
  'Thumb MCP',
  'Thumb IP',
  'Thumb tip',
  'Index MCP',
  'Index PIP',
  'Index DIP',
  'Index tip',
  'Middle MCP',
  'Middle PIP',
  'Middle DIP',
  'Middle tip',
  'Ring MCP',
  'Ring PIP',
  'Ring DIP',
  'Ring tip',
  'Pinky MCP',
  'Pinky PIP',
  'Pinky DIP',
  'Pinky tip',
]

export function landmarkLabel(i: number): string {
  return `${i} — ${LANDMARK_NAMES[i]}`
}
