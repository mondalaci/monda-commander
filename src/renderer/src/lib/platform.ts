/**
 * The app's own chords are built on the *primary* modifier: Command on macOS,
 * Control everywhere else. That is the one place the platform reaches into the
 * key model — `window.mc.platform` is read once, here — and every gesture in
 * `App.vue` asks these helpers rather than a raw `ctrlKey`.
 *
 * A chord is only ever the primary modifier: a Mac user's Command+Control+O is
 * not the terminal toggle, so each helper reads *both* keys and refuses the
 * other platform's. The `Alt`/`Shift`/plain keys are the same everywhere and
 * keep their own checks.
 */
export const isMac = window.mc.platform === 'darwin'

/**
 * Windows keeps no Unix mode bits and has no POSIX shell, so a few places step
 * aside there rather than offer something that cannot work: the mode columns,
 * the exec-bit runnable rule, and the shell-injection gestures (see
 * docs/porting.md). The chord modifier is the other thing this file decides —
 * Windows is Control, like Linux.
 */
export const isWindows = window.mc.platform === 'win32'

/** Just the two modifiers a chord can be built on. */
type ModifierEvent = Pick<KeyboardEvent, 'ctrlKey' | 'metaKey'>

/** The platform's chord modifier: Command on macOS, Control elsewhere. */
function primary(event: ModifierEvent): boolean {
  return isMac ? event.metaKey : event.ctrlKey
}

/** The other platform's: Control on macOS, Command (Super) elsewhere. */
function secondary(event: ModifierEvent): boolean {
  return isMac ? event.ctrlKey : event.metaKey
}

/** The primary modifier alone — no Shift, no Alt, not the other Control. */
export function isPlainPrimary(event: KeyboardEvent): boolean {
  return primary(event) && !event.shiftKey && !event.altKey && !secondary(event)
}

/** The primary modifier with Shift, and nothing else. */
export function isPrimaryShift(event: KeyboardEvent): boolean {
  return primary(event) && event.shiftKey && !event.altKey && !secondary(event)
}

/**
 * The primary modifier is down, whatever else may be — for the chords that do
 * not care about Shift (the wall's tile zoom is `Ctrl+=`/`Ctrl+-`/`Ctrl+0`, and
 * a Mac user's `Cmd+Shift+=` is the same zoom). Alt is left to the caller.
 */
export function hasPrimary(event: ModifierEvent): boolean {
  return primary(event) && !secondary(event)
}
