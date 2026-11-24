/**
 * How the editor lays its lines out. A long line that runs off the edge is the
 * common nuisance — prose is written to a width, and the editor's own scrollbar
 * is the only way to read the rest of a sentence — so the editor wraps by
 * default. Code is where an unwrapped line reads better, so the gesture turns
 * it off. The key and the two tooltips are spelled here so the editor's action,
 * its button and the documentation cannot drift apart.
 */
export const EDITOR_WRAP_KEY = 'Alt+Z'

/** What the editor's wrap button says while the lines are wrapped. */
export const EDITOR_WRAP_ON_TOOLTIP = `Wrap lines: on. ${EDITOR_WRAP_KEY} turns it off.`

/** What it says while they are not. */
export const EDITOR_WRAP_OFF_TOOLTIP = `Wrap lines: off. ${EDITOR_WRAP_KEY} turns it on.`
