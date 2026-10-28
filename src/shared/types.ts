export type PanelSide = 'left' | 'right'

export type EntryKind =
  | 'directory'
  | 'file'
  | 'symlink'
  | 'socket'
  | 'fifo'
  | 'device'
  | 'unknown'

export interface DirEntry {
  name: string
  path: string
  kind: EntryKind
  isSymlink: boolean
  symlinkTarget: string | null
  size: number
  mtimeMs: number
  mode: number
}

/**
 * The total size of a folder's contents, in bytes — the answer to "how much is
 * in there", which a listing cannot give without walking the whole tree. Symlinks
 * are counted as the links they are rather than followed, so a link back up its
 * own tree cannot make the walk endless.
 */
export interface DirSize {
  bytes: number
}

/**
 * A running total from a folder walk, sent while it is still going so the row
 * can fill in as the tree is traversed rather than only when it ends. `path` is
 * the folder the walk was asked about, which is what lets a pane match the
 * report to the row that asked for it.
 */
export interface DirSizeProgress {
  path: string
  bytes: number
}

export interface DirListing {
  path: string
  parent: string | null
  entries: DirEntry[]
  /**
   * The entry names this directory's `.mchide` file lists, one per line, in the
   * order the file gives them. Empty when there is no such file, or none that can
   * be read. Main returns every entry and lets the pane apply the list, because
   * the mode can be switched off and on in the interface without reading the
   * directory again.
   */
  hiddenNames: string[]
}

/**
 * One entry a repository's status has something to say about — the mirror of a
 * record in `git status --porcelain=v2`. `index` and `worktree` are git's own two
 * status characters, in git's own order, with `.` left in place for the side that
 * is unmodified, so the pair can be shown as `git status --short` shows it and
 * means exactly what it means there. `path` is the path git printed: relative to
 * the repository root, forward-slashed, and ending in `/` when it names a whole
 * untracked directory rather than a file — porcelain collapses one when nothing
 * inside it is tracked, which is also the cheaper answer for a listing to roll up.
 */
export interface GitFileStatus {
  path: string
  index: string
  worktree: string
  /**
   * For a rename or a copy, the path the entry came from; null for everything
   * else. Only porcelain's rename records carry it, and only a staged rename
   * normally produces one.
   */
  from: string | null
}

/**
 * A repository's status in one read: where its root is, what HEAD is on, how far
 * it has drifted from its upstream, and every path git has something to say
 * about. Read once per repository rather than once per row — porcelain answers
 * for the whole work tree in a single call, which is what makes a per-row marker
 * affordable at all.
 */
export interface GitStatus {
  /** The work tree's root, absolute, as `rev-parse --show-toplevel` gives it. */
  root: string
  /** The branch HEAD is on; null when detached, or on an unborn branch. */
  branch: string | null
  /** HEAD's commit, or null on an unborn branch — what a detached label needs. */
  oid: string | null
  detached: boolean
  /** Commits the upstream is behind and ahead, both zero with no upstream. */
  ahead: number
  behind: number
  files: GitFileStatus[]
}

/**
 * Pushed to the renderer when a repository may have changed: a stage, a commit, a
 * checkout, or an ordinary write to a directory of it that main already watches.
 * `root` is the work tree's own path, matching `GitStatus.root`, so a pane can
 * tell whether the news is about the repository it is looking at.
 */
export interface GitChangeEvent {
  root: string
}

export interface FsError {
  code: string
  message: string
}

/**
 * Pushed to the renderer when a watched directory's contents change on disk, so
 * a pane showing that directory can re-list itself instead of polling. `path` is
 * the resolved directory that was watched, matching `DirListing.path`.
 */
export interface FsChangeEvent {
  path: string
}

/**
 * A regular file read for the viewer. `text` is the file decoded as UTF-8, and
 * `truncated` marks one larger than the viewer's read limit whose tail was
 * dropped rather than loaded. Main refuses non-regular files (directories,
 * sockets, FIFOs, devices) and files that look binary, so a successful read is
 * always something the editor can display.
 */
export interface FileContent {
  path: string
  text: string
  truncated: boolean
}

/**
 * An image read for a pane's status-bar preview, already encoded as a `data:`
 * URL so the renderer can drop it straight into an `<img>` without touching the
 * filesystem itself (the renderer CSP allows `img-src data:`). Main refuses
 * non-regular files, formats Chromium cannot decode, and files past the preview
 * ceiling, so a successful read is always something the bar can show.
 */
export interface ImagePreview {
  dataUrl: string
}

/**
 * A picture's pixel dimensions, read from its header rather than by decoding
 * it, so a pane can reserve a preview of the right shape before the picture
 * arrives. Nullable everywhere it is returned: a format whose header does not
 * carry them cheaply simply has no shape to reserve.
 */
export interface PixelSize {
  width: number
  height: number
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: FsError }

export interface DeleteFailure {
  path: string
  error: FsError
}

/**
 * Deleting a set of paths is best-effort: one unwritable entry must not abort
 * the rest, so the call reports what went through and what did not.
 */
export interface DeleteOutcome {
  deleted: string[]
  failed: DeleteFailure[]
}

export interface CopyFailure {
  path: string
  error: FsError
}

/**
 * Copying a set of paths is best-effort for the same reason: a collision or an
 * unreadable entry must not abort the rest, so the call reports `copied`
 * destinations and the `failed` sources with why they did not go through.
 * `destination` is the resolved destination directory, so callers can compare
 * it against a pane's path (a relative destination resolves against the pane
 * that was copied from, not the process working directory).
 */
export interface CopyOutcome {
  copied: string[]
  failed: CopyFailure[]
  destination: string
}

export interface MoveFailure {
  path: string
  error: FsError
}

/**
 * Moving a set of paths is best-effort like copy: a collision or an unreadable
 * entry is reported without aborting the rest. `moved` lists the destination
 * paths that now hold the entries, `failed` the source paths with why they did
 * not go through, and `destination` is the resolved destination directory (a
 * relative destination resolves against the pane moved from).
 */
export interface MoveOutcome {
  moved: string[]
  failed: MoveFailure[]
  destination: string
}

export interface PtySpawnOptions {
  cwd: string
  cols: number
  rows: number
}

export interface PtyDataEvent {
  id: string
  data: string
}

export interface PtyExitEvent {
  id: string
  exitCode: number
  signal: number | undefined
}

export interface PtyStateSnapshot {
  cwd: string | null
  idle: boolean
}
