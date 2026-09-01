import { CONNECTIONS, FINGERS } from '$lib/hand'

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
