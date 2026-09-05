import type { Hand } from '$lib/hand'
import { Vector3 } from 'three'

/** Landmark pairs to draw as skeleton lines, deliberately separate from `$lib/hand.ts`'s
 * `CONNECTIONS` -- that constant defines each finger's actual bone vectors (`hand.limbs`), used by
 * every angle/fit in the model, so editing it to change how the hand *looks* would corrupt
 * measurements for every consumer. This list is display-only: each finger's own segments (unchanged
 * from CONNECTIONS) plus a "knuckle line" (2-5, 5-9, 9-13, 13-17) across the MCPs instead of fanning
 * index/middle/ring out from the wrist -- a more recognizable hand outline. Thumb (0-1) and pinky
 * (0-17) keep their wrist spokes since nothing asked to drop those. Shared by every scan-tests page
 * via drawHandOverlay/drawSkeletonView -- change it once here, not per page. */
export const HAND_DRAW_EDGES: [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4], // thumb
  [5, 6],
  [6, 7],
  [7, 8], // index
  [9, 10],
  [10, 11],
  [11, 12], // middle
  [13, 14],
  [14, 15],
  [15, 16], // ring
  [0, 17],
  [17, 18],
  [18, 19],
  [19, 20], // pinky
  [2, 5],
  [5, 9],
  [9, 13],
  [13, 17], // knuckle line
]

/** Shared line+arrowhead primitive, factored out for drawAxisTriad/drawSkeletonView so a 5th copy of
 * this same arrowhead math doesn't get pasted in -- drawPalmNormalOverlay/drawVectorSpaceTriangle/
 * TopView each still have their own older copy, left alone to avoid touching already-tuned,
 * long-validated diagnostic code for an unrelated change. */
function drawArrow2D(
  ctx: CanvasRenderingContext2D,
  from: { x: number; y: number },
  to: { x: number; y: number },
  color: string,
  lineWidth = 3,
) {
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = lineWidth
  ctx.beginPath()
  ctx.moveTo(from.x, from.y)
  ctx.lineTo(to.x, to.y)
  ctx.stroke()
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  const headLen = 9
  ctx.beginPath()
  ctx.moveTo(to.x, to.y)
  ctx.lineTo(to.x - headLen * Math.cos(angle - Math.PI / 6), to.y - headLen * Math.sin(angle - Math.PI / 6))
  ctx.lineTo(to.x - headLen * Math.cos(angle + Math.PI / 6), to.y - headLen * Math.sin(angle + Math.PI / 6))
  ctx.closePath()
  ctx.fill()
}

/** Draws MediaPipe's 21 keypoints and the HAND_DRAW_EDGES skeleton onto a canvas overlaying the video.
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
  for (const [a, b] of HAND_DRAW_EDGES) {
    ctx.beginPath()
    ctx.moveTo(keypoints[a].x * w, keypoints[a].y * h)
    ctx.lineTo(keypoints[b].x * w, keypoints[b].y * h)
    ctx.stroke()
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

/** Video-overlay equivalent of drawAxisTriad: draws all 3 of `palmBasisAxes()`'s raw vectors (normal,
 * up, left -- see its doc comment in $lib/hand.ts) rooted at the wrist keypoint, using each vector's
 * own raw x/y components directly (hand.vectors' x/y already correspond to the image plane, the same
 * assumption drawPalmNormalOverlay's tilt.x/tilt.y rely on) rather than a projection through an
 * arbitrary camera basis -- appropriate here since the "camera" for this overlay is the real one, not
 * a synthetic viewpoint. Same color convention as drawAxisTriad (normal=cyan, up=amber, left=pink) so
 * the two are directly comparable when used side by side (e.g. multi-view's center tile vs. its side
 * tiles). Call after drawHandOverlay on the same canvas; doesn't clear it. */
export function drawAxisTriadOverlay(
  canvas: HTMLCanvasElement,
  keypoints: { x: number; y: number }[] | undefined,
  axes: { normal: Vector3; up: Vector3; left: Vector3 } | undefined,
) {
  const ctx = canvas.getContext('2d')
  if (!ctx || !keypoints || !axes) return

  const w = canvas.width
  const h = canvas.height
  const cx = keypoints[0].x * w
  const cy = keypoints[0].y * h
  const length = Math.min(w, h) * 0.3
  const dotThreshold = length * 0.08

  const entries: [Vector3, string][] = [
    [axes.normal, '#38bdf8'],
    [axes.up, '#facc15'],
    [axes.left, '#f472b6'],
  ]
  for (const [axis, color] of entries) {
    const tip = { x: cx + axis.x * length, y: cy - axis.y * length } // y-down screen vs. y-up vectors
    const drawnLen = Math.hypot(tip.x - cx, tip.y - cy)
    if (drawnLen < dotThreshold) {
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(cx, cy, 4, 0, 2 * Math.PI)
      ctx.fill()
    } else {
      drawArrow2D(ctx, { x: cx, y: cy }, tip, color, 2)
    }
  }
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

/** Builds an orthonormal camera basis {right, up} for viewing along `forward` (the direction the
 * camera looks, i.e. into the screen) -- the standard "look-at" construction, resolving the
 * remaining degree of freedom (rotation about `forward`) from `upHint`. Falls back to a different
 * hint when `forward` is nearly parallel to the primary one, since cross(upHint, forward) degenerates
 * there. Used by multi-view to build a camera basis for each of its ring viewpoints. */
export function lookAtBasis(
  forward: Vector3,
  upHint: Vector3 = new Vector3(0, 1, 0),
  upHintFallback: Vector3 = new Vector3(0, 0, 1),
): { right: Vector3; up: Vector3; forward: Vector3 } {
  const f = forward.clone().normalize()
  const hint = Math.abs(f.dot(upHint)) > 0.95 ? upHintFallback : upHint
  const right = new Vector3().crossVectors(hint, f).normalize()
  const up = new Vector3().crossVectors(f, right).normalize()
  return { right, up, forward: f }
}

/** Draws `hand.vectors`'s full skeleton (all 5 fingers via HAND_DRAW_EDGES, not just the [0,5,17]
 * triangle drawVectorSpaceTriangle/TopView draw) and the hand-plane normal, orthographically
 * projected through an arbitrary camera basis instead of a fixed (x,y)/(x,z) plane -- for viewing the
 * same reconstructed 3D skeleton from any chosen angle (e.g. multi-view's FreeCAD-style Front/Top/
 * Right/... viewpoints, all locked to the live hand-plane-normal direction).
 *
 * `scale` is a caller-supplied pixels-per-hand-unit factor rather than an auto-fit computed per
 * frame, so the rendered hand stays a visually stable size frame to frame instead of jarringly
 * resizing as the pose changes -- derive it once from a roughly pose-invariant reference length (e.g.
 * wrist-to-middle-MCP) and reuse it across frames and tiles, the same idea
 * drawVectorSpaceTriangle/TopView's `span`-based scale uses, just shared rather than recomputed per
 * box. `options.throughScreen` ('toward' | 'away'), if given, draws a toward/away glyph (a filled or
 * hollow circle) instead of an arrow -- for a view whose viewing axis is parallel to the normal, where
 * an ordinary arrow would project to an uninformative zero-length dot. Otherwise, `options.facingCamera`,
 * if given, colors the normal arrow the way drawPalmNormalOverlay does (green = pointing toward this
 * particular view's camera, red = away) -- computed by the caller, since "facing this camera" depends
 * on the view direction chosen for this tile, not just the projection basis. If both are omitted, the
 * arrow draws in a neutral color instead of silently defaulting to "facing away" -- appropriate for a
 * view where facing-this-camera isn't a meaningful per-tile signal (e.g. multi-view's Front/Rear/
 * Right/Left tiles, where the normal renders pointing "up" in every one of them by construction, not
 * something that varies frame to frame or tile to tile). */
export function drawSkeletonView(
  canvas: HTMLCanvasElement,
  hand: Pick<Hand, 'vectors'> | undefined,
  normal: Vector3 | undefined,
  basis: { right: Vector3; up: Vector3 },
  scale: number,
  options: { facingCamera?: boolean; throughScreen?: 'toward' | 'away'; label?: string } = {},
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.fillStyle = '#0f172a'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  if (!hand) return

  const wrist = hand.vectors[0]
  const cx = canvas.width / 2
  const cy = canvas.height / 2
  const toScreen = (p: Vector3) => {
    const rel = new Vector3().subVectors(p, wrist)
    // Screen y grows downward; hand.vectors is y-up (see makeHand's `-a.y`) -- same flip every other
    // drawing function in this module uses.
    return { x: cx + rel.dot(basis.right) * scale, y: cy - rel.dot(basis.up) * scale }
  }

  ctx.strokeStyle = '#facc15'
  ctx.lineWidth = 2
  for (const [a, b] of HAND_DRAW_EDGES) {
    const pa = toScreen(hand.vectors[a])
    const pb = toScreen(hand.vectors[b])
    ctx.beginPath()
    ctx.moveTo(pa.x, pa.y)
    ctx.lineTo(pb.x, pb.y)
    ctx.stroke()
  }
  ctx.fillStyle = '#a855f7'
  for (const p of hand.vectors) {
    const s = toScreen(p)
    ctx.beginPath()
    ctx.arc(s.x, s.y, 3, 0, 2 * Math.PI)
    ctx.fill()
  }

  if (normal && options.throughScreen) {
    // The normal points along (or against) this view's own viewing axis -- its projection onto
    // (right, up) is ~zero, so an arrow would draw as an invisible dot regardless of the real
    // direction. Draw an explicit toward/away glyph instead (a filled circle for "coming at you," a
    // ring for "receding into the screen"), the same convention a 3D axis gizmo uses for an axis
    // pointing straight at or away from the camera.
    const w = toScreen(wrist)
    const color = options.throughScreen === 'toward' ? '#4ade80' : '#f87171'
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(w.x, w.y, 9, 0, 2 * Math.PI)
    if (options.throughScreen === 'toward') ctx.fill()
    else ctx.stroke()
  } else if (normal) {
    const w = toScreen(wrist)
    const len = Math.min(canvas.width, canvas.height) * 0.35
    const color = options.facingCamera === undefined ? '#38bdf8' : options.facingCamera ? '#4ade80' : '#f87171'
    drawArrow2D(
      ctx,
      w,
      { x: w.x + normal.dot(basis.right) * len, y: w.y - normal.dot(basis.up) * len },
      color,
    )
  }

  if (options.label) {
    ctx.font = 'bold 11px monospace'
    ctx.fillStyle = '#94a3b8'
    ctx.fillText(options.label, 6, canvas.height - 8)
  }
}

/** Draws all 3 of `palmBasisAxes()`'s raw vectors (normal, up, left -- see its doc comment in
 * $lib/hand.ts) as a color-coded arrow triad, rooted at the wrist and projected through an arbitrary
 * camera basis the same way `drawSkeletonView` projects the skeleton -- meant to be layered on top of
 * a `drawSkeletonView` call on the same canvas (it doesn't clear or redraw the skeleton itself).
 *
 * Built for a specific diagnostic: watching whether this triad stays rigidly attached to the hand as
 * it moves (the orientation frame is stable, real hand motion is what's being seen) or visibly
 * twists/wobbles independently of the visible hand motion (the orientation frame itself is drifting --
 * e.g. the whole-arm-rotation leak into `hand.basis` documented in docs/thumbs/test_results.md,
 * 2026-09-03). A degenerate (near-zero-length) projection is drawn as a small dot rather than an
 * arrow with an undefined direction, the same treatment `drawSkeletonView`'s `throughScreen` option
 * gives the normal specifically when it's exactly axis-aligned with the viewing direction -- here it's
 * handled generically since any of the three axes could foreshorten to near-zero in an arbitrary view,
 * not just in the two views deliberately chosen to look straight down one. */
export function drawAxisTriad(
  canvas: HTMLCanvasElement,
  hand: Pick<Hand, 'vectors'> | undefined,
  axes: { normal: Vector3; up: Vector3; left: Vector3 },
  basis: { right: Vector3; up: Vector3 },
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx || !hand) return

  // The wrist is drawSkeletonView's projection origin (rel = p - wrist), so it always projects to
  // exactly canvas center -- reuse that rather than recomputing a `rel` of zero.
  const w = { x: canvas.width / 2, y: canvas.height / 2 }
  const len = Math.min(canvas.width, canvas.height) * 0.35
  const dotThreshold = len * 0.08

  const entries: [Vector3, string][] = [
    [axes.normal, '#38bdf8'], // matches drawPalmNormalOverlay/drawSkeletonView's neutral normal color
    [axes.up, '#facc15'], // "0->5" axis -- amber
    [axes.left, '#f472b6'], // cross(normal, up) -- pink
  ]
  for (const [axis, color] of entries) {
    const tip = { x: w.x + axis.dot(basis.right) * len, y: w.y - axis.dot(basis.up) * len }
    const drawnLen = Math.hypot(tip.x - w.x, tip.y - w.y)
    if (drawnLen < dotThreshold) {
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(w.x, w.y, 4, 0, 2 * Math.PI)
      ctx.fill()
    } else {
      drawArrow2D(ctx, w, tip, color, 2)
    }
  }
}
