<script lang="ts">
  /** Bubble/crosshair leveling indicator, driven by orientation.ts's palmTilt(). The dot's direction
   * off-center is which way to tilt the palm to correct, its distance from center is how far off --
   * meant to be glanceable during live positioning, unlike a bare numeric angle. */
  export let tiltX: number = 0
  export let tiltY: number = 0
  export let totalDeg: number = 0
  /** Tilt (degrees) that fills the outer ring -- smaller values give more resolution for small
   * corrections at the cost of clipping sooner on large ones. */
  export let maxDeg: number = 40
  /** Tilt (degrees) at/under which the dot reads "level" (green). */
  export let goodDeg: number = 8
  export let size: number = 130

  $: scale = 1 / Math.sin((maxDeg * Math.PI) / 180)
  $: rawX = tiltX * scale
  $: rawY = tiltY * scale
  $: mag = Math.hypot(rawX, rawY)
  $: clampedMag = Math.min(mag, 1)
  $: dirX = mag > 0 ? rawX / mag : 0
  $: dirY = mag > 0 ? rawY / mag : 0
  $: ringRadius = size / 2 - 12
  $: dotCx = size / 2 + dirX * clampedMag * ringRadius
  // Screen y grows downward; hand.vectors is already y-up (see makeHand), so a positive tiltY
  // (tilting up) should move the dot up on screen -- flip here.
  $: dotCy = size / 2 - dirY * clampedMag * ringRadius
  $: good = totalDeg <= goodDeg
  $: clipped = mag > 1
</script>

<div class="flex flex-col items-center gap-1 select-none">
  <svg width={size} height={size} viewBox="0 0 {size} {size}">
    <circle
      cx={size / 2}
      cy={size / 2}
      r={size / 2 - 2}
      fill="#0f172a"
      stroke="#475569"
      stroke-width="2"
    />
    <circle
      cx={size / 2}
      cy={size / 2}
      r={ringRadius}
      fill="none"
      stroke="#334155"
      stroke-width="1"
      stroke-dasharray="2 4"
    />
    <line x1={size / 2} y1="6" x2={size / 2} y2={size - 6} stroke="#334155" stroke-width="1" />
    <line x1="6" y1={size / 2} x2={size - 6} y2={size / 2} stroke="#334155" stroke-width="1" />
    <circle cx={size / 2} cy={size / 2} r="3" fill="#64748b" />
    <circle
      cx={dotCx}
      cy={dotCy}
      r="8"
      fill={good ? '#34d399' : clipped ? '#f87171' : '#fbbf24'}
      stroke="#0f172a"
      stroke-width="2"
    />
  </svg>
  <span class="text-xs" class:text-emerald-400={good} class:text-amber-400={!good}>
    {totalDeg.toFixed(1)}&deg; off level
  </span>
</div>
