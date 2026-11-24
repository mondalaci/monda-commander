import { createReadStream, promises as fs, type Stats } from 'node:fs'
import { Readable } from 'node:stream'
import { spawn, type ChildProcess } from 'node:child_process'
import { ipcMain, protocol } from 'electron'
import { audioMimeFor } from '@shared/audio'
import {
  codecNeedsTranscode,
  MEDIA_SCHEME,
  needsTranscode,
  videoCodecSniffable,
  videoMimeFor
} from '@shared/video'
import { videoCodecOf } from './videoCodec'

/**
 * A range of bytes a media element asked for.
 */
interface ByteRange {
  start: number
  end: number
}

/**
 * Where ffmpeg is looked for. Beside `PATH`, an explicit path can be given, for
 * a machine that keeps it somewhere the app's environment does not.
 */
const FFMPEG = process.env['MC_FFMPEG'] ?? 'ffmpeg'

/** Where ffprobe is looked for, which is what can say how long a clip is. */
const FFPROBE = process.env['MC_FFPROBE'] ?? 'ffprobe'

/**
 * How wide a transcoded clip's output may be. A 4K source is encoded at 720px at
 * most, which the panes scale down anyway, and the width is what keeps the
 * encode small enough to keep ahead of playback.
 */
const TRANSCODE_MAX_WIDTH = 720

/**
 * How long an encode may go unread before it is stopped, and how often that is
 * looked at. An encode writes as fast as it can and is read only as fast as the
 * clip is played, so it spends its life with a full pipe: what this catches is a
 * response the element has walked away from, whose frames nobody is coming back
 * for. Chromium holds a media response open for a while after the element that
 * asked for it has gone, so the process cannot rely on the request being
 * cancelled to know that it is finished with.
 */
const TRANSCODE_IDLE_MS = 30_000
const TRANSCODE_IDLE_CHECK_MS = 5_000

/**
 * The scheme a video preview streams through, registered before the app is
 * ready (Electron requires it then). `stream` is what makes a response a stream
 * the media stack reads incrementally rather than one buffered body, and
 * `standard` gives the scheme the URL parsing a media element expects.
 */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true }
    }
  ])
}

/**
 * Where a request asked a transcode to start, in seconds: a whole number of them
 * or a fraction, and never negative. Anything else — an absent parameter, a
 * blank one, a word — means the beginning.
 */
function startOffsetFromUrl(url: URL): number {
  const from = Number.parseFloat(url.searchParams.get('from') ?? '')
  return Number.isFinite(from) && from > 0 ? from : 0
}

/**
 * The requested file, or null if the URL does not name one. The path travels in
 * a query parameter rather than as the pathname: a `standard` scheme's pathname
 * is normalised and percent-decoded by the URL parser, which mangles an
 * absolute path (`//`, `%2F`, and friends) often enough to not risk it.
 */
function mediaPathFromUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const target = parsed.searchParams.get('path')
  return target !== null && target.startsWith('/') ? target : null
}

/**
 * A single `bytes=` range, or null when the header is absent or does not
 * describe a satisfiable range (the caller answers 416 for a present header).
 */
function parseRange(header: string | null, size: number): ByteRange | null {
  if (header === null) return null

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null

  const [, rawStart = '', rawEnd = ''] = match
  if (rawStart === '' && rawEnd === '') return null

  let start: number
  let end: number
  if (rawStart === '') {
    // A suffix range: the last N bytes, which is how a player finds a `moov`
    // atom queued at the end of the file.
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start < 0 || start > end || start >= size) return null
  return { start, end }
}

/**
 * Serve a file on disk as a byte stream, honouring Range requests — which is
 * what lets a status bar play a hundred-megabyte file: the media element asks
 * for the metadata and then for the bytes it plays, and nothing else is read.
 */
function serveFile(
  target: string,
  mime: string,
  size: number,
  rangeHeader: string | null,
  method: string
): Response {
  const range = parseRange(rangeHeader, size)
  if (rangeHeader !== null && range === null) {
    return new Response('Range not satisfiable', {
      status: 416,
      headers: { 'Content-Range': `bytes */${size}` }
    })
  }

  const head = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    // A preview is of a file the user is looking at right now, and it can change
    // under us; nothing here is worth a cache.
    'Cache-Control': 'no-store'
  }

  if (size === 0) return new Response(null, { status: 200, headers: head })

  const body = (start: number, end: number): ReadableStream =>
    Readable.toWeb(createReadStream(target, { start, end })) as ReadableStream

  if (range === null) {
    const headers = { ...head, 'Content-Length': String(size) }
    if (method === 'HEAD') return new Response(null, { status: 200, headers })
    return new Response(body(0, size - 1), { status: 200, headers })
  }

  const headers = {
    ...head,
    'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
    'Content-Length': String(range.end - range.start + 1)
  }
  if (method === 'HEAD') return new Response(null, { status: 206, headers })
  return new Response(body(range.start, range.end), { status: 206, headers })
}

/**
 * Whether ffmpeg is there to transcode with. Asked once and remembered: the
 * answer decides whether the containers Chromium cannot demux are previewable
 * at all, and a missing binary is not going to appear mid-session.
 */
let available: Promise<boolean> | null = null

export function ffmpegAvailable(): Promise<boolean> {
  if (available !== null) return available
  available = new Promise<boolean>((resolve) => {
    const child = spawn(FFMPEG, ['-version'], { stdio: 'ignore' })
    child.once('error', () => resolve(false))
    child.once('close', (code) => resolve(code === 0))
  })
  return available
}

const children = new Set<ChildProcess>()

/**
 * Serve a clip Chromium cannot play, encoded as it is watched.
 *
 * The encode is a *stream*, from `from` to the end of the file — not a clip cut
 * short, and not something finished before it is played. A feature-length file
 * is something to watch, so it starts in a fraction of a second like anything
 * else, and nothing is written to disk: a two-hour encode is not something to
 * keep. The sound is encoded with it, because the display is watched *and*
 * heard; the footer's thumbnail is muted by the element that plays it.
 *
 * `from` is also the whole of seeking. A live stream reports no range to move
 * within, so there is nothing for the element to seek *to*: the way to move
 * about the clip is to ask for the stream again at the position wanted, which is
 * what `from` is for. The element counts from the start of whatever it was
 * given — a stream is rebased to zero however its timestamps are written — so
 * the pane that asked for it adds the offset back on to say where the clip is.
 */
function serveTranscode(target: string, from: number, method: string): Response {
  const child = spawn(
    FFMPEG,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      // Seeking to the position before reading, so the stream is the clip from
      // `from` onwards.
      '-ss',
      String(from),
      '-i',
      target,
      // The audio travels with it: a footer thumbnail is muted by the element
      // that plays it, but a display is watched and heard, and a clip stripped
      // of its sound here could never be heard there.
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-vf',
      `scale='min(${TRANSCODE_MAX_WIDTH},iw)':-2`,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '26',
      '-pix_fmt',
      'yuv420p',
      // A keyframe often enough that the first playable fragment arrives within
      // a fraction of a second, and a fragmented file so later fragments can
      // follow it down the same response.
      '-g',
      '30',
      '-movflags',
      '+empty_moov+default_base_moof+frag_keyframe',
      '-flush_packets',
      '1',
      '-f',
      'mp4',
      '-'
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  )
  children.add(child)

  // Nothing is ever read from an encode nobody is watching, so its pipe fills
  // and stays full: a reader that has moved on is a queue that stops changing.
  let queued = -1
  let lastProgress = Date.now()
  const reaper = setInterval(() => {
    const length = child.stdout?.readableLength ?? 0
    if (length !== queued) {
      queued = length
      lastProgress = Date.now()
      return
    }
    if (Date.now() - lastProgress >= TRANSCODE_IDLE_MS) child.kill('SIGKILL')
  }, TRANSCODE_IDLE_CHECK_MS)

  child.once('close', () => {
    clearInterval(reaper)
    children.delete(child)
  })

  const head = { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' }
  if (method === 'HEAD' || child.stdout === null) {
    child.kill('SIGKILL')
    return new Response(null, { status: 200, headers: head })
  }

  // No length and no ranges: what is on its way is not a file, and a player
  // handed a growing stream plays it as one. The element going away closes this,
  // which is what stops the encode.
  return new Response(Readable.toWeb(child.stdout) as ReadableStream, {
    status: 200,
    headers: head
  })
}

/**
 * Stop every encode still running. Called as the app quits, so an encode cannot
 * outlive the window that was watching it.
 */
export function killAllTranscodes(): void {
  for (const child of children) child.kill('SIGKILL')
  children.clear()
  durations.clear()
}

/** How long a preview of each file is, by the identity of the file. */
const durations = new Map<string, number | null>()

/**
 * How long the clip a preview will play is: the file's own length, or as much of
 * read by ffprobe rather than off the element: a clip main has to encode arrives
 * as a live stream, and a stream has no length to report until it is over. Null
 * when nothing can say.
 */
async function videoDuration(target: string): Promise<number | null> {
  let stats: Stats
  try {
    stats = await fs.stat(target)
    if (!stats.isFile()) return null
  } catch {
    return null
  }

  const key = `${target}\u0000${stats.mtimeMs}:${stats.size}`
  const known = durations.get(key)
  if (known !== undefined) return known

  const child = spawn(
    FFPROBE,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', target],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  )
  children.add(child)

  let printed = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    printed = (printed + chunk.toString()).slice(-64)
  })

  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    child.once('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.once('close', (status) => {
      clearTimeout(timer)
      resolve(status)
    })
  })
  children.delete(child)

  const seconds = Number.parseFloat(printed.trim())
  const length = code === 0 && Number.isFinite(seconds) && seconds > 0 ? seconds : null

  durations.set(key, length)
  return length
}

/**
 * Answer whether this build can transcode, which is what decides whether a
 * container Chromium has nothing for is previewable at all — and, since only
 * such a clip needs its length asked of it, what it can say about durations.
 * Beside it, what the stream inside a container Chromium *does* demux is: the
 * one question a name cannot answer, and the one that keeps a phone's HEVC
 * `.mp4` from being served as a file nothing can decode.
 */
export function registerMediaHandlers(): void {
  ipcMain.handle('fs:can-transcode', () => ffmpegAvailable())
  ipcMain.handle('fs:video-codec', async (_event, target: string): Promise<string | null> => {
    if (typeof target !== 'string' || target.length === 0) return null
    if (!videoCodecSniffable(target)) return null
    return videoCodecOf(target)
  })
  ipcMain.handle('fs:video-duration', async (_event, target: string): Promise<number | null> => {
    if (typeof target !== 'string' || target.length === 0) return null
    if (!(await ffmpegAvailable())) return null
    try {
      return await videoDuration(target)
    } catch {
      return null
    }
  })
}

/**
 * The encode part of serving a preview: refused when there is no ffmpeg to do
 * it with, and otherwise the clip from the position asked for to its end.
 */
async function serveEncoded(target: string, method: string, url: URL): Promise<Response> {
  if (!(await ffmpegAvailable())) {
    return new Response('No transcoder available', { status: 501 })
  }

  // A position past the end would be a stream with nothing in it, so the
  // length is asked of the file — once per file, and only when a request
  // arrives with a position in it at all.
  const wanted = startOffsetFromUrl(url)
  const length = wanted > 0 ? await videoDuration(target) : null
  const from = length !== null ? Math.min(wanted, Math.max(0, length - 0.25)) : wanted
  return serveTranscode(target, from, method)
}

/**
 * Serve a previewable video or audio clip. A file Chromium demuxes *and* decodes
 * goes over as its own bytes, ranged; a video only ffmpeg can make playable is
 * transcoded first, and refused outright when there is no ffmpeg to do it with.
 * Either way only regular files with a previewable extension are served, so this
 * cannot be turned into a reader for anything the bar would not have offered.
 *
 * Audio is always served as its own bytes: a container the element's audio stack
 * decodes needs no encode, and one it does not is not audio at all (see
 * `audioMimeFor`). A clip's picture is what needs transcoding, not its sound.
 */
export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const target = mediaPathFromUrl(request.url)
    if (target === null) return new Response('Bad request', { status: 400 })

    const audioMime = audioMimeFor(target)
    const mime = videoMimeFor(target)
    // Whether the extension alone names a container Chromium has nothing for,
    // which needs no reading to know: nothing inside it could be playable.
    const byExtension = mime === null
    if (audioMime === null && byExtension && !needsTranscode(target)) {
      return new Response('Not previewable', { status: 403 })
    }

    let stats: Stats
    try {
      stats = await fs.stat(target)
      if (!stats.isFile()) return new Response('Not a file', { status: 403 })
    } catch {
      return new Response('Not found', { status: 404 })
    }

    // An audio file is a whole file the element's own audio stack decodes, so it
    // is ranged and served as it stands — the same bytes a player would read.
    if (audioMime !== null) {
      return serveFile(target, audioMime, stats.size, request.headers.get('range'), request.method)
    }

    // A container Chromium demuxes is still not on its own playable: the stream
    // inside it has to be one Chromium decodes, and only ITS header can say so —
    // a phone's `.mp4` is HEVC as often as it is H.264, and the HEVC plays its
    // sound over a black picture. Only the containers that can hold such a
    // stream are read; the rest carry what Chromium's own parsers were written
    // for, and are served as they stand.
    const encode =
      byExtension ||
      (videoCodecSniffable(target) && codecNeedsTranscode(await videoCodecOf(target)))
    if (encode) return serveEncoded(target, request.method, new URL(request.url))

    return serveFile(target, mime, stats.size, request.headers.get('range'), request.method)
  })
}
