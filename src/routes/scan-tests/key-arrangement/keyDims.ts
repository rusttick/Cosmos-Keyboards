/**
 * Key envelope dimensions from docs/thumbs/key-arrangement-in-3d.md sections 1-2 and 6.1 -- the
 * "frustum on rectangle" model (keycap taper sitting on a straight switch-housing box, plus a
 * separate wire-clearance box below the plate). All values in mm.
 *
 * The doc's 2D cross-section only fixes width along the row axis (B, w1). The keycap and switch
 * housing are square in plan view in reality (matches the real MX socket/switch-body footprints
 * already used elsewhere in this codebase, e.g. `src/lib/geometry/socketsParts.ts`'s
 * `MX_BOTTOM = box(14, 14, 8.5)` and `mx-better`'s `socketSize: [18, 18, 4.7]`), so B and w2 are
 * reused as both width and depth here rather than inventing a second pair of numbers.
 */

export const B = 18.2 // base width/depth at the plate (switch-housing footprint, keycap taper base)
export const w1 = 14 // keycap top width/depth (frustum top)
export const hf = 9.5 // keycap taper (frustum) height
export const hs = 6.5 // switch-housing straight height above the plate
export const h1 = hf + hs // total height above the plate (16)
export const w2 = 14 // wire-clearance box width/depth, below the plate
export const h2 = 10 // wire-clearance box height, below the plate
export const m = 0.5 // minimum gap between adjacent keys at rest
