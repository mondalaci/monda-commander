import { ref } from 'vue'
import type { PdfInfo, PixelSize } from '@shared/types'
import { previewKeyFor, type PreviewTarget } from './preview'
import type { TargetApi } from './targetApi'

/**
 * A PDF is shown as a *document*: pages stacked one under another and scrolled
 * through, with the page in view being what the footer's thumbnail and the
 * display's transport say the file is on. That page is not a thing the cursor or
 * the display can derive, so it is kept here, one answer per file (keyed by the
 * same identity a preview is keyed by, so a rewritten file is a different
 * document), rather than in either pane.
 *
 * The alternative — handing the page from the asking pane to the display and back
 * the way a clip's position is handed over — exists because a clip can only play
 * in one element at a time. A page has no such cost: the renderer asks main for
 * it and main caches the raster, so the display can scroll freely and the pane
 * showing the thumbnail simply reads which page that is.
 */

/** What each document's header said, by identity: its page count and shapes. */
const infos = ref<Map<string, PdfInfo>>(new Map())

/** The page each document is showing, 1-based, by identity. Absent means the first. */
const pages = ref<Map<string, number>>(new Map())

/** The documents whose header is being read, so a row reached twice asks once. */
const probing = new Set<string>()
const inFlight = new Map<string, Promise<PdfInfo | null>>()

function keyOf(target: PreviewTarget | null | undefined): string | null {
  return target ? previewKeyFor(target) : null
}

/** How many pages a document has, once its header has answered, or null. */
export function pdfPageCountFor(target: PreviewTarget | null | undefined): number | null {
  const key = keyOf(target)
  if (key === null) return null
  return infos.value.get(key)?.pages ?? null
}

/** A page's shape in points, or null when the header could not say. */
export function pdfSizeFor(
  target: PreviewTarget | null | undefined,
  page: number
): PixelSize | null {
  const key = keyOf(target)
  if (key === null) return null
  const info = infos.value.get(key)
  if (!info) return null
  const index = Math.max(0, Math.round(page) - 1)
  return info.sizes[index] ?? info.sizes[0] ?? null
}

/** The shape of the page reserved in a thumbnail, or null when unknown. */
export function pdfSizeHintFor(target: PreviewTarget | null | undefined): PixelSize | null {
  return pdfSizeFor(target, 1)
}

/** The page a document is showing, 1-based. One before its header has answered. */
export function pdfPageFor(target: PreviewTarget | null | undefined): number {
  const key = keyOf(target)
  if (key === null) return 1
  return pages.value.get(key) ?? 1
}

/** Put a document on a given page, clamped to the pages its header reported. */
export function setPdfPage(target: PreviewTarget | null | undefined, page: number): void {
  const key = keyOf(target)
  if (key === null) return

  const count = infos.value.get(key)?.pages ?? 1
  const next = Math.min(Math.max(Math.round(page), 1), Math.max(1, count))
  if (pages.value.get(key) === next) return
  pages.value.set(key, next)
}

/**
 * Step a document's page by `delta`. Nothing happens while the page count is
 * unknown: how far there is to go is exactly what the header has not said, and a
 * request for a page past the end would only fail to render.
 */
export function stepPdfPage(target: PreviewTarget | null | undefined, delta: number): void {
  const key = keyOf(target)
  if (key === null || !infos.value.has(key)) return
  setPdfPage(target, pdfPageFor(target) + delta)
}

/** A page's place in the stacked document, in the layout's own pixels. */
export interface PdfPageBox {
  /** The page's distance from the top of the document's content. */
  top: number
  height: number
}

export interface PdfLayout {
  /** One box per page, in order. */
  boxes: PdfPageBox[]
  /** How tall the whole document is, padding and gaps included. */
  total: number
}

/** How tall a page is at a given width, before anything has been rendered. */
const DEFAULT_PAGE_RATIO = 792 / 612

/**
 * The stacked document's geometry: every page's box at `pageWidth`, with `gap`
 * between pages and `pad` above the first and below the last. The height comes
 * from the page's own shape, so the scrollbar, the windowed rendering and the
 * page a scroll position names are all exact before a single page has been
 * rasterized. Null while the document's header has not answered.
 */
export function pdfLayoutFor(
  target: PreviewTarget | null | undefined,
  pageWidth: number,
  gap: number,
  pad: number
): PdfLayout | null {
  const key = keyOf(target)
  if (key === null) return null
  const info = infos.value.get(key)
  if (!info) return null

  const fallback = info.sizes[0]
  const boxes: PdfPageBox[] = []
  let top = pad
  for (let i = 0; i < info.pages; i += 1) {
    const size = info.sizes[i] ?? fallback
    const ratio = size && size.width > 0 ? size.height / size.width : DEFAULT_PAGE_RATIO
    const height = Math.max(1, Math.round(pageWidth * ratio))
    boxes.push({ top, height })
    top += height + gap
  }

  const last = boxes[boxes.length - 1]
  const total = last ? last.top + last.height + pad : pad * 2
  return { boxes, total }
}

/**
 * Ask main for a document's page count and page shapes, once, and hand the answer
 * back. The read is cheap (a header read) but not free, and a held arrow key
 * crosses rows faster than it returns, so repeats are coalesced and the map is
 * the memory. Resolves null when the document's header could not be read.
 */
export function ensurePdfInfo(
  target: PreviewTarget | null | undefined,
  api: TargetApi
): Promise<PdfInfo | null> {
  const key = keyOf(target)
  if (key === null || !target) return Promise.resolve(null)

  const known = infos.value.get(key)
  if (known) return Promise.resolve(known)
  const pending = inFlight.get(key)
  if (pending) return pending

  const promise = api.fs.pdfInfo(target.path).then((info) => {
    probing.delete(key)
    inFlight.delete(key)
    if (info && info.pages > 0) {
      infos.value.set(key, info)
      return info
    }
    return null
  })
  probing.add(key)
  inFlight.set(key, promise)
  return promise
}
