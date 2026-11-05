/**
 * How a pane lays its own rows out. `details` is the listing the panes have
 * always had — one entry per row, in columns, sorted and scannable, which is
 * what a directory of code, archives and text wants. `thumbnails` is the same
 * entries drawn as a wall of tiles with each file's own picture in it, which is
 * what a folder of images, clips, pages and models wants: there the file *is*
 * its picture, and a name and a size say almost nothing about it.
 *
 * The mode is a property of the *pane* (like its sort and its columns), not a
 * place: it changes how the rows are drawn and nothing about which rows they
 * are, so every cursor move, mark, transfer, search and menu goes on working
 * unchanged. Entering a folder, switching tabs or leaving quick cd does not
 * change it, and one pane can be a wall while the other stays a listing.
 */
export type ViewMode = 'details' | 'thumbnails'

/**
 * The modes in the order Alt+T cycles them, so the key walks a fixed ring
 * rather than toggling: a third mode can be added without moving the key.
 */
export const VIEW_MODES: readonly ViewMode[] = ['details', 'thumbnails']

/** The next mode in the ring, for the cycle key. */
export function nextViewMode(mode: ViewMode): ViewMode {
  const at = VIEW_MODES.indexOf(mode)
  return VIEW_MODES[(at + 1) % VIEW_MODES.length] ?? 'details'
}

/** Whether an unknown value is a mode this build knows. */
export function isViewMode(value: unknown): value is ViewMode {
  return value === 'details' || value === 'thumbnails'
}

/** The mode's name, as the title-bar button and its tooltip spell it. */
export const VIEW_MODE_LABELS: Record<ViewMode, string> = {
  details: 'Details',
  thumbnails: 'Thumbnails'
}

/**
 * The key that cycles the pane's view, and the button's tooltip. Spelled here,
 * where the mode lives, so the handler, the button and the documentation cannot
 * drift apart — as the hide mode's own key and tooltips are (`shared/hide.ts`).
 */
export const VIEW_MODE_KEY = 'Alt+T'
export const VIEW_MODE_TOOLTIP = `View: details or thumbnails (${VIEW_MODE_KEY})`

/**
 * How a mode switch arrives: the entries of the layout coming on screen rise in
 * a step behind one another (`styles/view.css`), the step being a per-entry
 * `animation-delay` the view sets. The step is capped so the fortieth entry of a
 * long listing is not left waiting on the ones above it, and `VIEW_ENTER_MS` is
 * the whole gesture — the last entry's delay plus the animation — after which the
 * flag is dropped, so an entry the viewport reveals later is simply there.
 *
 * Both the pane (for a listing row) and the grid (for a tile) read the same
 * numbers, so the two layouts arrive at the same pace.
 */
export const VIEW_ENTER_STEP_MS = 8
export const VIEW_ENTER_MAX = 40
export const VIEW_ENTER_MS = (VIEW_ENTER_MAX - 1) * VIEW_ENTER_STEP_MS + 240

/**
 * The sizes a wall of tiles is shown at, as a factor of the size it is drawn at by
 * default, and the rung it starts on. `Ctrl+=` and `Ctrl+-` walk the ladder and
 * `Ctrl+0` returns to the middle rung — Ctrl being the chord every app uses for
 * zoom, where a *display*'s own controls (a PDF's fit and magnification) are
 * Alt+W/Alt+P/Alt+=/Alt+-. The size is kept per pane, like the sort, and the grid
 * animates toward the rung rather than jumping to it.
 */
export const THUMB_SCALE_STEPS: readonly number[] = [0.6, 0.8, 1, 1.25, 1.6, 2]

/** The rung a wall starts on: the size its tiles are drawn at by default. */
export const THUMB_SCALE_DEFAULT_STEP = 2

/** The factor a rung names, held to the ladder's ends. */
export function thumbScaleFor(step: number): number {
  const index = Math.min(Math.max(Math.round(step), 0), THUMB_SCALE_STEPS.length - 1)
  return THUMB_SCALE_STEPS[index]!
}

/** The rung one press of the zoom keys moves to, held to the ladder's ends. */
export function stepThumbScale(step: number, delta: 1 | -1): number {
  return Math.min(Math.max(Math.round(step) + delta, 0), THUMB_SCALE_STEPS.length - 1)
}
