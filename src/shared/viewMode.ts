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
