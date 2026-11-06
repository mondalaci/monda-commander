import type { Target } from './target'
import type {
  ConflictChoice,
  CopyOutcome,
  DeleteOutcome,
  DirListing,
  DirSize,
  DirSizeProgress,
  DiskUsage,
  FileContent,
  FsChangeEvent,
  GitChangeEvent,
  GitCommitResult,
  GitFileBase,
  GitPushResult,
  GitStatus,
  ImagePreview,
  ModelData,
  PixelSize,
  MoveOutcome,
  PtyDataEvent,
  PtyExitEvent,
  PtySpawnOptions,
  PtyStateSnapshot,
  PdfInfo,
  PdfPageText,
  PdfViewState,
  Result,
  TransferConflict,
  TransferProgress
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
   * A small tile of a file for a pane's thumbnail view, as a `data:` URL: an
   * image decoded and shrunk to `max` on its longest side, or a single frame of
   * a clip. A format with no thumbnail — a model, a clip with no ffmpeg to cut a
   * frame, anything on a remote target — comes back as an error, and the tile
   * draws the entry's own icon instead. Only the local machine answers.
   */
  thumbnail(target: string, max: number): Promise<Result<ImagePreview>>
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
   * Whether main can rasterize a PDF page in-app (poppler's `pdftocairo` is
   * present). False on a machine without it, in which case a PDF is not media at
   * all and `Enter` opens it with the system's own viewer instead.
   */
  canRenderPdf(): Promise<boolean>
  /**
   * How many pages a PDF has, and the shape of its first page, read from the
   * document's header without rendering anything. Null when the file is not a
   * PDF or its header could not be read.
   */
  pdfInfo(target: string): Promise<PdfInfo | null>
  /**
   * One page of a PDF, rasterized at `width` pixels wide (the height follows the
   * page's own aspect) and returned as a PNG `data:` URL, for the same reason an
   * image is read that way: the renderer has no URL for a file on disk. `page` is
   * 1-based.
   */
  pdfPage(target: string, page: number, width: number): Promise<Result<ImagePreview>>
  /**
   * One page's text, with each word's box in points, for the invisible layer a
   * selection is made over. Read for the page being looked at rather than the
   * whole document; a page with no text comes back with no words, and a build
   * without poppler's `pdftotext` answers with an error the pane simply does not
   * draw a layer for.
   */
  pdfText(target: string, page: number): Promise<Result<PdfPageText>>
  /**
   * Whether main can convert a CAD document — STEP, IGES, FreeCAD's own
   * `.fcstd` — to a mesh for the preview, which needs FreeCAD's command-line
   * binary (`MC_FREECAD`). False on a machine without it, in which case those
   * files are not models at all and `Enter` opens them with the system. A mesh
   * format (STL, 3MF, OBJ, PLY, glTF) needs no answer: the renderer parses it
   * itself.
   */
  canRenderModel(): Promise<boolean>
  /**
   * A 3D model read for a pane's preview: the bytes of a mesh the renderer can
   * parse, and which parser to use. A mesh format travels as it stands; a CAD
   * document is converted to STL by main first, so `format` is `'stl'` for those
   * however the file was named. Read on the local machine only — a CAD
   * conversion runs a binary main can reach and a mesh travels the bridge whole.
   */
  readModel(target: string): Promise<Result<ModelData>>
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
  /**
   * Copy `sources` into `destination`. A relative destination resolves against
   * `baseDir`, the pane the gesture was made in. `id` names the transfer, so the
   * progress `onTransferProgress` reports and a `cancelTransfer` can be routed to
   * it; an empty id copies with neither. Best-effort like delete: entries that
   * collide or cannot be read are reported without aborting the rest.
   */
  copy(id: string, sources: string[], destination: string, baseDir: string): Promise<Result<CopyOutcome>>
  /** Move `sources` into `destination`, mirroring `copy` and sharing its `id`. */
  move(id: string, sources: string[], destination: string, baseDir: string): Promise<Result<MoveOutcome>>
  /**
   * Ask the transfer named `id` to stop. A copy gives up at its next chunk and
   * takes back the entry it was half through; already-copied entries stay. A
   * no-op for an id that is not running, or on a remote target, whose relay
   * cannot be interrupted mid-request.
   */
  cancelTransfer(id: string): void
  /**
   * The byte progress of transfers this window is running, each keyed by the id
   * its `copy`/`move` was called with. A remote relay answers a copy in one
   * piece, so it reports none.
   */
  onTransferProgress(handler: (event: TransferProgress) => void): () => void
  /**
   * A name collision a running copy or move has hit, which main is holding open
   * for an answer. The dialog shows the two sides and asks what to do; until
   * `answerTransferConflict` is called the transfer waits where it is.
   */
  onTransferConflict(handler: (event: TransferConflict) => void): () => void
  /**
   * Answer the collision `requestId` on transfer `id`: `overwrite` replaces the
   * file or merges the folder, `skip` leaves it, the `…All` forms decide the rest
   * of that kind silently, and `cancel` stops the transfer.
   */
  answerTransferConflict(id: string, requestId: string, choice: ConflictChoice): void
  /**
   * Delete `targets`. `id` names the transfer, so the progress
   * `onTransferProgress` reports and a `cancelTransfer` can be routed to it.
   * Best-effort like copy: an unreadable entry is reported without aborting the
   * rest. A delete that is stopped stops where it is — what it already removed
   * stays removed, since removal cannot be taken back the way a half-written copy
   * can.
   */
  remove(id: string, targets: string[]): Promise<Result<DeleteOutcome>>
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

export interface McPdfViewApi {
  /**
   * How a PDF display is sized — the fit (the box's width, or a whole page) and a
   * magnification on top of it. The choice is remembered across launches and
   * shared by every display, as the hide mode is.
   */
  get(): Promise<PdfViewState>
  set(view: PdfViewState): Promise<void>
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
   * Stage every change in the work tree and commit it. `root` is the
   * `GitStatus.root`. The message's first line is the subject and the rest the
   * body; the answer carries the new commit's oid. This is the only write the
   * app makes to a repository's *history*, so it is deliberately all-or-nothing:
   * `git add -A` and one commit, no partial staging the user did not ask for.
   */
  commit(root: string, message: string): Promise<Result<GitCommitResult>>
  /**
   * Push the current branch to the one it already tracks. Not offered with no
   * upstream and on a detached HEAD; a failure — no upstream, a rejected
   * refspec, a credential git cannot answer with prompts off — comes back as
   * git's own message.
   */
  push(root: string): Promise<Result<GitPushResult>>
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
  pdfView: McPdfViewApi
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
