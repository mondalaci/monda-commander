import { ref, type Ref } from 'vue'
import type { McPtyApi } from '@shared/api'

/**
 * One shell session. A workspace owns exactly one, so the app can run several
 * at once: each instance keeps its own shell process, output buffer, cwd and
 * command-line model, and `TerminalPane` renders whichever one is active.
 *
 * The command line writes into the session and the Ctrl+O terminal renders it,
 * so Enter on the command line is a real Enter and everything stateful (cwd,
 * history, pipes) works for free.
 */
const POLL_INTERVAL_MS = 300
const MAX_BUFFER_LENGTH = 200_000

export interface Shell {
  readonly id: string
  readonly started: Ref<boolean>
  readonly cwd: Ref<string | null>
  readonly idle: Ref<boolean>
  /**
   * The exit code once the shell process has ended, or null while it runs. The
   * app watches this to take the terminal's tab away: `exit` (or Ctrl+D) is the
   * user closing a terminal, and a session with no prompt is of no use to the
   * command line. It is app state rather than a view's callback, so a shell that
   * dies in a background tab is answered just the same as the active one.
   */
  readonly exitCode: Ref<number | null>
  /**
   * What the shell's input line currently holds. We model it from the bytes
   * xterm sends, because the command line *is* the shell: the alternative is
   * poking at the terminal buffer, which cannot tell where the prompt ends.
   * Only emptiness matters, so a simple append/backspace model stays accurate
   * even when readline's own caret moves behind our back.
   */
  readonly inputLine: Ref<string>
  /**
   * Incremented whenever the user submits a non-empty line, i.e. the shell is
   * about to run a command. Panels listen to it to re-list their directory once
   * that command finishes, since a command need not change the cwd.
   */
  readonly commandSeq: Ref<number>
  /**
   * The last non-empty line submitted, which is what a `cd` typed at the prompt
   * is read from to report a change that did not take. It is the *model's* line,
   * so only what was typed is here: a command readline drew itself — a history
   * recall, a completion — reaches the shell without a byte passing through
   * `onData` and is not seen.
   */
  readonly lastCommand: Ref<string>
  ensureStarted(spawnCwd: string, cols: number, rows: number): Promise<void>
  write(data: string): void
  /** Sends input we originate, keeping the line model in step. */
  sendInput(data: string): void
  clearInputLine(): void
  noteInput(data: string): void
  refreshState(): Promise<void>
  resize(cols: number, rows: number): void
  attachTerminal(onData: (data: string) => void): { initial: string; detach: () => void }
  /** Stop polling and kill the underlying process (Ctrl+W on the workspace). */
  dispose(): void
}

export function createShell(id: string, api: McPtyApi): Shell {
  const started = ref(false)
  const cwd = ref<string | null>(null)
  const idle = ref(false)
  const inputLine = ref('')
  const commandSeq = ref(0)
  const lastCommand = ref('')
  const exitCode = ref<number | null>(null)

  let lineBuffer = ''

  const dataListeners = new Set<(data: string) => void>()

  let buffer = ''
  let pollTimer: number | null = null
  let startPromise: Promise<void> | null = null

  function handleData(data: string): void {
    // Retain recent output so a terminal opened later can replay it instead of
    // showing an empty screen.
    buffer += data
    if (buffer.length > MAX_BUFFER_LENGTH) {
      buffer = buffer.slice(buffer.length - MAX_BUFFER_LENGTH)
    }
    for (const listener of dataListeners) listener(data)
  }

  async function refreshState(): Promise<void> {
    if (!started.value) return

    const snapshot = await api.state(id)
    idle.value = snapshot.idle
    if (snapshot.cwd && snapshot.cwd !== cwd.value) cwd.value = snapshot.cwd
  }

  function beginPolling(): void {
    if (pollTimer !== null) return
    pollTimer = window.setInterval(() => {
      void refreshState()
    }, POLL_INTERVAL_MS)
  }

  function stopPolling(): void {
    if (pollTimer === null) return
    window.clearInterval(pollTimer)
    pollTimer = null
  }

  function teardown(): void {
    stopPolling()
    startPromise = null
    started.value = false
    idle.value = false
  }

  function ensureStarted(spawnCwd: string, cols: number, rows: number): Promise<void> {
    if (startPromise) return startPromise

    // A fresh spawn is a fresh session: any code a previous process left behind
    // must not read as this one having already ended.
    exitCode.value = null

    const created = api.create(id, {
      cwd: spawnCwd,
      cols: Math.max(cols, 2),
      rows: Math.max(rows, 1)
    })

    let cancelled = false

    const onDataDisposer = api.onData((event) => {
      if (event.id === id) handleData(event.data)
    })

    const onExitDisposer = api.onExit((event) => {
      if (event.id !== id) return
      if (cancelled) return
      exitCode.value = event.exitCode
      stopListening()
      teardown()
    })

    function stopListening(): void {
      cancelled = true
      onDataDisposer()
      onExitDisposer()
    }

    startPromise = created.then(() => {
      if (cancelled) return
      started.value = true
      cwd.value = spawnCwd
      beginPolling()
    })

    return startPromise
  }

  function write(data: string): void {
    if (!started.value) return
    api.write(id, data)
  }

  function noteInput(data: string): void {
    for (const char of data) {
      const code = char.codePointAt(0) ?? 0

      if (code === 13 || code === 10) {
        // Enter: a non-empty line is a command the shell is about to run, not
        // just an empty prompt line, so it is worth re-listing for — and worth
        // keeping, so a `cd` it names can be answered for if it fails.
        if (lineBuffer.length > 0) {
          lastCommand.value = lineBuffer
          commandSeq.value++
        }
        lineBuffer = ''
        continue
      }
      if (code === 3 || code === 21) {
        lineBuffer = ''
        continue
      }
      if (code === 127 || code === 8) {
        lineBuffer = lineBuffer.slice(0, -1)
        continue
      }
      if (code === 23) {
        lineBuffer = lineBuffer.replace(/\s*\S*$/, '')
        continue
      }
      if (code === 27) break
      if (code < 32) continue
      lineBuffer += char
    }

    inputLine.value = lineBuffer
  }

  function sendInput(data: string): void {
    noteInput(data)
    write(data)
  }

  function clearInputLine(): void {
    sendInput('\u0015')
  }

  function resize(cols: number, rows: number): void {
    if (!started.value) return
    api.resize(id, cols, rows)
  }

  function attachTerminal(
    onData: (data: string) => void
  ): { initial: string; detach: () => void } {
    // The buffer is not drained: a terminal that attaches later — or re-attaches
    // after a reload — replays the session so far instead of showing a blank
    // screen. It is a bounded rolling window, not the full scrollback.
    const initial = buffer
    dataListeners.add(onData)

    return {
      initial,
      detach: () => {
        dataListeners.delete(onData)
      }
    }
  }

  function dispose(): void {
    stopPolling()
    dataListeners.clear()
    startPromise = null
    started.value = false
    idle.value = false
    // Main reaps sessions when the window goes away, so this only needs to
    // cover a workspace the user closed while the app keeps running.
    api.kill(id)
  }

  return {
    id,
    started,
    cwd,
    idle,
    inputLine,
    commandSeq,
    lastCommand,
    exitCode,
    ensureStarted,
    write,
    sendInput,
    clearInputLine,
    noteInput,
    refreshState,
    resize,
    attachTerminal,
    dispose
  }
}
