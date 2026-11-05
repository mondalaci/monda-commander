import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ipcMain } from 'electron'
import { isArchivePath } from '@shared/archive'
import { isPdfName } from '@shared/pdf'
import type { ImagePreview, PdfInfo, PdfPageText, PdfWord, PixelSize, Result } from '@shared/types'

/**
 * Where poppler's tools are looked for. Beside `PATH`, an explicit path can be
 * given, for a machine that keeps them somewhere the app's environment does not,
 * as `MC_FFMPEG` does for transcoding.
 */
const PDFTOCAIRO = process.env['MC_PDFTOCAIRO'] ?? 'pdftocairo'
const PDFINFO = process.env['MC_PDFINFO'] ?? 'pdfinfo'
const PDFTOTEXT = process.env['MC_PDFTOTEXT'] ?? 'pdftotext'

/**
 * How wide a page may be rasterized, in pixels. A page is rendered at the width
 * the box it will sit in needs, so a full-screen display asks for more than a
 * footer thumbnail — but a page is a page, and past this every further pixel is
 * one the eye will not be given.
 */
const MAX_RENDER_WIDTH = 2400

/** A page is at most a second's work on any machine; past this something is wrong. */
const RENDER_TIMEOUT_MS = 20_000

/**
 * The rendered pages a session keeps. Scrolling back over a document, and a
 * display and a footer asking for the same page, re-visit the same renders; the
 * key carries the file's size and mtime as well as the page and the width, so a
 * rewrite on disk misses it. A page past the whole budget is not cached at all.
 */
const PDF_CACHE_MAX_BYTES = 64 * 1024 * 1024
const PDF_CACHE_MAX_ENTRIES = 32

const pageCache = new Map<string, { dataUrl: string; bytes: number }>()

/**
 * Whether poppler is there to render with. Both tools are needed — `pdftocairo`
 * draws a page and `pdfinfo` gives the shapes the document is laid out by — so
 * the probe asks for each. Asked once and remembered: the answer decides whether
 * a PDF is media at all, and a missing binary is not going to appear mid-session.
 */
let available: Promise<boolean> | null = null

function probe(binary: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn(binary, ['-v'], { stdio: 'ignore' })
    child.once('error', () => resolve(false))
    child.once('close', (code) => resolve(code === 0))
  })
}

export function pdftocairoAvailable(): Promise<boolean> {
  if (available !== null) return available
  available = Promise.all([probe(PDFTOCAIRO), probe(PDFINFO)]).then(([render, info]) => render && info)
  return available
}

export function killAllPdfRenders(): void {
  for (const child of children) child.kill('SIGKILL')
  children.clear()
  pageCache.clear()
  textCache.clear()
}

const children = new Set<ReturnType<typeof spawn>>()

/**
 * Run one of poppler's tools and hand back its standard output, or null when it
 * could not be run, failed, or said nothing. The tools print their version and
 * their warnings to standard error, so what is read here is the payload alone.
 */
function runTool(binary: string, args: string[]): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    children.add(child)

    const chunks: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))

    const timer = setTimeout(() => child.kill('SIGKILL'), RENDER_TIMEOUT_MS)
    const done = (buffer: Buffer | null): void => {
      clearTimeout(timer)
      children.delete(child)
      resolve(buffer)
    }

    child.once('error', () => done(null))
    child.once('close', (code) => done(code === 0 ? Buffer.concat(chunks) : null))
  })
}

/**
 * The most pages `pdfinfo` is asked to describe. Beyond this the first page's
 * shape stands for the rest — a shape is only layout, and a document of tens of
 * thousands of pages does not warrant parsing every one of them to scroll it.
 */
const MAX_DESCRIBED_PAGES = 2000

/**
 * A document's page count and each page's shape, from `pdfinfo`'s text output.
 * A page's own rotation is folded in: a landscape page stored rotated reports a
 * portrait size, and the directory it sits in must be laid out at the
 * orientation the page is actually drawn in. A page with no size line is left
 * for the layout to fill from the first one; the count is what makes it required.
 */
function parsePdfInfo(text: string): PdfInfo | null {
  const count = /^Pages:\s*(\d+)/m.exec(text)
  if (!count) return null
  const pages = Number.parseInt(count[1]!, 10)
  if (!Number.isFinite(pages) || pages <= 0) return null

  const rotations = new Map<number, number>()
  for (const match of text.matchAll(/^Page\s+(\d+)\s+rot:\s*(\d+)/gm)) {
    rotations.set(Number.parseInt(match[1]!, 10), Number.parseInt(match[2]!, 10))
  }

  const sizes: PixelSize[] = []
  for (const match of text.matchAll(/^Page\s+(\d+)\s+size:\s*([\d.]+)\s+x\s+([\d.]+)\s+pts/gm)) {
    const index = Number.parseInt(match[1]!, 10) - 1
    let width = Number.parseFloat(match[2]!)
    let height = Number.parseFloat(match[3]!)
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) continue
    if ((rotations.get(index + 1) ?? 0) % 180 === 90) [width, height] = [height, width]
    sizes[index] = { width, height }
  }

  return { pages, sizes }
}

const infoCache = new Map<string, PdfInfo | null>()

/** How many documents' info is remembered; small, since each is two numbers. */
const INFO_CACHE_MAX_ENTRIES = 128

/**
 * A document's page count and first-page shape, read from its header. The read
 * is memoized by the file's size and mtime, so a pane's question and a later
 * one about the same document share a single `pdfinfo`.
 */
async function pdfInfoFor(target: string): Promise<PdfInfo | null> {
  let stats
  try {
    stats = await fs.stat(target)
  } catch {
    return null
  }
  if (!stats.isFile()) return null

  const key = `${target}\u0000${stats.mtimeMs}:${stats.size}`
  if (infoCache.has(key)) return infoCache.get(key)!

  const printed = await runTool(PDFINFO, [
    '-f',
    '1',
    '-l',
    String(MAX_DESCRIBED_PAGES),
    '-enc',
    'UTF-8',
    target
  ])
  const info = printed === null ? null : parsePdfInfo(printed.toString('utf8'))

  infoCache.delete(key)
  infoCache.set(key, info)
  while (infoCache.size > INFO_CACHE_MAX_ENTRIES) {
    const oldest = infoCache.keys().next()
    if (oldest.done) break
    infoCache.delete(oldest.value)
  }
  return info
}

function readPageCache(key: string): string | null {
  const hit = pageCache.get(key)
  if (!hit) return null
  // Re-insert so the map's order stays least-recently-used first.
  pageCache.delete(key)
  pageCache.set(key, hit)
  return hit.dataUrl
}

function writePageCache(key: string, dataUrl: string): void {
  if (dataUrl.length > PDF_CACHE_MAX_BYTES) return

  pageCache.delete(key)
  pageCache.set(key, { dataUrl, bytes: dataUrl.length })

  let total = 0
  for (const entry of pageCache.values()) total += entry.bytes

  while (total > PDF_CACHE_MAX_BYTES || pageCache.size > PDF_CACHE_MAX_ENTRIES) {
    const oldest = pageCache.keys().next()
    if (oldest.done) break
    total -= pageCache.get(oldest.value)?.bytes ?? 0
    pageCache.delete(oldest.value)
  }
}

/**
 * Rasterize one page at `width` pixels wide, as a PNG. `pdftocairo` writes a
 * single file to standard output (`-` as the prefix with `-singlefile`), which is
 * what lets the bytes travel without a temporary file ever touching the disk.
 * The height follows the page's own aspect (`-scale-to-y -1`).
 */
async function renderPdfPage(input: string, page: number, width: number): Promise<ImagePreview> {
  const target = path.resolve(input)
  if (!isPdfName(target)) {
    throw Object.assign(new Error(`"${path.basename(target)}" is not a PDF`), { code: 'EINVAL' })
  }

  const stats = await fs.stat(target)
  if (!stats.isFile()) {
    throw Object.assign(new Error(`"${path.basename(target)}" is not a regular file`), {
      code: 'EINVAL'
    })
  }

  const key = `${target}\u0000${stats.mtimeMs}:${stats.size}:${page}:${width}`
  const cached = readPageCache(key)
  if (cached !== null) return { dataUrl: cached }

  const png = await runTool(PDFTOCAIRO, [
    '-png',
    '-f',
    String(page),
    '-l',
    String(page),
    '-scale-to-x',
    String(width),
    '-scale-to-y',
    '-1',
    '-singlefile',
    target,
    '-'
  ])
  if (png === null || png.length === 0) {
    throw Object.assign(new Error(`Could not render page ${page} of "${path.basename(target)}"`), {
      code: 'ERENDER'
    })
  }

  const dataUrl = `data:image/png;base64,${png.toString('base64')}`
  writePageCache(key, dataUrl)
  return { dataUrl }
}

/**
 * A page's text is not shown — it is laid over the rendered page invisibly so a
 * selection can be made across it, the same trick a browser's own PDF viewer
 * uses. `pdftotext -bbox-layout` writes an XHTML document whose `<word>` elements
 * carry the box each word occupies, in points with the origin at the page's
 * top-left, which is exactly the coordinate space a text layer needs; its
 * `<block>` wrappers are kept as each word's `block`, which is the paragraph a
 * triple-click selects.
 */

/** The basic entities `pdftotext` writes, and the numeric ones it may too. */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_m, digits: string) => String.fromCodePoint(Number.parseInt(digits, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * A page's size, its words in reading order — each tagged with the text block it
 * fell in and the line it sits on — and each line's own band. Null when the output
 * carries no page at all — a `pdftotext` that could not run, or a document it could
 * not read — which is not an error the pane has to report: it simply draws no
 * layer.
 */
function parsePdfPageText(xhtml: string): PdfPageText | null {
  const page = /<page\s+width="([\d.]+)"\s+height="([\d.]+)"/.exec(xhtml)
  if (!page) return null

  const width = Number.parseFloat(page[1]!)
  const height = Number.parseFloat(page[2]!)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null

  // One pass over the three tags, so a word is tagged with the block and the line
  // it is inside: the openers are counted as they come and the words follow them in
  // reading order. `-bbox-layout` is what wraps them: `flow` > `block` > `line` >
  // `word`. The line's own band is kept because a highlight is drawn per line —
  // a word's box is its ink, which is shorter for a word with no descender in it,
  // and a band that changed height word by word would read as a fault.
  const words: PdfWord[] = []
  const lines: { y: number; height: number }[] = []
  let block = 0
  const pattern =
    /<line\s+xMin="([\d.eE+-]+)"\s+yMin="([\d.eE+-]+)"\s+xMax="([\d.eE+-]+)"\s+yMax="([\d.eE+-]+)"|<block[\s>]|<word\s+xMin="([\d.eE+-]+)"\s+yMin="([\d.eE+-]+)"\s+xMax="([\d.eE+-]+)"\s+yMax="([\d.eE+-]+)">([\s\S]*?)<\/word>/g

  for (const match of xhtml.matchAll(pattern)) {
    if (match[1] !== undefined) {
      const top = Number.parseFloat(match[2]!)
      const bottom = Number.parseFloat(match[4]!)
      lines.push({ y: top, height: bottom - top })
      continue
    }

    if (match[5] === undefined) {
      block += 1
      continue
    }

    const xMin = Number.parseFloat(match[5]!)
    const yMin = Number.parseFloat(match[6]!)
    const xMax = Number.parseFloat(match[7]!)
    const yMax = Number.parseFloat(match[8]!)
    const text = decodeXmlEntities(match[9]!)
    if (text.length === 0) continue
    if (![xMin, yMin, xMax, yMax].every((value) => Number.isFinite(value))) continue
    words.push({
      text,
      x: xMin,
      y: yMin,
      width: xMax - xMin,
      height: yMax - yMin,
      block,
      line: Math.max(0, lines.length - 1)
    })
  }

  return { width, height, words, lines }
}

const textCache = new Map<string, PdfPageText | null>()

/** How many pages' text is remembered; small, since each is one page's words. */
const TEXT_CACHE_MAX_ENTRIES = 32

/**
 * Extract one page's text. It is keyed by the file and the page alone — a text
 * layer does not depend on the width the page is drawn at — and a page with no
 * words is cached as an answer rather than missed again, so a textless page of a
 * scanned document is asked for once.
 */
async function pdfTextFor(input: string, page: number): Promise<PdfPageText | null> {
  const target = path.resolve(input)
  const stats = await fs.stat(target)
  if (!stats.isFile()) return null

  const key = `${target}\u0000${stats.mtimeMs}:${stats.size}:${page}`
  if (textCache.has(key)) return textCache.get(key)!

  const printed = await runTool(PDFTOTEXT, [
    '-f',
    String(page),
    '-l',
    String(page),
    '-bbox-layout',
    '-enc',
    'UTF-8',
    target,
    '-'
  ])
  const parsed = printed === null ? null : parsePdfPageText(printed.toString('utf8'))

  textCache.set(key, parsed)
  while (textCache.size > TEXT_CACHE_MAX_ENTRIES) {
    const oldest = textCache.keys().next()
    if (oldest.done) break
    textCache.delete(oldest.value)
  }
  return parsed
}

function toFsError(error: unknown): { code: string; message: string } {
  const err = error as NodeJS.ErrnoException
  return {
    code: err.code ?? 'EUNKNOWN',
    message: err.message || 'Unknown PDF error'
  }
}

export function registerPdfHandlers(): void {
  ipcMain.handle('fs:can-render-pdf', () => pdftocairoAvailable())

  ipcMain.handle('fs:pdf-info', async (_event, target: string): Promise<PdfInfo | null> => {
    if (typeof target !== 'string' || target.length === 0) return null
    // An entry inside an archive has no real path for poppler to read.
    if (isArchivePath(target)) return null
    if (!isPdfName(target)) return null
    if (!(await pdftocairoAvailable())) return null
    try {
      return await pdfInfoFor(target)
    } catch {
      return null
    }
  })

  ipcMain.handle(
    'fs:pdf-page',
    async (_event, target: string, page: number, width: number): Promise<Result<ImagePreview>> => {
      if (typeof target !== 'string' || target.length === 0) {
        return { ok: false, error: { code: 'EINVAL', message: 'No PDF to render' } }
      }
      if (isArchivePath(target)) {
        return {
          ok: false,
          error: { code: 'ENOTSUP', message: 'Rendering a PDF inside an archive is not supported' }
        }
      }
      if (!isPdfName(target)) {
        return { ok: false, error: { code: 'EINVAL', message: 'Not a PDF' } }
      }
      if (!(await pdftocairoAvailable())) {
        return { ok: false, error: { code: 'ENOTSUP', message: 'No PDF renderer available' } }
      }

      const wanted = Math.max(1, Number.isFinite(page) ? Math.floor(page) : 1)
      const pixels = Math.min(MAX_RENDER_WIDTH, Math.max(16, Math.round(width) || 160))
      try {
        return { ok: true, data: await renderPdfPage(target, wanted, pixels) }
      } catch (error) {
        return { ok: false, error: toFsError(error) }
      }
    }
  )

  ipcMain.handle(
    'fs:pdf-text',
    async (_event, target: string, page: number): Promise<Result<PdfPageText>> => {
      if (typeof target !== 'string' || target.length === 0) {
        return { ok: false, error: { code: 'EINVAL', message: 'No PDF to read' } }
      }
      if (isArchivePath(target)) {
        return {
          ok: false,
          error: { code: 'ENOTSUP', message: 'Reading a PDF inside an archive is not supported' }
        }
      }
      if (!isPdfName(target)) {
        return { ok: false, error: { code: 'EINVAL', message: 'Not a PDF' } }
      }

      const wanted = Math.max(1, Number.isFinite(page) ? Math.floor(page) : 1)
      try {
        const text = await pdfTextFor(target, wanted)
        if (text === null) {
          return { ok: false, error: { code: 'ETEXT', message: 'Could not read the page text' } }
        }
        return { ok: true, data: text }
      } catch (error) {
        return { ok: false, error: toFsError(error) }
      }
    }
  )
}
