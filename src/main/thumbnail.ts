import { promises as fs, type Stats } from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { ipcMain, nativeImage } from 'electron'
import { isArchivePath, splitArchivePath } from '@shared/archive'
import { imageMimeFor } from '@shared/image'
import { needsTranscode, videoMimeFor } from '@shared/video'
import { readArchiveEntry } from './archive'
import { ffmpegAvailable } from './media'
import type { ImagePreview, Result } from '@shared/types'

/**
 * The tiles a pane's thumbnail view draws, read from main rather than the
 * renderer: a picture has no URL the renderer could use, so its bytes travel as
 * a `data:` URL — but a *tile* of it, not the picture. The status-bar preview's
 * own read hands a small file over whole (up to 16 MiB), which is right for one
 * box and ruinous for a wall of sixty, so a thumbnail is always decoded and
 * shrunk to a fixed longest side, however small the source was.
 *
 * Only the local machine answers here. A remote target's relay has no resize
 * step, so `thumbnail` on one refuses and the pane draws the entry's icon
 * instead (see targetApi.ts).
 */

/**
 * The longest side a thumbnail is drawn at. A cell is around 100px on a 1x
 * display and 200 on a 2x one, so this is crisp at twice the size it is shown
 * and still small enough that a screenful is a few megabytes.
 */
const THUMB_DEFAULT_DIM = 320
const THUMB_MAX_DIM = 512

/**
 * The most a source file may be before its bytes are refused rather than read
 * to decode. A picture past this is not one a tile is worth reading whole; the
 * same ceiling the preview read uses.
 */
const THUMB_SOURCE_MAX_BYTES = 64 * 1024 * 1024

/** The most an image with no decoder — an SVG — may travel as its own bytes. */
const THUMB_RAW_MAX_BYTES = 2 * 1024 * 1024

/**
 * The rendered tiles a session keeps. Scrolling back over a wall, and a tile
 * asked for again after a resize, re-visit the same reads; the key carries the
 * file's size and mtime as well as the requested dimension, so a rewrite on disk
 * misses it and a tile and a footer asking for different sizes do not collide.
 */
const THUMB_CACHE_MAX_BYTES = 48 * 1024 * 1024
const THUMB_CACHE_MAX_ENTRIES = 512

const thumbCache = new Map<string, { dataUrl: string; bytes: number }>()

function identityOf(target: string, stats: Stats, max: number): string {
  return `${target}\u0000${stats.mtimeMs}:${stats.size}:${max}`
}

function readThumbCache(key: string): string | null {
  const hit = thumbCache.get(key)
  if (!hit) return null
  // Re-insert so the map's order stays least-recently-used first.
  thumbCache.delete(key)
  thumbCache.set(key, hit)
  return hit.dataUrl
}

function writeThumbCache(key: string, dataUrl: string): void {
  if (dataUrl.length > THUMB_CACHE_MAX_BYTES) return

  thumbCache.delete(key)
  thumbCache.set(key, { dataUrl, bytes: dataUrl.length })

  let total = 0
  for (const entry of thumbCache.values()) total += entry.bytes

  while (total > THUMB_CACHE_MAX_BYTES || thumbCache.size > THUMB_CACHE_MAX_ENTRIES) {
    const oldest = thumbCache.keys().next()
    if (oldest.done) break
    total -= thumbCache.get(oldest.value)?.bytes ?? 0
    thumbCache.delete(oldest.value)
  }
}

/** Hold a requested dimension to something a tile can use. */
function clampDim(max: unknown): number {
  const wanted = typeof max === 'number' && Number.isFinite(max) ? Math.floor(max) : THUMB_DEFAULT_DIM
  return Math.min(THUMB_MAX_DIM, Math.max(32, wanted))
}

/**
 * Shrink an image's bytes to `max` on the longest side. A format the decoder
 * cannot open — an SVG, whose rendering is the browser's job — falls back to its
 * own bytes when they are small enough to hand over, which the renderer draws
 * anyway; anything else is refused.
 */
function shrinkImage(bytes: Buffer, mime: string, max: number): string {
  const image = nativeImage.createFromBuffer(bytes)
  if (image.isEmpty()) {
    if (bytes.length <= THUMB_RAW_MAX_BYTES) {
      return `data:${mime};base64,${bytes.toString('base64')}`
    }
    throw Object.assign(new Error('This image is too large to thumbnail'), { code: 'E2BIG' })
  }

  const { width, height } = image.getSize()
  const longest = Math.max(width, height)
  if (longest <= 0) throw Object.assign(new Error('Empty image'), { code: 'EINVAL' })
  if (longest <= max) return image.toDataURL()

  const scale = max / longest
  return image
    .resize({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale))
    })
    .toDataURL()
}

/** A tile of an image file on disk. */
async function imageThumbnail(input: string, max: number): Promise<ImagePreview> {
  const target = path.resolve(input)
  const mime = imageMimeFor(target)
  if (!mime) {
    throw Object.assign(new Error(`"${path.basename(target)}" is not a supported image`), {
      code: 'EINVAL'
    })
  }

  const stats = await fs.stat(target)
  if (!stats.isFile()) {
    throw Object.assign(new Error(`"${path.basename(target)}" is not a regular file`), {
      code: 'EINVAL'
    })
  }
  if (stats.size > THUMB_SOURCE_MAX_BYTES) {
    throw Object.assign(new Error(`"${path.basename(target)}" is too large to thumbnail`), {
      code: 'E2BIG'
    })
  }

  const key = identityOf(target, stats, max)
  const cached = readThumbCache(key)
  if (cached !== null) return { dataUrl: cached }

  const bytes = await fs.readFile(target)
  const dataUrl = shrinkImage(bytes, mime, max)
  writeThumbCache(key, dataUrl)
  return { dataUrl }
}

/** A tile of an image entry held inside an archive. */
async function archiveImageThumbnail(input: string, max: number): Promise<ImagePreview> {
  const { archive, inner } = splitArchivePath(input) as { archive: string; inner: string }
  const name = inner.slice(inner.lastIndexOf('/') + 1)
  const mime = imageMimeFor(name)
  if (!mime) {
    throw Object.assign(new Error(`"${name}" is not a supported image`), { code: 'EINVAL' })
  }

  const stats = await fs.stat(path.resolve(archive))
  const key = identityOf(`${path.resolve(archive)}\u0000${inner}`, stats, max)
  const cached = readThumbCache(key)
  if (cached !== null) return { dataUrl: cached }

  const bytes = await readArchiveEntry(archive, inner, THUMB_SOURCE_MAX_BYTES)
  const dataUrl = shrinkImage(bytes, mime, max)
  writeThumbCache(key, dataUrl)
  return { dataUrl }
}

const posterChildren = new Set<ChildProcess>()

/** Stop every poster still running, as the app quits. */
export function killAllThumbnails(): void {
  for (const child of posterChildren) child.kill('SIGKILL')
  posterChildren.clear()
}

/**
 * One frame of a clip, as a JPEG, through ffmpeg. The frame is taken a second
 * in by preference — the opening frame of a recording is often black, a title
 * card or a fade — and from the very start when the clip is shorter than that
 * (ffmpeg then finds no frame at the offset and produces nothing). `-ss` before
 * `-i` makes the seek fast; the output goes to standard output as image data
 * rather than a temp file, and nothing is written to disk.
 *
 * No ffmpeg means no poster: the caller refuses and the tile keeps its icon,
 * exactly as a clip Chromium cannot play is simply not previewed elsewhere.
 */
function ffmpegPoster(target: string, at: number, max: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const child = spawn(
      process.env['MC_FFMPEG'] ?? 'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-ss',
        String(at),
        '-i',
        target,
        '-frames:v',
        '1',
        '-vf',
        `scale='min(${max},iw)':-2`,
        '-f',
        'image2pipe',
        '-vcodec',
        'mjpeg',
        '-'
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    )
    posterChildren.add(child)

    const chunks: Buffer[] = []
    let size = 0
    child.stdout?.on('data', (chunk: Buffer) => {
      // A poster is a tile's worth, not a film: stop reading a runaway one.
      if (size > 8 * 1024 * 1024) return
      chunks.push(chunk)
      size += chunk.length
    })

    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    const done = (buffer: Buffer | null): void => {
      clearTimeout(timer)
      posterChildren.delete(child)
      resolve(buffer)
    }

    child.once('error', () => done(null))
    child.once('close', (code) => done(code === 0 && size > 0 ? Buffer.concat(chunks) : null))
  })
}

/** A poster frame of a video file on disk. */
async function videoThumbnail(target: string, max: number): Promise<ImagePreview> {
  if (!(await ffmpegAvailable())) {
    throw Object.assign(new Error('No transcoder available for a video thumbnail'), {
      code: 'ENOTSUP'
    })
  }

  const stats = await fs.stat(target)
  if (!stats.isFile()) {
    throw Object.assign(new Error(`"${path.basename(target)}" is not a regular file`), {
      code: 'EINVAL'
    })
  }

  const key = identityOf(target, stats, max)
  const cached = readThumbCache(key)
  if (cached !== null) return { dataUrl: cached }

  const png = (await ffmpegPoster(target, 1, max)) ?? (await ffmpegPoster(target, 0, max))
  if (png === null || png.length === 0) {
    throw Object.assign(new Error(`Could not read a frame from "${path.basename(target)}"`), {
      code: 'ERENDER'
    })
  }

  const dataUrl = `data:image/jpeg;base64,${png.toString('base64')}`
  writeThumbCache(key, dataUrl)
  return { dataUrl }
}

function toFsError(error: unknown): { code: string; message: string } {
  const err = error as NodeJS.ErrnoException
  return { code: err.code ?? 'EUNKNOWN', message: err.message || 'Unknown thumbnail error' }
}

/**
 * Which reader answers for a target, by its name: the same extension maps the
 * renderer decided to ask by. A name that is neither an image nor a clip is
 * refused, so a caller cannot turn this into a reader for anything else.
 */
function isVideoName(name: string): boolean {
  return videoMimeFor(name) !== null || needsTranscode(name)
}

export function registerThumbnailHandlers(): void {
  ipcMain.handle(
    'fs:thumbnail',
    async (_event, target: string, max: number): Promise<Result<ImagePreview>> => {
      if (typeof target !== 'string' || target.length === 0) {
        return { ok: false, error: { code: 'EINVAL', message: 'No file to thumbnail' } }
      }

      const name = isArchivePath(target)
        ? (splitArchivePath(target) as { inner: string }).inner.split('/').pop() ?? ''
        : path.basename(target)
      const dim = clampDim(max)

      try {
        if (imageMimeFor(name)) {
          return {
            ok: true,
            data: isArchivePath(target)
              ? await archiveImageThumbnail(target, dim)
              : await imageThumbnail(target, dim)
          }
        }
        // A clip inside an archive is not a stream on disk to read a frame from.
        if (!isArchivePath(target) && isVideoName(name)) {
          return { ok: true, data: await videoThumbnail(target, dim) }
        }
        return {
          ok: false,
          error: { code: 'EINVAL', message: `"${name}" has no thumbnail` }
        }
      } catch (error) {
        return { ok: false, error: toFsError(error) }
      }
    }
  )
}
