import { onScopeDispose, reactive, watch } from 'vue'
import { hideMode } from '@renderer/composables/useHideMode'
import { shouldExecute } from '@renderer/lib/executable'
import type { DirEntry, PanelSide } from '@shared/types'

export type PaneEntry = DirEntry & { isParent?: boolean }

export type ScrollAlign = 'nearest' | 'start' | 'end'

export interface PaneState {
  side: PanelSide
  path: string
  parent: string | null
  /**
   * The entry names the current directory's `.mchide` file lists. Non-empty means
   * the folder has a hide list, which is what the title bar's icon stands for;
   * these are the names the rows leave out while the mode is on.
   */
  hideNames: Set<string>
  /**
   * Every entry the last listing returned, the hidden ones included. The hide
   * filter is applied on top of this rather than baked into it, so switching the
   * mode is a re-filter of what is already in hand, not another read.
   */
  allEntries: DirEntry[]
  allRows: PaneEntry[]
  entries: PaneEntry[]
  itemCount: number
  cursor: number
  pageRows: number
  scrollAlign: ScrollAlign
  /**
   * Whether the move that just happened should be shown as a quick scroll
   * rather than a jump. Only a page or an end-to-end jump asks for it — a
   * one-row move must stay instant, or holding an arrow key would animate
   * every step and lag behind the key. Reset once the pane has applied it.
   */
  animateScroll: boolean
  searchActive: boolean
  searchQuery: string
  selected: Set<string>
  loading: boolean
  error: string | null
  /**
   * Path of the entry currently being renamed in place, or null. The row list
   * keys off this to swap the name cell for an input; it is null whenever the
   * pane is not editing.
   */
  renaming: string | null
  /**
   * Paths a refresh just found new or changed. Membership alone drives the
   * row's transient highlight, and the set is emptied shortly after each batch
   * (and on navigation) so a later change replays the animation.
   */
  fresh: Set<string>
}

export interface PaneController {
  readonly state: PaneState
  init(): Promise<void>
  navigateTo(dir: string, focusPath?: string): Promise<void>
  refresh(focusPath?: string): Promise<void>
  goUp(): Promise<void>
  moveCursor(delta: number): void
  movePage(direction: 1 | -1): void
  moveTo(index: number): void
  activate(): Promise<void>
  current(): PaneEntry | undefined
  isSelected(entry: PaneEntry): boolean
  selectedCount(): number
  setSelected(path: string, value: boolean): void
  toggleSelection(): void
  toggleSelectAll(): void
  clearSelection(): void
  selectionTargets(): PaneEntry[]
  deletionTargets(): PaneEntry[]
  copyEntries(destination: string): Promise<string | null>
  moveEntries(destination: string): Promise<string | null>
  createDirectory(name: string): Promise<string | null>
  deleteEntries(): Promise<void>
  openSearch(): void
  updateSearch(query: string): void
  closeSearch(): void
  beginRename(): void
  cancelRename(): void
  commitRename(name: string): Promise<void>
  beginSelfChange(): void
  endSelfChange(): void
}

const PARENT_LABEL = '..'

/**
 * The renderer has no `node:path` (contextIsolation is on), but rename only
 * needs the containing directory of an absolute path so it can rebuild the
 * target from the new basename. Both separators are handled so a Windows path
 * still lands in the same folder.
 */
function parentOf(target: string): string {
  const slash = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'))
  return slash > 0 ? target.slice(0, slash) : target
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function sortEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    const aDir = a.kind === 'directory'
    const bDir = b.kind === 'directory'
    if (aDir !== bDir) return aDir ? -1 : 1
    return collator.compare(a.name, b.name)
  })
}

/**
 * The rows for a set of entries: sorted, with the ".." row in front when there
 * is somewhere to go. The entries handed in are already the ones the pane shows,
 * so the hide filter has been applied by the caller.
 */
function toRows(entries: DirEntry[], parent: string | null): PaneEntry[] {
  const sorted = sortEntries(entries)
  if (!parent) return sorted

  const parentRow: PaneEntry = {
    name: PARENT_LABEL,
    path: parent,
    kind: 'directory',
    isSymlink: false,
    symlinkTarget: null,
    size: 0,
    mtimeMs: 0,
    mode: 0,
    isParent: true
  }

  return [parentRow, ...sorted]
}

function countRealRows(rows: PaneEntry[]): number {
  return rows.reduce((count, row) => (row.isParent ? count : count + 1), 0)
}

function firstMatchIndex(rows: PaneEntry[]): number {
  const index = rows.findIndex((row) => !row.isParent)
  return index >= 0 ? index : 0
}

/**
 * One animation cycle (see flash.css). A row whose change is a one-off sweeps
 * exactly once; a row that keeps changing has this timer re-armed by every
 * refresh, so it stays highlighted — and keeps sweeping — until a full cycle
 * passes with no further change.
 */
const FLASH_MS = 1600

/**
 * A refresh reporting more changes than this is a bulk operation (a large copy,
 * a checkout, a `git switch`) — hundreds of simultaneous animations would jank
 * the list to say nothing useful, so such a batch is not highlighted at all.
 */
const FLASH_MAX = 150

/**
 * How long a pane keeps ignoring changes after a user-initiated one ends. The
 * directory watcher debounces for up to 750ms, so its notification for the same
 * write arrives after the operation's own re-list; this tail keeps that
 * follow-up from re-announcing what the user just caused. A change made by
 * another program after the tail still sweeps.
 */
const QUIET_TAIL_MS = 1000

/**
 * Which entries a re-list found new or altered, by path. "Altered" is a changed
 * size, mtime or kind, which is exactly what the row's metadata columns show, so
 * a rewritten file is highlighted for the same reason a fresh one is.
 */
function diffEntries(before: PaneEntry[], after: PaneEntry[]): Set<string> {
  const seen = new Map<string, PaneEntry>()
  for (const row of before) seen.set(row.path, row)

  const changed = new Set<string>()
  for (const row of after) {
    if (row.isParent) continue
    const old = seen.get(row.path)
    if (!old || old.size !== row.size || old.mtimeMs !== row.mtimeMs || old.kind !== row.kind) {
      changed.add(row.path)
    }
  }
  return changed
}

export interface PaneOptions {
  /**
   * Run a file the user asked to run. The pane decides *when* — Enter on a file
   * it can run (`lib/executable.ts`) — and hands the entry to whoever owns the
   * shell; `false` means the shell was in no state to take it, which the pane
   * reports as its notice.
   */
  run(entry: PaneEntry): Promise<boolean>
}

export function useDirectory(side: PanelSide, options: PaneOptions): PaneController {
  const state = reactive<PaneState>({
    side,
    path: '',
    parent: null,
    hideNames: new Set<string>(),
    allEntries: [],
    allRows: [],
    entries: [],
    itemCount: 0,
    cursor: 0,
    pageRows: 10,
    scrollAlign: 'nearest',
    animateScroll: false,
    searchActive: false,
    searchQuery: '',
    selected: new Set<string>(),
    loading: false,
    error: null,
    renaming: null,
    fresh: new Set<string>()
  })

  function current(): PaneEntry | undefined {
    return state.entries[state.cursor]
  }

  /**
   * The rows for the directory in hand, with the hide mode applied: the entries
   * whose names the folder's `.mchide` file lists are left out while the mode is
   * on. Built from `allEntries` rather than from a fresh read, so switching the
   * mode costs a filter and nothing else.
   */
  function buildRows(): PaneEntry[] {
    const names = state.hideNames
    const entries =
      hideMode.value && names.size > 0
        ? state.allEntries.filter((entry) => !names.has(entry.name))
        : state.allEntries
    return toRows(entries, state.parent)
  }

  /**
   * Drop marks for rows that are no longer on screen — an entry that left the
   * directory, or one the hide mode is now covering. A mark is a promise about
   * what F5/F6/F8 act on, and an invisible one would make the footer's count
   * disagree with what those keys do.
   */
  function pruneSelection(): void {
    if (state.selected.size === 0) return
    const visible = new Set(state.allRows.map((row) => row.path))
    for (const path of [...state.selected]) {
      if (!visible.has(path)) state.selected.delete(path)
    }
  }

  /**
   * The mode is one answer for the whole app, so a toggle anywhere — in the other
   * pane, or in a workspace that is not on screen — re-filters this pane's rows
   * too, keeping the cursor on the entry it was on wherever that entry survives.
   */
  watch(hideMode, () => {
    const previous = current()
    state.allRows = buildRows()
    pruneSelection()
    applyFilter(previous)
  })

  function clampCursorTo(value: number): number {
    const last = state.entries.length - 1
    if (last < 0) return 0
    return Math.min(Math.max(value, 0), last)
  }

  function applyFilter(previous: PaneEntry | undefined = current()): void {
    const needle = state.searchQuery.trim().toLowerCase()

    state.entries = needle
      ? state.allRows.filter(
          (row) => row.isParent || row.name.toLowerCase().includes(needle)
        )
      : state.allRows

    state.itemCount = countRealRows(state.entries)

    // With an active query, only a real entry is worth keeping the cursor on:
    // the ".." row survives every filter, so holding it would strand the
    // cursor there instead of landing on the match.
    let preserved = -1
    if (previous && (needle === '' || !previous.isParent)) {
      preserved = state.entries.findIndex((row) => row.path === previous.path)
    }

    state.cursor = preserved >= 0 ? preserved : firstMatchIndex(state.entries)
    state.scrollAlign = 'nearest'
    state.animateScroll = false
  }

  function openSearch(): void {
    if (state.searchActive) return
    state.searchActive = true
    state.searchQuery = ''
    applyFilter()
  }

  function updateSearch(query: string): void {
    if (!state.searchActive) return
    state.searchQuery = query
    applyFilter()
  }

  function closeSearch(): void {
    if (!state.searchActive) return
    state.searchActive = false
    state.searchQuery = ''
    applyFilter()
  }

  /**
   * Start an in-place rename on the entry under the cursor. A filter is closed
   * first so the row stays in the list, and the ".." row is never renamed.
   */
  function beginRename(): void {
    const entry = current()
    if (!entry || entry.isParent) return
    if (state.searchActive) closeSearch()
    state.renaming = entry.path
  }

  function cancelRename(): void {
    state.renaming = null
  }

  /**
   * Commit the edited name. The argument is the raw input value — the basename
   * the user typed, not a path. An unchanged or empty name is a no-op, and a
   * failure (collision, permissions) surfaces through the pane's error line
   * while leaving the directory untouched.
   */
  async function commitRename(name: string): Promise<void> {
    const source = state.renaming
    state.renaming = null
    if (!source) return

    const next = name.trim()
    if (!next) return
    if (next.includes('/') || next.includes('\\')) {
      state.error = 'EINVAL: A name cannot contain a path separator'
      return
    }
    if (next === '.' || next === '..') {
      state.error = 'EINVAL: Reserved name'
      return
    }

    const target = `${parentOf(source)}/${next}`
    if (target === source) {
      state.error = null
      return
    }

    const result = await window.mc.fs.rename(source, target)
    if (!result.ok) {
      state.error = `${result.error.code}: ${result.error.message}`
      return
    }

    state.error = null
    // Land the cursor on the renamed entry rather than the path it used to
    // have, which no longer exists.
    await navigateTo(state.path, result.data)
  }

  /**
   * Auto-refresh: main watches the pane's current directory and pushes a change
   * event whenever its contents change on disk, so a file created or removed by
   * another program (or by a shell command) appears without re-entering the
   * directory. The subscription follows `state.path` — retargeted on navigate
   * and refresh — and is refcounted in main so both panes may watch one
   * directory. Release happens when the pane moves on or the app unmounts.
   */
  let watchedPath: string | null = null

  /**
   * Clears highlighted rows one cycle after the last change. Re-armed by every
   * refresh, which is what keeps a row that is still being written to sweeping
   * instead of settling after its first pass.
   */
  let flashTimer: number | null = null

  /**
   * Nesting depth of user-initiated changes currently in flight. While it is
   * non-zero the pane's listing still updates, but nothing sweeps: the entries a
   * copy, move or shell command makes are ones the user asked for, and the
   * watcher reports them exactly like an external writer would. `quietUntil`
   * carries that silence past the end of the operation so the watcher's delayed
   * notification is covered too.
   */
  let selfChanges = 0
  let quietUntil = 0

  function clearFresh(): void {
    if (flashTimer !== null) {
      window.clearTimeout(flashTimer)
      flashTimer = null
    }
    state.fresh.clear()
  }

  function markFresh(paths: Set<string>): void {
    // A change the pane itself just made is not news: the sweep exists to
    // announce entries that appeared behind the app's back, so a copy, move or
    // `mkdir` the user issued must not animate. Both the operation's own
    // re-list and the watcher's delayed notification for it land inside the
    // quiet window this guards.
    if (selfChanges > 0 || Date.now() < quietUntil) return
    if (paths.size === 0 || paths.size > FLASH_MAX) return
    for (const path of paths) state.fresh.add(path)

    if (flashTimer !== null) window.clearTimeout(flashTimer)
    flashTimer = window.setTimeout(() => {
      flashTimer = null
      state.fresh.clear()
    }, FLASH_MS)
  }

  /**
   * Mark the start of a change this pane is making because the user asked for
   * it — a transfer, or a command typed at the prompt — so its result is not
   * swept. Nested calls are counted, so overlapping operations are all covered;
   * the matching `endSelfChange` starts the quiet tail.
   */
  function beginSelfChange(): void {
    selfChanges += 1
  }

  function endSelfChange(): void {
    if (selfChanges === 0) return
    selfChanges -= 1
    if (selfChanges === 0) quietUntil = Date.now() + QUIET_TAIL_MS
  }

  function unwatchCurrent(): void {
    if (watchedPath === null) return
    const dir = watchedPath
    watchedPath = null
    void window.mc.fs.unwatch(dir)
  }

  function watchCurrent(): void {
    if (state.path === watchedPath) return
    unwatchCurrent()
    if (!state.path) return
    watchedPath = state.path
    void window.mc.fs.watch(state.path)
  }

  const stopWatching = window.mc.fs.onChanged((event) => {
    if (event.path === state.path) void refresh()
  })

  onScopeDispose(() => {
    stopWatching()
    unwatchCurrent()
    clearFresh()
  })

  async function navigateTo(dir: string, focusPath?: string): Promise<void> {
    state.loading = true
    state.error = null

    const result = await window.mc.fs.list(dir)
    state.loading = false

    if (!result.ok) {
      state.error = `${result.error.code}: ${result.error.message}`
      return
    }

    // The listing is kept whole; `buildRows` applies the hide filter on top of
    // it, so the mode can be switched without reading the directory again.
    state.path = result.data.path
    state.parent = result.data.parent
    state.allEntries = result.data.entries
    state.hideNames = new Set(result.data.hiddenNames)
    const rows = buildRows()
    state.allRows = rows
    state.entries = rows
    state.itemCount = countRealRows(rows)
    state.cursor = focusPath ? indexOfPath(rows, focusPath) : 0
    state.scrollAlign = 'nearest'
    state.animateScroll = false

    // A filter and the marks belong to the directory they were set in.
    state.searchActive = false
    state.searchQuery = ''
    state.selected.clear()
    state.renaming = null
    clearFresh()
    watchCurrent()
  }

  function indexOfPath(rows: PaneEntry[], target: string): number {
    const index = rows.findIndex((row) => row.path === target)
    return index >= 0 ? index : 0
  }

  /**
   * Re-list the current directory in place. Unlike navigateTo this keeps the
   * cursor on the same entry (matching by path, so it follows a rename-free
   * re-sort) and leaves any active filter alone: a command that adds or removes
   * a file should not also throw away where the user was looking.
   *
   * `focusPath` is for the caller that knows where the entry under the cursor
   * went — a move that renamed it in place, so its old path no longer exists.
   * The cursor lands on that new path instead of falling back to the first row,
   * exactly as navigateTo places it.
   */
  async function refresh(focusPath?: string): Promise<void> {
    if (!state.path || state.loading) return

    const result = await window.mc.fs.list(state.path)
    if (!result.ok) {
      state.error = `${result.error.code}: ${result.error.message}`
      return
    }

    // Captured before `allRows` is replaced, so the diff below compares the
    // listing as it was against the listing just read.
    const before = state.allRows
    const previous = current()
    state.error = null
    state.path = result.data.path
    state.parent = result.data.parent
    state.allEntries = result.data.entries
    state.hideNames = new Set(result.data.hiddenNames)
    const rows = buildRows()
    state.allRows = rows
    const anchor = focusPath ? rows.find((row) => row.path === focusPath) ?? previous : previous
    applyFilter(anchor)
    // An entry the mode now covers carries no mark any more, exactly as one that
    // left the directory does not.
    pruneSelection()
    markFresh(diffEntries(before, rows))
    watchCurrent()
  }

  async function goUp(): Promise<void> {
    if (!state.parent) return
    // Park the cursor on the directory we came from.
    await navigateTo(state.parent, state.path)
  }

  function moveCursor(delta: number): void {
    state.scrollAlign = 'nearest'
    state.animateScroll = false
    state.cursor = clampCursorTo(state.cursor + delta)
  }

  function movePage(direction: 1 | -1): void {
    const last = state.entries.length - 1
    if (last < 0) return

    const target = state.cursor + direction * Math.max(state.pageRows, 1)
    const clamped = clampCursorTo(target)

    state.cursor = clamped

    if (clamped !== target) {
      // Ran past an end: show the final page rather than leaving it off-screen.
      state.scrollAlign = direction > 0 ? 'end' : 'start'
    } else {
      state.scrollAlign = direction > 0 ? 'start' : 'end'
    }
    state.animateScroll = true
  }

  function moveTo(index: number): void {
    state.scrollAlign = 'nearest'
    state.animateScroll = true
    state.cursor = clampCursorTo(index)
  }

  /**
   * Marks are keyed by absolute path, so they survive a re-sort and a refresh
   * of the same directory — navigating to another directory clears them. The
   * ".." row is never selectable.
   */
  function isSelected(entry: PaneEntry): boolean {
    return !entry.isParent && state.selected.has(entry.path)
  }

  function selectedCount(): number {
    return state.selected.size
  }

  function setSelected(path: string, value: boolean): void {
    if (value) state.selected.add(path)
    else state.selected.delete(path)
  }

  function toggleSelection(): void {
    const entry = current()
    if (!entry || entry.isParent) return

    if (state.selected.has(entry.path)) state.selected.delete(entry.path)
    else state.selected.add(entry.path)

    // Marking advances the cursor so a column of files can be picked in one
    // pass, exactly like the classic dual-pane Insert key.
    moveCursor(1)
  }

  function clearSelection(): void {
    if (state.selected.size === 0) return
    state.selected.clear()
  }

  /**
   * Mark every file in the pane, or unmark them when they are all marked
   * already — the one key that means "all of this". "File" here is every row
   * that is not a folder, which is what the actions downstream can take: a
   * symlink counts even when it dangles (`~/.steampath`), since `lstat` is all
   * the kind it can have, while a link *to* a directory is a directory like any
   * other and is left out. Only files are touched, both ways: a folder is marked
   * by hand when it is wanted (Insert), and a key that swept them up too would
   * drag them into whatever transfer follows. The ".." row is not an entry. Drawn
   * from `allRows` rather than the filtered view, exactly as `selectionTargets`
   * is, so a filter can never hide a mark from the actions.
   */
  function toggleSelectAll(): void {
    const files = state.allRows.filter((row) => !row.isParent && row.kind !== 'directory')
    if (files.length === 0) return

    const allMarked = files.every((row) => state.selected.has(row.path))
    for (const row of files) {
      if (allMarked) state.selected.delete(row.path)
      else state.selected.add(row.path)
    }
  }

  /**
   * What a transfer acts on: the marks if any are set, otherwise the entry
   * under the cursor. The ".." row is never a target, and a filter does not
   * hide a mark — every mark in the pane is used, matched in listing order.
   */
  function selectionTargets(): PaneEntry[] {
    if (state.selected.size > 0) {
      return state.allRows.filter((row) => !row.isParent && state.selected.has(row.path))
    }
    const entry = current()
    return entry && !entry.isParent ? [entry] : []
  }

  function deletionTargets(): PaneEntry[] {
    return selectionTargets()
  }

  /**
   * Copy the pane's targets into `destination`. A relative destination is
   * resolved against this pane's directory, so `sub` means `<pane>/sub` rather
   * than a path next to the app. Best-effort like delete: entries that collide
   * or cannot be read are reported without aborting the rest, and the source
   * listing is re-read in place. Returns the resolved destination directory so
   * the caller can refresh a pane showing it, or null on failure.
   */
  async function copyEntries(destination: string): Promise<string | null> {
    const targets = selectionTargets()
    if (targets.length === 0 || !destination) return null

    const result = await window.mc.fs.copy(
      targets.map((target) => target.path),
      destination,
      state.path
    )
    if (!result.ok) {
      state.error = `${result.error.code}: ${result.error.message}`
      return null
    }

    await refresh()

    if (result.data.failed.length > 0) {
      const [first] = result.data.failed
      if (first) state.error = `${first.error.code}: ${first.error.message}`
    }

    return result.data.destination
  }

  /**
   * Move the pane's targets into `destination`, mirroring copyEntries. A
   * relative destination resolves against this pane's directory, and a
   * collision or unreadable entry is reported without aborting the rest. Marks
   * for entries that actually left are dropped, then the listing is re-read in
   * place. Returns the resolved destination so the caller can refresh a pane
   * showing it, or null on failure.
   */
  async function moveEntries(destination: string): Promise<string | null> {
    const targets = selectionTargets()
    if (targets.length === 0 || !destination) return null

    const result = await window.mc.fs.move(
      targets.map((target) => target.path),
      destination,
      state.path
    )
    if (!result.ok) {
      state.error = `${result.error.code}: ${result.error.message}`
      return null
    }

    // A source that did not fail has left this directory; drop its mark. Marks
    // for entries that failed stay so a retry still knows what the user meant.
    const failedPaths = new Set(result.data.failed.map((failure) => failure.path))
    for (const target of targets) {
      if (!failedPaths.has(target.path)) state.selected.delete(target.path)
    }

    // A single entry moved to a name inside this same directory is a rename in
    // place (the F6 dialog's non-directory destination): its old path is gone,
    // so without this refresh would fall back to the first row. Hand the new
    // path in so the cursor follows the entry, as an in-place Shift+F6 does.
    const under = current()
    const renamedTo = result.data.moved.length === 1 ? result.data.moved[0] : undefined
    const movesInPlace =
      under !== undefined &&
      targets.length === 1 &&
      targets[0]?.path === under.path &&
      renamedTo !== undefined &&
      parentOf(renamedTo) === state.path
    await refresh(movesInPlace ? renamedTo : undefined)

    if (result.data.failed.length > 0) {
      const [first] = result.data.failed
      if (first) state.error = `${first.error.code}: ${first.error.message}`
    }

    return result.data.destination
  }

  /**
   * Make a directory inside this pane's own directory (F7). The name is what the
   * user typed: a plain folder name, or a path — absolute, or relative to this
   * pane, exactly as the transfer dialogs read their destination. Main refuses a
   * name that is already there and answers the resolved directory, which the pane
   * then re-lists onto: the cursor lands on the new folder, the way an in-place
   * rename lands on the renamed entry. A name that cannot be made (a collision, a
   * permission, a missing parent) surfaces through the pane's error line with the
   * directory untouched.
   */
  async function createDirectory(name: string): Promise<string | null> {
    const wanted = name.trim()
    if (!wanted || !state.path) return null

    const result = await window.mc.fs.mkdir(state.path, wanted)
    if (!result.ok) {
      state.error = `${result.error.code}: ${result.error.message}`
      return null
    }

    state.error = null
    // A filter is closed before the re-list, exactly as an in-place rename closes
    // one: the folder just made is what the cursor is meant to land on, and a
    // query it does not match would hide it the moment it appears.
    if (state.searchActive) closeSearch()
    await refresh(result.data)
    return result.data
  }

  async function deleteEntries(): Promise<void> {
    const targets = deletionTargets()
    if (targets.length === 0) return

    const result = await window.mc.fs.remove(targets.map((target) => target.path))
    if (!result.ok) {
      state.error = `${result.error.code}: ${result.error.message}`
      return
    }

    // Drop the marks that are gone, keep any that failed so a retry still
    // knows what the user meant, then re-list in place.
    for (const removed of result.data.deleted) state.selected.delete(removed)

    // Park the cursor on the row just before the deleted one before re-listing:
    // `refresh` preserves the entry under the cursor by path, and that entry is
    // gone, so without this the cursor falls back to the first match. A row the
    // cursor was not on (marked entries deleted from elsewhere) is left alone,
    // and deleting the first row falls forward to the next one.
    const deleted = new Set(result.data.deleted)
    const underCursor = state.entries[state.cursor]
    if (underCursor && deleted.has(underCursor.path)) {
      let anchor = -1
      for (let i = state.cursor - 1; i >= 0; i -= 1) {
        const row = state.entries[i]
        if (row && !deleted.has(row.path)) {
          anchor = i
          break
        }
      }
      if (anchor < 0) {
        for (let i = state.cursor + 1; i < state.entries.length; i += 1) {
          const row = state.entries[i]
          if (row && !deleted.has(row.path)) {
            anchor = i
            break
          }
        }
      }
      state.cursor = anchor >= 0 ? anchor : 0
    }

    await refresh()

    if (result.data.failed.length > 0) {
      const [first] = result.data.failed
      if (first) state.error = `${first.error.code}: ${first.error.message}`
    }
  }

  async function activate(): Promise<void> {
    const entry = current()
    if (!entry) return

    // Resolve the target before dropping the filter: closeSearch keeps the
    // cursor on this entry, but activation must act on what was highlighted.
    if (state.searchActive) closeSearch()

    if (entry.isParent) {
      await goUp()
      return
    }

    if (entry.kind === 'directory') {
      await navigateTo(entry.path)
      return
    }

    // A file the user can run is a file they meant to run: Enter starts it in
    // the shell rather than handing it to whatever the system opens an unknown
    // type with. A `.desktop` is the exception — it *describes* a program, and
    // the system is the thing that launches those.
    if (shouldExecute(entry)) {
      const started = await options.run(entry)
      if (!started) state.error = 'The shell is busy'
      return
    }

    const message = await window.mc.fs.open(entry.path)
    if (message) state.error = message
  }

  async function init(): Promise<void> {
    const home = await window.mc.fs.home()
    await navigateTo(home)
  }

  return {
    state,
    init,
    navigateTo,
    refresh,
    goUp,
    moveCursor,
    movePage,
    moveTo,
    activate,
    current,
    isSelected,
    selectedCount,
    setSelected,
    toggleSelection,
    toggleSelectAll,
    clearSelection,
    selectionTargets,
    deletionTargets,
    copyEntries,
    moveEntries,
    createDirectory,
    deleteEntries,
    openSearch,
    updateSearch,
    closeSearch,
    beginRename,
    cancelRename,
    commitRename,
    beginSelfChange,
    endSelfChange
  }
}
