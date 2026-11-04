import type { Target } from './target'
import type {
  CopyOutcome,
  DeleteOutcome,
  DirListing,
  DirSize,
  DirSizeProgress,
  DiskUsage,
  FileContent,
  FsChangeEvent,
  GitChangeEvent,
  GitFileBase,
  GitStatus,
  ImagePreview,
  PixelSize,
  MoveOutcome,
  PtyDataEvent,
  PtyExitEvent,
  PtySpawnOptions,
  PtyStateSnapshot,
  Result
} from './types'

export interface McFsApi {
  home(): Promise<string>
  list(dir: string): Promise<Result<DirListing>>
  /**
   * Read a regular text file for the viewer. Non-regular files and binary
   * content come back as an error rather than a lossy decode.
   */
  read(target: string): Promise<Result<FileContent>>
  /**
   * The total size of everything under a directory, in bytes. The walk does not
   * follow symlinks — a link back up its own tree would make it endless — and an
   * unreadable entry is skipped rather than failing the whole answer, so a folder
   * holding one protected subdirectory still reports the rest.
   */
  dirSize(target: string): Promise<Result<DirSize>>
  /**
   * What the filesystem holding `path` looks like: its size, what is allocated
   * on it, and what is still available to the user. A path inside an archive is
   * answered for the archive file's own filesystem, since that is what extracting
   * into it would fill.
   */
  diskUsage(target: string): Promise<Result<DiskUsage>>
  /**
   * Stop every folder walk this window has running. The walks give up at their
   * next batch, so a tree that is still being traversed does not keep the disk
   * busy after the gesture that asked for it has been taken back.
   */
  cancelDirSize(): void
  /**
   * The running total of a walk still in progress, so the row can show the size
   * as subdirectories are traversed. `path` is the folder the walk was asked
   * about; a pane ignores reports for folders it is not sizing.
   */
  onDirSizeProgress(handler: (event: DirSizeProgress) => void): () => void
  /**
   * Read a regular image file for a pane's status-bar preview, as a `data:`
   * URL. Only decodable formats and files within the preview ceiling come back;
   * anything else is an error the bar simply renders nothing for.
   */
  readImage(target: string): Promise<Result<ImagePreview>>
  /**
   * The pixel dimensions in an image's header, read without decoding it, so a
   * pane can reserve a preview of the right shape before reading the image
   * itself. Null when the target is not a previewable image, or when its header
   * does not carry the dimensions cheaply — nothing to reserve, not an error.
   */
  imageSize(target: string): Promise<PixelSize | null>
  /**
   * Whether main can transcode a clip Chromium has no decoder for or no
   * demuxer for (an old camcorder AVI, a WMV, the HEVC of a phone's `.mp4`).
   * False without ffmpeg on the machine, in which case those files are not
   * previewable and are simply opened instead.
   */
  canTranscode(): Promise<boolean>
  /**
   * Whether main can read archives at all, so a pane knows to offer entering a
   * `.zip` rather than handing it to the system. False without 7z on the
   * machine, which is also the answer while the probe is still running.
   */
  canArchive(): Promise<boolean>
  /**
   * The video codec inside a container Chromium demuxes (`mp4`, `m4v`, `mov`),
   * read from the file's header without decoding anything. Null when the file
   * is not such a container or its header does not say — nothing known against
   * it, so it is served as it stands.
   */
  videoCodec(target: string): Promise<string | null>
  /**
   * How long the clip a preview of this file would play is — its own length, or
   * as much of it as an encode covers — or null when nothing can say. Only a
   * clip Chromium cannot play itself needs this: the element reports its own
   * length as soon as it has one.
   */
  videoDuration(target: string): Promise<number | null>
  /**
   * Overwrite a regular text file with edited content (the editor's save).
   * Returns the resolved path that was written.
   */
  write(target: string, text: string): Promise<Result<string>>
  open(target: string): Promise<string>
  reveal(target: string): Promise<void>
  rename(source: string, target: string): Promise<Result<string>>
  /**
   * Make a directory (F7). `name` is what the user typed — a folder name, or a
   * path: absolute, or relative to `dir`, which is the pane the gesture was made
   * in. Not recursive, so an existing name and a missing parent each come back as
   * an error rather than being papered over; returns the resolved directory that
   * was made.
   */
  mkdir(dir: string, name: string): Promise<Result<string>>
  copy(sources: string[], destination: string, baseDir: string): Promise<Result<CopyOutcome>>
  move(sources: string[], destination: string, baseDir: string): Promise<Result<MoveOutcome>>
  remove(targets: string[]): Promise<Result<DeleteOutcome>>
  /**
   * Append an entry's name to a directory's `.mchide` file — the pane menu's way
   * of adding to a hide list without the file being opened. Idempotent: a name
   * already listed is left where it is. Returns the file that was written, or the
   * error that stopped it (a folder in the way, a permission).
   */
  hideAdd(dir: string, name: string): Promise<Result<string>>
  /**
   * Take an entry's name out of a directory's `.mchide` file — the pane menu's
   * way of letting a normally hidden entry stop being listed. Only the lines
   * naming it go; the rest of the file is left as it was, a name that is not
   * listed leaves the file alone, and the file is never created. Returns the file
   * that was looked at, or the error that stopped it.
   */
  hideRemove(dir: string, name: string): Promise<Result<string>>
  /**
   * Watch a directory for on-disk changes. Refcounted in main, so several
   * callers (both panes, or the same pane twice) may watch one directory.
   */
  watch(dir: string): Promise<void>
  unwatch(dir: string): Promise<void>
  onChanged(handler: (event: FsChangeEvent) => void): () => void
}

export interface McPtyApi {
  create(id: string, options: PtySpawnOptions): Promise<void>
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  kill(id: string): void
  state(id: string): Promise<PtyStateSnapshot>
  onData(handler: (event: PtyDataEvent) => void): () => void
  onExit(handler: (event: PtyExitEvent) => void): () => void
}

export interface McWindowApi {
  minimize(): Promise<void>
  toggleMaximize(): Promise<boolean>
  close(): Promise<void>
  isMaximized(): Promise<boolean>
  onMaximizedChange(handler: (maximized: boolean) => void): () => void
}

export interface McHideApi {
  /**
   * Whether the hide mode is applied — the choice remembered from the last time
   * it was toggled. A `.mchide` file says *what* a folder hides; this says
   * whether the panes leave those entries out at all.
   */
  get(): Promise<boolean>
  set(enabled: boolean): Promise<void>
}

export interface McQuickCdApi {
  /**
   * The remembered quick cd directories, one absolute path each, in the order
   * the user put them. Empty before anything has been added.
   */
  get(): Promise<string[]>
  /**
   * Replace the remembered list whole. The renderer owns the order and the
   * membership — adding appends, removing filters — and main only writes down
   * what it is handed.
   */
  set(directories: string[]): Promise<void>
}

export interface McGitApi {
  /**
   * A repository's status, read from `git status --porcelain=v2` for the whole
   * work tree in one call. `dir` is any directory; the answer names the work
   * tree that holds it. A directory outside one comes back as an `ENOTREPO`
   * error rather than an empty status, so a pane can tell a folder with nothing
   * to report from one git does not know about — which is also how a machine
   * with no git at all answers, so nothing has to ask whether one is there.
   * `MC_GIT` names the binary when it is not the one on `PATH`, as `MC_FFMPEG`
   * does for transcoding.
   */
  status(dir: string): Promise<Result<GitStatus>>
  /**
   * What HEAD holds for one path, for the viewer's changed-line gutter: the blob
   * the working copy is compared against. `path` is the file itself rather than a
   * directory, and the answer names the work tree that holds it. A path HEAD has
   * no blob for — a new, untracked or ignored file — comes back with `exists`
   * false and empty text rather than as an error, so the viewer can mark the whole
   * working copy as added.
   */
  fileBase(path: string): Promise<Result<GitFileBase>>
  /**
   * Watch a work tree for changes to what git thinks. `root` is the
   * `GitStatus.root`, not an arbitrary directory, because a pane keeps one
   * watcher per repository: it re-targets the watch only when it moves to a
   * different work tree, so walking between folders of one repository does not
   * close and reopen the watchers. Refcounted in main like the directory watch.
   */
  watch(root: string): Promise<void>
  unwatch(root: string): Promise<void>
  onChanged(handler: (event: GitChangeEvent) => void): () => void
}

export interface McApi {
  fs: McFsApi
  pty: McPtyApi
  win: McWindowApi
  hide: McHideApi
  quickCd: McQuickCdApi
  git: McGitApi
  targets: McTargetsApi
  remote: McRemoteApi
}

/**
 * One stage of a target's relay coming up, as the pane draws it: the label for
 * the title, and how far through the whole connect that stage sits. `value` is
 * what makes the title's bar determinate — the stage is a real step, so the bar
 * can say how much is left instead of sliding with no end in sight.
 */
export interface RelayProgress {
  /** The stage now under way, spelled for the pane title, e.g. "Contacting uhk…". */
  phase: string
  /** How far through the connect this stage is, 0..1. */
  value: number
}

/**
 * The targets a workspace can run on. Local and root are always present; ssh
 * targets are the ones the user saved. `add` takes what the picker's dialog
 * collects and returns the stored target, id included.
 */
export interface McTargetsApi {
  /**
   * The local user's name, read synchronously so the app can open its first
   * workspace on localhost before the async target list has arrived. The rest of
   * the list — local, root and saved remotes — is loaded by `list`.
   */
  readonly localUser: string
  list(): Promise<Target[]>
  add(input: { user: string; host: string; port?: number; relayPath?: string }): Promise<Target>
  remove(id: string): Promise<void>
  /**
   * Live stages of an in-flight `add`: contacting the host, installing the relay,
   * starting it, verifying it. Sent while the promise is pending so the dialog can
   * tell a slow ssh handshake from a download from a hang, each with a fraction of
   * the connect done for a determinate bar.
   */
  onProgress(handler: (progress: RelayProgress) => void): () => void
}

/** The raw answer from a relay, before a target API turns it into a domain value. */
export interface McRemoteResult {
  ok: boolean
  data?: unknown
  error?: { code: string; message: string }
  blob?: Uint8Array
}

/**
 * An event a relay pushed: a directory changed, git changed, a pty produced
 * output or ended. `targetId` says which connection it belongs to, so a pane or
 * a shell filters for its own.
 */
export interface McRemoteEvent {
  targetId: string
  type?: string
  path?: string
  id?: string
  data?: string
  exitCode?: number
  signal?: number
  /** For a `target:progress` event: the connect stage now under way. */
  phase?: string
  /** For a `target:progress` event: how far through the connect it sits, 0..1. */
  value?: number
}

/**
 * The door to the relays. One generic request rather than one method per
 * operation: the relay's protocol is the operation table, so a new operation is
 * taught to the relay and the target API wrapper, not wired into another IPC
 * handler.
 */
export interface McRemoteApi {
  request(
    targetId: string,
    op: string,
    args: Record<string, unknown>,
    blob?: Uint8Array
  ): Promise<McRemoteResult>
  onEvent(handler: (event: McRemoteEvent) => void): () => void
}
