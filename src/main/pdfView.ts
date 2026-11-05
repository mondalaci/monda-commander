import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, ipcMain } from 'electron'
import { clampPdfScale } from '@shared/pdf'
import type { PdfViewState } from '@shared/types'

/**
 * How a PDF display was last sized, kept on disk so the choice outlives the
 * window: a fit (the page keeps filling the box) or a scale of the page's own. It
 * is one answer for the whole app — every PDF display reads it — as the hide mode
 * is, and the file lives beside it in `userData`.
 */
const DEFAULT_VIEW: PdfViewState = { mode: 'width', scale: 1 }

/** What a state file may hold. The `fit`/`zoom` pair is the shape before the mode. */
type StoredView = Partial<PdfViewState> & { fit?: unknown; zoom?: unknown }

function statePath(): string {
  return join(app.getPath('userData'), 'pdf-view.json')
}

/**
 * The remembered sizing. Absent or unreadable state answers the fill at the page's
 * own scale, what the document had before the choice existed, so a first launch —
 * and a state file that got mangled — behaves as it always did. A file written
 * before the mode existed carries a `fit` and a `zoom`; the fit is kept and the
 * magnification starts again from the page's own scale.
 */
export function readPdfView(): PdfViewState {
  try {
    return sanitizePdfView(JSON.parse(readFileSync(statePath(), 'utf8')) as StoredView)
  } catch {
    return { ...DEFAULT_VIEW }
  }
}

export function writePdfView(view: StoredView): void {
  try {
    const file = statePath()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(sanitizePdfView(view)))
  } catch {
    // A preference that cannot be written is not worth failing the gesture over;
    // the next switch tries again.
  }
}

/** A view with only the values this build knows: a mode it has, a scale it has. */
function sanitizePdfView(view: StoredView | null | undefined): PdfViewState {
  const mode =
    view?.mode === 'free' || view?.mode === 'page' || view?.mode === 'width'
      ? view.mode
      : view?.fit === 'page'
        ? 'page'
        : 'width'
  return { mode, scale: clampPdfScale(view?.scale) }
}

export function registerPdfViewHandlers(): void {
  ipcMain.handle('pdf:view-get', () => readPdfView())

  ipcMain.handle('pdf:view-set', (_event, view: StoredView) => {
    writePdfView(view)
  })
}
