<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { PaneController, PaneEntry } from '@renderer/composables/useDirectory'
import { isRunnable } from '@renderer/lib/executable'
import { dotStyle, markTitle, rowMarkFor, type GitRowMark } from '@renderer/lib/gitMark'
import { previewKindFor, type PreviewKind } from '@renderer/lib/preview'
import { injectTargetApi } from '@renderer/lib/targetContext'
import { morphing, whenNotMorphing } from '@renderer/lib/viewTransition'
import { VIEW_ENTER_MAX, VIEW_ENTER_STEP_MS, thumbScaleFor } from '@shared/viewMode'
import FileIcon from '@renderer/components/FileIcon.vue'

/**
 * The 3D tiles are drawn by one shared renderer (`ModelWall`), which is where
 * three.js lives: keeping it behind an async component is what stops the wall's
 * large dependency from being pulled into the renderer's main chunk, exactly as
 * `ModelViewer` is kept out of it for the footer.
 */
const ModelWall = defineAsyncComponent(() => import('@renderer/components/ModelWall.vue'))

/** One tile: its entry, its place in the listing, and what can be drawn for it. */
interface Cell {
  entry: PaneEntry
  index: number
  /** The git mark the tile carries, read once here rather than in the markup. */
  git: GitRowMark | null
  /** What the entry previews as, or null when it is not media at all. */
  kind: PreviewKind | null
  /** The tile's own key, by which a friend of the model wall names it. */
  key: string
}

/**
 * A pane's rows as a wall of tiles: each entry drawn from its own picture where
 * one can be had — an image decoded and shrunk, one frame of a clip, a PDF's
 * first page — and from its type icon where none can (a folder, a text file, a
 * 3D model, a clip with no ffmpeg, anything on a remote target).
 *
 * It is the *same* rows the detail listing draws — `controller.state.entries`,
 * with the same cursor, marks, filter and order — so nothing about the cursor,
 * the transfers, the search or the menu changes with the mode; only the drawing
 * does. What is new is the geometry: the listing's fixed row height is replaced
 * by a cell size and however many cells fit across, so the windowing, the page
 * arithmetic and the scroll-into-view are this component's own rather than the
 * row list's.
 */
const props = defineProps<{
  controller: PaneController
  active: boolean
  /**
   * Whether these tiles are arriving from a view switch and should rise in a step
   * behind one another (`styles/view.css`). True only for the moment of the
   * switch, so a tile the viewport reveals later — a scroll — is simply there.
   */
  enter?: boolean
  /**
   * The `view-transition-name` an entry carries (the pane's own assignment), so a
   * mode morph can match the tile a row became. The pane owns the names because
   * they must be unique across both its layouts — and across both panes.
   */
  nameFor: (path: string) => string
}>()

const emit = defineEmits<{
  (event: 'left-down', index: number): void
  (event: 'right-down', index: number, native: MouseEvent): void
  (event: 'enter', index: number): void
  (event: 'activate'): void
}>()

const api = injectTargetApi()

/**
 * One cell's height at the ladder's own size, name included — the whole of the
 * grid's pitch, since the cells carry their spacing as padding and no gap is
 * counted twice. The size shown is this times the zoom's step (`cellHeight`).
 */
const BASE_CELL_HEIGHT = 100

/** The narrowest a cell may be, at that same size, before one fewer fits across. */
const BASE_CELL_MIN_WIDTH = 104

/** The gutter the grid keeps at its own left and right edges. */
const GRID_GUTTER = 8

/**
 * The cell rows drawn beyond the viewport, so a fast scroll never flashes a
 * blank band. Smaller than the listing's because a cell row is several entries
 * at once, so the same count covers more of the listing.
 */
const OVERSCAN_ROWS = 4

/**
 * The longest side a tile's picture is asked for at. It is read once per file and
 * kept, so it is sized for the largest tile the zoom can make (a 200px cell at
 * twice the device ratio) rather than re-read as the wall grows.
 */
const TILE_MAX_DIM = 400

/** How many tiles are read at once, so a wall does not open sixty decodes. */
const LOAD_LIMIT = 4

/** How long a step of the tile zoom takes to travel, and how sharply. */
const ZOOM_MS = 200

const listEl = ref<HTMLUListElement | null>(null)
const scrollTop = ref(0)
const viewportHeight = ref(0)
const columns = ref(1)

/**
 * How large the tiles are drawn, as a factor of the ladder's own size. It is the
 * *animated* value: a zoom step moves it to the next rung over `ZOOM_MS` rather
 * than jumping, so the wall grows into its new size — and the model wall, which
 * measures each tile's box every frame, draws the turning models at the size the
 * boxes have at that moment, so they grow with it.
 */
const scale = ref(thumbScaleFor(props.controller.state.thumbStep))

/** One cell's height, at the size the wall is being drawn at just now. */
const cellHeight = computed(() => Math.max(24, Math.round(BASE_CELL_HEIGHT * scale.value)))

/** The narrowest a cell may be at that size, which is what decides the columns. */
const cellMinWidth = computed(() => Math.max(28, Math.round(BASE_CELL_MIN_WIDTH * scale.value)))

const entries = computed<PaneEntry[]>(() => props.controller.state.entries)
const totalRows = computed(() => Math.ceil(entries.value.length / columns.value))

/**
 * The mark a tile shows, read from the pane's own git view by the same reader
 * the detail listing uses — the dot is a property of the entry and the status,
 * not of how the row is drawn.
 */
function markAt(entry: PaneEntry): GitRowMark | null {
  if (props.controller.state.quickCd) return null
  return rowMarkFor(props.controller.state.git, entry)
}

/**
 * The cells to render: the window the viewport covers, widened by the overscan
 * band, carried with each entry's absolute index so every handler keys off the
 * same index the controller's cursor uses. The arithmetic is index-against-cell
 * only — no DOM measurement — which is what lets the window be computed before
 * the cells it describes exist.
 */
const visibleCells = computed<Cell[]>(() => {
  const all = entries.value
  if (all.length === 0) return []
  const cols = columns.value
  const pitch = cellHeight.value
  const height = viewportHeight.value || pitch * 12
  const firstRow = Math.max(0, Math.floor(scrollTop.value / pitch) - OVERSCAN_ROWS)
  const lastRow = Math.ceil((scrollTop.value + height) / pitch) + OVERSCAN_ROWS
  const first = Math.min(firstRow * cols, Math.max(all.length - 1, 0))
  const last = Math.min(Math.max(lastRow * cols, first + 1), all.length)
  const cells: Cell[] = []
  for (let i = first; i < last; i += 1) {
    const entry = all[i]
    if (entry) {
      cells.push({
        entry,
        index: i,
        git: markAt(entry),
        kind: isTileReadable(entry) ? previewKindFor(entry) : null,
        key: tileKey(entry)
      })
    }
  }
  return cells
})

/** The band of cells hidden above the window, as padding of its exact height. */
const padTop = computed(() => {
  const first = visibleCells.value[0]
  if (!first) return 0
  return Math.floor(first.index / columns.value) * cellHeight.value
})

/** The band of cells hidden below the window, as padding of its exact height. */
const padBottom = computed(() => {
  const cells = visibleCells.value
  const last = cells[cells.length - 1]
  if (!last) return 0
  const lastRow = Math.floor(last.index / columns.value) + 1
  return Math.max(0, totalRows.value - lastRow) * cellHeight.value
})

const gridStyle = computed(() => ({
  gridTemplateColumns: `repeat(${columns.value}, minmax(0, 1fr))`,
  gridAutoRows: `${cellHeight.value}px`,
  paddingTop: `${padTop.value}px`,
  paddingBottom: `${padBottom.value}px`,
  paddingLeft: `${GRID_GUTTER}px`,
  paddingRight: `${GRID_GUTTER}px`
}))

// --- Tiles -----------------------------------------------------------------

/**
 * The pictures read so far, by a key that names the file's *content* rather
 * than its path, so a rewrite on disk is a different key and a stale picture is
 * never shown for it. A key present with a null value is a settled "no picture"
 * — an unsupported format, a missing decoder — which is what lets the cell stop
 * showing its spinner and draw the type icon instead.
 */
const tiles = reactive(new Map<string, string | null>())

/** Bumped on every navigation, so a read for a listing already left is dropped. */
let epoch = 0

/**
 * Whether a tile could draw the entry at all. Only a regular file is media, the
 * same rule the footer's preview follows: a folder that happens to be named
 * `holiday.jpg` is a folder, and a broken symlink has nothing behind it.
 */
function isTileReadable(entry: PaneEntry): boolean {
  return entry.kind === 'file'
}

function tileKey(entry: PaneEntry): string {
  return `${entry.path}\u0000${entry.size}:${entry.mtimeMs}`
}

/** The picture read for an entry, or undefined while none has been. */
function tileUrl(entry: PaneEntry): string | undefined {
  const found = tiles.get(tileKey(entry))
  return found ?? undefined
}

/**
 * Whether an entry's tile has settled — a picture, or a decision there is none.
 * The `..` row is settled from the start: it is a way up, never a file to draw,
 * so it has no picture and none is ever read for it.
 */
function tileSettled(entry: PaneEntry): boolean {
  return entry.isParent || tiles.has(tileKey(entry))
}

/**
 * What still wants reading: the cells the window now covers that have no tile
 * yet. It is *rebuilt* from the window on every scroll rather than appended to,
 * so a fast flick down a folder of thousands drops the cells it has left behind
 * instead of queueing a decode for every one of them.
 */
let wanted: { key: string; entry: PaneEntry }[] = []
const wantedKeys = new Set<string>()
const inFlight = new Set<string>()
let running = 0

function pump(): void {
  while (running < LOAD_LIMIT && wanted.length > 0) {
    const next = wanted.shift()!
    if (tiles.has(next.key) || inFlight.has(next.key)) continue
    inFlight.add(next.key)
    running += 1
    const startedFor = epoch
    void readTile(next.entry)
      .then(async (url) => {
        // A read that lands after the pane has left is not shown: the rows it
        // belonged to are gone, and the cache was cleared with them. A read that
        // lands during a mode morph waits for it: an image decoded into the DOM is
        // work on frames the flight is using.
        await whenNotMorphing()
        if (startedFor === epoch) tiles.set(next.key, url)
      })
      .finally(() => {
        inFlight.delete(next.key)
        running -= 1
        pump()
      })
  }
}

function requestVisible(cells: Cell[]): void {
  // The wall is not on screen while a mode morph flies (a transition shows
  // snapshots), so no tile is read during one: the decodes would be work on frames
  // nobody sees, on the thread the flight needs. The moment it lands, the window
  // is asked for again.
  if (morphing.value) return

  wanted = []
  wantedKeys.clear()
  for (const cell of cells) {
    const { key, entry, kind } = cell
    if (entry.isParent || tiles.has(key) || inFlight.has(key) || wantedKeys.has(key)) continue
    // A model's tile is the shared renderer's (`ModelWall`); this queue never
    // reads one, and never settles one either — the wall reports on it.
    if (kind === 'model') continue
    // Nothing to read at all — a folder, a text file, a binary — settles at once,
    // so the tile draws its icon rather than spinning on a read that would answer
    // nothing.
    if (kind === null) {
      tiles.set(key, null)
      continue
    }
    wanted.push({ key, entry })
    wantedKeys.add(key)
  }
  pump()
}

/**
 * What a tile is read as, by the same shared extension maps the footer preview
 * decides by — so a cell asks for exactly what the row can be given. A model is
 * not read here: it is drawn by the one shared renderer (`ModelWall`), which is
 * also why a wall of models can all turn at once without a WebGL context each.
 */
async function readTile(entry: PaneEntry): Promise<string | null> {
  const kind = previewKindFor(entry)
  if (kind === 'image' || kind === 'video') {
    const result = await api.fs.thumbnail(entry.path, TILE_MAX_DIM)
    return result.ok ? result.data.dataUrl : null
  }
  if (kind === 'pdf') {
    const result = await api.fs.pdfPage(entry.path, 1, TILE_MAX_DIM)
    return result.ok ? result.data.dataUrl : null
  }
  return null
}

/** Read what the window now covers, so scrolling fills the cells it reveals. */
watch(visibleCells, requestVisible, { immediate: true, flush: 'post' })

/** The morph has landed: whatever the window covers now is read. */
watch(morphing, (on) => {
  if (!on) requestVisible(visibleCells.value)
})

/**
 * A tile key as a DOM attribute value. The key is `<path>\0<size>:<mtime>` —
 * NUL cannot occur in a path, which is what keeps it unambiguous — but NUL
 * cannot travel in an HTML attribute either, so it is encoded for the one place
 * the key leaves JavaScript (the wall reads it back off `data-model-key`).
 */
function domKey(key: string): string {
  return encodeURIComponent(key)
}

// --- The model wall --------------------------------------------------------

/**
 * The model tiles on screen, by key and path, handed to the one shared renderer.
 * Only the visible ones are asked for, so a folder of a thousand models reads the
 * dozen or so in view.
 */
const modelCells = computed(() =>
  visibleCells.value
    .filter((cell) => cell.kind === 'model')
    .map((cell) => ({ key: cell.key, path: cell.entry.path }))
)

/**
 * Whether the folder holds any model at all, which is what mounts the wall — and
 * so fetches three.js. A folder of pictures never pays for it.
 */
const hasModels = computed(() =>
  props.controller.state.entries.some((entry) => isTileReadable(entry) && previewKindFor(entry) === 'model')
)

/** What the wall has managed for each model tile: drawn, or a refusal. */
const modelStatus = reactive(new Map<string, 'ready' | 'error'>())

function onModelStatus(key: string, status: 'ready' | 'error'): void {
  modelStatus.set(key, status)
}

// --- Geometry and scrolling ------------------------------------------------

function measure(): void {
  const element = listEl.value
  if (!element) return
  viewportHeight.value = element.clientHeight

  const usable = element.clientWidth - GRID_GUTTER * 2
  const cols = Math.max(1, Math.floor(usable / cellMinWidth.value))
  const changed = cols !== columns.value
  columns.value = cols

  // The pane's own page arithmetic runs on these: a page is a screen of cells,
  // and an up/down arrow steps a whole row. Kept on the controller because the
  // cursor moves are the controller's, not this view's.
  props.controller.state.cellsPerRow = cols
  props.controller.state.pageRows = Math.max(1, Math.floor(element.clientHeight / cellHeight.value)) * cols

  // Only a re-laid-out grid — a different number of columns — is followed here.
  // A height change is not, and that is deliberate: the footer's preview strip
  // growing is an *animated* height change, so a reveal keyed to it would run on
  // every frame of the animation and scroll the whole wall up in steps — the
  // models trembling with the strip. The strip covering the cursor's tile for a
  // moment is the smaller evil; a cursor move reveals it again from the geometry
  // it already has (the cursor watcher below).
  if (changed) scrollCellIntoView(props.controller.state.cursor, 'nearest')
}

function onScroll(): void {
  const element = listEl.value
  if (element) scrollTop.value = element.scrollTop
}

const SCROLL_ANIM_MS = 140
let scrollAnimation = 0

function setScrollTop(element: HTMLElement, target: number, animated: boolean): void {
  if (!animated) {
    cancelAnimationFrame(scrollAnimation)
    element.scrollTop = target
    return
  }
  cancelAnimationFrame(scrollAnimation)
  const from = element.scrollTop
  const delta = target - from
  if (delta === 0) return
  const start = performance.now()
  const step = (now: number): void => {
    const t = Math.min((now - start) / SCROLL_ANIM_MS, 1)
    element.scrollTop = from + delta * (1 - Math.pow(1 - t, 3))
    if (t < 1) scrollAnimation = requestAnimationFrame(step)
  }
  scrollAnimation = requestAnimationFrame(step)
}

/** Bring a cell's whole row into view, the way the listing reveals a row. */
function scrollCellIntoView(index: number, align: 'nearest' | 'start' | 'end', animated = false): void {
  const element = listEl.value
  if (!element) return

  const rowTop = Math.floor(index / columns.value) * cellHeight.value
  const rowBottom = rowTop + cellHeight.value
  const viewTop = element.scrollTop
  const viewBottom = viewTop + element.clientHeight

  if (align === 'start') return setScrollTop(element, rowTop, animated)
  if (align === 'end') {
    return setScrollTop(element, Math.max(rowBottom - element.clientHeight, 0), animated)
  }
  if (rowTop < viewTop) setScrollTop(element, rowTop, animated)
  else if (rowBottom > viewBottom) setScrollTop(element, rowBottom - element.clientHeight, animated)
  else if (animated) setScrollTop(element, viewTop, false)
}

/**
 * The zoom's own flight: a step moves `scale` to the next rung over `ZOOM_MS`
 * rather than jumping to it, so the wall grows into its new size. Each frame is
 * re-measured, because the size is the whole geometry — the columns that fit,
 * the pitch the rows are placed at, the page arithmetic — and it is re-revealed
 * on the cursor, so what the user is looking at stays put while everything
 * around it changes size. The model wall needs no telling: it measures each
 * tile's box every frame, so the turning models grow with the boxes.
 */
let zoomFrame = 0

function animateScaleTo(target: number): void {
  cancelAnimationFrame(zoomFrame)
  const from = scale.value
  if (from === target) return

  const start = performance.now()
  const step = (now: number): void => {
    const t = Math.min((now - start) / ZOOM_MS, 1)
    scale.value = t < 1 ? from + (target - from) * (1 - Math.pow(1 - t, 3)) : target
    measure()
    scrollCellIntoView(props.controller.state.cursor, 'nearest')
    if (t < 1) zoomFrame = requestAnimationFrame(step)
  }
  zoomFrame = requestAnimationFrame(step)
}

/** A step of the size ladder (Ctrl+= / Ctrl+- / Ctrl+0) is a resize, animated. */
watch(
  () => props.controller.state.thumbStep,
  (step) => animateScaleTo(thumbScaleFor(step))
)

/**
 * Follow the cursor to its cell — on a move, a page jump, and on arriving in a
 * new directory. A navigation clears what was read for the previous listing
 * first, since those pictures are for rows that are gone.
 */
let lastPath = props.controller.state.path

watch(
  [() => props.controller.state.path, () => props.controller.state.cursor],
  async () => {
    if (props.controller.state.path !== lastPath) {
      lastPath = props.controller.state.path
      epoch += 1
      tiles.clear()
      modelStatus.clear()
      wanted = []
      wantedKeys.clear()
      if (listEl.value) listEl.value.scrollTop = 0
      scrollTop.value = 0
    }
    const { cursor, scrollAlign, animateScroll } = props.controller.state
    props.controller.state.scrollAlign = 'nearest'
    props.controller.state.animateScroll = false
    await nextTick()
    scrollCellIntoView(cursor, scrollAlign, animateScroll)
  }
)

let observer: ResizeObserver | null = null

onMounted(() => {
  // Measured synchronously, before this flush ends, so the first layout the pane
  // can see is the measured one: a mode morph snapshots the page at the next
  // frame, and a grid still on one column for a microtask would be captured — and
  // flown to — at the wrong shape.
  measure()
  if (listEl.value) {
    observer = new ResizeObserver(measure)
    observer.observe(listEl.value)
  }
  scrollCellIntoView(props.controller.state.cursor, 'nearest')
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  cancelAnimationFrame(scrollAnimation)
  cancelAnimationFrame(zoomFrame)
})

/**
 * The cursor's tile box, in the page's own coordinates — what a display grows
 * out of in the wall, where there is no footer preview to grow from. Null when
 * that tile is not in the document (scrolled out, or a listing just replaced),
 * which leaves the reveal to appear in place, as it does anywhere there is no
 * thumbnail to fly from.
 */
function cellRect(): DOMRect | null {
  const path = props.controller.state.entries[props.controller.state.cursor]?.path
  const list = listEl.value
  if (!path || !list) return null

  const cell = list.querySelector<HTMLElement>(`li[data-path="${CSS.escape(path)}"]`)
  const box = cell?.firstElementChild
  if (!(box instanceof HTMLElement)) return null

  const rect = box.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0 ? rect : null
}

/**
 * Hide the model tiles' canvas, for the moment a mode morph is captured. The
 * canvas is not part of any named tile — it lies over them — so a live one is the
 * one thing the flight cannot carry: it would be copied whole into the morph, and
 * left floating in the root snapshot while the named tile boxes flew out from
 * under it. The pane is leaving the wall whenever this is called, so nothing has
 * to be shown again.
 */
function hideModels(): void {
  const canvasEl = listEl.value?.parentElement?.querySelector('canvas')
  if (canvasEl instanceof HTMLElement) canvasEl.style.visibility = 'hidden'
}

defineExpose({ cellRect, hideModels })

// --- Drawing ---------------------------------------------------------------

function cellClass(index: number): string {
  const entry = entries.value[index]
  const cursor = index === props.controller.state.cursor
  const cursorBand = props.active ? 'bg-accent text-fg-bright' : 'bg-selection-inactive text-fg'

  let base: string
  if (entry && props.controller.isSelected(entry)) {
    base = cursor ? `${cursorBand} row-mark` : 'bg-marked'
  } else if (cursor) {
    base = cursorBand
  } else {
    base = 'text-fg hover:bg-hover'
  }

  const flash = entry && props.controller.state.fresh.has(entry.path) ? ' flash-row' : ''
  return `${base}${flash}`
}

function nameClass(index: number): string {
  const entry = entries.value[index]
  if (!entry) return ''
  return isRunnable(entry) ? 'text-runnable' : ''
}

/** The entrance class a tile at `order` in the window carries, or none. */
function enterClass(order: number): string {
  return props.enter === true && order < VIEW_ENTER_MAX ? 'view-entry' : ''
}

/** Its step, so the tiles arrive one behind another rather than together. */
function enterStyle(order: number): { animationDelay: string } | null {
  if (props.enter !== true || order >= VIEW_ENTER_MAX) return null
  return { animationDelay: `${order * VIEW_ENTER_STEP_MS}ms` }
}
</script>

<template>
  <div class="relative flex min-h-0 flex-1">
    <ul
      ref="listEl"
      data-list
      class="pane-scrollbar relative grid min-h-0 flex-1 overflow-y-auto"
      :style="gridStyle"
      @scroll="onScroll"
    >
      <li
        v-for="(cell, order) in visibleCells"
        :key="cell.entry.path"
        :data-path="cell.entry.path"
        class="relative flex min-w-0 cursor-default flex-col items-center gap-1 rounded p-1"
        :style="[enterStyle(order), { viewTransitionName: nameFor(cell.entry.path) }]"
        :class="[cellClass(cell.index), enterClass(order)]"
        @mousedown.left="emit('left-down', cell.index)"
        @mousedown.right="emit('right-down', cell.index, $event)"
        @mouseenter="emit('enter', cell.index)"
        @dblclick="emit('activate')"
        @contextmenu.prevent
      >
        <!-- The picture box: a thumbnail where one was read, the entry's own icon
             where none can be, and a spinner only until the read settles. A 3D
             model's box is named by `data-model-key`, which is how the one shared
             renderer finds where to paint each model (`ModelWall`). -->
        <span
          class="relative flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden rounded border border-border-subtle bg-bg [&_svg]:h-8 [&_svg]:w-8"
          :data-model-key="cell.kind === 'model' ? domKey(cell.key) : undefined"
        >
          <img
            v-if="cell.kind !== 'model' && tileUrl(cell.entry)"
            :src="tileUrl(cell.entry)"
            alt=""
            draggable="false"
            class="h-full w-full object-contain"
          />
          <FileIcon
            v-else-if="
              cell.kind === 'model'
                ? modelStatus.get(cell.key) === 'error'
                : tileSettled(cell.entry)
            "
            :entry="cell.entry"
          />
          <!-- Nothing is drawn for a model whose renderer is ready: the wall's
               canvas paints it, over this box. -->
          <span
            v-else-if="cell.kind !== 'model' || modelStatus.get(cell.key) !== 'ready'"
            class="h-3.5 w-3.5 animate-spin rounded-full border border-fg border-t-transparent"
          />

          <!-- The row's git mark, the same dot the listing draws on its icon: the
               status's colour, filled for the entry and a ring for a folder that
               holds what changed, in the picture box's bottom-right corner. The
               model wall's canvas is over this box, but a model is framed inside a
               sphere with margin, so its silhouette never reaches the corner — the
               transparent canvas there lets the dot read. -->
          <span
            v-if="cell.git"
            class="absolute right-1 bottom-1 h-1.5 w-1.5 rounded-full border"
            :style="dotStyle(cell.git, true)"
            :title="markTitle(cell.git.mark, cell.git.count, cell.git.rollup)"
          />
        </span>

        <span
          class="w-full shrink-0 truncate text-center text-ui-sm"
          :class="nameClass(cell.index)"
          :title="cell.entry.name"
        >
          {{ cell.entry.name }}
        </span>
      </li>
    </ul>

    <!-- One renderer for every 3D tile, laid over the grid: fetched only where
         the folder could hold a model, so three.js is not loaded for a folder of
         pictures. -->
    <ModelWall
      v-if="hasModels"
      :viewport="listEl"
      :cells="modelCells"
      @status="onModelStatus"
    />
  </div>
</template>
