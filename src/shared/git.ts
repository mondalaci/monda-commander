/**
 * The words the commit gesture is spoken about with. It is reached by the
 * keyboard (`Ctrl+G`) and by the git chip in the pane title bar, which is the
 * only place the action is visible — so one spelling of the key keeps the two
 * from drifting apart, as `shared/quickCd.ts` does for the star.
 *
 * `Ctrl+G` rather than a function key on purpose: F5–F8 are the orthodox
 * file-operation canon and F9 is the menu bar in every file manager of that
 * family, so committing — a command, not a file operation — takes a chord of
 * the app's own rather than a key an orthodox user expects elsewhere.
 */
export const COMMIT_KEY = 'Ctrl+G'

/** What the title bar's git chip says. */
export const COMMIT_TOOLTIP = `Commit changes… (${COMMIT_KEY})`
