import { watch as watchDir, type FSWatcher } from 'node:fs'
import { ipcMain, webContents } from 'electron'
import { noteDirectoryChanged } from './git'
import type { FsChangeEvent } from '@shared/types'

/**
 * Debounce window: how long the event stream must be quiet before we tell the
 * renderer a directory changed. One user action can emit a burst of events (a
 * recursive copy, an editor's write/rename dance), and each notification costs
 * a full re-list, so a burst should collapse into one.
 */
const DEBOUNCE_MS = 200

/**
 * Hard ceiling on how long a *sustained* stream may suppress that notification.
 * A pure trailing-edge debounce never fires while events keep arriving, and a
 * stream that never goes quiet is exactly what a download in progress looks
 * like: Chrome writes the `.crdownload` file continuously, so the pane would
 * stay frozen until the writes stopped — which is the moment the file is
 * renamed to its final name. Capping the wait makes long writes visible as they
 * grow, at the cost of a re-list roughly twice a second during the download.
 */
const MAX_WAIT_MS = 750

interface WatchedDir {
  watcher: FSWatcher
  /**
   * Per-webContents subscription count. Both panes can show the same directory,
   * so a plain Set would drop the watcher when the first of them navigated away
   * while the other was still looking at it.
   */
  refs: Map<number, number>
}

const watched = new Map<string, WatchedDir>()

/**
 * Pending debounce timers, keyed by directory. Kept apart from `watched` so a
 * watcher that closes mid-burst still cancels its trailing notification.
 * `startedAt` anchors the MAX_WAIT_MS ceiling to the first event of the current
 * burst, rather than letting every new event push the deadline up.
 */
const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; startedAt: number }>()

/**
 * WebContents ids we have already wired a cleanup listener for, so a destroyed
 * window releases every directory it was watching instead of leaking watchers.
 */
const hooked = new Set<number>()

function closeWatcher(dir: string): void {
  const entry = watched.get(dir)
  if (!entry) return
  watched.delete(dir)

  const timer = pending.get(dir)
  if (timer !== undefined) {
    clearTimeout(timer.timer)
    pending.delete(dir)
  }

  try {
    entry.watcher.close()
  } catch {
    // Already closed.
  }
}

function notify(dir: string): void {
  const entry = watched.get(dir)
  if (!entry) return

  // The panes' git markers are keyed off the same writes: a file edited in a
  // watched directory of a work tree changes that repository's status too, and
  // the panes looking at *another* directory of it are owed the news. A `git`
  // read is only invalidated for a repository this app already resolved.
  noteDirectoryChanged(dir)

  const payload: FsChangeEvent = { path: dir }
  for (const id of entry.refs.keys()) {
    const target = webContents.fromId(id)
    if (target && !target.isDestroyed()) target.send('fs:changed', payload)
  }
}

function fire(dir: string): void {
  pending.delete(dir)
  notify(dir)
}

/**
 * Debounce with a ceiling: each event pushes the deadline out by DEBOUNCE_MS so
 * a burst collapses into one notification, but never past MAX_WAIT_MS after the
 * burst's first event, so a stream that never goes quiet still refreshes.
 */
function scheduleNotify(dir: string): void {
  const now = Date.now()
  const existing = pending.get(dir)

  if (existing) {
    clearTimeout(existing.timer)
    const elapsed = now - existing.startedAt
    const delay = Math.max(0, Math.min(DEBOUNCE_MS, MAX_WAIT_MS - elapsed))
    existing.timer = setTimeout(() => fire(dir), delay)
    return
  }

  pending.set(dir, { startedAt: now, timer: setTimeout(() => fire(dir), DEBOUNCE_MS) })
}

function addRef(dir: string, owner: number): void {
  let entry = watched.get(dir)

  if (!entry) {
    let watcher: FSWatcher
    try {
      // `persistent: false` so a watcher never keeps the app alive on its own;
      // on Linux libuv implements this with inotify.
      watcher = watchDir(dir, { persistent: false }, () => scheduleNotify(dir))
    } catch {
      // A directory that vanished or cannot be watched simply has no live
      // updates; the pane still lists it on demand.
      return
    }

    watcher.on('error', () => closeWatcher(dir))
    entry = { watcher, refs: new Map() }
    watched.set(dir, entry)
  }

  entry.refs.set(owner, (entry.refs.get(owner) ?? 0) + 1)
}

function releaseRef(dir: string, owner: number): void {
  const entry = watched.get(dir)
  if (!entry) return

  const count = (entry.refs.get(owner) ?? 0) - 1
  if (count > 0) entry.refs.set(owner, count)
  else entry.refs.delete(owner)

  if (entry.refs.size === 0) closeWatcher(dir)
}

function hookOwner(owner: number): void {
  if (hooked.has(owner)) return
  const target = webContents.fromId(owner)
  if (!target) return

  hooked.add(owner)
  target.once('destroyed', () => {
    hooked.delete(owner)
    for (const dir of [...watched.keys()]) {
      const entry = watched.get(dir)
      if (!entry || !entry.refs.has(owner)) continue
      entry.refs.delete(owner)
      if (entry.refs.size === 0) closeWatcher(dir)
    }
  })
}

export function registerWatchHandlers(): void {
  ipcMain.handle('fs:watch', (event, dir: string) => {
    if (typeof dir !== 'string' || dir.length === 0) return
    hookOwner(event.sender.id)
    addRef(dir, event.sender.id)
  })

  ipcMain.handle('fs:unwatch', (event, dir: string) => {
    if (typeof dir !== 'string' || dir.length === 0) return
    releaseRef(dir, event.sender.id)
  })
}

export function closeAllWatchers(): void {
  for (const dir of [...watched.keys()]) closeWatcher(dir)
}
