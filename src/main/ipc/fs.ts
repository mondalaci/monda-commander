import { constants as fsConstants, promises as fs, type Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ipcMain, nativeImage, shell } from 'electron'
import { HIDE_MARKER } from '@shared/hide'
import { imageMimeFor } from '@shared/image'
import { readImageSize } from '../imageSize'
import type {
  CopyFailure,
  CopyOutcome,
  DeleteFailure,
  DeleteOutcome,
  DirEntry,
  DirListing,
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

export function registerFsHandlers(): void {
  ipcMain.handle('fs:home', () => os.homedir())

  ipcMain.handle('fs:list', async (_event, dir: string): Promise<Result<DirListing>> => {
    try {
      return { ok: true, data: await listDirectory(dir) }
    } catch (error) {
      return { ok: false, error: toFsError(error) }
    }
  })

  ipcMain.handle('fs:open', async (_event, target: string) => {
    return shell.openPath(target)
  })

  ipcMain.handle('fs:read', async (_event, target: string): Promise<Result<FileContent>> => {
    if (typeof target !== 'string' || target.length === 0) {
      return { ok: false, error: { code: 'EINVAL', message: 'No file to read' } }
    }
    try {
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
      return { ok: true, data: await readImageForPreview(target) }
    } catch (error) {
      return { ok: false, error: toFsError(error) }
    }
  })

  ipcMain.handle('fs:image-size', async (_event, target: string): Promise<PixelSize | null> => {
    if (typeof target !== 'string' || target.length === 0) return null
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
    shell.showItemInFolder(target)
  })

  ipcMain.handle(
    'fs:rename',
    async (_event, source: string, target: string): Promise<Result<string>> => {
      try {
        if (typeof source !== 'string' || typeof target !== 'string') {
          return { ok: false, error: { code: 'EINVAL', message: 'Invalid rename arguments' } }
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
}
