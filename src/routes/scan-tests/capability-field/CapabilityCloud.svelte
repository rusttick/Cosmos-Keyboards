<script lang="ts">
  /**
   * Renders a capability field/cloud (docs/thumbs/representing-keyboard-build-inputs.md's naming):
   * one small marker per sample, colored either by a scalar (posture cost, manipulability, positional
   * uncertainty -- Stage 8) through a sequential colormap, or by a fixed `color` (finger identity --
   * Stage 5), whichever the caller passes. This is Stage 2's "settled API," extended (not replaced) in
   * Stage 5 -- every stage feeds real `points`/`scalar`/`color` data into this same component, only the
   * data source changes (synthetic in Stage 2, `fkBy`-sampled from Stage 3 onward).
   *
   * Uses `@threlte/extras`'s `InstancedMesh`/`Instance` rather than one `T.Mesh` per point -- cheap
   * for the thousands of samples later stages will produce, and `InstancedMesh` disables raycasting by
   * default (`raycast={() => null}` in its own source), so a large cloud can't repeat Stage 1's
   * pointer-event regression the way a raycast-registered mesh per point could.
   */
  import { T } from '@threlte/core'
  import { InstancedMesh, Instance } from '@threlte/extras'
  import type { Vector3Tuple } from 'three'

  /** One marker position per sample. */
  export let points: Vector3Tuple[]
  /** One scalar per sample, same length/order as `points` -- arbitrary range, normalized internally
   * against this cloud's own min/max (real cost fields won't arrive pre-normalized either). Ignored
   * when `color` is set. */
  export let scalar: number[] = []
  /** A fixed color for every marker, bypassing the colormap entirely -- for a stage that colors by
   * finger identity (Stage 5) rather than by cost (Stage 8's `scalar`). A constant `scalar` can't serve
   * this purpose: each `CapabilityCloud` instance normalizes against its own min/max, so a uniform
   * scalar always collapses to the colormap's first stop regardless of its value, the same color for
   * every finger. */
  export let color: string | undefined = undefined
  /** An optional second scalar (same length/order as `points`, normalized against its own min/max)
   * dimming each marker's color -- lets one cost drive hue (via `color`/`scalar` above) while a second,
   * independent cost drives brightness, so two attributes are visible on the same cloud at once
   * (`docs/thumbs/representing-keyboard-build-inputs.md`'s "brightness ... could also be used to
   * distinguish attributes" note). Floored at `MIN_BRIGHTNESS`, not 0, so the dimmest samples stay
   * visible/identifiable rather than fading to black. */
  export let brightness: number[] = []
  export let markerRadiusMM = 2

  const MIN_BRIGHTNESS = 0.25

  /** A hand-rolled, perceptually-sequential colormap (viridis-like control points) -- deliberately not
   * this codebase's existing tiered green/red "comfortable vs. dangerous" scheme
   * (`ContactSpherePreview`'s deviation coloring): cost/manipulability/uncertainty are continuous,
   * ordered quantities, and a discrete good/bad split would smuggle in an unearned judgment about what
   * "good" means before any packing step defines that. See the plan doc's "Open questions". No
   * colormap dependency exists in this project yet, and this is small enough not to warrant adding one. */
  const COLORMAP_STOPS: [number, number, number][] = [
    [0.267, 0.005, 0.329],
    [0.229, 0.322, 0.545],
    [0.128, 0.567, 0.551],
    [0.369, 0.789, 0.383],
    [0.993, 0.906, 0.144],
  ]

  function toHex(v: number): string {
    return Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0')
  }

  function sequentialColormap(t: number): string {
    const clamped = Math.min(1, Math.max(0, t))
    const scaled = clamped * (COLORMAP_STOPS.length - 1)
    const i = Math.min(COLORMAP_STOPS.length - 2, Math.floor(scaled))
    const f = scaled - i
    const [r0, g0, b0] = COLORMAP_STOPS[i]
    const [r1, g1, b1] = COLORMAP_STOPS[i + 1]
    const r = r0 + (r1 - r0) * f
    const g = g0 + (g1 - g0) * f
    const b = b0 + (b1 - b0) * f
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`
  }

  function scaleHexBrightness(hex: string, factor: number): string {
    const r = parseInt(hex.slice(1, 3), 16) / 255
    const g = parseInt(hex.slice(3, 5), 16) / 255
    const b = parseInt(hex.slice(5, 7), 16) / 255
    return `#${toHex(r * factor)}${toHex(g * factor)}${toHex(b * factor)}`
  }

  $: lo = scalar.length ? Math.min(...scalar) : 0
  $: hi = scalar.length ? Math.max(...scalar) : 1
  $: range = hi - lo || 1
  $: baseColors = color
    ? points.map(() => color as string)
    : scalar.map((s) => sequentialColormap((s - lo) / range))

  $: brightnessLo = brightness.length ? Math.min(...brightness) : 0
  $: brightnessHi = brightness.length ? Math.max(...brightness) : 1
  $: brightnessRange = brightnessHi - brightnessLo || 1
  $: colors = brightness.length
    ? baseColors.map((c, i) => {
        const t = (brightness[i] - brightnessLo) / brightnessRange
        return scaleHexBrightness(c, MIN_BRIGHTNESS + (1 - MIN_BRIGHTNESS) * t)
      })
    : baseColors
</script>

<InstancedMesh limit={Math.max(points.length, 1)} range={points.length}>
  <T.SphereGeometry args={[markerRadiusMM, 8, 8]} />
  <T.MeshStandardMaterial />
  {#each points as p, i (i)}
    <Instance position={p} color={colors[i]} />
  {/each}
</InstancedMesh>
