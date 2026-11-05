import { ref } from 'vue'
import { isArchivePath } from '@shared/archive'
import { imageMimeFor } from '@shared/image'
import { isPdfName } from '@shared/pdf'
import {
  codecNeedsTranscode,
  needsTranscode,
  videoCodecSniffable,
  videoMimeFor
} from '@shared/video'
import type { PaneEntry } from '@renderer/composables/useDirectory'

/**
 * Whether main can transcode what Chromium cannot play itself. Until the answer
 * is in, those files are not treated as previewable at all — which is also the
 * answer when ffmpeg is missing, and what keeps Enter opening such a file in the
 * system's own player rather than displaying nothing.
 */
const transcode = ref(false)

export function canTranscodePreview(): boolean {
  return transcode.value
}

/** Ask main once, early, so the answer is there before a cursor lands on a file. */
export async function loadTranscodeSupport(): Promise<void> {
  transcode.value = await window.mc.fs.canTranscode()
}

/**
 * Whether main can rasterize a PDF page in-app. Like transcode support, this has
 * to be known before a cursor lands: until it is, a PDF is not media at all, and
 * with no poppler on the machine that is the answer for good — Enter opens it
 * with the system's own viewer instead.
 */
const renderPdf = ref(false)

export function canRenderPdfPreview(): boolean {
  return renderPdf.value
}

/** Ask main once, early, so the answer is there before a cursor lands on a `.pdf`. */
export async function loadPdfSupport(): Promise<void> {
  renderPdf.value = await window.mc.fs.canRenderPdf()
}

/** What a pane can show of the cursor's row: an image, a video, or a PDF page. */
export type PreviewKind = 'image' | 'video' | 'pdf'

/**
 * The video codec inside a container Chromium demuxes, by the identity of the
 * file whose header it was read from. A name can say a file is a video and which
 * container it is in, but not which stream is inside it: an `.mp4` is HEVC as
 * often as it is H.264, and HEVC is not something Chromium decodes here — the
 * format's only decoder is the platform one, which is the hardware decoder this
 * app turns off — so it has to be asked of the file, and only a header read can
 * tell. Absent means not asked yet, and null means the header did not say; a
 * `ref` over the map so that an answer arriving for a row the cursor is already
 * on re-derives what to show for it.
 */
const videoCodecs = ref<Map<string, string | null>>(new Map())

/** The files whose codec is being asked for, so a row reached twice asks once. */
const probing = new Set<string>()

/** How a file is identified for the caches: its content, not merely its path. */
function identityOf(path: string, size: number, mtimeMs: number): string {
  return `${path}\u0000${size}:${mtimeMs}`
}

/** The codec already read for an entry, or undefined while it has not been asked. */
function codecOf(entry: PaneEntry): string | null | undefined {
  return videoCodecs.value.get(identityOf(entry.path, entry.size, entry.mtimeMs))
}

/**
 * Ask the file itself which stream it holds, for the one case no name can
 * answer: a container whose extension says "video" whatever is inside it. It is
 * cheap enough to be issued on the cursor move rather than with the read — a
 * header read in main, no decode — which is what has the answer in hand before
 * the settle lets the element fetch anything.
 */
export function probeVideoCodec(target: PreviewTarget | null): void {
  if (target === null || target.kind !== 'video' || target.encode) return
  if (!videoCodecSniffable(target.name)) return

  const identity = identityOf(target.path, target.size, target.mtimeMs)
  if (videoCodecs.value.has(identity) || probing.has(identity)) return

  probing.add(identity)
  void window.mc.fs.videoCodec(target.path).then((codec) => {
    probing.delete(identity)
    videoCodecs.value.set(identity, codec)
  })
}

/**
 * What an entry is previewable as, or null when it is not media at all. The
 * shared extension maps are what main reads, streams and transcodes by, so a
 * pane only ever asks for something it can be given — the one thing they cannot
 * say being what stream a container of Chromium's is holding.
 */
export function previewKindFor(entry: PaneEntry): PreviewKind | null {
  if (imageMimeFor(entry.name)) return 'image'

  // A video inside an archive is not streamable: the ranged stream serves a real
  // file on disk, and an entry is not one. An image still previews, since it
  // travels as a data URL main can extract — so only the video answer is given up.
  // A PDF is rendered from a real file too, so it goes with the video.
  if (isArchivePath(entry.path)) return null

  // A PDF is media only where main has poppler to rasterize a page; without it,
  // the file is an ordinary one and Enter opens it with the system's viewer.
  if (isPdfName(entry.name)) return canRenderPdfPreview() ? 'pdf' : null

  if (videoMimeFor(entry.name) !== null) {
    // A container Chromium demuxes, which is still only playable while the
    // stream inside it is one Chromium decodes. Until the header has been read
    // the name's answer stands — and keeps standing for the codecs it cannot
    // name — so the file is served as it stands, exactly as it was before.
    if (!codecNeedsTranscode(codecOf(entry) ?? null)) return 'video'
    return canTranscodePreview() ? 'video' : null
  }

  if (canTranscodePreview() && needsTranscode(entry.name)) return 'video'
  return null
}

/**
 * The row being previewed. It carries the file's size and mtime as well as its
 * path so a preview can be keyed by content: an external rewrite of the same
 * path is a different thing to show, and a slow answer for the old one must not
 * land on the new one.
 */
export interface PreviewTarget {
  kind: PreviewKind
  /**
   * Whether showing this means *encoding* it: the stream a pane mounts for it is
   * an ffmpeg encode rather than the file. True for a container Chromium has
   * nothing for, and for one it demuxes whose stream it cannot decode — so it is
   * the same flag that carries the seek that a live stream needs and the length
   * only the file itself can report. False for an image or a PDF page, neither of
   * which is a stream.
   */
  encode: boolean
  path: string
  name: string
  size: number
  mtimeMs: number
}

/** The media an entry is, or null when it is a directory, a parent row or not media at all. */
export function previewTargetFor(entry: PaneEntry | null | undefined): PreviewTarget | null {
  if (!entry || entry.isParent || entry.kind !== 'file') return null

  const kind = previewKindFor(entry)
  if (kind === null) return null

  const encode =
    kind === 'video' && (needsTranscode(entry.name) || codecNeedsTranscode(codecOf(entry) ?? null))

  return {
    kind,
    encode,
    path: entry.path,
    name: entry.name,
    size: entry.size,
    mtimeMs: entry.mtimeMs
  }
}

/** The key that identifies a preview by what it shows, not merely by which file it came from. */
export function previewKeyFor(target: PreviewTarget | null): string | null {
  return target ? identityOf(target.path, target.size, target.mtimeMs) : null
}

/**
 * Where a playing clip has got to: its position, and its length once that is
 * knowable. A clip that has been transferred to a display is played only there,
 * so its own pane reads this from the display rather than from an element of its
 * own.
 */
export interface PlaybackClock {
  time: number
  length: number | null
}

/**
 * One flash of the on-screen display over a clip — YouTube's feedback for an
 * action on it: a glyph on a pause or a resume, and how far it was stepped on a
 * seek. Its `id` identifies the flash, so repeating an action is a new element
 * that restarts the animation rather than an unchanged one that shows nothing.
 */
export interface OsdFlash {
  kind: 'play' | 'pause' | 'seek'
  /** Seconds stepped: negative back, positive forward. A seek only. */
  delta: number
  id: number
}

/**
 * What one pane asks another to display: the media under *its* cursor, plus how
 * to find the thumbnail that media is already shown as — the box the display
 * grows out of. `animation` changes only when a display should be revealed with
 * that motion, rather than swapped in while the display is already up.
 */
export interface StageRequest {
  target: PreviewTarget
  /**
   * Where the clip had got to in the pane that asked for the display, or null
   * when it was not playing there — a display carries on from there rather than
   * starting the clip over, so that enlarging it is the same clip changing place.
   */
  resumeAt: number | null
  from: () => DOMRect | null
  /**
   * The footer's small preview box at the moment the display is revealed, its
   * bottom edge carried down so a clip's transport grows out from directly below
   * the thumbnail rather than appearing in its final place — the same gesture
   * the picture makes, and one that keeps the bar under it throughout. Null when
   * the pane has no thumbnail to grow from.
   */
  barFrom: () => DOMRect | null
  animation: number
}
