/**
 * The key that parks a running transfer's dialog in the title bar — the keyboard
 * half of the dialog's own "Background" button, spelled here so the key and the
 * button's hint cannot disagree (as the commit chord is in `shared/git.ts`).
 *
 * It is `Escape`, the leave of every overlay in the app, but here it does not
 * *cancel* anything: a copy of a large file is not something a stray key should
 * throw away, so `Escape` only puts the dialog away. The transfer outlives it as
 * a pill beside the window buttons, and clicking that brings the dialog back.
 */
export const TRANSFER_BACKGROUND_KEY = 'Escape'

/** How the key is written on the dialog's button. */
export const TRANSFER_BACKGROUND_LABEL = 'Esc'

/**
 * The chord that *cancels* the transfer — the keyboard half of the dialog's
 * "Cancel" button. Parking is the safe half and keeps the easy key (`Escape`);
 * cancelling takes the half-written entry back, so it wants a deliberate chord
 * rather than the key a reflex reaches for. `Ctrl+X` is unused elsewhere and is
 * read as "cut this short".
 */
export const TRANSFER_CANCEL_KEY = 'x'
export const TRANSFER_CANCEL_LABEL = 'Ctrl+X'

/**
 * The chord that jumps the keyboard to the background-transfer pills in the title
 * bar (`Ctrl+B`): the first pill takes focus, the arrows then move between them,
 * and Enter restores one exactly as clicking it does. It is claimed with the
 * panes' keys rather than above an expanded terminal, so a real terminal keeps
 * its own `Ctrl+B` (readline's backward-char) — as it keeps `Ctrl+R` and `Ctrl+G`.
 */
export const TRANSFER_PILLS_KEY = 'KeyB'
export const TRANSFER_PILLS_LABEL = 'Ctrl+B'
