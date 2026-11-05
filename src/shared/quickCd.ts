/**
 * The words the quick cd list is spoken about with. The list is reached by the
 * keyboard (`Alt+C`) and by the pane title bar's button; the button is the only
 * place the gesture is visible, so one spelling of the key keeps the two from
 * drifting apart.
 */
export const QUICK_CD_KEY = 'Alt+C'

/** What the title bar's button says while the mode is off. */
export const QUICK_CD_TOOLTIP = `Quick cd — the bookmarked folders (${QUICK_CD_KEY})`

/** What it says while the mode is on, when the button is how it is left. */
export const QUICK_CD_LEAVE_TOOLTIP = `Leave quick cd — back to the listing (${QUICK_CD_KEY})`
