/**
 * Extension -> MIME for the one document format a pane renders itself. Unlike an
 * image, a PDF is not shown as its own bytes: main rasterizes a *page* of it
 * through poppler (`pdftocairo`) and hands the pane a PNG, so a pane previews a
 * page at the size its box needs rather than a whole document it could not lay
 * out. The map is shared so the renderer decides what to preview with the same
 * answer main renders by — a mismatch would mean a row asking for a page main
 * then refuses.
 *
 * Chromium can display a PDF through its own built-in viewer, but that viewer is
 * a plugin: the renderer's CSP forbids `<object>`/`<embed>` outright
 * (`object-src 'none'`), and it is a chrome of its own rather than something the
 * panes' cursor and display can drive page by page. Rasterizing in main keeps a
 * PDF a *media* file like an image or a clip, with the same shortcuts.
 */
const PDF_MIME: Record<string, string> = {
  pdf: 'application/pdf'
}

/** The MIME type for a name that is a PDF, or null. */
export function pdfMimeFor(name: string): string | null {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot <= 0 || dot === lower.length - 1) return null
  return PDF_MIME[lower.slice(dot + 1)] ?? null
}

/** Whether a name is a PDF the panes render in-app. */
export function isPdfName(name: string): boolean {
  return pdfMimeFor(name) !== null
}

/**
 * The keys that switch a PDF display's fit and magnification. Spelled here, where
 * the view lives, so the buttons' tooltips, the key handler and the documentation
 * cannot drift apart — as the hide mode's own key and tooltips are
 * (`shared/hide.ts`).
 */
export const PDF_FIT_WIDTH_KEY = 'Alt+W'
export const PDF_FIT_PAGE_KEY = 'Alt+P'
export const PDF_ZOOM_IN_KEY = 'Alt+='
export const PDF_ZOOM_OUT_KEY = 'Alt+-'

/**
 * The magnifications `+`/`-` step through, in the terms the percentage is read
 * in: 1 is the page at its own size (a point is 4/3 of a CSS pixel at 96 dots per
 * inch), and the ends are as far as a page is worth scaling from it. A fixed
 * ladder rather than a multiply-by-step, so the sizes are predictable and every
 * reader reaches the same percentages.
 */
export const PDF_ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8]

/** The smallest and largest magnifications the ladder holds. */
export const PDF_MIN_SCALE = PDF_ZOOM_STEPS[0]!
export const PDF_MAX_SCALE = PDF_ZOOM_STEPS[PDF_ZOOM_STEPS.length - 1]!

/**
 * What the percentage on the transport means, for the label's own tooltip. The
 * reference is the *box* rather than the page's own size in inches, because the box
 * is the thing on screen a reader can point at: fitting the width is 100% by
 * definition, and a page wider than the box — anything above 100% — scrolls
 * sideways.
 */
export const PDF_ZOOM_TOOLTIP =
  'Zoom: how much of the width the page fills. 100% is the width exactly; above that it scrolls sideways.'

/** A stored magnification, held to the ladder's ends. */
export function clampPdfScale(scale: unknown): number {
  if (typeof scale !== 'number' || !Number.isFinite(scale)) return 1
  return Math.min(PDF_MAX_SCALE, Math.max(PDF_MIN_SCALE, scale))
}

/**
 * The next magnification from `scale`, one step up or down, held to the ends of
 * the ladder. A value between steps — a fit's own scale, say, or a state file from
 * an older build — steps to the neighbouring one rather than snapping on its own.
 */
export function nextPdfZoom(scale: number, direction: 1 | -1): number {
  if (direction > 0) return PDF_ZOOM_STEPS.find((step) => step > scale + 1e-6) ?? PDF_MAX_SCALE
  for (let i = PDF_ZOOM_STEPS.length - 1; i >= 0; i -= 1) {
    const step = PDF_ZOOM_STEPS[i]!
    if (step < scale - 1e-6) return step
  }
  return PDF_MIN_SCALE
}
