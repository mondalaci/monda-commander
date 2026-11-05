import { ref } from 'vue'
import { clampPdfScale } from '@shared/pdf'
import type { PdfFitMode, PdfViewState } from '@shared/types'

/**
 * How a PDF display is sized, as one answer for the whole app — both panes'
 * displays read it, and it is remembered across launches in `userData/pdf-view.json`
 * (`main/pdfView.ts`). A module-level ref rather than per-pane state, exactly as
 * the hide mode is: switching it in one pane's display is the same choice the
 * other pane's display shows, and a new display opens the way the last one was
 * left.
 */
export const pdfView = ref<PdfViewState>({ mode: 'width', scale: 1 })

/**
 * Ask main for the sizing that was left on last time. Called once on mount; the
 * default above stands only for the moment that takes.
 */
export async function loadPdfView(): Promise<void> {
  pdfView.value = await window.mc.pdfView.get()
}

/**
 * Fit the page to the box. The scale is left where it is: it is what a step away
 * from the fit will use, and it is not shown while a fit is in charge.
 */
export async function setPdfFit(mode: PdfFitMode): Promise<void> {
  await setPdfView({ mode, scale: pdfView.value.scale })
}

/**
 * Hold the page at a scale of its own. It is the same size whatever the box does
 * from here — which is the difference between this and a fit, and the reason the
 * percentage stops moving when the pane is resized.
 */
export async function setPdfZoom(scale: number): Promise<void> {
  await setPdfView({ mode: 'free', scale: clampPdfScale(scale) })
}

/** Set the ref first — that is what moves the display now — and write it down. */
async function setPdfView(view: PdfViewState): Promise<void> {
  pdfView.value = view
  await window.mc.pdfView.set(view)
}
