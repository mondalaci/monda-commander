<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { injectTargetApi } from '@renderer/lib/targetContext'
import { resolveDocRef, type DocFormat } from '@shared/doc'

/**
 * A markdown document or a mermaid diagram, drawn natively in the display. The
 * prose is parsed and sanitized here — never trusted as it stands, since a
 * document is a file like any other and may have come from anywhere — and a
 * mermaid fence (or a whole `.mmd` file) is handed to mermaid, which is loaded
 * on demand: it is a large library, and a folder of ordinary prose should not
 * pay for it.
 *
 * The component owns only the document itself; the box around it, the scroll
 * and the reveal belong to the pane, exactly as they do for a PDF's page stack.
 */
const props = defineProps<{
  /** The document's text, as main read it. */
  text: string
  /** Which of the two documents it is: prose, or one diagram's source. */
  format: DocFormat
  /** The document's own path, which relative links and images resolve against. */
  path: string
  /** Whether main stopped short of the end of the file, so the display says so. */
  truncated?: boolean
}>()

const emit = defineEmits<{ ready: []; error: []; navigate: [path: string] }>()

const api = injectTargetApi()

/** Where the typeset document goes. */
const bodyEl = ref<HTMLElement | null>(null)

/**
 * Counts render passes, so an answer that arrives for a document the display
 * has already left cannot write into the new one — a sibling image can be slow
 * and mermaid is slower.
 */
let renderToken = 0

/**
 * Mermaid, loaded once for the whole window. Initialising it repeatedly is
 * cheap but the import is not, and a diagram's colours are the app's own, so
 * one readiness promise is all that is kept.
 */
let mermaidLoader: Promise<typeof import('mermaid').default> | null = null

async function loadMermaid(): Promise<typeof import('mermaid').default> {
  mermaidLoader ??= import('mermaid').then(({ default: mermaid }) => {
    const root = getComputedStyle(document.documentElement)
    const token = (name: string, fallback: string): string =>
      root.getPropertyValue(name).trim() || fallback
    mermaid.initialize({
      startOnLoad: false,
      // Strict sanitizes every label and ignores click handlers a diagram might
      // carry: a document is untrusted input, and a diagram is not a program.
      securityLevel: 'strict',
      theme: 'dark',
      fontFamily: token('--font-sans', 'sans-serif'),
      themeVariables: {
        background: 'transparent',
        // Mermaid's dark theme keeps its own node fill and a light `#ccc` border
        // whatever `primaryColor` says; both are pinned to the app's surfaces so
        // a rectangle reads as part of the window rather than as a lit box.
        mainBkg: token('--color-surface-2', '#2d2d30'),
        nodeBorder: token('--color-border', '#3c3c3c'),
        clusterBkg: token('--color-surface', '#252526'),
        clusterBorder: token('--color-border', '#3c3c3c'),
        edgeLabelBackground: token('--color-bg', '#1e1e1e'),
        primaryColor: token('--color-surface-2', '#2d2d30'),
        primaryTextColor: token('--color-fg', '#cccccc'),
        primaryBorderColor: token('--color-border', '#3c3c3c'),
        secondaryColor: token('--color-surface', '#252526'),
        tertiaryColor: token('--color-bg-alt', '#181818'),
        lineColor: token('--color-fg-dim', '#c0c0c0'),
        textColor: token('--color-fg', '#cccccc'),
        // Mermaid's dark theme drops a white-ish glow behind every node and
        // strokes the shapes with a light-to-dark gradient. On the app's flat
        // reading surface both read as glare around each rectangle rather than
        // as depth, so the diagrams are drawn flat.
        dropShadow: 'none',
        useGradient: false,
        fontSize: '14px'
      }
    })
    return mermaid
  })
  return mermaidLoader
}

/** One diagram's worth of failure, shown where the diagram would have been. */
function diagramFailure(host: HTMLElement, source: string, message: string): void {
  const note = document.createElement('p')
  note.className = 'md-diagram-note'
  note.textContent = message
  const code = document.createElement('pre')
  code.className = 'md-diagram-source'
  const inner = document.createElement('code')
  inner.textContent = source
  code.append(inner)
  host.replaceChildren(note, code)
}

/**
 * How far a diagram can be zoomed: the same kind of ladder the PDF display
 * steps through, in proportions of the drawing's own size. The first rungs are
 * there for a large diagram fitted into a small pane, which the controls take
 * over from.
 */
const ZOOM_STEPS = [0.1, 0.15, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4]
const ZOOM_MIN = 0.1
const ZOOM_MAX = 4

/** The next rung above (or below) the scale a diagram is at. */
function zoomStep(current: number, direction: number): number {
  if (direction > 0) return ZOOM_STEPS.find((step) => step > current + 1e-6) ?? ZOOM_MAX
  return [...ZOOM_STEPS].reverse().find((step) => step < current - 1e-6) ?? ZOOM_MIN
}

/**
 * Resize observers of the diagrams on screen. A diagram is fitted to its box
 * when it appears, and a pane that is resized has a new fit — but only while the
 * reader has not zoomed it, which is what the observer checks.
 */
let diagramObservers: ResizeObserver[] = []

function releaseDiagramObservers(): void {
  for (const observer of diagramObservers) observer.disconnect()
  diagramObservers = []
}

/** A small square button for a diagram's own bar. */
function diagramButton(label: string, title: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'md-diagram-button'
  button.textContent = label
  button.title = title
  button.setAttribute('aria-label', title)
  return button
}

/**
 * Put a mermaid drawing into its host with its own viewport and controls.
 *
 * Mermaid draws at its own size; that size is what the zoom is a proportion of,
 * so the viewer takes the viewBox and owns the SVG's width and height. A
 * standalone drawing opens at that size, one inside prose is fitted to the
 * column, and from there the bar zooms by rungs, `Ctrl+wheel` zooms about the
 * pointer, and a drag pans when the drawing is bigger than its box. A zoomed
 * drawing scrolls inside its own viewport, never growing the page under it.
 */
function mountDiagram(host: HTMLElement, markup: string, single: boolean): void {
  const viewport = document.createElement('div')
  viewport.className = 'md-diagram-viewport'

  const canvas = document.createElement('div')
  canvas.className = 'md-diagram-canvas'
  canvas.innerHTML = markup
  const svg = canvas.querySelector('svg')
  if (svg === null) {
    diagramFailure(host, '', 'This diagram produced nothing to draw.')
    return
  }
  viewport.append(canvas)

  // The drawing's own proportions, which every size below is a multiple of. The
  // width and height mermaid writes are discarded: the viewport decides them.
  const box = svg.viewBox.baseVal
  const baseWidth = box.width > 0 ? box.width : Math.max(1, svg.clientWidth || 640)
  const baseHeight = box.height > 0 ? box.height : Math.max(1, svg.clientHeight || 360)
  svg.style.maxWidth = 'none'
  svg.style.width = `${baseWidth}px`
  svg.style.height = `${baseHeight}px`

  const zoomOut = diagramButton('−', 'Zoom out (Ctrl+wheel)')
  const zoomLabel = diagramButton('100%', 'Fit the diagram to the pane')
  const zoomIn = diagramButton('+', 'Zoom in (Ctrl+wheel)')
  zoomLabel.classList.add('md-diagram-zoom-label')
  const controls = document.createElement('div')
  controls.className = 'md-diagram-controls'
  controls.append(zoomOut, zoomLabel, zoomIn)

  host.replaceChildren(viewport, controls)

  let scale = 1
  let fitScale = 1
  let fitted = true

  const refreshOverflow = (): void => {
    const scrollable =
      viewport.scrollWidth > viewport.clientWidth + 1 ||
      viewport.scrollHeight > viewport.clientHeight + 1
    viewport.classList.toggle('md-scrollable', scrollable)
  }

  const apply = (next: number): number => {
    scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next))
    svg.style.width = `${baseWidth * scale}px`
    svg.style.height = `${baseHeight * scale}px`
    zoomLabel.textContent = `${Math.round(scale * 100)}%`
    refreshOverflow()
    return scale
  }

  const measureFit = (): number => {
    const width = viewport.clientWidth
    if (width <= 0) return 1
    let fit = width / baseWidth
    // A standalone diagram is fitted both ways; one inside prose only has the
    // column's width to honour, and its own viewport caps its height.
    if (single && viewport.clientHeight > 0) {
      fit = Math.min(fit, viewport.clientHeight / baseHeight)
    }
    return Math.min(1, Math.max(ZOOM_MIN, fit))
  }

  const fit = (): void => {
    fitScale = measureFit()
    fitted = true
    apply(fitScale)
  }

  const zoomTo = (next: number, pointer?: { x: number; y: number }): void => {
    const viewportRect = viewport.getBoundingClientRect()
    const point = pointer ?? {
      x: viewportRect.left + viewport.clientWidth / 2,
      y: viewportRect.top + viewport.clientHeight / 2
    }
    // The point's place *within the drawing*, so the same ink stays under the
    // pointer however the drawing is centred or scrolled at either size.
    const before = svg.getBoundingClientRect()
    const fractionX = before.width > 0 ? (point.x - before.left) / before.width : 0.5
    const fractionY = before.height > 0 ? (point.y - before.top) / before.height : 0.5

    fitted = false
    apply(next)

    const after = svg.getBoundingClientRect()
    const originX = after.left - viewportRect.left + viewport.scrollLeft
    const originY = after.top - viewportRect.top + viewport.scrollTop
    viewport.scrollLeft = originX + fractionX * after.width - (point.x - viewportRect.left)
    viewport.scrollTop = originY + fractionY * after.height - (point.y - viewportRect.top)
  }

  zoomOut.addEventListener('click', () => zoomTo(zoomStep(scale, -1)))
  zoomIn.addEventListener('click', () => zoomTo(zoomStep(scale, 1)))
  zoomLabel.addEventListener('click', () => fit())

  // The wheel scrolls the document as it always does. Ctrl turns it into a
  // zoom of the diagram under the pointer, which is why the listener has to be
  // non-passive and has to stop the browser's own page zoom.
  viewport.addEventListener(
    'wheel',
    (event) => {
      if (!event.ctrlKey) return
      event.preventDefault()
      event.stopPropagation()
      zoomTo(zoomStep(scale, event.deltaY < 0 ? 1 : -1), {
        x: event.clientX,
        y: event.clientY
      })
    },
    { passive: false }
  )

  // A drawing bigger than its box is dragged around, as a map is. A drawing
  // that fits has nothing to pan, so a drag there stays a text selection.
  let pan: { x: number; y: number; left: number; top: number; pointer: number } | null = null

  viewport.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    if (!viewport.classList.contains('md-scrollable')) return
    pan = {
      x: event.clientX,
      y: event.clientY,
      left: viewport.scrollLeft,
      top: viewport.scrollTop,
      pointer: event.pointerId
    }
    viewport.setPointerCapture(event.pointerId)
    viewport.classList.add('is-panning')
    event.preventDefault()
    event.stopPropagation()
  })

  viewport.addEventListener('pointermove', (event) => {
    if (pan === null || event.pointerId !== pan.pointer) return
    viewport.scrollLeft = pan.left - (event.clientX - pan.x)
    viewport.scrollTop = pan.top - (event.clientY - pan.y)
  })

  const endPan = (event: PointerEvent): void => {
    if (pan === null || event.pointerId !== pan.pointer) return
    pan = null
    viewport.classList.remove('is-panning')
  }
  viewport.addEventListener('pointerup', endPan)
  viewport.addEventListener('pointercancel', endPan)

  // A fitted diagram follows the box it is in — a resized pane or window — while
  // one the reader has zoomed keeps the size they chose. The observer watches the
  // viewport, whose own size only changes with the layout, not with the zoom.
  const observer = new ResizeObserver(() => {
    if (!fitted) return
    const next = measureFit()
    if (Math.abs(next - fitScale) < 0.001) return
    fitScale = next
    apply(next)
  })
  observer.observe(viewport)
  diagramObservers.push(observer)

  // A standalone `.mmd` opens at the drawing's own size — the diagram *is* the
  // document, and its labels are meant to be read. A diagram inside prose is
  // fitted to the column instead, so it does not knock the page out of shape;
  // either one can be fitted or zoomed from the bar.
  if (single) {
    fitted = false
    apply(1)
  } else {
    fit()
  }
}

/**
 * Draw one mermaid diagram into `host`. A diagram that will not parse is shown
 * as its source with a note rather than taking the whole document down: the
 * text is still the document, and a syntax error is the reader's to see.
 */
async function drawDiagram(
  host: HTMLElement,
  source: string,
  key: string,
  single: boolean
): Promise<void> {
  const trimmed = source.trim()
  if (trimmed === '') {
    host.remove()
    return
  }
  let id = ''
  try {
    const mermaid = await loadMermaid()
    // Mermaid measures the diagram in the document, so it needs an id that is
    // unique in it; the token keeps a re-render from reusing a live one.
    id = `mc-mermaid-${key}`
    const { svg } = await mermaid.render(id, trimmed)
    mountDiagram(host, svg, single)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    diagramFailure(host, trimmed, `This diagram could not be drawn: ${message.split('\n')[0]}`)
  } finally {
    // Mermaid leaves its measuring element behind on a failed render.
    if (id !== '') document.getElementById(`d${id}`)?.remove()
  }
}

/**
 * Mermaid fences in markdown. Marked marks the language on the `<code>` inside
 * a `<pre>`; the pair is replaced by the diagram, so the reader sees the
 * drawing where the source was and the source is one failed render away.
 */
async function drawFences(host: HTMLElement, token: number): Promise<void> {
  const blocks = Array.from(host.querySelectorAll<HTMLElement>('pre > code.language-mermaid'))
  let index = 0
  for (const code of blocks) {
    const pre = code.parentElement
    if (pre === null) continue
    const diagram = document.createElement('div')
    diagram.className = 'md-diagram'
    pre.replaceWith(diagram)
    await drawDiagram(diagram, code.textContent ?? '', `${token}-${index}`, false)
    index += 1
  }
}

/**
 * Resolve a document's own images through the pane's target, so a relative
 * `![shot](img/shot.png)` shows the picture beside the file (inside an archive
 * too, where main reads the entry) rather than a broken box. Anything the app
 * cannot read — an absolute URL, a missing file — is left as its alt text.
 */
async function resolveImages(host: HTMLElement, token: number): Promise<void> {
  const images = Array.from(host.querySelectorAll('img'))
  await Promise.all(
    images.map(async (image) => {
      const source = image.getAttribute('src')
      if (source === null || source.startsWith('data:')) return
      const resolved = resolveDocRef(props.path, source)
      if (resolved === null) {
        image.removeAttribute('src')
        image.classList.add('md-image-missing')
        return
      }
      const result = await api.fs.readImage(resolved)
      if (token !== renderToken) return
      if (result.ok) image.src = result.data.dataUrl
      else {
        image.removeAttribute('src')
        image.classList.add('md-image-missing')
      }
    })
  )
}

/** GitHub's heading slug: lower case, words joined by dashes, punctuation gone. */
function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/\s+/g, '-')
}

/**
 * Give every heading an id, so a table of contents built from `#anchors` can
 * reach it. Marked emits no ids of its own, and a browser needs one to scroll.
 * A repeated heading takes a suffix, as GitHub's does, rather than the second
 * one stealing the first one's destination.
 */
function anchorHeadings(host: HTMLElement): void {
  const used = new Map<string, number>()
  for (const heading of host.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')) {
    const base = slugify(heading.textContent ?? '')
    if (base === '') continue
    const seen = used.get(base) ?? 0
    used.set(base, seen + 1)
    heading.id = seen === 0 ? base : `${base}-${seen}`
  }
}

/** Scroll a `#fragment` link's target into view within the display's box. */
function scrollToAnchor(id: string): void {
  const host = bodyEl.value
  if (host === null) return
  const target = host.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`)
  target?.scrollIntoView({ block: 'start', behavior: 'smooth' })
}

/**
 * A link in the document. A fragment scrolls this document; a page goes to the
 * system's browser through main, which only allows the schemes a page can be;
 * a relative path is handed to the pane, which moves its cursor to the file so
 * the display follows the link — a sibling document opens in this same display,
 * as a link between files should.
 */
function onClick(event: MouseEvent): void {
  const element = event.target
  const anchor = element instanceof Element ? element.closest('a') : null
  const href = anchor?.getAttribute('href') ?? null
  if (href === null || href === '') return
  event.preventDefault()
  event.stopPropagation()

  if (href.startsWith('#')) {
    scrollToAnchor(href.slice(1))
    return
  }
  if (/^(https?|mailto):/i.test(href) || href.startsWith('//')) {
    void api.fs.openExternal(href)
    return
  }
  const resolved = resolveDocRef(props.path, href)
  if (resolved !== null) emit('navigate', resolved)
}

async function render(): Promise<void> {
  const host = bodyEl.value
  if (host === null) return
  const token = (renderToken += 1)
  releaseDiagramObservers()

  try {
    if (props.format === 'mermaid') {
      const diagram = document.createElement('div')
      diagram.className = 'md-diagram'
      host.replaceChildren(diagram)
      await drawDiagram(diagram, props.text, `${token}-0`, true)
    } else {
      // Markdown is untrusted text: marked turns it into HTML, and DOMPurify is
      // what decides which of that HTML the display may put on screen.
      const html = await marked.parse(props.text, { gfm: true, breaks: false, async: false })
      host.innerHTML = DOMPurify.sanitize(html, {
        USE_PROFILES: { html: true },
        // A form is not part of a document's reading: its action would be a page
        // the app posts to on a click, which the pane's CSP does not cover.
        FORBID_TAGS: ['form']
      })
      anchorHeadings(host)
      await resolveImages(host, token)
      if (token !== renderToken) return
      await drawFences(host, token)
    }
  } catch (error) {
    if (token !== renderToken) return
    console.error('Could not typeset the document', error)
    emit('error')
    return
  }

  // The reader stops at its own ceiling, so a document cut short says so rather
  // than looking whole and ending in the middle of a sentence.
  if (props.truncated === true) {
    const note = document.createElement('p')
    note.className = 'md-truncated'
    note.textContent =
      'This file is larger than the reader’s limit, so only its beginning is shown.'
    host.append(note)
  }

  if (token !== renderToken) return
  emit('ready')
}

onMounted(() => void render())
onBeforeUnmount(() => {
  renderToken += 1
  releaseDiagramObservers()
})
</script>

<template>
  <div
    ref="bodyEl"
    class="markdown-body"
    :class="format === 'mermaid' ? 'doc-diagram-page' : 'doc-article'"
    data-doc-text
    @click="onClick"
  ></div>
</template>
