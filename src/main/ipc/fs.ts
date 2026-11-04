import { constants as fsConstants, promises as fs, type Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ipcMain, nativeImage, shell } from 'electron'
import { isArchivePath, splitArchivePath } from '@shared/archive'
import { HIDE_MARKER } from '@shared/hide'
import { imageMimeFor } from '@shared/image'
import { readImageSize } from '../imageSize'
import {
  archiveDirSize,
  canArchive,
  listArchive,
  readArchiveEntry
} from '../archive'
import type {
  CopyFailure,
  CopyOutcome,
  DeleteFailure,
  DeleteOutcome,
  DirEntry,
  DirListing,
  DirSize,
  DiskUsage,
  EntryKind,
  FileContent,
  ImagePreview,
  PixelSize,
  MoveFailure,
  MoveOutcome,
  Result
} from '@shared/types'

function kindFromStats(stats: Stats): EntryKind {
  if (stats.isDirectory()) return 'directory'
  if (stats.isFile()) return 'file'
  if (stats.isSymbolicLink()) return 'symlink'
  if (stats.isSocket()) return 'socket'
  if (stats.isFIFO()) return 'fifo'
  if (stats.isCharacterDevice() || stats.isBlockDevice()) return 'device'
  return 'unknown'
}

function toFsError(error: unknown): { code: string; message: string } {
  const err = error as NodeJS.ErrnoException
  return {
    code: err.code ?? 'EUNKNOWN',
    message: err.message || 'Unknown filesystem error'
  }
}

/** A mount point as `/proc` writes it: `\040` for a space, and so on. */
function decodeMountPath(raw: string): string {
  return raw.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(parseInt(octal, 8))
  )
}

/** Whether `target` sits at or under `mount`, on a path boundary. */
function isWithinMount(target: string, mount: string): boolean {
  if (mount === '/') return target.startsWith('/')
  const prefix = mount.endsWith('/') ? mount : `${mount}/`
  return target === mount || target.startsWith(prefix)
}

/**
 * The mount point holding a path, matched by the *longest* mount point in
 * `/proc/self/mountinfo` that contains it — so a directory on a nested mount
 * answers with the inner one rather than the root. Null when the file cannot be
 * read, which is how a non-Linux platform or a restricted sandbox answers.
 */
async function mountPointFor(target: string): Promise<string | null> {
  let text: string
  try {
    text = await fs.readFile('/proc/self/mountinfo', 'utf8')
  } catch {
    return null
  }
  const resolved = path.resolve(target)
  let best: string | null = null
  for (const line of text.split('\n')) {
    if (!line) continue
    const field = line.split(' ')[4]
    if (!field) continue
    const mount = decodeMountPath(field)
    if (!isWithinMount(resolved, mount)) continue
    if (best === null || mount.length > best.length) best = mount
  }
  return best
}

async function readEntry(dir: string, name: string): Promise<DirEntry> {
  const full = path.join(dir, name)

  let stats: Stats
  let isSymlink = false
  try {
    stats = await fs.lstat(full)
    isSymlink = stats.isSymbolicLink()
    if (isSymlink) stats = await fs.stat(full)
  } catch {
    stats = await fs.lstat(full)
  }

  let symlinkTarget: string | null = null
  if (isSymlink) {
    try {
      symlinkTarget = await fs.readlink(full)
    } catch {
      symlinkTarget = null
    }
  }

  return {
    name,
    path: full,
    kind: kindFromStats(stats),
    isSymlink,
    symlinkTarget,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    mode: stats.mode
  }
}

/**
 * The names a `.mchide` file's text lists — one per line — with blank lines
 * skipped and every line trimmed, so a Windows line ending or a stray space
 * around a name still matches the entry it names. The reader of a listing and the
 * writer the pane menu borrows both come through here, because a rule that lived
 * in one of them and not the other would show up as a name that hides nothing.
 */
function parseHiddenNames(text: string): Set<string> {
  const names = new Set<string>()
  for (const line of text.split('\n')) {
    const name = line.trim()
    if (name) names.add(name)
  }
  return names
}

/**
 * The names a `.mchide` file lists — one per line — or null when the file cannot
 * be read (missing, unreadable, a dangling symlink), in which case it lists
 * nothing.
 */
async function readHiddenNames(file: string): Promise<Set<string> | null> {
  try {
    return parseHiddenNames(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Put a name in a directory's `.mchide` file, which is how the pane menu's `Hide`
 * adds to a folder's list without the file being opened in the editor.
 *
 * It appends rather than rewrites, and a name already listed is left alone — the
 * request is "hide this", not "list this twice". A newline is added first when the
 * file does not end in one, since otherwise the new name would join the last line
 * and hide whatever that line happened to spell. The file written is returned, so
 * a caller can name which one it was.
 */
export async function addHiddenName(dir: string, name: string): Promise<string> {
  const target = path.join(path.resolve(dir), HIDE_MARKER)
  const wanted = name.trim()

  // A missing file is the ordinary case: this is how a folder gets its list at
  // all. A read that failed for any other reason (a permission) fails the append
  // below just the same, and *that* error is the honest one to report.
  let text = ''
  try {
    text = await fs.readFile(target, 'utf8')
  } catch {
    text = ''
  }

  if (parseHiddenNames(text).has(wanted)) return target

  const separator = text === '' || text.endsWith('\n') ? '' : '\n'
  await fs.appendFile(target, `${separator}${wanted}\n`)
  return target
}

/**
 * Take a name out of a directory's `.mchide` file, which is how the pane menu's
 * `Remove from .mchide` lets a row stop being normally hidden.
 *
 * Only the lines that spell the name are dropped; every other line — blank ones
 * and whatever a hand-written file holds that the format does not read — is
 * rewritten exactly as it was read, because the request is about one name and not
 * about tidying the file up. A name the file does not list leaves it untouched
 * rather than rewriting what is already right, and the file is never created: a
 * name taken out of a list that does not exist has already been taken out. The
 * file that was looked at is returned, so a caller can name which one it was.
 */
export async function removeHiddenName(dir: string, name: string): Promise<string> {
  const target = path.join(path.resolve(dir), HIDE_MARKER)
  const wanted = name.trim()

  let text: string
  try {
    text = await fs.readFile(target, 'utf8')
  } catch (error) {
    // A missing file lists nothing, so there is nothing to take out of it. Any
    // other read failure — a folder of that name, a permission — is the honest
    // one to report.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return target
    throw error
  }

  const lines = text.split('\n')
  const kept = lines.filter((line) => line.trim() !== wanted)
  if (kept.length === lines.length) return target

  await fs.writeFile(target, kept.join('\n'))
  return target
}

/**
 * Read a directory, together with the names its `.mchide` file lists — one per
 * line. The names are reported rather than applied: the pane owns the hide mode
 * (it can be switched off and on without touching the folder), so main's job is
 * only to say what the file asked for. Blank lines are skipped and every line is
 * trimmed, so a Windows line ending or a stray space still matches the entry it
 * names. A folder called `.mchide` is not the file, and an unreadable one — a
 * dangling symlink, a permission — lists nothing.
 */
export async function listDirectory(input: string): Promise<DirListing> {
  const dir = path.resolve(input)
  const dirents = await fs.readdir(dir, { withFileTypes: true })

  const settled = await Promise.allSettled(dirents.map((d) => readEntry(dir, d.name)))

  const entries: DirEntry[] = []
  for (const item of settled) {
    if (item.status === 'fulfilled') entries.push(item.value)
  }

  // The file is looked up in the listing just read rather than by a separate
  // stat, so a directory is never walked twice to answer one question.
  const marker = entries.find(
    (entry) => entry.name === HIDE_MARKER && entry.kind !== 'directory'
  )
  const names = marker ? await readHiddenNames(marker.path) : null

  const parent = path.dirname(dir)
  return {
    path: dir,
    parent: parent === dir ? null : parent,
    entries,
    hiddenNames: names ? [...names] : []
  }
}

/**
 * How often a walk may report its running total. A tree can hold hundreds of
 * thousands of files, so a message per entry would cost more than the walking;
 * ten a second is enough for a row to visibly count up and cheap enough that the
 * walk itself stays the work.
 */
const SIZE_PROGRESS_MS = 100

/**
 * How many `lstat`s one walk keeps in flight. A walk used to stat a directory's
 * files one at a time, which leaves three of the fs thread pool's four threads
 * idle while every call waits; a batch keeps the pool busy without a single walk
 * monopolising it. The batch is small on purpose: the walks themselves are
 * limited too (two at a time in the pane), so the worst case is a handful of
 * queued stats rather than an unbounded fan-out that would delay the app's
 * listings and previews.
 */
const SIZE_STAT_BATCH = 12

/**
 * The total size of everything under a directory, in bytes. The walk does not
 * follow symlinks — a link back up its own tree would make it endless, and the
 * answer is about what the folder itself holds — so a link is counted as the
 * link it is, exactly as `du` counts one. An unreadable entry is skipped rather
 * than failing the whole answer, so a tree with one protected subdirectory still
 * reports the rest of itself.
 *
 * Folders are discovered through `Dirent.isDirectory`, which is the entry's
 * own kind and never a link's target, so nothing is descended through a link.
 *
 * `onProgress` is called with the running total, throttled to `SIZE_PROGRESS_MS`,
 * so a row can say how much has been found while the rest is still being walked.
 *
 * `isCancelled` is checked between batches: a walk that has been taken back
 * answers `null` rather than a total, so a partial sum is never presented as the
 * size of the folder.
 */
async function directorySize(
  input: string,
  onProgress?: (bytes: number) => void,
  isCancelled?: () => boolean
): Promise<DirSize | null> {
  const root = path.resolve(input)
  let bytes = 0
  let lastReport = 0
  const pending: string[] = [root]

  const cancelled = (): boolean => isCancelled?.() ?? false

  const report = (): void => {
    if (onProgress === undefined || cancelled()) return
    const now = Date.now()
    if (lastReport !== 0 && now - lastReport < SIZE_PROGRESS_MS) return
    lastReport = now
    onProgress(bytes)
  }

  while (pending.length > 0) {
    if (cancelled()) return null

    const dir = pending.pop() as string

    let dirents
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true })
    } catch (error) {
      // Only the folder the user asked about can fail the answer: a
      // subdirectory the walk cannot open is simply not part of what it can
      // count, exactly as an unreadable file contributes nothing.
      if (dir === root) throw error
      continue
    }

    for (let start = 0; start < dirents.length; start += SIZE_STAT_BATCH) {
      if (cancelled()) return null

      // A batch of entries at a time, so the stats of one directory are not a
      // chain of waits. Subdirectories are only queued here — the walk visits
      // them in turn below — and the pushed paths keep the walk's own order.
      const batch = dirents.slice(start, start + SIZE_STAT_BATCH)
      const sizes = await Promise.all(
        batch.map(async (dirent) => {
          const full = path.join(dir, dirent.name)
          if (dirent.isDirectory()) {
            pending.push(full)
            return 0
          }
          try {
            return (await fs.lstat(full)).size
          } catch {
            // Vanished, or not ours to read: it contributes nothing.
            return 0
          }
        })
      )
      for (const size of sizes) bytes += size

      // The first batch reports at once, so a row says something is happening
      // even when the walk is spread over many directories.
      report()
    }
  }

  return { bytes }
}

/**
 * The viewer decodes what it reads as UTF-8 text, so a NUL byte in the head of
 * the file is the cheapest reliable signal that it is not text — decoding it
 * anyway would flood the editor with replacement characters.
 */
function looksBinary(buffer: Buffer): boolean {
  const sample = Math.min(buffer.length, 8000)
  for (let i = 0; i < sample; i += 1) {
    if (buffer[i] === 0) return true
  }
  return false
}

/**
 * Ceiling on what the viewer will load. A model larger than this is read only
 * up to the limit and flagged `truncated` rather than pulling gigabytes into
 * the renderer.
 */
const MAX_VIEW_BYTES = 8 * 1024 * 1024

/**
 * Read a regular file for the viewer. O_NONBLOCK matters: without it the `open`
 * of a FIFO waits for a writer and the handler would never answer, so the kind
 * check below could not run. Directories, sockets, FIFOs and devices are
 * refused here, which is why the renderer only offers regular files.
 */
async function readFileForViewer(input: string): Promise<FileContent> {
  const target = path.resolve(input)
  const handle = await fs.open(target, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)

  try {
    const stats = await handle.stat()
    if (!stats.isFile()) {
      throw Object.assign(new Error(`"${path.basename(target)}" is not a regular file`), {
        code: 'EINVAL'
      })
    }

    const length = Math.min(stats.size, MAX_VIEW_BYTES)
    const buffer = Buffer.allocUnsafe(length)
    // A single read of a regular file can return short; keep going until the
    // buffer is full or the file ends.
    let filled = 0
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, filled)
      if (bytesRead === 0) break
      filled += bytesRead
    }

    const content = buffer.subarray(0, filled)
    if (looksBinary(content)) {
      throw Object.assign(new Error(`"${path.basename(target)}" looks binary`), {
        code: 'EBINARY'
      })
    }

    return {
      path: target,
      text: content.toString('utf8'),
      truncated: stats.size > length
    }
  } finally {
    await handle.close()
  }
}

/**
 * Below this a preview is sent exactly as the file is on disk: small enough
 * that the base64 round trip is cheap, and it keeps what re-encoding would lose
 * — an animated GIF stays animated, an SVG stays vector, a JPEG keeps its EXIF
 * orientation (which `nativeImage` does not apply).
 */
const RAW_PREVIEW_BYTES = 16 * 1024 * 1024

/**
 * A downscaled preview never needs to be larger than this on its longest side.
 * The footer shows at most 160x64 CSS px — 320x128 on a HiDPI display — so the
 * headroom is for crispness rather than size.
 */
const PREVIEW_MAX_DIM = 512

/**
 * Ceiling for a file too large to send raw *and* one the platform decoder
 * cannot read (an SVG, or a format `nativeImage` does not handle). Reading it
 * whole is then the only way to show it, but past this the payload stops being
 * worth moving at all for a 64px strip.
 */
const LARGE_RAW_PREVIEW_BYTES = 64 * 1024 * 1024

/**
 * Read a regular file to the end. A single read of a regular file can return
 * short, so keep going until the buffer is full or the file ends.
 */
async function readAll(handle: FileHandle, size: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(size)
  let filled = 0
  while (filled < size) {
    const { bytesRead } = await handle.read(buffer, filled, size - filled, filled)
    if (bytesRead === 0) break
    filled += bytesRead
  }
  return buffer.subarray(0, filled)
}

/**
 * Decode an image and shrink it to fit the preview, as a PNG data URL, or null
 * if this build cannot read the format. This is what keeps an arbitrarily large
 * source from becoming an arbitrarily large payload: past `RAW_PREVIEW_BYTES`
 * the bar gets the thumbnail, not the original. The decode is synchronous, so
 * it does block main for the length of one image — which is why the caller
 * reaches it only for a cursor that has settled (see below), and why the small
 * file path skips it entirely.
 */
function downscalePreview(target: string): string | null {
  const image = nativeImage.createFromPath(target)
  if (image.isEmpty()) return null

  const { width, height } = image.getSize()
  const longest = Math.max(width, height)
  if (longest <= 0) return null
  if (longest <= PREVIEW_MAX_DIM) return image.toDataURL()

  const scale = PREVIEW_MAX_DIM / longest
  const resized = image.resize({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  })
  return resized.toDataURL()
}

/**
 * A preview is worth keeping. Scrolling back and forth over a folder re-visits
 * the same rows, and without this every return pays the read — or the decode of
 * a large image — again. The key carries the file's size and mtime, exactly what
 * the renderer keys its read on, so a rewrite on disk misses the cache as well.
 * Entries larger than the whole budget are not cached at all, which in practice
 * means only downscaled previews and small files are.
 */
const PREVIEW_CACHE_MAX_BYTES = 24 * 1024 * 1024
const PREVIEW_CACHE_MAX_ENTRIES = 32

const previewCache = new Map<string, { dataUrl: string; bytes: number }>()

function previewCacheKey(target: string, mtimeMs: number, size: number): string {
  return `${target}\u0000${mtimeMs}:${size}`
}

function readPreviewCache(key: string): string | null {
  const hit = previewCache.get(key)
  if (!hit) return null
  // Re-insert so the map's order stays least-recently-used first.
  previewCache.delete(key)
  previewCache.set(key, hit)
  return hit.dataUrl
}

function writePreviewCache(key: string, dataUrl: string): void {
  if (dataUrl.length > PREVIEW_CACHE_MAX_BYTES) return

  previewCache.delete(key)
  previewCache.set(key, { dataUrl, bytes: dataUrl.length })

  let total = 0
  for (const entry of previewCache.values()) total += entry.bytes

  while (total > PREVIEW_CACHE_MAX_BYTES || previewCache.size > PREVIEW_CACHE_MAX_ENTRIES) {
    const oldest = previewCache.keys().next()
    if (oldest.done) break
    total -= previewCache.get(oldest.value)?.bytes ?? 0
    previewCache.delete(oldest.value)
  }
}

/**
 * Read a regular image file for a pane's status-bar preview. The extension is
 * the same map the renderer used to decide to ask, so a successful read is
 * always a format it can decode. O_NONBLOCK and the regular-file check mirror
 * `readFileForViewer`: a FIFO must not block the handler, and a directory or
 * device is not an image. Size is handled rather than refused — a small file
 * goes over as-is, a large one is downscaled.
 */
async function readImageForPreview(input: string): Promise<ImagePreview> {
  const target = path.resolve(input)
  const mime = imageMimeFor(target)
  if (!mime) {
    throw Object.assign(new Error(`"${path.basename(target)}" is not a supported image`), {
      code: 'EINVAL'
    })
  }

  let size = 0
  let key: string | null = null
  const handle = await fs.open(target, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)

  try {
    const stats = await handle.stat()
    if (!stats.isFile()) {
      throw Object.assign(new Error(`"${path.basename(target)}" is not a regular file`), {
        code: 'EINVAL'
      })
    }

    size = stats.size
    key = previewCacheKey(target, stats.mtimeMs, size)

    const cached = readPreviewCache(key)
    if (cached !== null) return { dataUrl: cached }

    if (size <= RAW_PREVIEW_BYTES) {
      const bytes = await readAll(handle, size)
      const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`
      writePreviewCache(key, dataUrl)
      return { dataUrl }
    }
  } finally {
    await handle.close()
  }

  const downscaled = downscalePreview(target)
  if (downscaled !== null) {
    if (key !== null) writePreviewCache(key, downscaled)
    return { dataUrl: downscaled }
  }

  // The decoder could not read it, so the bytes have to travel after all.
  if (size > LARGE_RAW_PREVIEW_BYTES) {
    throw Object.assign(new Error(`"${path.basename(target)}" is too large to preview`), {
      code: 'E2BIG'
    })
  }
  const bytes = await fs.readFile(target)
  return { dataUrl: `data:${mime};base64,${bytes.toString('base64')}` }
}

/**
 * How much of a file the size probe reads. The dimensions sit in the header of
 * every format handled here, but a JPEG's can come after its EXIF and an
 * embedded thumbnail, so this is generous — reading a prefix is still cheap
 * next to the decode the preview itself needs.
 */
const SIZE_PROBE_BYTES = 256 * 1024

/**
 * The dimensions of an image file, so the renderer can reserve a preview of the
 * right shape before the image is read. Only a prefix of the file is read and
 * nothing is decoded, so this answers in well under a millisecond even for a
 * file the preview read would take hundreds of milliseconds to decode. A format
 * the probe cannot measure answers null rather than failing: there is simply no
 * shape to reserve.
 */
async function readImageSizeForPreview(input: string): Promise<PixelSize | null> {
  const target = path.resolve(input)
  if (!imageMimeFor(target)) return null

  const handle = await fs.open(target, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) return null
    const bytes = await readAll(handle, Math.min(stats.size, SIZE_PROBE_BYTES))
    return readImageSize(bytes)
  } finally {
    await handle.close()
  }
}

/**
 * Read one entry of an archive for the viewer, mirroring `readFileForViewer`:
 * the same binary test and the same ceiling, so a file an archive holds reads
 * exactly like the same file on disk. The entry's bytes are pulled through 7z
 * rather than a file handle, which is why it is a second reader and not a branch
 * inside the first.
 */
async function readEntryForViewer(
  archive: string,
  inner: string,
  location: string
): Promise<FileContent> {
  const bytes = await readArchiveEntry(archive, inner, MAX_VIEW_BYTES)
  if (looksBinary(bytes)) {
    throw Object.assign(new Error(`"${inner}" looks binary`), { code: 'EBINARY' })
  }
  return {
    path: location,
    text: bytes.toString('utf8'),
    truncated: bytes.length >= MAX_VIEW_BYTES
  }
}

/**
 * Read an image entry of an archive for a pane's preview, mirroring
 * `readImageForPreview`: a small image travels as it is, a large one is decoded
 * and shrunk, and the extension is the same map the renderer asked by. There is
 * no header-size probe for an archive entry (it would mean streaming the whole
 * entry just to read a prefix), so the box reserves nothing and fills when the
 * read lands.
 */
async function readEntryImageForPreview(
  archive: string,
  inner: string
): Promise<ImagePreview> {
  const name = inner.slice(inner.lastIndexOf('/') + 1)
  const mime = imageMimeFor(name)
  if (!mime) {
    throw Object.assign(new Error(`"${name}" is not a supported image`), { code: 'EINVAL' })
  }

  const bytes = await readArchiveEntry(archive, inner, LARGE_RAW_PREVIEW_BYTES)
  if (bytes.length <= RAW_PREVIEW_BYTES) {
    return { dataUrl: `data:${mime};base64,${bytes.toString('base64')}` }
  }

  const image = nativeImage.createFromBuffer(bytes)
  if (image.isEmpty()) {
    throw Object.assign(new Error(`"${name}" is too large to preview`), { code: 'E2BIG' })
  }
  const { width, height } = image.getSize()
  const longest = Math.max(width, height)
  if (longest <= PREVIEW_MAX_DIM) return { dataUrl: image.toDataURL() }
  const scale = PREVIEW_MAX_DIM / longest
  return {
    dataUrl: image
      .resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) })
      .toDataURL()
  }
}

/**
 * One folder walk's cancellation flag. The walks of a window are kept together
 * by the webContents that asked, because Escape's "stop that" is the window's,
 * and a cancel must reach every walk it started.
 */
interface SizeWalk {
  cancelled: boolean
}

const sizeWalks = new Map<number, Set<SizeWalk>>()

export function registerFsHandlers(): void {
  ipcMain.handle('fs:home', () => os.homedir())

  ipcMain.handle('fs:list', async (_event, dir: string): Promise<Result<DirListing>> => {
    try {
      if (isArchivePath(dir)) {
        const { archive, inner } = splitArchivePath(dir) as { archive: string; inner: string }
        return { ok: true, data: await listArchive(archive, inner) }
      }
      return { ok: true, data: await listDirectory(dir) }
    } catch (error) {
      return { ok: false, error: toFsError(error) }
    }
  })

  // Whether a pane can enter archives at all. Asked once by the renderer; false
  // is why Enter on a `.zip` opens it with the system instead.
  ipcMain.handle('fs:can-archive', () => canArchive())

  ipcMain.handle('fs:dir-size', async (event, target: string): Promise<Result<DirSize>> => {
    if (typeof target !== 'string' || target.length === 0) {
      return { ok: false, error: { code: 'EINVAL', message: 'No directory to size' } }
    }

    // A folder inside an archive is sized from the listing that is already in
    // hand — every entry's stored size is known — so there is no walk and no
    // cancellation to track.
    if (isArchivePath(target)) {
      try {
        const { archive, inner } = splitArchivePath(target) as { archive: string; inner: string }
        return { ok: true, data: { bytes: await archiveDirSize(archive, inner) } }
      } catch (error) {
        return { ok: false, error: toFsError(error) }
      }
    }

    const sender = event.sender
    const walk: SizeWalk = { cancelled: false }
    let walks = sizeWalks.get(sender.id)
    if (!walks) {
      walks = new Set()
      sizeWalks.set(sender.id, walks)
    }
    walks.add(walk)

    try {
      // `stat` rather than `lstat` so a link to a folder is a folder here too,
      // exactly as the listing shows it: the walk below is what must not follow
      // the links *inside*.
      if (!(await fs.stat(target)).isDirectory()) {
        return {
          ok: false,
          error: {
            code: 'ENOTDIR',
            message: `"${path.basename(target)}" is not a directory`
          }
        }
      }

      const resolved = path.resolve(target)
      const data = await directorySize(
        resolved,
        (bytes) => {
          if (sender.isDestroyed()) return
          sender.send('fs:dir-size-progress', { path: resolved, bytes })
        },
        () => walk.cancelled || sender.isDestroyed()
      )

      // A taken-back walk has no answer: reporting a partial total as the size
      // of the folder would be worse than reporting nothing.
      if (data === null) {
        return { ok: false, error: { code: 'EABORTED', message: 'Size walk stopped' } }
      }
      return { ok: true, data }
    } catch (error) {
      return { ok: false, error: toFsError(error) }
    } finally {
      walks.delete(walk)
      if (walks.size === 0) sizeWalks.delete(sender.id)
    }
  })

  // Escape gives the walks back. A flag rather than an abort of a socket: the
  // walk is a set of fs calls already in flight, and the batch boundary is the
  // soonest it can honestly stop without leaving a readdir half-consumed.
  ipcMain.on('fs:dir-size-cancel', (event) => {
    const walks = sizeWalks.get(event.sender.id)
    if (!walks) return
    for (const walk of walks) walk.cancelled = true
  })

  // How full the filesystem holding a pane's path is. `statfs` answers in
  // blocks, so the block size turns them into bytes; `bavail` is what a
  // non-root writer may still use, while `bfree` is every free block including
  // the reserved ones `df`'s "used" subtracts. A path inside an archive is
  // answered for the archive file itself — that is the disk extracting into it
  // would fill.
  ipcMain.handle('fs:disk-usage', async (_event, target: string): Promise<Result<DiskUsage>> => {
    if (typeof target !== 'string' || target.length === 0) {
      return { ok: false, error: { code: 'EINVAL', message: 'No path to measure' } }
    }
    const probe = isArchivePath(target)
      ? (splitArchivePath(target) as { archive: string }).archive
      : target
    try {
      const stats = await fs.statfs(probe)
      const blockSize = stats.bsize
      return {
        ok: true,
        data: {
          total: blockSize * stats.blocks,
          used: blockSize * (stats.blocks - stats.bfree),
          free: blockSize * stats.bavail,
          mount: await mountPointFor(probe)
        }
      }
    } catch (error) {
      return { ok: false, error: toFsError(error) }
    }
  })

  ipcMain.handle('fs:open', async (_event, target: string) => {
    // An entry inside an archive has no path the system could open; the message
    // is non-empty, which is how a failure travels back to the pane's notice.
    if (isArchivePath(target)) return 'Extract this entry to open it'
    return shell.openPath(target)
  })

  ipcMain.handle('fs:read', async (_event, target: string): Promise<Result<FileContent>> => {
    if (typeof target !== 'string' || target.length === 0) {
      return { ok: false, error: { code: 'EINVAL', message: 'No file to read' } }
    }
    try {
      if (isArchivePath(target)) {
        const { archive, inner } = splitArchivePath(target) as { archive: string; inner: string }
        return { ok: true, data: await readEntryForViewer(archive, inner, target) }
      }
      return { ok: true, data: await readFileForViewer(target) }
    } catch (error) {
      return { ok: false, error: toFsError(error) }
    }
  })

  ipcMain.handle('fs:read-image', async (_event, target: string): Promise<Result<ImagePreview>> => {
    if (typeof target !== 'string' || target.length === 0) {
      return { ok: false, error: { code: 'EINVAL', message: 'No image to read' } }
    }
    try {
      if (isArchivePath(target)) {
        const { archive, inner } = splitArchivePath(target) as { archive: string; inner: string }
        return { ok: true, data: await readEntryImageForPreview(archive, inner) }
      }
      return { ok: true, data: await readImageForPreview(target) }
    } catch (error) {
      return { ok: false, error: toFsError(error) }
    }
  })

  ipcMain.handle('fs:image-size', async (_event, target: string): Promise<PixelSize | null> => {
    if (typeof target !== 'string' || target.length === 0) return null
    // No shape is reserved for an entry inside an archive: measuring it would
    // mean streaming the whole entry for a prefix. The preview still arrives.
    if (isArchivePath(target)) return null
    try {
      return await readImageSizeForPreview(target)
    } catch {
      // Nothing to reserve is not an error the renderer can act on.
      return null
    }
  })

  ipcMain.handle(
    'fs:write',
    async (_event, target: string, text: string): Promise<Result<string>> => {
      if (typeof target !== 'string' || target.length === 0) {
        return { ok: false, error: { code: 'EINVAL', message: 'No file to write' } }
      }
      // Writing an entry back into an archive is the next phase; until then the
      // save is refused with a message rather than a path 7z would never see.
      if (isArchivePath(target)) {
        return {
          ok: false,
          error: { code: 'ENOTSUP', message: 'Saving inside an archive is not supported yet' }
        }
      }
      if (typeof text !== 'string') {
        return { ok: false, error: { code: 'EINVAL', message: 'Refusing to write non-text content' } }
      }

      const resolved = path.resolve(target)
      try {
        // Only an existing regular file (or a symlink to one) is a save target.
        // A directory, socket or device would either fail oddly or write into
        // something the editor never showed. A path that no longer exists is
        // allowed: re-saving a deleted file recreates it, as an editor should.
        try {
          const stats = await fs.lstat(resolved)
          if (!stats.isFile() && !stats.isSymbolicLink()) {
            return {
              ok: false,
              error: {
                code: 'EINVAL',
                message: `"${path.basename(resolved)}" is not a regular file`
              }
            }
          }
        } catch {
          // Missing target — a fresh save recreates it.
        }

        await fs.writeFile(resolved, text, 'utf8')
        return { ok: true, data: resolved }
      } catch (error) {
        return { ok: false, error: toFsError(error) }
      }
    }
  )

  ipcMain.handle('fs:reveal', (_event, target: string) => {
    // There is nothing to point at inside an archive; the archive file itself is
    // the closest real item to show.
    if (isArchivePath(target)) {
      const { archive } = splitArchivePath(target) as { archive: string }
      shell.showItemInFolder(archive)
      return
    }
    shell.showItemInFolder(target)
  })

  ipcMain.handle(
    'fs:rename',
    async (_event, source: string, target: string): Promise<Result<string>> => {
      try {
        if (typeof source !== 'string' || typeof target !== 'string') {
          return { ok: false, error: { code: 'EINVAL', message: 'Invalid rename arguments' } }
        }

        if (isArchivePath(source) || isArchivePath(target)) {
          return {
            ok: false,
            error: { code: 'ENOTSUP', message: 'Renaming inside an archive is not supported yet' }
          }
        }

        const from = path.resolve(source)
        const to = path.resolve(target)

        if (from === to) return { ok: true, data: to }

        if (from === path.parse(from).root) {
          return {
            ok: false,
            error: { code: 'EPERM', message: 'Refusing to rename a filesystem root' }
          }
        }

        // `rename` would silently clobber an existing target on POSIX, so make
        // the collision an error the pane can surface instead of data loss.
        try {
          await fs.lstat(to)
          return {
            ok: false,
            error: { code: 'EEXIST', message: `"${path.basename(to)}" already exists` }
          }
        } catch {
          // Target is free — proceed.
        }

        await fs.rename(from, to)
        return { ok: true, data: to }
      } catch (error) {
        return { ok: false, error: toFsError(error) }
      }
    }
  )

  /**
   * Make a directory for the pane the gesture was made in (F7). The name is
   * whatever the user typed: a plain folder name, or a path — absolute, or
   * relative to the pane's directory, exactly as the transfer dialogs resolve
   * their destination. Creation is deliberately *not* recursive: the gesture is
   * "make this directory", so a name that is already there (`EEXIST`) or one
   * whose parent is not (`ENOENT`) is the honest answer rather than something
   * papered over by making a chain of folders, and `recursive` would report an
   * existing directory as a silent success. The resolved directory that was made
   * is returned, so the pane can land its cursor on it.
   */
  ipcMain.handle(
    'fs:mkdir',
    async (_event, dir: string, name: string): Promise<Result<string>> => {
      if (typeof name !== 'string' || name.length === 0) {
        return { ok: false, error: { code: 'EINVAL', message: 'No directory name' } }
      }
      if (name.includes('\0')) {
        return { ok: false, error: { code: 'EINVAL', message: 'Invalid directory name' } }
      }

      if (isArchivePath(dir)) {
        return {
          ok: false,
          error: { code: 'ENOTSUP', message: 'Making a folder inside an archive is not supported yet' }
        }
      }

      // A relative name belongs to the pane the gesture was made in, not to the
      // process working directory — typing `sub` must mean `<pane>/sub`.
      const base =
        typeof dir === 'string' && dir.length > 0 ? path.resolve(dir) : process.cwd()
      const target = path.isAbsolute(name) ? path.resolve(name) : path.resolve(base, name)

      try {
        await fs.mkdir(target, { recursive: false })
        return { ok: true, data: target }
      } catch (error) {
        // A name that is already taken reads better named than quoted from the
        // machine's own `mkdir` failure, exactly as rename's collision does.
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          return {
            ok: false,
            error: { code: 'EEXIST', message: `"${path.basename(target)}" already exists` }
          }
        }
        return { ok: false, error: toFsError(error) }
      }
    }
  )

  ipcMain.handle(
    'fs:copy',
    async (
      _event,
      sources: string[],
      destination: string,
      baseDir: string
    ): Promise<Result<CopyOutcome>> => {
      if (typeof destination !== 'string' || destination.length === 0) {
        return { ok: false, error: { code: 'EINVAL', message: 'No destination directory' } }
      }
      if (!Array.isArray(sources)) {
        return { ok: false, error: { code: 'EINVAL', message: 'Invalid copy arguments' } }
      }

      if (sources.some((source) => isArchivePath(source)) || isArchivePath(destination)) {
        return {
          ok: false,
          error: { code: 'ENOTSUP', message: 'Copying into or out of an archive is not supported yet' }
        }
      }

      // A relative destination belongs to the pane being copied from, not to
      // the process working directory — typing `sub` must mean `<pane>/sub`.
      const base =
        typeof baseDir === 'string' && baseDir.length > 0 ? path.resolve(baseDir) : process.cwd()
      const dest = path.isAbsolute(destination)
        ? path.resolve(destination)
        : path.resolve(base, destination)

      const valid = sources.filter(
        (source): source is string => typeof source === 'string' && source.length > 0
      )

      // A trailing separator means "a directory", the way a shell reads it, and
      // is how one asks for a fresh folder when a single entry could also be a
      // rename.
      const forceDirectory = /[/\\]$/.test(destination)

      let destStats: Stats | null = null
      try {
        destStats = await fs.lstat(dest)
      } catch {
        destStats = null
      }

      // The destination is a directory to copy *into* when it already is one, or
      // when a path that does not exist yet can only be a folder because several
      // entries share it (a trailing separator asks for the same). Otherwise —
      // a single entry naming a path that is not a directory — it is the copy's
      // new name: `a.txt` -> `b.txt` copies to `b.txt`, rather than making a
      // `b.txt` folder and copying `a.txt` inside it. This mirrors `fs:move`.
      const intoDirectory =
        (destStats?.isDirectory() ?? false) ||
        (!destStats && (forceDirectory || valid.length > 1))

      if (intoDirectory && destStats && !destStats.isDirectory()) {
        return {
          ok: false,
          error: { code: 'ENOTDIR', message: `"${path.basename(dest)}" is not a directory` }
        }
      }

      if (!intoDirectory && valid.length > 1) {
        return {
          ok: false,
          error: {
            code: 'ENOTDIR',
            message: 'Copying several entries needs an existing destination directory'
          }
        }
      }

      // A folder destination the dialog named but that does not exist yet is
      // created, so typing a fresh folder name works instead of failing on a
      // missing parent.
      if (intoDirectory && !destStats) {
        try {
          await fs.mkdir(dest, { recursive: true })
        } catch (error) {
          return { ok: false, error: toFsError(error) }
        }
      }

      const destDir = intoDirectory ? dest : path.dirname(dest)
      const copied: string[] = []
      const failed: CopyFailure[] = []

      for (const source of valid) {
        const from = path.resolve(source)
        const to = intoDirectory ? path.join(dest, path.basename(from)) : dest

        try {
          // Never silently clobber: a name that already exists in the
          // destination is reported as a per-entry failure, exactly like
          // rename, so a copy can never overwrite data.
          try {
            await fs.lstat(to)
            failed.push({
              path: from,
              error: {
                code: 'EEXIST',
                message: intoDirectory
                  ? `"${path.basename(to)}" already exists in "${destDir}"`
                  : `"${path.basename(to)}" already exists`
              }
            })
            continue
          } catch {
            // Destination is free — proceed.
          }

          // A directory cannot be copied into itself or into one of its own
          // descendants: that would recurse without end.
          if (to.startsWith(from + path.sep)) {
            failed.push({
              path: from,
              error: { code: 'EINVAL', message: 'Cannot copy a directory into itself' }
            })
            continue
          }

          // `recursive` covers directories; symlinks are preserved rather than
          // followed, so a link is copied as a link.
          await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false })
          copied.push(to)
        } catch (error) {
          failed.push({ path: from, error: toFsError(error) })
        }
      }

      return { ok: true, data: { copied, failed, destination: destDir } }
    }
  )

  ipcMain.handle(
    'fs:move',
    async (
      _event,
      sources: string[],
      destination: string,
      baseDir: string
    ): Promise<Result<MoveOutcome>> => {
      if (typeof destination !== 'string' || destination.length === 0) {
        return { ok: false, error: { code: 'EINVAL', message: 'No destination directory' } }
      }
      if (!Array.isArray(sources)) {
        return { ok: false, error: { code: 'EINVAL', message: 'Invalid move arguments' } }
      }

      if (sources.some((source) => isArchivePath(source)) || isArchivePath(destination)) {
        return {
          ok: false,
          error: { code: 'ENOTSUP', message: 'Moving into or out of an archive is not supported yet' }
        }
      }

      // A relative destination belongs to the pane being moved from, exactly as
      // for copy: typing `sub` must mean `<pane>/sub`.
      const base =
        typeof baseDir === 'string' && baseDir.length > 0 ? path.resolve(baseDir) : process.cwd()
      const dest = path.isAbsolute(destination)
        ? path.resolve(destination)
        : path.resolve(base, destination)

      const valid = sources.filter(
        (source): source is string => typeof source === 'string' && source.length > 0
      )

      // A trailing separator means "a directory", the way a shell reads it, and
      // is how one asks for a fresh folder when a single entry could also be a
      // rename.
      const forceDirectory = /[/\\]$/.test(destination)

      let destStats: Stats | null = null
      try {
        destStats = await fs.lstat(dest)
      } catch {
        destStats = null
      }

      // The destination is a directory to move *into* when it already is one, or
      // when a path that does not exist yet can only be a folder because several
      // entries share it (a trailing separator asks for the same). Otherwise —
      // a single entry naming a path that is not a directory — it is the entry's
      // new name: `blah` -> `blah2` renames, rather than making a `blah2` folder
      // and moving `blah` inside it.
      const intoDirectory =
        (destStats?.isDirectory() ?? false) ||
        (!destStats && (forceDirectory || valid.length > 1))

      if (intoDirectory && destStats && !destStats.isDirectory()) {
        return {
          ok: false,
          error: { code: 'ENOTDIR', message: `"${path.basename(dest)}" is not a directory` }
        }
      }

      if (!intoDirectory && valid.length > 1) {
        return {
          ok: false,
          error: {
            code: 'ENOTDIR',
            message: 'Moving several entries needs an existing destination directory'
          }
        }
      }

      // A folder destination the dialog named but that does not exist yet is
      // created, so typing a fresh folder name works instead of failing on a
      // missing parent.
      if (intoDirectory && !destStats) {
        try {
          await fs.mkdir(dest, { recursive: true })
        } catch (error) {
          return { ok: false, error: toFsError(error) }
        }
      }

      const destDir = intoDirectory ? dest : path.dirname(dest)
      const moved: string[] = []
      const failed: MoveFailure[] = []

      for (const source of valid) {
        const from = path.resolve(source)
        const to = intoDirectory ? path.join(dest, path.basename(from)) : dest

        // Moving an entry to where it already is leaves it where it is.
        if (from === to) continue

        if (from === path.parse(from).root) {
          failed.push({
            path: from,
            error: { code: 'EPERM', message: 'Refusing to move a filesystem root' }
          })
          continue
        }

        try {
          // Never silently clobber: an existing name is a per-entry failure,
          // exactly like copy and rename.
          try {
            await fs.lstat(to)
            failed.push({
              path: from,
              error: {
                code: 'EEXIST',
                message: intoDirectory
                  ? `"${path.basename(to)}" already exists in "${destDir}"`
                  : `"${path.basename(to)}" already exists`
              }
            })
            continue
          } catch {
            // Destination is free — proceed.
          }

          // A directory cannot be moved into itself or into one of its own
          // descendants.
          if (to.startsWith(from + path.sep)) {
            failed.push({
              path: from,
              error: { code: 'EINVAL', message: 'Cannot move a directory into itself' }
            })
            continue
          }

          try {
            await fs.rename(from, to)
          } catch (error) {
            // rename cannot cross filesystems (EXDEV); fall back to copy and
            // only remove the source once the copy has finished.
            if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
              await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false })
              await fs.rm(from, { recursive: true, force: false })
            } else {
              throw error
            }
          }

          moved.push(to)
        } catch (error) {
          failed.push({ path: from, error: toFsError(error) })
        }
      }

      return { ok: true, data: { moved, failed, destination: destDir } }
    }
  )

  ipcMain.handle(
    'fs:delete',
    async (_event, targets: string[]): Promise<Result<DeleteOutcome>> => {
      const deleted: string[] = []
      const failed: DeleteFailure[] = []

      if (targets.some((target) => typeof target === 'string' && isArchivePath(target))) {
        return {
          ok: false,
          error: { code: 'ENOTSUP', message: 'Deleting inside an archive is not supported yet' }
        }
      }

      for (const target of targets) {
        if (typeof target !== 'string' || target.length === 0) continue
        const resolved = path.resolve(target)
        if (resolved === path.parse(resolved).root) {
          failed.push({
            path: resolved,
            error: { code: 'EPERM', message: 'Refusing to delete a filesystem root' }
          })
          continue
        }
        try {
          // `recursive` handles directories; `force: false` keeps a missing or
          // protected path an error instead of a silent success.
          await fs.rm(resolved, { recursive: true, force: false })
          deleted.push(resolved)
        } catch (error) {
          failed.push({ path: resolved, error: toFsError(error) })
        }
      }

      return { ok: true, data: { deleted, failed } }
    }
  )

  ipcMain.handle(
    'fs:hide-add',
    async (_event, dir: string, name: string): Promise<Result<string>> => {
      if (typeof dir !== 'string' || dir.length === 0 || typeof name !== 'string') {
        return { ok: false, error: { code: 'EINVAL', message: 'No entry to hide' } }
      }

      if (isArchivePath(dir)) {
        return {
          ok: false,
          error: { code: 'ENOTSUP', message: 'A hide list inside an archive is not supported yet' }
        }
      }

      // The file lists one name per line, so a name that is empty or spans lines
      // cannot be spelled in it: refusing is better than writing a line that hides
      // a different entry — or nothing at all.
      if (name.trim() === '' || /[\r\n]/.test(name)) {
        return {
          ok: false,
          error: { code: 'EINVAL', message: `"${name}" cannot be listed in ${HIDE_MARKER}` }
        }
      }

      try {
        return { ok: true, data: await addHiddenName(dir, name) }
      } catch (error) {
        return { ok: false, error: toFsError(error) }
      }
    }
  )

  ipcMain.handle(
    'fs:hide-remove',
    async (_event, dir: string, name: string): Promise<Result<string>> => {
      if (typeof dir !== 'string' || dir.length === 0 || typeof name !== 'string') {
        return {
          ok: false,
          error: { code: 'EINVAL', message: 'No entry to take out of the hide list' }
        }
      }

      if (isArchivePath(dir)) {
        return {
          ok: false,
          error: { code: 'ENOTSUP', message: 'A hide list inside an archive is not supported yet' }
        }
      }

      // The same refusal as the write: a name that cannot be spelled in this
      // format cannot be in it either, so there is nothing to take out.
      if (name.trim() === '' || /[\r\n]/.test(name)) {
        return {
          ok: false,
          error: { code: 'EINVAL', message: `"${name}" cannot be listed in ${HIDE_MARKER}` }
        }
      }

      try {
        return { ok: true, data: await removeHiddenName(dir, name) }
      } catch (error) {
        return { ok: false, error: toFsError(error) }
      }
    }
  )
}
