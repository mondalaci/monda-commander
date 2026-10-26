import type {
  CopyOutcome,
  DeleteOutcome,
  DirListing,
  FileContent,
  FsChangeEvent,
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

export interface McApi {
  fs: McFsApi
  pty: McPtyApi
  win: McWindowApi
  hide: McHideApi
}
