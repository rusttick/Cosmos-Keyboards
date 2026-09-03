import { CONNECTIONS, FINGERS, type Hand } from '$lib/hand'

/** Draws MediaPipe's 21 keypoints and the CONNECTIONS skeleton onto a canvas overlaying the video.
 * estimateHands() is called with flipHorizontal: true, which sets MediaPipe's selfieMode and makes it
 * return landmarks already flipped to match a mirror-style view — the same reason the <video> itself
 * is separately CSS-mirrored (-scale-x-100). So the canvas passed in must NOT also be CSS-mirrored:
 * drawing these already-mirrored coordinates raw, on an unmirrored canvas overlaying the mirrored
 * video, is what lines them up. Mirroring the canvas too double-flips the overlay against real hand
 * motion (found the hard way — see docs/thumbs/test_results.md). */
export function drawHandOverlay(canvas: HTMLCanvasElement, keypoints: { x: number; y: number }[] | undefined) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  if (!keypoints) return

  const w = canvas.width
  const h = canvas.height

  ctx.strokeStyle = '#facc15'
  ctx.lineWidth = 2
  for (const finger of FINGERS) {
    for (const [a, b] of CONNECTIONS[finger]) {
      ctx.beginPath()
      ctx.moveTo(keypoints[a].x * w, keypoints[a].y * h)
      ctx.lineTo(keypoints[b].x * w, keypoints[b].y * h)
      ctx.stroke()
    }
  }

  ctx.fillStyle = '#a855f7'
  for (const p of keypoints) {
    ctx.beginPath()
    ctx.arc(p.x * w, p.y * h, 4, 0, 2 * Math.PI)
    ctx.fill()
  }
}

/** Draws the hand-plane normal (orientation.ts's palmTilt/handPlaneNormal -- deliberately not called
 * "palm normal," see that function's doc comment) as an arrow rooted at landmark 0 (the wrist) -- the
 * direct visual answer to "can the model tell which way the palm is facing," rather
 * than inferring it from a bubble position or a number. Same mirrored-keypoint convention as
 * drawHandOverlay (don't CSS-mirror the canvas); call this after drawHandOverlay on the same canvas, it
 * does not clear it.
 *
 * The arrow's on-screen direction/length (from tilt.x/tilt.y) is symmetric in depth -- a normal tilted
 * one way while facing the camera projects identically to the mirror-image tilt facing away, since
 * that's just how projecting a 3D vector onto 2D works. So which-way-facing can't be read from the
 * arrow's position at all -- it's carried entirely by color (green = tilt.z > 0, i.e. the same side as
 * whatever `reference` palmTilt was computed against -- the camera-forward axis if uncalibrated; red =
 * the opposite side) and the printed z value. If the model is actually differentiating orientations,
 * this color should flip promptly and cleanly at the true edge-on boundary, not drift or lag. */
export function drawPalmNormalOverlay(
  canvas: HTMLCanvasElement,
  keypoints: { x: number; y: number }[] | undefined,
  tilt: { x: number; y: number; z: number } | undefined,
) {
  const ctx = canvas.getContext('2d')
  if (!ctx || !keypoints || !tilt) return

  const w = canvas.width
  const h = canvas.height

  const cx = keypoints[0].x * w
  const cy = keypoints[0].y * h

  const length = Math.min(w, h) * 0.3
  const tipX = cx + tilt.x * length
  // Screen y grows downward; hand.vectors (and so tilt.y) is y-up -- see makeHand's `-a.y`.
  const tipY = cy - tilt.y * length

  const facingReference = tilt.z > 0
  const color = facingReference ? '#4ade80' : '#f87171'

  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.moveTo(cx, cy)
  ctx.lineTo(tipX, tipY)
  ctx.stroke()

  const angle = Math.atan2(tipY - cy, tipX - cx)
  const headLen = 12
  ctx.beginPath()
  ctx.moveTo(tipX, tipY)
  ctx.lineTo(tipX - headLen * Math.cos(angle - Math.PI / 6), tipY - headLen * Math.sin(angle - Math.PI / 6))
  ctx.lineTo(tipX - headLen * Math.cos(angle + Math.PI / 6), tipY - headLen * Math.sin(angle + Math.PI / 6))
  ctx.closePath()
  ctx.fill()

  ctx.beginPath()
  ctx.arc(cx, cy, 4, 0, 2 * Math.PI)
  ctx.fill()

  ctx.font = 'bold 13px monospace'
  ctx.fillStyle = color
  ctx.fillText(
    `${facingReference ? 'facing camera' : 'facing away'}  z=${tilt.z.toFixed(2)}`,
    cx + 10,
    cy - 10,
  )
}

/** Diagnostic for a suspected coordinate-frame mismatch: draws the palm-plane triangle (landmarks 0,
 * 5, 17) reconstructed purely from `hand.vectors`'s x/y -- the exact input handPlaneNormal() (and so
 * the arrow drawn by drawPalmNormalOverlay) is computed from -- in a small inset box, independent of and
 * comparable against the real skeleton drawHandOverlay already draws from the raw, mirrored 2D
 * keypoints (the same 0-5/0-17 edges, via CONNECTIONS.indexFinger[0]/pinky[0]).
 *
 * `hand.vectors` comes from MediaPipe's *world* landmarks (`multiHandWorldLandmarks`), a separate
 * output from the 2D `keypoints` the skeleton/screen position are built from -- nothing in this test
 * suite has ever checked whether the two share the same left/right convention, because every finding
 * validated so far (bone lengths, joint angles via angleTo()) is a magnitude or relative angle, both
 * invariant to a uniform mirror flip. A cross product (the hand-plane normal, and everything makeBasis()
 * builds on it) is exactly the kind of quantity a mirror flip *does* change the sign of. If this inset
 * triangle's handedness (which side landmark 5 vs. 17 falls on relative to the wrist) doesn't match the
 * real skeleton's, that confirms hand.vectors is mirrored relative to the screen -- a coordinate-frame
 * bug upstream of handPlaneNormal's own math, not a sign convention to guess-flip inside it.
 *
 * Also draws the normal arrow (if `tilt` is given), rooted at landmark 0 like drawPalmNormalOverlay and
 * drawVectorSpaceTopView, so all three views are directly comparable. */
export function drawVectorSpaceTriangle(
  canvas: HTMLCanvasElement,
  hand: Pick<Hand, 'vectors'> | undefined,
  tilt: { x: number; y: number; z: number } | undefined,
  box: { x: number; y: number; size: number } = { x: 10, y: 10, size: 190 },
) {
  const ctx = canvas.getContext('2d')
  if (!ctx || !hand) return

  const wrist = hand.vectors[0]
  const indexMcp = hand.vectors[5]
  const pinkyMcp = hand.vectors[17]

  const span = Math.max(
    Math.abs(indexMcp.x - wrist.x),
    Math.abs(indexMcp.y - wrist.y),
    Math.abs(pinkyMcp.x - wrist.x),
    Math.abs(pinkyMcp.y - wrist.y),
    1e-6,
  )
  const scale = (box.size / 3.4) / span
  const cx = box.x + box.size / 2
  const cy = box.y + box.size / 2
  const toScreen = (p: { x: number; y: number }) => ({
    x: cx + (p.x - wrist.x) * scale,
    // Screen y grows downward; hand.vectors is y-up (see makeHand's `-a.y`) -- same flip as
    // drawPalmNormalOverlay/PalmBubble use.
    y: cy - (p.y - wrist.y) * scale,
  })

  ctx.save()
  ctx.fillStyle = 'rgba(15,23,42,0.8)'
  ctx.fillRect(box.x, box.y, box.size, box.size)
  ctx.strokeStyle = '#475569'
  ctx.strokeRect(box.x, box.y, box.size, box.size)

  const w = toScreen(wrist)
  const i = toScreen(indexMcp)
  const p = toScreen(pinkyMcp)
  ctx.strokeStyle = '#38bdf8'
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.moveTo(w.x, w.y)
  ctx.lineTo(i.x, i.y)
  ctx.moveTo(w.x, w.y)
  ctx.lineTo(p.x, p.y)
  ctx.stroke()

  ctx.fillStyle = '#38bdf8'
  for (const q of [w, i, p]) {
    ctx.beginPath()
    ctx.arc(q.x, q.y, 6, 0, 2 * Math.PI)
    ctx.fill()
  }

  ctx.font = 'bold 20px monospace'
  ctx.fillStyle = '#f8fafc'
  ctx.fillText('0', w.x + 10, w.y - 10)
  ctx.fillText('5', i.x + 10, i.y - 10)
  ctx.fillText('17', p.x + 10, p.y - 10)

  if (tilt) {
    const len = box.size * 0.3
    const facingReference = tilt.z > 0
    const color = facingReference ? '#4ade80' : '#f87171'
    const tipX = w.x + tilt.x * len
    // Screen y grows downward; hand.vectors is y-up -- same flip as the triangle points above.
    const tipY = w.y - tilt.y * len
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(w.x, w.y)
    ctx.lineTo(tipX, tipY)
    ctx.stroke()
    const angle = Math.atan2(tipY - w.y, tipX - w.x)
    const headLen = 10
    ctx.beginPath()
    ctx.moveTo(tipX, tipY)
    ctx.lineTo(tipX - headLen * Math.cos(angle - Math.PI / 6), tipY - headLen * Math.sin(angle - Math.PI / 6))
    ctx.lineTo(tipX - headLen * Math.cos(angle + Math.PI / 6), tipY - headLen * Math.sin(angle + Math.PI / 6))
    ctx.closePath()
    ctx.fill()
  }

  ctx.font = 'bold 13px monospace'
  ctx.fillStyle = '#94a3b8'
  ctx.fillText('front (x,y)', box.x + 8, box.y + box.size - 10)
  ctx.restore()
}

/** Companion to drawVectorSpaceTriangle: same [0, 5, 17] triangle and normal arrow (rooted at landmark
 * 0, the wrist, like the other two normal-arrow views), but projected top-down (x, z) instead of
 * front-on (x, y) -- the dimension a front view can't show at all, which is
 * exactly why the front-on inset alone can't answer "which way does the normal point": depth is what
 * the normal's sign (palmTilt's `z`) actually encodes, and a front silhouette throws depth away
 * entirely. This view draws it directly instead.
 *
 * This codebase's established convention (`FORWARD = (0,0,1)` in orientation.ts, and empirically
 * verified: Tests 1-2's auto-detect-and-dwell gating reliably bootstrapped palm-facing captures for
 * both hands using exactly this convention) is that a normal near +z means facing the camera -- so an
 * arrow pointing toward the labeled `z>0 (camera)` edge here should mean this pose reads as
 * palm-facing. If it doesn't -- if the arrow points the wrong way in this view specifically, while the
 * front view (x,y) still matches the real skeleton's handedness -- that localizes the problem to depth
 * (world-landmark z), not the in-plane (x,y) vectors already ruled out. */
export function drawVectorSpaceTopView(
  canvas: HTMLCanvasElement,
  hand: Pick<Hand, 'vectors'> | undefined,
  tilt: { x: number; z: number } | undefined,
  box: { x: number; y: number; size: number } = { x: 210, y: 10, size: 190 },
) {
  const ctx = canvas.getContext('2d')
  if (!ctx || !hand) return

  const wrist = hand.vectors[0]
  const indexMcp = hand.vectors[5]
  const pinkyMcp = hand.vectors[17]

  const span = Math.max(
    Math.abs(indexMcp.x - wrist.x),
    Math.abs(indexMcp.z - wrist.z),
    Math.abs(pinkyMcp.x - wrist.x),
    Math.abs(pinkyMcp.z - wrist.z),
    1e-6,
  )
  const scale = (box.size / 3.4) / span
  const cx = box.x + box.size / 2
  const cy = box.y + box.size / 2
  // Screen y grows downward; drawn so +z (facing-camera per the established convention) is UP in the
  // box, matching the front view's "+y is up" convention.
  const toScreen = (p: { x: number; z: number }) => ({
    x: cx + (p.x - wrist.x) * scale,
    y: cy - (p.z - wrist.z) * scale,
  })

  ctx.save()
  ctx.fillStyle = 'rgba(15,23,42,0.8)'
  ctx.fillRect(box.x, box.y, box.size, box.size)
  ctx.strokeStyle = '#475569'
  ctx.strokeRect(box.x, box.y, box.size, box.size)

  const w = toScreen(wrist)
  const i = toScreen(indexMcp)
  const p = toScreen(pinkyMcp)
  ctx.strokeStyle = '#38bdf8'
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.moveTo(w.x, w.y)
  ctx.lineTo(i.x, i.y)
  ctx.moveTo(w.x, w.y)
  ctx.lineTo(p.x, p.y)
  ctx.stroke()

  ctx.fillStyle = '#38bdf8'
  for (const q of [w, i, p]) {
    ctx.beginPath()
    ctx.arc(q.x, q.y, 6, 0, 2 * Math.PI)
    ctx.fill()
  }
  ctx.font = 'bold 20px monospace'
  ctx.fillStyle = '#f8fafc'
  ctx.fillText('0', w.x + 10, w.y - 10)
  ctx.fillText('5', i.x + 10, i.y - 10)
  ctx.fillText('17', p.x + 10, p.y - 10)

  if (tilt) {
    const len = box.size * 0.3
    const facingCamera = tilt.z > 0
    const color = facingCamera ? '#4ade80' : '#f87171'
    const tipX = w.x + tilt.x * len
    const tipY = w.y - tilt.z * len
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(w.x, w.y)
    ctx.lineTo(tipX, tipY)
    ctx.stroke()
    const angle = Math.atan2(tipY - w.y, tipX - w.x)
    const headLen = 10
    ctx.beginPath()
    ctx.moveTo(tipX, tipY)
    ctx.lineTo(tipX - headLen * Math.cos(angle - Math.PI / 6), tipY - headLen * Math.sin(angle - Math.PI / 6))
    ctx.lineTo(tipX - headLen * Math.cos(angle + Math.PI / 6), tipY - headLen * Math.sin(angle + Math.PI / 6))
    ctx.closePath()
    ctx.fill()
  }

  ctx.font = 'bold 12px monospace'
  ctx.fillStyle = '#94a3b8'
  ctx.fillText('z>0 (camera) ↑', box.x + 8, box.y + 16)
  ctx.fillText('z<0 ↓', box.x + 8, box.y + box.size - 24)
  ctx.fillText('top (x,z)', box.x + 8, box.y + box.size - 10)
  ctx.restore()
}
