<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { Shell } from '@renderer/composables/useShell'

// Read the mono stack from the theme rather than repeating it, so the terminal
// and the rest of the UI cannot drift apart (or fall out of sync when the theme
// token changes).
function monoFontStack(): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue('--font-mono')
    .trim()
  return value || 'monospace'
}

// A theme token as a concrete colour, for the places xterm needs one before the
// app's own CSS can answer for it.
function themeColor(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

// `shell` is the workspace's session. The view does not own it — it detaches on
// unmount and lets the workspace decide when the process dies — so switching
// workspaces simply renders a different session.
const props = defineProps<{ expanded: boolean; cwd: string; shell: Shell }>()

const emit = defineEmits<{
  (event: 'focused-change', value: boolean): void
  (event: 'collapse'): void
}>()

const root = ref<HTMLElement | null>(null)
const host = ref<HTMLElement | null>(null)

let term: Terminal | null = null
let fitAddon: FitAddon | null = null
let observer: ResizeObserver | null = null
let detach: (() => void) | null = null
let termReady = false
let pendingFrame = 0

// One xterm row, in CSS pixels. It is a fraction (12px * 1.25 line height is
// not a whole pixel), so it has to be measured rather than assumed.
let stripRowHeight = 0

function measureStripRow(): void {
  const row = term?.element?.querySelector<HTMLElement>('.xterm-rows > div')
  const measured = row?.getBoundingClientRect().height ?? 0
  if (measured > 0) stripRowHeight = measured
}

// Where the prompt ends, as a terminal position. The app models the command
// line from the bytes xterm sends (`shell.inputLine`), which is enough while the
// user types — but readline also puts text on the line itself: an entry recalled
// from history with Up or Ctrl+P, a Tab completion, a Ctrl+Y yank. The model
// cannot see those, yet emptiness is what decides whether the arrows edit the
// line or scrub the clip, so it has to come from the terminal. While the shell
// reports it is waiting at a prompt with an empty line, the cursor rests at the
// prompt's end; that spot is remembered, and any later cursor position that
// differs from it means the line holds something. The cost is one-sided on
// purpose: a stale spot can make an empty line look occupied (the arrows go to
// the shell, which does nothing at an empty line, and only the clip scrub is
// missed until the next prompt), while a missed line — the model saying empty
// when readline has drawn text — would send the arrows to the clip instead of
// the line, which is exactly what must not happen.
let promptColumn = 0
let promptRow = -1
let promptKnown = false

function capturePrompt(): void {
  if (!term) return
  if (!props.shell.idle.value || props.shell.inputLine.value.length > 0) return
  const buffer = term.buffer.active
  promptColumn = buffer.cursorX
  promptRow = buffer.baseY + buffer.cursorY
  promptKnown = true
}

/**
 * Whether the command line holds anything at all, read from the terminal so
 * text readline produced on its own is seen as well as what was typed. False
 * until a prompt has been read, so before that the model's word stands.
 */
function lineHasContent(): boolean {
  if (!term || !promptKnown) return false
  const buffer = term.buffer.active
  const row = buffer.baseY + buffer.cursorY
  return buffer.cursorX !== promptColumn || row !== promptRow
}

// The last styles written by applyStripViewport. It runs on every cursor move
// (onCursorMove), so unchanged values must not be rewritten.
let stripHeight = ''
let stripTransform = ''

/**
 * The collapsed strip is one visible row, but the terminal keeps two rows so the
 * panel -> shell `cd` sync's own erase has a row to work with (see refit). The
 * row that must be visible is the one the cursor is on: the strip is the command
 * line, so it shows the line being typed, not whichever row happens to sit at
 * the top of the two-row buffer. The host is therefore sized to exactly one row
 * and the terminal is shifted up so the cursor's row lands inside it — with the
 * terminal left alone the strip showed the row above the cursor (the last output
 * line after `ls`) instead of the prompt.
 *
 * `overflow: hidden` clips at the padding box, not the content box, so the host
 * must carry no vertical padding: with it, the translated terminal's row above
 * the cursor painted its descender tips into the top of the strip, a stray pixel
 * of the previous line. The gutter above and below is the host's margin instead,
 * which lies outside the clip edge, and the height written here is exactly one
 * row.
 *
 * Expanded, the same shift pins the screen to the *bottom* of its host while the
 * section opens. The host is only a whole number of rows tall once the animation
 * has settled; for its length the height is an interpolated fraction while the
 * fit rounds the row count down, so a terminal laid out from the top is left
 * between zero and one row of empty space under the cursor line — a gap that
 * grows smoothly and snaps back with every row the fit adds, which is the
 * command line jittering as the terminal grows. Holding the screen's bottom
 * against the host's bottom keeps the cursor line still and lets the rows above
 * it appear as the box opens. The strip left above the screen is the page
 * background, which is the terminal's own background colour, so it is not seen.
 */
function applyStripViewport(): void {
  const hostEl = host.value
  const xtermEl = term?.element
  if (!hostEl || !xtermEl) return

  if (props.expanded) {
    if (stripHeight !== '') hostEl.style.height = stripHeight = ''
    const screenHeight = xtermEl.getBoundingClientRect().height
    if (screenHeight <= 0) return
    const shift = hostEl.getBoundingClientRect().height - screenHeight
    const nextTransform = Math.abs(shift) > 0.5 ? `translateY(${shift}px)` : ''
    if (nextTransform !== stripTransform) xtermEl.style.transform = stripTransform = nextTransform
    return
  }

  if (stripRowHeight === 0) measureStripRow()
  if (stripRowHeight === 0) return

  const cursorRow = term?.buffer.active.cursorY ?? 0
  const nextHeight = `${stripRowHeight}px`
  const nextTransform = cursorRow > 0 ? `translateY(${-cursorRow * stripRowHeight}px)` : ''
  if (nextHeight !== stripHeight) hostEl.style.height = stripHeight = nextHeight
  if (nextTransform !== stripTransform) xtermEl.style.transform = stripTransform = nextTransform
}

function refit(): void {
  if (!term || !fitAddon) return
  const element = host.value
  if (!element || element.clientWidth === 0 || element.clientHeight === 0) return
  // fit reads the host's height, so the collapsed strip's one-row sizing has to
  // be released before an expanded terminal can fill the window.
  if (props.expanded) element.style.height = ''
  fitAddon.fit()
  // The panel -> shell `cd` sync erases its own echo with `printf
  // '\033[1A\033[2K'`, which walks back one row and clears it. That needs a
  // spare row below the cursor: a one-row terminal scrolls on every newline, so
  // the echoed `cd` leaves the viewport for the scrollback before the `printf`
  // runs, and Ctrl+O then shows a transcript of syncs the user never typed.
  // Two rows keep the sync on screen for its own erase to clear, so the terminal
  // is clamped to two rows here; the collapsed strip clips the spare row away
  // (applyStripViewport) rather than showing it.
  const rows = Math.max(term.rows, 2)
  if (rows !== term.rows) term.resize(term.cols, rows)
  props.shell.resize(term.cols, rows)
  measureStripRow()
  applyStripViewport()
}

function scheduleRefit(): void {
  cancelAnimationFrame(pendingFrame)
  pendingFrame = requestAnimationFrame(refit)
}

function focusTerminal(): void {
  void nextTick(() => term?.focus())
}

function startTerminal(): void {
  if (termReady || !host.value) return
  termReady = true

  term = new Terminal({
    cursorBlink: true,
    cursorStyle: 'block',
    fontFamily: monoFontStack(),
    fontSize: 12,
    // The cell height has to be the font's own line box (12px * 1.32 = ~16px),
    // not a roomier multiple of the font size. A TUI's frames are drawn from the
    // box-drawing glyphs themselves (the DOM renderer draws every character with
    // the font), and JetBrains Mono's `│` only reaches ~1.52em — so at a taller
    // cell the ink stops short of the cell's bottom edge and every row leaves a
    // ~3px gap: the "pipes" that do not join, next to an emulator whose cell is
    // the font's own height. At 16px the glyphs meet and a frame is continuous.
    lineHeight: 1.0,
    scrollback: 5000,
    allowProposedApi: true,
    theme: {
      // The terminal is a program's surface, not the app's own chrome, so it
      // gets a background of its own. A TUI is entitled to lay its panels out
      // against the host terminal's default background and paint only its
      // chrome — herdr leaves its sidebar and panes at `SGR 49` and colours the
      // rest — and that only reads if the background differs from the chrome it
      // draws on top. Sharing `--color-bg` (#1e1e1e) put the two within a few
      // units of each other, so the whole UI collapsed into one flat shade.
      background: themeColor('--color-surface-2', '#2d2d30'),
      foreground: '#cccccc',
      cursor: '#cccccc',
      cursorAccent: themeColor('--color-surface-2', '#2d2d30'),
      selectionBackground: '#264f78',
      // The sixteen ANSI slots take xterm's own defaults. ANSI standardises the
      // slot *names*, not their RGB values, so every concrete palette is
      // opinionated; xterm's is the reference a `TERM=xterm-256color` terminal
      // implies and the one Unix CLI tools' colour choices are written against,
      // which makes it the least surprising palette to inherit. (VS Code's,
      // which this used to mirror, is a different opinionated set.)
      black: '#000000',
      red: '#cd0000',
      green: '#00cd00',
      yellow: '#cdcd00',
      blue: '#0000ee',
      magenta: '#cd00cd',
      cyan: '#00cdcd',
      white: '#e5e5e5',
      brightBlack: '#7f7f7f',
      brightRed: '#ff0000',
      brightGreen: '#00ff00',
      brightYellow: '#ffff00',
      brightBlue: '#5c5cff',
      brightMagenta: '#ff00ff',
      brightCyan: '#00ffff',
      brightWhite: '#ffffff'
    }
  })

  fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(host.value)
  refit()

  term.onData((data) => {
    props.shell.noteInput(data)
    props.shell.write(data)
  })

  // Output scrolls the two-row buffer, and the sync's erase moves the cursor
  // back up a row; either way the strip has to follow the cursor's row.
  term.onCursorMove(() => applyStripViewport())

  term.attachCustomKeyEventHandler((event) => {
    const isTerminalToggle =
      event.type === 'keydown' &&
      event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey &&
      event.key.toLowerCase() === 'o'
    return !isTerminalToggle
  })

  // No exit line is written to the view: a shell that ends takes its tab with
  // it (the app watches `shell.exitCode`), so there is no dead terminal left to
  // explain.
  const attached = props.shell.attachTerminal((data) => term?.write(data))
  detach = attached.detach
  if (attached.initial) term.write(attached.initial)

  void props.shell.ensureStarted(props.cwd, term.cols, term.rows).then(() => {
    refit()
    scheduleRefit()
    // A remount (a workspace switch, an HMR update) reattaches to a shell that
    // may already be sitting at a prompt, so the idle transition the watcher
    // below waits for may already have happened: read the prompt's end here too.
    capturePrompt()
  })
}

// The shell reports it is at a prompt a poll after the prompt is printed, so
// this is where the prompt's end is read off — the one moment the line is known
// to be empty and the cursor's resting place is the prompt's own.
watch(() => props.shell.idle.value, (idle) => {
  if (idle) capturePrompt()
})

watch(
  () => props.expanded,
  (expanded) => {
    void nextTick(() => {
      refit()
      // Expanding and collapsing reflows the grid, moving the prompt's end; a
      // fresh read keeps the remembered spot honest.
      capturePrompt()
      if (expanded) focusTerminal()
    })
  },
  { flush: 'post' }
)

onMounted(() => {
  observer = new ResizeObserver(scheduleRefit)
  if (root.value) observer.observe(root.value)

  startTerminal()
  void nextTick(() => {
    refit()
    focusTerminal()
  })

  // The mono font is a bundled web font now, so the first fit measures the row
  // against whatever fallback is up until it arrives — and fit is what tells the
  // pty its cols/rows. Re-fit once the font has actually loaded, so the grid is
  // the font's own and the shell is sized to a cell that exists.
  void document.fonts.ready.then(() => refit())
})

onBeforeUnmount(() => {
  cancelAnimationFrame(pendingFrame)
  observer?.disconnect()
  observer = null
  detach?.()
  detach = null
  // The shell is app-level, not owned by this view: main kills sessions when
  // the window goes away. Killing it here would let any remount race a fresh
  // spawn and take the new shell down with it.
  term?.dispose()
  term = null
  fitAddon = null
})

function onFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget as Node | null
  if (next && root.value?.contains(next)) return
  emit('focused-change', false)
}

defineExpose({ focusTerminal, lineHasContent })
</script>

<template>
  <section
    ref="root"
    class="flex min-h-0 flex-col overflow-hidden border-t border-border bg-surface-2 transition-[flex-grow,flex-basis] duration-150 ease-out"
    :class="expanded ? 'grow basis-0' : 'grow-0 shrink-0 basis-7'"
    @focusin="emit('focused-change', true)"
    @focusout="onFocusOut"
  >
    <div
      v-if="expanded"
      class="flex h-8 shrink-0 items-center justify-between border-b border-border-subtle bg-surface px-3"
    >
      <span class="text-ui-sm font-medium tracking-wider text-fg-dim uppercase">
        Terminal
      </span>
      <button
        type="button"
        class="rounded p-0.5 text-fg-dim transition-colors hover:bg-hover hover:text-fg"
        title="Collapse to the command line (Ctrl+O)"
        @click="emit('collapse')"
      >
        <svg
          viewBox="0 0 24 24"
          class="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>

    <div
      ref="host"
      class="min-h-0 overflow-hidden px-3 my-1"
      :class="expanded ? 'flex-1' : 'flex-none'"
    ></div>
  </section>
</template>
