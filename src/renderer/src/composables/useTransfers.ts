import { computed, reactive, ref, type ComputedRef, type Ref } from 'vue'
import type { TransferProgress } from '@shared/types'
import type { PaneEntry } from '@renderer/composables/useDirectory'

/**
 * The transfers the app is running, as the dialogs and the title bar draw them.
 *
 * A transfer outlives the dialog that started it: a copy of a large file runs for
 * minutes, so it is one *task* the app owns — a progress dialog while it is in
 * front, a pill in the title bar once it is backgrounded, and either way the same
 * record. Main reports its bytes against the id the task carries
 * (`TransferProgress`), and a stop is routed back by the same id.
 *
 * The state is the app's rather than a pane's because a transfer belongs to the
 * window: switching tabs, or navigating both panes away, must not take the
 * dialog, the pill or the progress with it.
 */

export type TransferMode = 'copy' | 'move'

/**
 * Where a transfer sits. `done` and `cancelled` are a moment rather than an end —
 * the last state is read, then the dialog or pill removes itself; `error` is the
 * one that waits, because a failure is something the user has to answer.
 */
export type TransferStatus = 'running' | 'done' | 'cancelled' | 'error'

export interface TransferTask {
  id: string
  mode: TransferMode
  /** What it acts on, for the title and the count. */
  entries: PaneEntry[]
  /** The pane directory the transfer was made from, and the destination the user
   * named (the resolved one below once main has answered). */
  source: string
  destination: string
  resolvedDestination: string | null
  /** Bytes copied so far, and the total to copy (0 while still unknown). */
  copied: number
  total: number
  /** The file now being written: its own bytes done and size, for the File bar. */
  fileCopied: number
  fileTotal: number
  /** Regular files written so far, and how many the transfer holds. */
  files: number
  totalFiles: number
  /** The entry now being written, or null before the first. */
  current: string | null
  status: TransferStatus
  error: string | null
  /** Whether the dialog is parked in the title bar rather than shown modally. */
  backgrounded: boolean
  /**
   * Whether the user asked to stop it. The promise's answer is then read as
   * `cancelled` rather than a failure, since the user caused it.
   */
  stopRequested: boolean
  /**
   * Whether a stop is offered at all: only a local transfer can be interrupted —
   * a relay answers a copy in one piece, with nothing to break into.
   */
  cancellable: boolean
}

export interface TransferInput {
  mode: TransferMode
  entries: PaneEntry[]
  source: string
  destination: string
  cancellable: boolean
}

/** The verb a transfer's state is spelled with, for the dialog and the pill. */
const VERBS: Record<TransferMode, { running: string; done: string; failed: string }> = {
  copy: { running: 'Copying', done: 'Copied', failed: 'Copy failed' },
  move: { running: 'Moving', done: 'Moved', failed: 'Move failed' }
}

/**
 * What a transfer calls itself: what it acts on while it runs (`Copying
 * report.pdf`), and only its outcome once it is over (`Copied`, `Cancelled`).
 */
export function transferPhrase(task: TransferTask): string {
  if (task.status === 'cancelled') return 'Cancelled'
  if (task.status === 'error') return VERBS[task.mode].failed
  // Stopping is shown the moment it is asked for, not when main confirms it: the
  // abort takes a round trip through the copy, and a dialog that sits still until
  // then reads as a key that did not register.
  if (task.status === 'running' && task.stopRequested) return 'Cancelling…'

  const verbs = VERBS[task.mode]
  const verb = task.status === 'done' ? verbs.done : verbs.running
  const [first] = task.entries
  const what = task.entries.length === 1 && first ? first.name : `${task.entries.length} items`
  return `${verb} ${what}`
}

/**
 * A transfer's hover text, one fact per line: what it is, where it came from and
 * where it is going. The pill is a percent and an icon, so this is where the
 * paths a transfer is really about are readable — the entry's own path for a
 * single one, the pane it was taken from when there are many, and the resolved
 * destination once main has answered (the named one until then).
 */
export function transferTooltip(task: TransferTask): string {
  const [first] = task.entries
  const from = task.entries.length === 1 && first ? first.path : task.source
  const to = task.resolvedDestination ?? task.destination
  const lines = [transferPhrase(task), `From: ${from}`]
  if (to) lines.push(`To: ${to}`)
  lines.push('Click to show')
  return lines.join('\n')
}

/** How long a finished dialog or pill stays before it takes itself off screen. */
const TRANSFER_LINGER_MS = 900

export interface Transfers {
  tasks: Ref<TransferTask[]>
  /** The tasks whose dialog is shown, in the order they were started. */
  foregroundTasks: ComputedRef<TransferTask[]>
  /** The tasks parked as title-bar pills, leftward of the window buttons. */
  backgroundTasks: ComputedRef<TransferTask[]>
  create(input: TransferInput): TransferTask
  /** Fold one byte-progress report into its task, if it is still running. */
  applyProgress(event: TransferProgress): void
  finish(task: TransferTask, status: TransferStatus, error?: string | null): void
  /** Take a task off screen now — the error dialog's Close, or a timer's ending. */
  dismiss(task: TransferTask): void
  /** Ask main to stop the transfer; its promise then finishes as `cancelled`. */
  stop(task: TransferTask): void
  /** Park the dialog as a title-bar pill. */
  background(task: TransferTask): void
  /** Bring a parked task's dialog back. */
  restore(task: TransferTask): void
}

let sequence = 0

export function useTransfers(): Transfers {
  const tasks = ref<TransferTask[]>([])
  const foregroundTasks = computed(() => tasks.value.filter((task) => !task.backgrounded))
  const backgroundTasks = computed(() => tasks.value.filter((task) => task.backgrounded))

  function create(input: TransferInput): TransferTask {
    sequence += 1
    const task = reactive<TransferTask>({
      id: `transfer-${Date.now()}-${sequence}`,
      mode: input.mode,
      entries: input.entries,
      source: input.source,
      destination: input.destination,
      resolvedDestination: null,
      copied: 0,
      total: 0,
      fileCopied: 0,
      fileTotal: 0,
      files: 0,
      totalFiles: 0,
      current: null,
      status: 'running',
      error: null,
      backgrounded: false,
      stopRequested: false,
      cancellable: input.cancellable
    })
    tasks.value.push(task)
    return task
  }

  function applyProgress(event: TransferProgress): void {
    const task = tasks.value.find((entry) => entry.id === event.id)
    if (!task || task.status !== 'running') return
    task.copied = event.copied
    task.total = event.total
    task.fileCopied = event.fileCopied
    task.fileTotal = event.fileTotal
    task.files = event.files
    task.totalFiles = event.totalFiles
    task.current = event.current
  }

  function finish(task: TransferTask, status: TransferStatus, error: string | null = null): void {
    if (task.status !== 'running') return
    task.status = status
    task.error = error
    if (status === 'done' || status === 'cancelled') {
      window.setTimeout(() => dismiss(task), TRANSFER_LINGER_MS)
    }
  }

  function dismiss(task: TransferTask): void {
    const index = tasks.value.findIndex((entry) => entry.id === task.id)
    if (index >= 0) tasks.value.splice(index, 1)
  }

  function stop(task: TransferTask): void {
    if (task.status !== 'running' || task.stopRequested) return
    task.stopRequested = true
    if (task.cancellable) window.mc.fs.cancelTransfer(task.id)
  }

  function background(task: TransferTask): void {
    task.backgrounded = true
  }

  function restore(task: TransferTask): void {
    task.backgrounded = false
  }

  return {
    tasks,
    foregroundTasks,
    backgroundTasks,
    create,
    applyProgress,
    finish,
    dismiss,
    stop,
    background,
    restore
  }
}
