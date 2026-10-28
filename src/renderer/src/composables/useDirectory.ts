import { markRaw, onScopeDispose, reactive, watch } from 'vue'
import { hideMode } from '@renderer/composables/useHideMode'
import { buildGitView, type GitView } from '@renderer/lib/gitMark'
import { shouldExecute } from '@renderer/lib/executable'
import type { DirEntry, PanelSide } from '@shared/types'

export type PaneEntry = DirEntry & { isParent?: boolean }

export type ScrollAlign = 'nearest' | 'start' | 'end'

/**
 * Which column the listing is ordered by, and which kinds of column a pane can
 * show. The two are one set on purpose: every column is drawn from the entry's
 * own metadata (`DirEntry`), and any one of them can be the column the listing
 * is ordered by. A column that is not the sort still shows, and a column that is
 * the sort still shows its own value — sorting and showing are the same list of
 * questions a listing already answers.
 */
export type SortKey = 'name' | 'size' | 'modified' | 'mode' | 'modeNumeric'

/**
 * Every column a pane can show, in the order the column editor's pickers offer
 * them. `columnOrder` is a subset of this, one entry per shown column. The two
 * mode columns are the same bits drawn two ways — symbolic (`rw-r--r--`) and
 * numeric (`644`) — so a pane can show one, the other, or both.
 */
export const COLUMN_TYPES: readonly SortKey[] = [
  'name',
  'size',
  'modified',
  'mode',
  'modeNumeric'
]

/** Whether the chosen column runs smallest-to-largest or the other way. */
export type SortDirection = 'asc' | 'desc'

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
  /**
   * A count of the times what the hide mode covers has changed for this pane —
   * a toggle, or a `.mchide` edit a refresh picked up. It exists only to tell
   * the *view* which row changes are the mode's and so worth showing as rows
   * leaving and arriving (see lib/hideAnimation.ts); a listing can change for
   * many reasons, and only this one is animated.
   */
  hideTick: number
  allRows: PaneEntry[]
  entries: PaneEntry[]
  itemCount: number
  cursor: number
  pageRows: number
  scrollAlign: ScrollAlign
  /**
   * The column the listing is ordered by, and the way it runs. Held per pane so
   * each can be read in the order its own user asked for, and kept across a
   * navigation — walking into a folder should not throw away how it was being
   * read.
   */
  sortKey: SortKey
  sortDir: SortDirection
  /**
   * The left-to-right order of the listing's columns, kept per pane. It is not
   * the sort: that says *which* column orders the rows, this says where each
   * column is shown, and dragging a header rearranges one without touching the
   * other. The ".." row and every cell follow it, so moving a column moves what
   * belongs to it.
   */
  columnOrder: SortKey[]
  /**
   * Whether the pane is editing its columns. While it is on, the header swaps
   * each column's label for a picker of column types, draws a remove button per
   * column and an add button in every gap, so the pane's own layout can be built
   * from the interface rather than only rearranged by dragging. It is a mode of
   * the pane (the icon beside the headers, and Alt+C), left again by the icon,
   * the shortcut, or Escape.
   */
  columnEdit: boolean
  /**
   * Which column the keyboard is on while the editor is on: the one the arrows
   * move between and Enter, Insert, Delete and Alt+Left/Right act on. It is kept
   * inside the current order, and it is only ever read while `columnEdit` is on —
   * a click on a column's capsule puts it there too, so the pointer and the keys
   * agree on which column is "this one".
   */
  columnFocus: number
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
   * What a folder's contents add up to, by path, for the folders the user asked
   * about with Space. Only a folder the gesture was made on is here: walking a
   * tree is a question worth asking, not one to ask about every row, so the
   * listing never sizes anything on its own.
   */
  dirSizes: Map<string, number>
  /** Folders whose walk is still running, so Space can ask again for no one. */
  sizing: Set<string>
  /**
   * Folders whose walk has been running long enough to be worth a bar — about
   * a third of a second. A folder of a few files is walked faster than the eye
   * can catch, and a bar that flicked in and out for it would say only that
   * something happened, not that anything was still happening; below the delay
   * the walk is simply too quick to be worth mentioning. Kept apart from
   * `sizing`, which is the walk itself and starts at once.
   */
  sizeSlow: Set<string>
  /**
   * Folders whose displayed size is stale: a recalculation is queued behind
   * `SIZE_WALK_LIMIT` but has not started, so the number on the row is the
   * previous answer. The row draws it dimmed rather than letting an old total
   * pass for a fresh one while the walk waits for its turn; it is dropped the
   * moment the walk starts, at which point the running total takes the column.
   */
  sizeStale: Set<string>
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
  /**
   * What git thinks of this directory, when it is inside a work tree: the
   * changed entries and the folders holding them, both keyed by absolute path so
   * a row's own path is the whole of the lookup. Null outside a repository, and
   * null on a machine with no git to ask — the same nothing, drawn the same way.
   *
   * Replaced whole on every read and never edited, which is why it is held raw:
   * the mark a row shows is decided by the object the pane was handed, not by
   * anything reactive inside it.
   */
  git: GitView | null
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
  sizeDirectory(): boolean
  /** Re-order the listing by a column, cycling the direction of the one in use. */
  sortBy(key: SortKey): void
  /** Move a column to a gap in the header order, for a dragged header. */
  moveColumn(from: SortKey, toIndex: number): void
  /** Toggle the pane's column edit mode — the header's icon, or Alt+C. */
  toggleColumnEdit(): void
  /** Swap one column's type, rebuilding the listing when it was the sorted one. */
  setColumnType(index: number, key: SortKey): void
  /**
   * Insert a column of the first type not already shown, into a gap in the
   * header. Answers the index it landed at, so the caller can open the new
   * column's picker, or null when every type is already shown.
   */
  addColumn(gapIndex: number): number | null
  /** Drop one column; the sort falls back to another when it was the sorted one. */
  removeColumn(index: number): void
  /** Move the column editor's keyboard focus by `delta` columns, clamped. */
  focusColumn(delta: number): void
  /** Put the column editor's keyboard focus on the first or last column. */
  focusColumnEdge(edge: 'start' | 'end'): void
  /** Put the column editor's keyboard focus on one column, for a click. */
  setColumnFocus(index: number): void
  /** Re-order the focused column one place left or right. */
  moveFocusedColumn(delta: number): void
  /** Drop the focused column — never the name column. */
  removeFocusedColumn(): void
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
  updateSearch(query: string): boolean
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

/**
 * The order of two entries under one column, ascending, before the direction is
 * applied: names through the listing's own collator, sizes numerically, and
 * times earliest first. A folder's size is not something a listing carries, so it
 * is read from `sizes` — the totals `Space` has walked (`dirSizes`) — and falls
 * back to the folder's own metadata size for one the user never asked about.
 * That fallback is what keeps the column honest: the blank a folder shows until
 * it is walked means "not asked", not zero, and a walk is what replaces it with a
 * total the ordering then respects.
 *
 * The mode sorts numerically, as the row draws it: the bits read low to high, so
 * a runnable file follows a plain one, matching the order the column shows. The
 * two mode columns are one question — the bits — so they order alike whichever
 * way they are drawn.
 */
function compareByKey(a: DirEntry, b: DirEntry, key: SortKey, sizes: Map<string, number>): number {
  switch (key) {
    case 'size':
      return sizeFor(a, sizes) - sizeFor(b, sizes)
    case 'modified':
      return a.mtimeMs - b.mtimeMs
    case 'mode':
    case 'modeNumeric':
      return a.mode - b.mode
    default:
      return collator.compare(a.name, b.name)
  }
}

/**
 * The number a row's size column orders it by. A file's size is its own metadata;
 * a folder's is whatever `Space` walked it to, when it has been walked, and its
 * metadata size otherwise — the same choice the row itself makes, so the order
 * and the column can never disagree about a folder.
 */
function sizeFor(entry: DirEntry, sizes: Map<string, number>): number {
  if (entry.kind === 'directory') {
    const walked = sizes.get(entry.path)
    if (walked !== undefined) return walked
  }
  return entry.size
}

/**
 * The listing's order. Folders keep their place in front — a directory is not a
 * row among files, it is where they live — and within the two groups the chosen
 * column decides, in the chosen direction. The name is always the tie-break,
 * ascending: entries a column cannot tell apart (two files of one size) keep a
 * stable, alphabetical order rather than whatever order the read returned. When
 * the column *is* the name, that tie-break is the comparison itself.
 */
function sortEntries(
  entries: DirEntry[],
  key: SortKey,
  direction: SortDirection,
  sizes: Map<string, number>
): DirEntry[] {
  const flip = direction === 'desc' ? -1 : 1
  return [...entries].sort((a, b) => {
    const aDir = a.kind === 'directory'
    const bDir = b.kind === 'directory'
    if (aDir !== bDir) return aDir ? -1 : 1

    const byKey = compareByKey(a, b, key, sizes)
    if (byKey !== 0) return byKey * flip
    return collator.compare(a.name, b.name)
  })
}

/**
 * The rows for a set of entries: sorted, with the ".." row in front when there
 * is somewhere to go. The entries handed in are already the ones the pane shows,
 * so the hide filter has been applied by the caller. The ".." row is prepended
 * rather than sorted in, so no chosen column — a size, a time — can move the way
 * up out of first place. `sizes` is the pane's walked folder totals, so a size
 * sort can order a sized folder by what its row actually shows.
 */
function toRows(
  entries: DirEntry[],
  parent: string | null,
  key: SortKey,
  direction: SortDirection,
  sizes: Map<string, number>
): PaneEntry[] {
  const sorted = sortEntries(entries, key, direction, sizes)
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
 * Whether two hidden-name sets say the same thing. A refresh replaces the set
 * whole, so identity says nothing about a change; the mode's coverage is what
 * the view animates on, and only a real difference is one.
 */
function sameNames(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const name of a) if (!b.has(name)) return false
  return true
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
 * How long a walk must run before its row shows a bar. A folder of a few files
 * is walked in a millisecond or two, and a bar for it would flick in and out
 * faster than it could be read; waiting 300ms means the bar only ever appears
 * over a walk that is really taking a while.
 */
const SIZE_BAR_DELAY_MS = 300

/**
 * How many folder walks may run at once, for the whole app. Each walk keeps a
 * batch of stats in flight (see `SIZE_STAT_BATCH` in main), so two is already
 * enough to saturate the fs thread pool; more would only queue behind it while
 * costing memory, progress messages and — on a mechanical disk — the locality
 * of walking one tree at a time. Two also fills the rows in an order that can be
 * read, instead of every row crawling at once.
 */
const SIZE_WALK_LIMIT = 2

/** Walks waiting for one of the `SIZE_WALK_LIMIT` slots, oldest first. */
const sizeWalkQueue: Array<() => void> = []
let sizeWalksRunning = 0

/**
 * Start queued walks while there is room. A job whose pane has moved on by the
 * time it starts returns at once, so a queue left behind by a navigation drains
 * without doing work whose answer no row could show.
 */
function pumpSizeWalks(): void {
  while (sizeWalksRunning < SIZE_WALK_LIMIT && sizeWalkQueue.length > 0) {
    const job = sizeWalkQueue.shift()
    if (!job) break
    sizeWalksRunning += 1
    job()
  }
}

/** Hold a walk until a slot is free, keeping the limit shared by both panes. */
function queueSizeWalk(job: () => Promise<void>): void {
  sizeWalkQueue.push(() => {
    void job().finally(() => {
      sizeWalksRunning -= 1
      pumpSizeWalks()
    })
  })
  pumpSizeWalks()
}

/**
 * Bumped when Escape stops every walk in the app. A queued job carries the epoch
 * it was asked under, so a queue that was still waiting is dropped whole instead
 * of waking later for a listing whose walk has been taken back.
 */
let sizeEpoch = 0

/** What each live pane does when the walks are stopped, one entry per controller. */
const sizeStops = new Set<() => void>()

/**
 * Stop every folder walk in the app — the ones running and everything queued
 * behind them — the way Escape takes back any other gesture. Main is told so a
 * tree it is still traversing gives up at its next batch, and every pane clears
 * the marks it was showing (restoring the size it had before the walk, if any).
 * Answers whether there was anything to stop.
 */
export function stopAllSizeWalks(): boolean {
  if (sizeWalkQueue.length === 0 && sizeWalksRunning === 0) return false

  sizeWalkQueue.length = 0
  sizeEpoch += 1
  window.mc.fs.cancelDirSize()
  for (const stop of sizeStops) stop()
  return true
}

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

/**
 * Where the cursor lands after a re-list: the row it was on when that row is
 * still there, and otherwise the row closest *before* where it was — an entry
 * that left the directory must not throw the cursor to the top of the listing.
 *
 * Both listings handed in are the *visible* ones (`filteredRows`), so a filter
 * is respected: the walk reads the order the user was looking at, and a row the
 * filter is hiding can never become the anchor. `focusPath` wins when it names a
 * row, since the caller knows the entry under the cursor was renamed to it (an
 * in-place rename, a move to a name in the same directory, a fresh folder). Only
 * when nothing before the departed entry survives does the cursor fall forward.
 *
 * This is the one rule for a vanished cursor, so `F8` needs no walk of its own:
 * the rows it deleted are simply absent from the listing handed back in.
 */
function resolveAnchor(
  rows: PaneEntry[],
  before: PaneEntry[],
  previous: PaneEntry | undefined,
  focusPath: string | undefined
): PaneEntry | undefined {
  if (focusPath) {
    const focused = rows.find((row) => row.path === focusPath)
    if (focused) return focused
  }
  if (!previous) return undefined

  const present = new Set(rows.map((row) => row.path))
  if (present.has(previous.path)) return previous

  // The departed entry's place in the listing it left, so "closest before" is
  // read from the order the user was looking at rather than from a re-sort.
  const from = before.findIndex((row) => row.path === previous.path)
  if (from < 0) return previous

  for (let i = from - 1; i >= 0; i -= 1) {
    const row = before[i]
    if (row && present.has(row.path)) return row
  }
  for (let i = from + 1; i < before.length; i += 1) {
    const row = before[i]
    if (row && present.has(row.path)) return row
  }
  return previous
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
    hideTick: 0,
    allRows: [],
    entries: [],
    itemCount: 0,
    cursor: 0,
    pageRows: 10,
    scrollAlign: 'nearest',
    sortKey: 'name',
    sortDir: 'asc',
    columnOrder: ['name', 'size', 'modified'],
    columnEdit: false,
    columnFocus: 0,
    animateScroll: false,
    searchActive: false,
    searchQuery: '',
    selected: new Set<string>(),
    loading: false,
    error: null,
    renaming: null,
    fresh: new Set<string>(),
    git: null,
    dirSizes: new Map<string, number>(),
    sizing: new Set<string>(),
    sizeSlow: new Set<string>(),
    sizeStale: new Set<string>()
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
    return toRows(entries, state.parent, state.sortKey, state.sortDir, state.dirSizes)
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
    // The rows the mode has just covered — or uncovered — are the ones the view
    // shows leaving and arriving; every other change to the listing is quiet.
    state.hideTick += 1
  })

  function clampCursorTo(value: number): number {
    const last = state.entries.length - 1
    if (last < 0) return 0
    return Math.min(Math.max(value, 0), last)
  }

  /**
   * The rows matching a query, the ".." row always among them: it survives every
   * filter, so it is never hidden by a search. An empty query is no filter at
   * all. Both `filteredRows` and the acceptance test below read this, so what the
   * listing shows and what a keystroke is judged by can never disagree.
   */
  function matchRows(query: string): PaneEntry[] {
    const needle = query.trim().toLowerCase()
    if (!needle) return state.allRows
    return state.allRows.filter((row) => row.isParent || row.name.toLowerCase().includes(needle))
  }

  /**
   * Whether a query would leave at least one real entry to find. The ".." row
   * does not count: it is present under every filter, so on its own it is a
   * search that found nothing.
   */
  function hasMatches(query: string): boolean {
    return matchRows(query).some((row) => !row.isParent)
  }

  /**
   * The rows the pane actually shows: `allRows` with the active query applied.
   * The listing the cursor reads for its fallback (`resolveAnchor`) is this one,
   * not `allRows`, so a filter cannot strand the cursor on a row it is hiding.
   */
  function filteredRows(): PaneEntry[] {
    return matchRows(state.searchQuery)
  }

  function applyFilter(previous: PaneEntry | undefined = current()): void {
    state.entries = filteredRows()

    state.itemCount = countRealRows(state.entries)

    // With an active query, only a real entry is worth keeping the cursor on:
    // the ".." row survives every filter, so holding it would strand the
    // cursor there instead of landing on the match.
    let preserved = -1
    if (previous && (state.searchQuery.trim() === '' || !previous.isParent)) {
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

  /**
   * Apply a keystroke's worth of query. A query that would leave nothing to find
   * is refused outright rather than shown: the listing stays as it was and the
   * caller is told, so the pane can put the last good query back and say why.
   * Returns whether the query was accepted.
   */
  function updateSearch(query: string): boolean {
    if (!state.searchActive) return false
    if (!hasMatches(query)) return false
    state.searchQuery = query
    applyFilter()
    return true
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

  /**
   * What git thinks of this directory, read after the listing lands rather than
   * before it. The two are independent — a status read is another process and a
   * walk of the whole work tree — so a pane that waited for both would show
   * nothing at all until the slower answered, and the marks arriving a frame
   * after the rows is exactly how a preview's shape already settles.
   *
   * Reads are sequenced rather than merely awaited: a pane navigated twice in
   * quick succession would otherwise let the first answer, for a directory it
   * has already left, land last and mark the wrong rows.
   */
  let gitSeq = 0

  /**
   * The work tree the pane is inside, as the last read reported it, whether or
   * not it had anything to say. Kept apart from `state.git` because it is also
   * what decides whether a change notification is this pane's news, and a
   * repository with nothing changed has no mark to hold it.
   */
  let gitRoot: string | null = null

  async function loadGit(): Promise<void> {
    const mine = ++gitSeq
    const result = await window.mc.git.status(state.path)
    if (mine !== gitSeq) return

    if (result.ok) {
      gitRoot = result.data.root
      state.git = markRaw(buildGitView(result.data))
    } else {
      gitRoot = null
      state.git = null
    }
    watchCurrentRepo()
  }

  /**
   * One watcher per work tree rather than per directory. The pane re-targets it
   * only when it moves to a different repository, so walking between the folders
   * of one does not close and reopen main's watchers on `.git` at every step.
   */
  let watchedRepo: string | null = null

  function unwatchRepo(): void {
    if (watchedRepo === null) return
    const root = watchedRepo
    watchedRepo = null
    void window.mc.git.unwatch(root)
  }

  function watchCurrentRepo(): void {
    const next = gitRoot
    if (next === watchedRepo) return

    const previous = watchedRepo
    watchedRepo = next
    if (previous !== null) void window.mc.git.unwatch(previous)
    if (next !== null) void window.mc.git.watch(next)
  }

  /**
   * A stage, a commit, a checkout — or an ordinary write to any directory of the
   * work tree the app is already watching, which main reports here as well, so a
   * file saved in one pane's folder marks its neighbour's row too.
   *
   * Only the status is re-read: a `.git` write is not a change to what a
   * directory holds, so there is no listing to take again.
   */
  const stopGitWatching = window.mc.git.onChanged((event) => {
    if (event.root === gitRoot) void loadGit()
  })

  const stopWatching = window.mc.fs.onChanged((event) => {
    if (event.path === state.path) void refresh()
  })

  /**
   * A walk's running total. Only a folder this pane is sizing is taken: another
   * pane may be walking a folder of its own, and a report for one this pane has
   * left behind must not appear in rows it is no longer showing.
   */
  const stopDirSizeProgress = window.mc.fs.onDirSizeProgress((event) => {
    if (!state.sizing.has(event.path)) return
    state.dirSizes.set(event.path, event.bytes)
    scheduleSizeSort()
  })

  onScopeDispose(() => {
    stopWatching()
    stopGitWatching()
    stopDirSizeProgress()
    sizeStops.delete(stopSizing)
    unwatchCurrent()
    unwatchRepo()
    clearFresh()
    cancelSizeSort()
    // Whatever walk is still running belongs to a pane that is gone; neither
    // its answer nor its bar timer must touch this state any more.
    sizeRun += 1
  })

  /**
   * Bumped whenever the pane enters another directory, so a size walk started
   * for the one it left cannot land in the new listing's rows. Sizes belong to
   * the listing they were asked from, exactly as marks and the filter do.
   */
  let sizeRun = 0

  /**
   * What a folder's size column showed before the walk in flight overwrote it
   * with a running total. `null` means there was no earlier answer. Stopping the
   * walks puts this back, so Escape never leaves a partial sum looking like a
   * size, nor erases a total the folder already had.
   */
  const sizePrior = new Map<string, number | null>()

  /**
   * Escape's half of the stop: clear the marks, put back what the rows showed
   * before, and bump the run so an in-flight answer is ignored. Registered for
   * the app's `stopAllSizeWalks`, which also tells main to give up.
   */
  const stopSizing = (): void => {
    if (state.sizing.size === 0 && state.sizeSlow.size === 0) return

    for (const path of state.sizing) {
      const prior = sizePrior.get(path)
      if (prior === undefined || prior === null) state.dirSizes.delete(path)
      else state.dirSizes.set(path, prior)
      sizePrior.delete(path)
    }

    state.sizing.clear()
    state.sizeSlow.clear()
    state.sizeStale.clear()
    sizeRun += 1
    scheduleSizeSort()
  }

  sizeStops.add(stopSizing)

  /**
   * A size walk changing the listing's order, live. Sorting by size is a question
   * whose answer keeps arriving — a walk reports a running total as it goes — so
   * the rows are re-ordered as those totals land, not only when the walk ends. It
   * is debounced for quiescence and periodic for a long walk: each change
   * re-schedules the run to a short wait after the last, but a burst that never
   * quiets still fires every `SIZE_SORT_MAX_MS`, so a walk of hundreds of
   * thousands of files updates the order while it runs instead of only at its
   * end. The cursor is kept on the entry it was on (`applyFilter`), so the
   * re-order moves rows around the cursor rather than off it — which is what
   * keeps the one-pass `Space` gesture usable.
   */
  const SIZE_SORT_DEBOUNCE_MS = 150
  const SIZE_SORT_MAX_MS = 600

  let sizeSortTimer: number | null = null
  /** When the current burst of size changes began, or null when none is due. */
  let sizeSortBurst: number | null = null

  function scheduleSizeSort(): void {
    if (state.sortKey !== 'size') return

    const now = performance.now()
    if (sizeSortBurst === null) sizeSortBurst = now

    // Quiet-first, but never longer than the cap since the burst began: a steady
    // stream of reports fires it about every `SIZE_SORT_MAX_MS`, and the end of
    // the stream fires it `SIZE_SORT_DEBOUNCE_MS` later.
    const waited = now - sizeSortBurst
    const wait = Math.max(0, Math.min(SIZE_SORT_DEBOUNCE_MS, SIZE_SORT_MAX_MS - waited))

    if (sizeSortTimer !== null) window.clearTimeout(sizeSortTimer)
    sizeSortTimer = window.setTimeout(() => {
      sizeSortTimer = null
      sizeSortBurst = null
      sortBySizeNow()
    }, wait)
  }

  function cancelSizeSort(): void {
    if (sizeSortTimer !== null) {
      window.clearTimeout(sizeSortTimer)
      sizeSortTimer = null
    }
    sizeSortBurst = null
  }

  /** Re-list the rows in size order, keeping the cursor on the entry it was on. */
  function sortBySizeNow(): void {
    if (!state.path || state.sortKey !== 'size') return
    const previous = current()
    state.allRows = buildRows()
    applyFilter(previous)
  }

  async function navigateTo(dir: string, focusPath?: string): Promise<void> {
    state.loading = true
    state.error = null
    // A pending size re-order belongs to the listing being left; the new one is
    // built whole below, and a late sort must not touch rows it never saw.
    cancelSizeSort()

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
    sizeRun += 1
    state.dirSizes.clear()
    state.sizing.clear()
    state.sizeSlow.clear()
    state.sizeStale.clear()
    sizePrior.clear()
    clearFresh()
    watchCurrent()
    void loadGit()
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
   *
   * An entry that simply left the directory — deleted by another program, by a
   * shell command, or by a pane sharing it — takes the cursor with it only as
   * far as the row closest before it (`resolveAnchor`), never to the top.
   */
  async function refresh(focusPath?: string): Promise<void> {
    if (!state.path || state.loading) return

    const result = await window.mc.fs.list(state.path)
    if (!result.ok) {
      state.error = `${result.error.code}: ${result.error.message}`
      return
    }

    // Captured before the listing is replaced: `before` is what the diff below
    // compares against, and `beforeVisible` is the order the cursor's fallback
    // reads when the entry under it has gone.
    const before = state.allRows
    const beforeVisible = state.entries
    const beforeHidden = state.hideNames
    const previous = current()
    state.error = null
    state.path = result.data.path
    state.parent = result.data.parent
    state.allEntries = result.data.entries
    state.hideNames = new Set(result.data.hiddenNames)
    const rows = buildRows()
    state.allRows = rows
    applyFilter(resolveAnchor(filteredRows(), beforeVisible, previous, focusPath))
    // A `.mchide` edit — the menu's hide, or a write behind the app's back — is a
    // change of what the mode covers, and so one the view shows as rows leaving;
    // an ordinary re-list leaves the tick alone and its new and gone rows sweep
    // as they always have.
    if (!sameNames(beforeHidden, state.hideNames)) state.hideTick += 1
    // An entry the mode now covers carries no mark any more, exactly as one that
    // left the directory does not.
    pruneSelection()
    markFresh(diffEntries(before, rows))
    watchCurrent()
    void loadGit()
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
   * Order the listing by a column, from a click on its header. A column not in
   * use becomes the sort in ascending order; the column already in use flips —
   * ascending to descending, descending back to ascending — so the same header
   * walks the two directions without a third state to pass through. The rows are
   * rebuilt in place and the cursor is kept on the entry it was on, as any other
   * re-order of the same directory does.
   */
  function sortBy(key: SortKey): void {
    const previous = current()
    if (state.sortKey === key) {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc'
    } else {
      state.sortKey = key
      state.sortDir = 'asc'
    }
    state.allRows = buildRows()
    applyFilter(previous)
  }

  /**
   * Move a column into a gap in the header order — a header dropped where the
   * insertion point was shown. `toIndex` is a gap in the order as it stands
   * before the move (0 before the first column, `length` after the last), so a
   * gap to the right of the dragged column closes up by one once that column is
   * lifted out, which is what `target` corrects for.
   */
  function moveColumn(from: SortKey, toIndex: number): void {
    const order = state.columnOrder
    const fromIndex = order.indexOf(from)
    if (fromIndex < 0) return

    const target = fromIndex < toIndex ? toIndex - 1 : toIndex
    if (target === fromIndex) return
    order.splice(fromIndex, 1)
    order.splice(target, 0, from)
    clampColumnFocus()
  }

  /**
   * Whether the pane is building its columns, so the header knows to draw its
   * editors rather than its labels and sort arrows. Turning it on lands the
   * keyboard on a real column, so the arrows have somewhere to start.
   */
  function toggleColumnEdit(): void {
    state.columnEdit = !state.columnEdit
    if (state.columnEdit) clampColumnFocus()
  }

  /**
   * Keep `columnFocus` pointing at a column that is actually in the order.
   */
  function clampColumnFocus(): void {
    const last = Math.max(state.columnOrder.length - 1, 0)
    state.columnFocus = Math.min(Math.max(state.columnFocus, 0), last)
  }

  /** Move the column editor's keyboard focus by `delta` columns, clamped. */
  function focusColumn(delta: number): void {
    state.columnFocus += delta
    clampColumnFocus()
  }

  /** Put the column editor's keyboard focus on the first or last column. */
  function focusColumnEdge(edge: 'start' | 'end'): void {
    state.columnFocus = edge === 'start' ? 0 : state.columnOrder.length - 1
    clampColumnFocus()
  }

  /** Put the column editor's keyboard focus on one column, for a click. */
  function setColumnFocus(index: number): void {
    state.columnFocus = index
    clampColumnFocus()
  }

  /**
   * Re-order the focused column one place left or right — the keyboard's half of
   * dragging the grip. Unlike `moveColumn`, this works in whole steps from the
   * column's own index, so the focus follows the column and the next press moves
   * it again from where it now is.
   */
  function moveFocusedColumn(delta: number): void {
    const order = state.columnOrder
    const from = state.columnFocus
    const target = from + delta
    if (from < 0 || from >= order.length) return
    if (target < 0 || target >= order.length) return

    const [moved] = order.splice(from, 1)
    if (moved === undefined) return
    order.splice(target, 0, moved)
    state.columnFocus = target
  }

  /**
   * Insert a column of the first type not already shown, into a gap in the
   * header. The keyboard lands on the new column, so the picker that follows and
   * the keys after it act on the column just made.
   */
  function addColumn(gapIndex: number): number | null {
    const key = COLUMN_TYPES.find((type) => !state.columnOrder.includes(type))
    // Every type is already on screen, so there is nothing left to add.
    if (key === undefined) return null
    const at = Math.min(Math.max(gapIndex, 0), state.columnOrder.length)
    state.columnOrder.splice(at, 0, key)
    state.columnFocus = at
    return at
  }

  /**
   * Drop one column. The name column is never dropped — a listing without the
   * entry's own name is not a listing — and the sort falls back to the first
   * column left when the column that went was the one ordering the rows,
   * ascending, since the direction belonged to the column that left rather than
   * to the place it was in. The keyboard focus gives way to the column that takes
   * its place — or the one before it, for the column that was last.
   */
  function removeColumn(index: number): void {
    const order = state.columnOrder
    if (index < 0 || index >= order.length) return
    if (order[index] === 'name') return

    const [removed] = order.splice(index, 1)
    if (index < state.columnFocus) state.columnFocus -= 1
    clampColumnFocus()
    if (removed === undefined || state.sortKey !== removed) return

    const previous = current()
    state.sortKey = order[0] ?? 'name'
    state.sortDir = 'asc'
    state.allRows = buildRows()
    applyFilter(previous)
  }

  /** Drop the focused column — never the name column. */
  function removeFocusedColumn(): void {
    removeColumn(state.columnFocus)
  }

  /**
   * Change what one column shows. Types are unique among the columns — the picker
   * greys out the ones already on screen — so a type being moved off the sorted
   * column hands the sort to it, and the listing is rebuilt the way any other
   * change of the sort key rebuilds it.
   */
  function setColumnType(index: number, key: SortKey): void {
    const order = state.columnOrder
    if (index < 0 || index >= order.length) return

    const old = order[index]
    if (old === undefined || old === key || order.includes(key)) return

    order[index] = key
    if (state.sortKey !== old) return

    const previous = current()
    state.sortKey = key
    state.allRows = buildRows()
    applyFilter(previous)
  }

  /**
   * Start one folder's walk, if it is not already running. The running total
   * lands in `dirSizes` as it arrives, the bar's timer raises `sizeSlow` after
   * `SIZE_BAR_DELAY_MS`, and the final answer overwrites the running one. Each
   * walk carries the run it began under, so one started before a navigation is
   * dropped when its answer comes back for a listing the pane has left.
   *
   * The walk itself waits for one of the app's `SIZE_WALK_LIMIT` slots: the
   * folder is marked as sizing at once (so Space cannot ask twice for it), but
   * neither the request nor the bar's timer starts before a slot is free.
   */
  function startSizeWalk(path: string): void {
    if (state.sizing.has(path)) return

    const run = sizeRun
    const epoch = sizeEpoch
    state.sizing.add(path)
    // Keep what the row showed before the running total overwrites it, so
    // Escape's stop can put it back (`stopSizing`).
    if (!sizePrior.has(path)) sizePrior.set(path, state.dirSizes.get(path) ?? null)
    // A row already showing an answer is stale the moment a recalculation is
    // asked for: the number is the old one until this walk actually starts.
    if (state.dirSizes.has(path)) state.sizeStale.add(path)

    queueSizeWalk(async () => {
      // The pane may have left the listing, or Escape may have stopped the
      // walks, while this waited for a slot: no answer it could bring would
      // belong to the rows on screen any more.
      if (run !== sizeRun || epoch !== sizeEpoch) return

      // The slot is this walk's: the dim old number gives way to the running
      // total that is about to replace it.
      state.sizeStale.delete(path)

      const slowTimer = window.setTimeout(() => {
        if (run !== sizeRun) return
        state.sizeSlow.add(path)
      }, SIZE_BAR_DELAY_MS)

      try {
        const result = await window.mc.fs.dirSize(path)
        if (run !== sizeRun) return
        if (result.ok) {
          state.dirSizes.set(path, result.data.bytes)
        } else {
          state.error = `${result.error.code}: ${result.error.message}`
        }
      } finally {
        // The walk is over before the mark is cleared, so a late progress report
        // can no longer revise the final total and the bar's timer cannot raise
        // a bar for a walk that has ended.
        window.clearTimeout(slowTimer)
        if (run === sizeRun) {
          state.sizing.delete(path)
          state.sizeSlow.delete(path)
          state.sizeStale.delete(path)
          sizePrior.delete(path)
          scheduleSizeSort()
        }
      }
    })
  }

  /**
   * Space on a folder: walk its contents for their total size, in the
   * background, and step to the next row so a column of folders can be asked
   * about in one pass. The answer lands in the row's own size column, exactly
   * where a file's size is; nothing waits for it, since a tree can take a
   * moment and the gesture asks the question rather than waiting for it.
   *
   * Space on the ".." row asks about all of them at once: every folder in the
   * listing is walked, and the cursor is left where it is, since there is no
   * row below to step to that the gesture could mean.
   *
   * A bar appears under a number only once its walk has been running for
   * `SIZE_BAR_DELAY_MS`: a small folder is walked in a millisecond or two and a
   * bar that blinked for it would say nothing useful.
   *
   * Answers false for anything Space is not this: a file, an empty directory, a
   * listing with no folder in it. The caller then lets the key go on to the
   * clip's play/pause and to the shell's own space, so nothing a Space did
   * before is taken away.
   */
  function sizeDirectory(): boolean {
    const entry = current()
    if (!entry) return false

    if (entry.isParent) {
      const folders = state.allRows.filter((row) => !row.isParent && row.kind === 'directory')
      if (folders.length === 0) return false
      for (const folder of folders) startSizeWalk(folder.path)
      return true
    }

    if (entry.kind !== 'directory') return false

    startSizeWalk(entry.path)
    moveCursor(1)
    return true
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
   * listing is re-read in place. Marks for entries that copied are dropped, as
   * a move's are when it takes them away. Returns the resolved destination
   * directory so the caller can refresh a pane showing it, or null on failure.
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

    // A copy leaves the source in place, so nothing prunes the marks the way a
    // move's departure does — but they have been spent all the same: a mark is
    // the promise about what the *next* F5 acts on, not a record of what the
    // last one did. A source that failed keeps its mark so a retry still knows
    // what the user meant, exactly as `moveEntries` leaves it.
    const failedPaths = new Set(result.data.failed.map((failure) => failure.path))
    for (const target of targets) {
      if (!failedPaths.has(target.path)) state.selected.delete(target.path)
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
    // knows what the user meant, then re-list in place. The cursor needs nothing
    // done for it here: `refresh` settles it on the row closest before the one
    // that went, over the rows the filter is showing, so an entry this delete
    // took — the one under the cursor or not — falls the same way an externally
    // deleted one does.
    for (const removed of result.data.deleted) state.selected.delete(removed)

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
    sizeDirectory,
    sortBy,
    moveColumn,
    toggleColumnEdit,
    setColumnType,
    addColumn,
    removeColumn,
    focusColumn,
    focusColumnEdge,
    setColumnFocus,
    moveFocusedColumn,
    removeFocusedColumn,
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
