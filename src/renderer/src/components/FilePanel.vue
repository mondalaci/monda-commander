<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import type { PaneController, PaneEntry, ScrollAlign, SortKey } from '@renderer/composables/useDirectory'
import { COLUMN_TYPES } from '@renderer/composables/useDirectory'
import { isRunnable } from '@renderer/lib/executable'
import { canMorphView, withViewTransition } from '@renderer/lib/viewTransition'
import { playHideAnimation } from '@renderer/lib/hideAnimation'
import {
  formatDuration,
  formatExactDate,
  formatMode,
  formatModeNumeric,
  formatRelativeDate,
  formatSize,
  sizeColor
} from '@renderer/lib/format'
import {
  probeVideoCodec,
  previewKeyFor,
  previewTargetFor,
  type OsdFlash,
  type PlaybackClock,
  type PreviewKind,
  type PreviewTarget,
  type StageRequest
} from '@renderer/lib/preview'
import {
  ensurePdfInfo,
  pdfLayoutFor,
  pdfPageCountFor,
  pdfPageFor,
  pdfSizeHintFor,
  setPdfPage,
  stepPdfPage
} from '@renderer/lib/pdf'
import { injectTargetApi } from '@renderer/lib/targetContext'
import type { PaneMenuRequest } from '@renderer/lib/paneMenu'
import {
  dotStyle,
  markSummary,
  markTitle,
  rowMarkFor,
  sideColor,
  type GitRowMark
} from '@renderer/lib/gitMark'
import FileIcon from '@renderer/components/FileIcon.vue'
import ThumbnailGrid from '@renderer/components/ThumbnailGrid.vue'
import DiskUsage from '@renderer/components/DiskUsage.vue'
import ColumnAddButton from '@renderer/components/ColumnAddButton.vue'
import ColumnDropMarker from '@renderer/components/ColumnDropMarker.vue'
import HoldRing from '@renderer/components/HoldRing.vue'
import PlaybackOsd from '@renderer/components/PlaybackOsd.vue'
import { hideMode } from '@renderer/composables/useHideMode'
import { pdfView, setPdfFit, setPdfZoom } from '@renderer/composables/usePdfView'
import { archiveDisplay } from '@shared/archive'
import { HIDE_MODE_OFF_TOOLTIP, HIDE_MODE_TOOLTIP } from '@shared/hide'
import { QUICK_CD_LEAVE_TOOLTIP, QUICK_CD_TOOLTIP } from '@shared/quickCd'
import {
  VIEW_ENTER_MAX,
  VIEW_ENTER_MS,
  VIEW_ENTER_STEP_MS,
  VIEW_MODE_TOOLTIP
} from '@shared/viewMode'
import {
  nextPdfZoom,
  PDF_FIT_PAGE_KEY,
  PDF_FIT_WIDTH_KEY,
  PDF_MAX_SCALE,
  PDF_MIN_SCALE,
  PDF_ZOOM_IN_KEY,
  PDF_ZOOM_OUT_KEY,
  PDF_ZOOM_TOOLTIP
} from '@shared/pdf'
import { MEDIA_SCHEME } from '@shared/video'
import type {
  DiskUsage as DiskUsageInfo,
  ModelData,
  PdfPageText,
  PdfWord,
  PixelSize
} from '@shared/types'

/**
 * The 3D model viewer is fetched on demand: three.js is a large library that only
 * a model preview needs, so it is kept out of the renderer's main chunk and
 * loaded when a row is actually a model — exactly as Monaco is kept out of it.
 * The panes show a spinner in the reserved box until it lands, as they do while
 * any other preview is read.
 */
const ModelViewer = defineAsyncComponent(() => import('@renderer/components/ModelViewer.vue'))

const ROW_HEIGHT = 22

/**
 * How far into a row a menu opened from the keyboard is anchored: past the icon,
 * at the name, which is what the row leads with and what the menu's header says.
 */
const ROW_INSET_X = 34

/**
 * `idle` is no previewable file under the cursor, `probing` is a shape that is
 * not known yet, `loading` is a reserved box with the picture on its way, and
 * the last two are terminal.
 */
type PreviewState = 'idle' | 'probing' | 'loading' | 'ready' | 'failed'

const props = defineProps<{
  controller: PaneController
  active: boolean
  stage?: StageRequest | null
  /**
   * Whether the media under this pane's cursor is being shown at full size in
   * the other pane. It is played there and only there — a second element would
   * decode it twice to draw the same thing — so this pane keeps the space its
   * preview had and reads the position from the display instead.
   */
  transferred?: boolean
  displayedClock?: PlaybackClock | null
  /**
   * Whether this pane is the display for the other pane's cursor — the mode,
   * rather than a particular file: its own content stays blurred and its listing
   * stays covered for as long as the mode is on, even while the cursor is on a
   * row there is nothing to show for.
   */
  displaying?: boolean
  /**
   * Whether that display fills the whole window rather than this pane — the
   * full-screen viewing mode. It is a presentation of the same display, not a
   * different one: only the box the media and its transport are laid out in
   * changes, and only while there is something being displayed.
   */
  fullscreen?: boolean
}>()

const emit = defineEmits<{
  (event: 'select'): void
  (event: 'pointer-down'): void
  (event: 'activate'): void
  /** A triple-click on a media file's name: open it in the full-screen viewer. */
  (event: 'fullscreen'): void
  /** A double-click on the displayed media: switch it between the pane and the whole window. */
  (event: 'toggle-fullscreen'): void
  /** A wheel outside the media: step the pane the display is showing for, by `delta` rows. */
  (event: 'step', delta: number): void
  (event: 'stage-clock', clock: PlaybackClock | null): void
  (event: 'stage-on'): void
  (event: 'stage-off'): void
  /**
   * A row has asked for its menu — a long right-press, Ctrl+right-click, or the
   * keyboard's Shift+F10 by way of `cursorMenuAnchor`. The menu itself is the
   * app's: it holds the operations the pane has no business owning.
   */
  (event: 'context-menu', request: PaneMenuRequest): void
}>()

// The target this pane lives on, so a preview reads the file where it actually
// is. Listing and operations go through the pane's own controller; these are the
// few calls the view makes itself (a preview's bytes, a clip's length).
const api = injectTargetApi()

/**
 * How full this pane's filesystem is, drawn in the title bar left of the hide
 * icon. It is re-read whenever the pane lands somewhere new or its listing is
 * refreshed (a transfer that fills the disk should move the meter), and a token
 * keeps a slow answer for a directory already left from landing on the new one.
 */
const diskUsage = ref<DiskUsageInfo | null>(null)
let diskUsageToken = 0

async function loadDiskUsage(path: string): Promise<void> {
  const token = ++diskUsageToken
  if (!path) {
    diskUsage.value = null
    return
  }
  const result = await api.fs.diskUsage(path)
  if (token !== diskUsageToken) return
  diskUsage.value = result.ok ? result.data : null
}

watch(
  () => [props.controller.state.path, props.controller.state.allEntries] as const,
  () => void loadDiskUsage(props.controller.state.path),
  { immediate: true }
)

const listEl = ref<HTMLUListElement | null>(null)
const footerEl = ref<HTMLElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)
/** The pane's own box, for telling a click that landed in it from one that did not. */
const sectionEl = ref<HTMLElement | null>(null)
/**
 * The wall, when the pane is drawing one. A display is revealed out of the
 * cursor's *tile* rather than the footer's little box, which the wall does not
 * have for a model — so the pane reaches into the grid for the rectangle to grow
 * from.
 */
const gridEl = ref<InstanceType<typeof ThumbnailGrid> | null>(null)

/**
 * The listing is windowed rather than rendered whole: a directory can hold tens
 * of thousands of entries, and one DOM row (plus its icon, name, size and date)
 * each is a cost paid on every navigation, every cursor move and every refresh.
 * Only the rows the viewport can show — plus an overscan band, so a fast scroll
 * never flashes a blank strip — are in the document; the rows above and below are
 * two spacers of their exact height, which keeps the scrollbar honest and the
 * fixed `ROW_HEIGHT` arithmetic (`scrollRowIntoView`, `measureListSlack`) valid.
 */
const OVERSCAN_ROWS = 10

/** Where the listing is scrolled to, kept from its own scroll events. */
const scrollTop = ref(0)

/**
 * How tall the listing's viewport is, measured with the rows. Zero before the
 * first measurement, where a window of `VIEWPORT_FALLBACK_ROWS` stands in so the
 * first paint is never empty.
 */
const viewportHeight = ref(0)
const VIEWPORT_FALLBACK_ROWS = 60

// The footer mirrors the status of this pane's own cursor and marks.
const entry = computed(() => props.controller.current())
const selectedCount = computed(() => props.controller.selectedCount())
const selectedSize = computed(() => props.controller.selectedSize())

/**
 * What the marked entries add up to, as the footer shows it. A total that leaves
 * a marked folder's contents uncounted reads as a lower bound (`≥`), so an
 * unsized folder is never taken for an empty one.
 */
const selectedSizeText = computed(() => {
  const { bytes, partial } = selectedSize.value
  return `${partial ? '≥ ' : ''}${formatSize(bytes)}`
})

/**
 * Whether this directory has a hide list at all — a `.mchide` file naming
 * entries. It is what puts the mode's icon in the title bar; whether that icon
 * reads as on or off is the app-wide mode, which `hideMode` carries.
 */
const hideListed = computed(() => props.controller.state.hideNames.size > 0)

/**
 * The column the listing is ordered by, and the way it runs. The header draws
 * the direction beside the column in use, and clicking a header asks the pane to
 * re-order — the pane owns the choice, so it survives this view being remounted
 * and stays with the directory it was made in.
 */
const sortKey = computed(() => props.controller.state.sortKey)
const sortDir = computed(() => props.controller.state.sortDir)

/**
 * The arrow beside a sorted column: a downward one for ascending, an upward one
 * for descending. It is drawn only on the column in use, so an unsorted header
 * says nothing about an order it is not part of.
 */
function sortArrow(key: SortKey): string | null {
  if (sortKey.value !== key) return null
  return sortDir.value === 'asc' ? '↓' : '↑'
}

function onSortClick(key: SortKey): void {
  props.controller.sortBy(key)
}

/**
 * The columns left to right, which the header, the rows and the drag all read
 * from one place: a dropped header reorders this, and both the header and every
 * row's cells follow it, so a column can never be shown in one and not the other.
 */
const columnOrder = computed(() => props.controller.state.columnOrder)

/** Whether the pane is showing the quick cd list instead of its directory. */
const quickCdMode = computed(() => props.controller.state.quickCd)

/**
 * Whether the pane is drawing its rows as a wall of thumbnails. The quick cd
 * list forces the detail listing (its rows are paths and nothing else), so the
 * mode stands aside while it is up.
 */
const thumbnails = computed(
  () => props.controller.state.viewMode === 'thumbnails' && !quickCdMode.value
)

/**
 * Whether a view switch is being shown as its entries arriving. It is raised when
 * the mode changes and dropped once the staggered entrance is over, so only the
 * layout the switch put on screen animates: an entry the viewport reveals later —
 * a scroll, a resize — is simply there (`styles/view.css`). The same flag drives
 * the listing's rows and, through the `enter` prop, the grid's tiles.
 */
const viewEnter = ref(false)
let viewEnterTimer = 0

watch(
  () => props.controller.state.viewMode,
  () => {
    // Where the browser can morph the switch — the entries flying to their new
    // place (`lib/viewTransition.ts`) — that *is* the switch's animation, and a
    // staggered fade on top of it would fight the snapshot. The fade is the
    // fallback for an engine without a view transition.
    if (canMorphView()) return
    viewEnter.value = true
    window.clearTimeout(viewEnterTimer)
    viewEnterTimer = window.setTimeout(() => {
      viewEnter.value = false
    }, VIEW_ENTER_MS)
  }
)

/**
 * The `view-transition-name` an entry carries, so a morph can match the row it
 * was to the tile it becomes. Names must be unique in the document, so they are
 * assigned in first-seen order and prefixed with the pane's side rather than
 * derived from the path — two panes can show one folder.
 */
const entryNames = new Map<string, string>()
let entryNameSeq = 0

function entryName(path: string): string {
  // Only the pane being switched carries names: the other pane's entries would be
  // captured for a morph that does not involve them, each at the price of its own
  // snapshot group and for no motion at all. `none` is the CSS way to stay out of
  // the transition, and the pane that is switched is the active one.
  if (!props.active) return 'none'

  let name = entryNames.get(path)
  if (name === undefined) {
    entryNameSeq += 1
    name = `entry-${props.controller.state.side}-${entryNameSeq}`
    entryNames.set(path, name)
  }
  return name
}

/**
 * Switch this pane's view. The change runs inside a view transition where there
 * is one, so the entries morph from the layout being left to the one arriving
 * rather than the two exchanging in a single frame.
 */
function toggleView(): void {
  // Leaving the wall, its canvas goes before the old state is captured. A live
  // WebGL canvas is the one thing the flight cannot carry: it is not part of any
  // named tile — it lies *over* them — so it would be copied whole into the morph
  // and left floating in the root snapshot while the named boxes flew out from
  // under it. Hidden, the tiles travel as the boxes they are, and the fleet of
  // models costs the flight nothing.
  if (thumbnails.value) gridEl.value?.hideModels()

  withViewTransition(async () => {
    props.controller.toggleViewMode()
    // The API waits for this promise, so the tick that lets Vue build the new
    // layout has to be inside it — the "after" snapshot must be of that layout.
    await nextTick()
  })
}

/**
 * The wheel on the view button sizes the wall, when there is a wall to size: a
 * wheel-up is the `Ctrl+=` rung and a wheel-down `Ctrl+-`, so the button is the
 * same zoom by pointer as the keys. Only the wall answers it — in the listing
 * there is no tile to grow, and the wheel over the title is left to whatever is
 * behind it — and only the vertical axis, which is the one every wheel has. The
 * event is swallowed so the title bar's wheel does not scroll the pane's rows.
 */
function onViewButtonWheel(event: WheelEvent): void {
  if (!thumbnails.value || event.deltaY === 0) return
  event.preventDefault()
  event.stopPropagation()
  props.controller.stepTileScale(event.deltaY < 0 ? 1 : -1)
}

/** The entrance class an entry at `order` in the window carries, or none. */
function viewEnterClass(order: number): string {
  return viewEnter.value && order < VIEW_ENTER_MAX ? 'view-entry' : ''
}

/** Its step, so the entries arrive one behind another rather than together. */
function viewEnterStyle(order: number): { animationDelay: string } | null {
  if (!viewEnter.value || order >= VIEW_ENTER_MAX) return null
  return { animationDelay: `${order * VIEW_ENTER_STEP_MS}ms` }
}

/**
 * The columns a row draws. The quick cd list shows only the directory's path —
 * in the name column — because a bookmark has no size, date or mode of its own to
 * put in the others, and the header that would label them is hidden with them.
 */
const displayColumns = computed<SortKey[]>(() =>
  quickCdMode.value ? ['name'] : columnOrder.value
)

/** The heading each column is labelled with, wherever it has been dragged to. */
const COLUMN_LABELS: Record<SortKey, string> = {
  name: 'Name',
  size: 'Size',
  modified: 'Modified',
  mode: 'Mode',
  modeNumeric: 'Mode (num)'
}

/** Whether the pane is building its columns, rather than reading them. */
const columnEdit = computed(() => props.controller.state.columnEdit)

/** The column the editor's keys are on, for the click-and-keyboard highlight. */
const columnFocus = computed(() => props.controller.state.columnFocus)

/**
 * Whether another column can be added: a type the pane does not already show is
 * left. Types are unique, so every one is on screen exactly once at most, and
 * the add buttons go quiet once there is nothing left to add.
 */
const canAddColumn = computed(() =>
  COLUMN_TYPES.some((key) => !columnOrder.value.includes(key))
)

/**
 * How a column's header is laid out: the name takes the room left over and its
 * text leads, while the metadata columns keep their measured widths and align
 * their text, matching the cells below them.
 */
function headerClass(key: SortKey): string {
  switch (key) {
    case 'name':
      return 'min-w-0 flex-1 gap-1.5 text-left'
    case 'size':
      return 'w-16 shrink-0 justify-end gap-1'
    case 'modified':
      return 'w-24 shrink-0 justify-end gap-1'
    default:
      return 'w-20 shrink-0 justify-end gap-1'
  }
}

/**
 * How a column's editor is laid out. The reader header matches the cell widths
 * below it, but an editor has a grip, a picker and a button in it, so it is
 * given the room its own controls need — the name column, as always, taking the
 * slack. The rows' own cells keep their widths throughout, so the listing never
 * moves while it is being edited.
 */
function editorClass(key: SortKey): string {
  return key === 'name' ? 'min-w-0 flex-1' : 'shrink-0'
}

/**
 * The header being dragged, and the gap it would be dropped into. The dragged
 * column says what would move; the gap is where the insertion point is drawn and
 * is what the drop uses — the gesture says *between which columns*, never "onto
 * this one".
 */
const draggingColumn = ref<SortKey | null>(null)
const dropIndex = ref<number | null>(null)

/**
 * Where the insertion marker is drawn, in the header's own coordinates, or null
 * while there is nothing to point at. It is one element rather than a copy per
 * column because it overshoots the header's top — the triangle hangs over the
 * title above — and only the header's own box can hold something that does.
 */
const dropMarkerX = ref<number | null>(null)

/** The header row, for measuring the columns against the pointer. */
const headerEl = ref<HTMLElement | null>(null)

/**
 * When the last column drag ended, so a click the browser still delivers after
 * it can be told from a real one. A header is both sortable and draggable, and
 * without this a reorder would also re-sort the listing on the drop.
 */
let columnDragEndedAt = 0

function onColumnDragStart(key: SortKey, event: DragEvent): void {
  const target = event.currentTarget
  if (!(target instanceof HTMLElement)) return
  beginColumnDrag(key, event, target)
}

/**
 * The column editor's own drag: a reader header is grabbed by its whole button,
 * but an editor holds a picker and two buttons, so it is grabbed by a small
 * handle instead and the whole column is what travels. The column's wrapper is
 * the ghost, not the handle, and it is also what `onHeaderDragOver` measures, so
 * the gap a drop lands in is read from the columns rather than from a grip.
 */
function onColumnEditDragStart(key: SortKey, event: DragEvent): void {
  const handle = event.currentTarget
  if (!(handle instanceof HTMLElement)) return
  const column = handle.closest<HTMLElement>('[data-column]')
  beginColumnDrag(key, event, column ?? handle)
}

/**
 * Start a column drag: say which column it is, and hand the browser a legible
 * image of what is moving. The image the browser would lift on its own is bare
 * text (a header is a transparent button) or a lone grip (an editor), so a chip
 * is built instead — the source on a solid background, the way the column reads
 * in the bar — so what is being dragged stays legible over whatever it passes.
 * The clone is laid out offscreen (it must be in the document to be painted) and
 * taken away once the browser has captured it.
 */
function beginColumnDrag(key: SortKey, event: DragEvent, source: HTMLElement): void {
  draggingColumn.value = key

  const data = event.dataTransfer
  if (!data) return

  data.effectAllowed = 'move'
  // Some platforms need a payload for the drop to be allowed at all; the key is
  // the only thing it could mean.
  data.setData('text/plain', key)

  const ghost = source.cloneNode(true) as HTMLElement
  ghost.removeAttribute('data-column')
  ghost.removeAttribute('draggable')
  for (const nested of ghost.querySelectorAll('[draggable]')) nested.removeAttribute('draggable')
  Object.assign(ghost.style, {
    position: 'fixed',
    top: '-1000px',
    left: '-1000px',
    height: `${source.offsetHeight}px`,
    boxSizing: 'border-box',
    padding: '0 6px',
    background: 'var(--color-surface-2)',
    color: 'var(--color-fg-bright)',
    border: '1px solid var(--color-accent-strong)',
    borderRadius: '3px',
    boxShadow: '0 2px 6px rgba(0, 0, 0, 0.45)',
    opacity: '1'
  })
  document.body.appendChild(ghost)
  data.setDragImage(ghost, ghost.offsetWidth / 2, ghost.offsetHeight / 2)
  window.setTimeout(() => ghost.remove(), 0)
}

/**
 * Where the dragged column would land: the gap nearest the pointer, read from
 * which column's midpoint the pointer has passed. Measuring the columns rather
 * than the gap under the pointer is what keeps a fast drag honest — the pointer
 * may be over no column at all between two of them, and the nearest midpoint
 * still names the gap it means.
 *
 * The marker's x is read here too — the boundary the gap sits on, in the header's
 * own coordinates — and left null for the two gaps beside the dragged column
 * itself, where a drop would move nothing, exactly as the marker used to be
 * hidden for them.
 */
function onHeaderDragOver(event: DragEvent): void {
  if (draggingColumn.value === null) return
  const container = headerEl.value
  if (container === null) return

  const columns = container.querySelectorAll<HTMLElement>('[data-column]')
  let index = columns.length
  for (let i = 0; i < columns.length; i += 1) {
    const rect = columns[i]!.getBoundingClientRect()
    if (event.clientX < rect.left + rect.width / 2) {
      index = i
      break
    }
  }
  dropIndex.value = index

  if (gapIsNoop(index) || columns.length === 0) {
    dropMarkerX.value = null
    return
  }

  const boundary =
    index >= columns.length
      ? columns[columns.length - 1]!.getBoundingClientRect().right
      : columns[index]!.getBoundingClientRect().left
  dropMarkerX.value = boundary - container.getBoundingClientRect().left
}

function onHeaderDrop(): void {
  const from = draggingColumn.value
  const to = dropIndex.value
  if (from !== null && to !== null) props.controller.moveColumn(from, to)
  onColumnDragEnd()
}

/**
 * Whether a gap is where the dragged column already sits — its own before-gap or
 * after-gap. Dropping there can change nothing, so no insertion point is shown
 * for it and the gesture does not offer a place it would not move to.
 */
function gapIsNoop(index: number): boolean {
  const from = draggingColumn.value
  if (from === null) return false
  const at = columnOrder.value.indexOf(from)
  return index === at || index === at + 1
}

function onColumnDragEnd(): void {
  draggingColumn.value = null
  dropIndex.value = null
  dropMarkerX.value = null
  columnDragEndedAt = performance.now()
  releaseHeaderFocus()
}

/**
 * Hand the keyboard back after a header was used. A header is a real button, so
 * clicking it leaves DOM focus on it — where typing would go nowhere and the
 * command line would render unfocused. Blurring it lands focus on the body,
 * which the app's own focus model re-claims for the command line, exactly as a
 * click on any other piece of chrome does. Dragging must not `preventDefault`
 * its mousedown — that would cancel the drag — so the focus is given back here
 * instead, once the gesture is over.
 */
function releaseHeaderFocus(): void {
  const active = document.activeElement
  if (active instanceof HTMLElement && active.closest('.pane-header-gutter')) active.blur()
}

function onHeaderClick(key: SortKey): void {
  // A drop can be followed by a click on the header it landed on; a gesture that
  // only just ended a drag is that click, not a request to sort.
  if (performance.now() - columnDragEndedAt < 250) {
    releaseHeaderFocus()
    return
  }
  onSortClick(key)
  releaseHeaderFocus()
}

/**
 * The column editor's own controls, which replace the sortable headers while the
 * mode is on. They are the pane's own chrome like the headers are, so they hand
 * the keyboard back once used and leave the list itself untouched: a column is
 * added, dropped or re-typed in place, and the rows go on showing what they did.
 */
function onToggleColumnEdit(): void {
  props.controller.toggleColumnEdit()
  releaseHeaderFocus()
}

/**
 * Add a column and open the new column's picker, so the gesture that made the
 * column is also the one that says what it is. The add is a real click, so the
 * transient user activation is still there when the picker is asked to open a
 * tick later; a platform without the picker's `showPicker` simply gets the
 * focused control the user can open themselves.
 */
async function onAddColumn(gapIndex: number): Promise<void> {
  const index = props.controller.addColumn(gapIndex)
  if (index === null) return

  await nextTick()
  openPickerAt(index)
}

/**
 * Focus a column's type picker and ask it to open. The native list is the point
 * of the picker, and only the browser can put it on screen; a platform without
 * `showPicker` simply gets the focused control, which the user opens themselves.
 */
function openPickerAt(index: number): void {
  const select = headerEl.value?.querySelectorAll<HTMLSelectElement>('select.column-select')[
    index
  ]
  if (!select) return

  select.focus()
  try {
    // The DOM lib does not carry `showPicker` on every TypeScript it is checked
    // against, so it is asked for by name rather than through the type.
    ;(select as HTMLSelectElement & { showPicker?: () => void }).showPicker?.()
  } catch {
    // A refused picker is not a failure: the control is focused either way.
  }
}

/**
 * The keyboard's own gestures, which act on the focused column. They are the
 * pane's DOM rather than its state — the picker and the header element live here
 * — so the app calls back into the pane for them, the way it does for the menu
 * anchor and the preview rectangles.
 */
function openColumnPicker(): void {
  openPickerAt(props.controller.state.columnFocus)
}

function addColumnAtFocus(): void {
  void onAddColumn(props.controller.state.columnFocus + 1)
}

function onRemoveColumn(index: number): void {
  props.controller.removeColumn(index)
  releaseHeaderFocus()
}

/**
 * A press anywhere on a column's capsule aims the editor's keyboard at it, so a
 * click and the arrows agree on which column is "this one". The picker stops the
 * press itself (its own `mousedown` handler runs this and stops propagation), for
 * the same reason it stops the pane's handler: so the native list can open.
 */
function onColumnFocusMouse(index: number): void {
  props.controller.setColumnFocus(index)
}

function onColumnTypeChange(index: number, event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLSelectElement)) return
  props.controller.setColumnType(index, target.value as SortKey)
  releaseHeaderFocus()
}

/**
 * How the mode column's own cell is laid out, matching the header above it so the
 * columns line up whichever of them are shown. It is set in the mono font, which
 * is what keeps the permission groups over one another.
 */
function cellClass(): string {
  return 'w-20 shrink-0 text-right font-mono text-fg'
}

/**
 * The mode column's text for a row: the permission bits, drawn symbolically or
 * in octal depending on which of the two mode columns this is. The ".." row
 * carries none of it — it names the folder above rather than an entry in this one
 * — so it reads blank.
 */
function cellText(entry: PaneEntry, key: SortKey): string {
  if (entry.isParent) return ''
  return key === 'modeNumeric' ? formatModeNumeric(entry.mode) : formatMode(entry.mode)
}

/**
 * The row this pane's footer previews: the cursor row when it is a regular file
 * the renderer can show — an image, or a video.
 */
const previewTarget = computed(() => {
  const target = previewTargetFor(entry.value)
  // A clip is streamed by main from a real local file (`mc-media`); on a remote
  // target that stream would serve a same-named local file. Images are read
  // through the target's own API, so they preview safely; a clip does not.
  if (target && target.kind !== 'image' && api.target.kind !== 'local') return null
  // The wall already draws the cursor's model in its own tile, with the one
  // renderer it holds. A footer viewer would mount a *second* WebGL context and
  // read and parse the file again on every step between two models — and that
  // per-step work is exactly what the wall's own rotation stutters on. So in the
  // wall a model keeps no footer preview; Enter and Ctrl+Enter still enlarge it.
  if (target && target.kind === 'model' && thumbnails.value) return null
  return target
})

/**
 * The pane title as an archive location, or null when the pane is on a real
 * directory. The chip this drives is what tells the two apart: a folder named
 * `foo.zip` shows the plain path and nothing else, while being *inside* the
 * archive `foo.zip` shows the archive's name in a chip before the entry path.
 * The full archive path is carried for the chip's own tooltip.
 */
const archiveTitle = computed(() => archiveDisplay(props.controller.state.path))

/**
 * Where the preview for the row in hand has got to. `probing` is "the shape is
 * not known yet", `loading` is "the box is reserved and the picture is on its
 * way", and `failed` releases the space again. The box is shown for `loading`
 * and `ready` only: the default ratio-less frame is then never on screen on the
 * way to a preview.
 */
const previewState = ref<PreviewState>('idle')

/** The shape being reserved, from the image header or the video's metadata. */
const sizeHint = ref<PixelSize | null>(null)

/** An image's bytes, as a `data:` URL, once read. */
const frame = ref<string | null>(null)

/**
 * A PDF's current page, rasterized by main, as a PNG `data:` URL. The document's
 * page is not read here because it cannot be: a PDF is not one picture, and the
 * box only needs the one page it is showing.
 */
const pdfFrame = ref<string | null>(null)

/**
 * A 3D model's bytes and format, once main has read (or converted) it. Unlike a
 * picture's frame this is not something to draw directly: the viewer parses it
 * into a scene, so it is kept as the payload main handed over and handed on
 * again, and rebuilt only when the row under the cursor changes.
 */
const modelData = ref<ModelData | null>(null)

/**
 * How wide a page is rasterized for the footer thumbnail. The box is at most
 * 160px wide, so this is a few times that — enough for a crisp thumbnail on a
 * retina display without rendering a display-sized page for a small box.
 */
const PDF_PREVIEW_WIDTH = 320

/**
 * How a PDF is laid out in a display. The document is a vertical stack of pages
 * at the width of the pane, `PDF_PAGE_GAP` apart, with `PDF_PAGE_PAD` above the
 * first and below the last. Pages are only in the document near the viewport
 * (`PDF_WINDOW_OVERSCAN` pages beyond it on each side), so a thousand-page document
 * renders the two or three pages being looked at — and it is the *raster* that is
 * capped (`PDF_RENDER_MAX`), not the layout, so a page may be drawn wider than the
 * raster it came from on a very wide pane rather than stopping short of the width.
 */
const PDF_PAGE_GAP = 12
const PDF_PAGE_PAD = 12
const PDF_WINDOW_OVERSCAN = 1

/**
 * The width a page is rasterized at, in device pixels, snapped to a step so a
 * resized pane re-renders on a stable set of widths rather than one per pixel.
 */
const PDF_RENDER_STEP = 40
const PDF_RENDER_MAX = 2400
const PDF_RENDER_MIN = 320

/**
 * How many rendered pages and how many pages' text a display keeps in the
 * renderer. Main caches them too, but a scroll back over a page should not have to
 * cross the bridge again; the bounds are small because only a windowful is ever on
 * screen. How many may be fetched at once is bounded too, so a fast scroll across
 * a long document does not start a run for every page it flies past.
 */
const PDF_FRAME_CACHE_MAX = 12
const PDF_TEXT_CACHE_MAX = 24
const PDF_MAX_INFLIGHT = 4


/**
 * Whether the cursor has held still on this row long enough to start loading
 * it. A video begins fetching the moment its element is mounted, so mounting it
 * is what this gates — the same discipline the read gets for an image.
 */
const settled = ref(false)

/**
 * Whether the footer is at its tall size. It is, from the moment the cursor is
 * on media — the extension says so, before anything has been read — so stepping
 * between clips never collapses the strip and pushes the list back up.
 */
const footerTall = computed(() => previewTarget.value !== null)

/**
 * Whether the preview box itself is on screen. It is up while a preview loads or
 * is ready, and while a *new* row's shape is still unknown it stays up at the
 * shape of the row just left, so the box is a steady thing to look at. Only the
 * first media row of a run — whose shape has never been known — has no box yet.
 */
const previewVisible = computed(() => {
  if (previewTarget.value === null) return false
  // A clip a display has taken over keeps the space its box had — the footer
  // must not move under the cursor — even though there is nothing to draw in it.
  if (props.transferred === true) return true
  if (previewState.value === 'loading' || previewState.value === 'ready') return true
  return previewState.value === 'probing' && sizeHint.value !== null
})

/**
 * Whether the tall footer is reserved with nothing drawn in it yet: the first
 * row of a run, until its shape is known. The space is held at the box's own
 * height, so nothing about the footer moves when the box arrives — a bare
 * spinner is what shows in the meantime.
 */
const previewWaiting = computed(() => footerTall.value && !previewVisible.value)

/**
 * The stream URL for a video. The file is served by main, ranged, so an element
 * fetches only the metadata and the frames it needs rather than a preview's
 * worth of a file that can be a hundred megabytes long.
 */
function mediaUrlFor(path: string, from = 0): string {
  const base = `${MEDIA_SCHEME}://file/?path=${encodeURIComponent(path)}`
  return from > 0 ? `${base}&from=${from}` : base
}

/**
 * Where each element is streaming its clip from. A clip main has to encode is a
 * live stream, which reports no range to move within, so moving about it means
 * asking for the stream again at the position wanted: this is what that position
 * is, and changing it is what a seek does. It stays put once set — the element
 * would reload all over again otherwise — and means nothing for a clip Chromium
 * plays itself, which is seeked where it stands.
 */
const footerFrom = ref(0)
const stageFrom = ref(0)

const videoUrl = computed(() => {
  const target = previewTarget.value
  if (!target || target.kind !== 'video') return null
  return mediaUrlFor(target.path, target.encode ? footerFrom.value : 0)
})

const showImage = computed(() => previewTarget.value?.kind === 'image' && frame.value !== null)
const showVideo = computed(
  () =>
    previewTarget.value?.kind === 'video' &&
    settled.value &&
    previewState.value !== 'failed'
)
/** The current page of the PDF under the cursor, once main has rasterized it. */
const showPdf = computed(() => previewTarget.value?.kind === 'pdf' && pdfFrame.value !== null)
/**
 * The model under the cursor — its bytes and format — or null when the row is
 * not one or main has not answered yet. What the footer's viewer is handed:
 * non-null is also what puts the canvas on screen, in place of the spinner.
 */
const previewModel = computed<ModelData | null>(() =>
  previewTarget.value?.kind === 'model' ? modelData.value : null
)
/**
 * Whether the box is still waiting for its picture. It is, for as long as the box
 * is on screen with no frame in it — and for a clip main has to transcode first
 * that is the whole encode, seconds of a strip that otherwise shows an empty box
 * and looks broken while nothing appears to happen.
 */
// While a display has the clip, whatever is still loading is its business rather
// than this box's: a spinner here would sit there for as long as the clip stays
// enlarged, promising something that is not coming.
const showSpinner = computed(
  () =>
    previewVisible.value && previewState.value !== 'ready' && props.transferred !== true
)

const PREVIEW_HEIGHT = 64
const PREVIEW_MAX_WIDTH = 160

/**
 * The strip's two sizes: the plain status bar, and the one holding a preview
 * box — the box's own height plus the gutter it keeps above and below it.
 */
const FOOTER_HEIGHT = 24
const FOOTER_PREVIEW_HEIGHT = PREVIEW_HEIGHT + 8

/** The room the strip takes from the listing when it is at its tall size. */
const FOOTER_GROWTH = FOOTER_PREVIEW_HEIGHT - FOOTER_HEIGHT

/**
 * The empty band the listing keeps at its end, so that a scroll a media row
 * pushed past the end stays a legal scroll position. The strip's height is the
 * listing's own height, so as the strip gives its room back the view's bottom
 * edge moves — and the browser keeps the view where it is rather than show blank
 * below the content, which drags the rows down with it. The band is only as wide
 * as the scroll past the end actually is, so a listing that is not sitting at its
 * end has none, and the row a cursor move lands on is never placed past it (see
 * `measureListSlack`).
 */
const listSlack = ref(0)
const listSlackStyle = computed(() =>
  listSlack.value === 0 ? undefined : { paddingBottom: `${listSlack.value}px` }
)

/**
 * How long the footer takes to grow. Only a growing strip is animated: a strip
 * *shrinking* sweeps over the very rows it is uncovering, so a cursor landing
 * there would be behind it for as long as the strip takes to get out of the way
 * — and bringing the row clear of it instead would leave the listing scrolled up
 * past where the cursor's own move puts it, a scroll nothing would take back.
 * Growing sweeps the same way, but the room it takes is room the cursor row
 * needs anyway, so there the reveal is the answer (see `onListResize`).
 */
const FOOTER_RESIZE_MS = 150

/**
 * The reserved box: the hinted ratio at the preview's height, capped at the
 * preview's width (a very wide picture letterboxes rather than pushing the rest
 * of the bar off the strip). Without a hint the box is the full cap and the
 * picture settles into it once it arrives.
 */
const previewBoxStyle = computed(() => {
  const hint = sizeHint.value
  const ratio = hint && hint.height > 0 ? hint.width / hint.height : null
  const limit = PREVIEW_MAX_WIDTH / PREVIEW_HEIGHT
  const capped = ratio === null ? limit : Math.min(ratio, limit)
  const width = Math.max(1, Math.round(PREVIEW_HEIGHT * capped))
  return { width: `${width}px`, height: `${PREVIEW_HEIGHT}px` }
})

/**
 * How long the cursor must hold still before its picture is read. A held arrow
 * key moves through rows far faster than a picture can be read, and a large
 * image is decoded synchronously in main: reading every row a key repeat passes
 * over keeps main busy, which delays the very input events that drive the cursor
 * and reads as choppy movement. Re-armed on every cursor change, so a scrolling
 * burst asks for nothing until it stops. A video is held back the same way — its
 * element is mounted only once the cursor settles, so a burst does not start a
 * metadata fetch per row — and everything past the settle is token-guarded.
 */
const PREVIEW_SETTLE_MS = 150

/**
 * The preview for the row the cursor sits on, keyed by path *and* size/mtime so
 * an external rewrite of the same path reloads, and guarded by a token so a slow
 * answer for a row the user has already left cannot replace the newer one.
 */
let previewToken = 0
let previewTimer: number | null = null

function cancelPreviewRead(): void {
  if (previewTimer === null) return
  window.clearTimeout(previewTimer)
  previewTimer = null
}

/**
 * The shape of an image, read from its header. It is cheap enough to be issued
 * on the cursor move rather than with the read, which is what lets the box take
 * the picture's real shape as soon as the row is reached.
 */
async function loadImageSizeHint(token: number, path: string): Promise<void> {
  const hint = await api.fs.imageSize(path)
  if (token !== previewToken) return
  sizeHint.value = hint
  previewState.value = 'loading'
}

async function loadImage(token: number, path: string): Promise<void> {
  const result = await api.fs.readImage(path)
  if (token !== previewToken) return
  frame.value = result.ok ? result.data.dataUrl : null
  if (result.ok) previewState.value = 'ready'
  else previewState.value = 'failed'
}

/**
 * Rasterize the current page of the PDF under the cursor, at the thumbnail's own
 * width. Main keeps the answer, so stepping back onto a page already shown costs
 * a lookup rather than a render, and a slow render for a page already left cannot
 * land on the newer one.
 */
async function loadPdfPage(token: number, target: PreviewTarget): Promise<void> {
  // A page being turned keeps its predecessor on screen until the new raster is
  // there — the box is already showing a page, and a spinner over it between two
  // pages would read as the document hiccuping. Only a first page, with nothing
  // to keep, reserves the space with a spinner.
  if (pdfFrame.value === null) previewState.value = 'loading'
  const result = await api.fs.pdfPage(target.path, pdfPageFor(target), PDF_PREVIEW_WIDTH)
  if (token !== previewToken) return
  if (result.ok) {
    pdfFrame.value = result.data.dataUrl
    previewState.value = 'ready'
  } else {
    previewState.value = 'failed'
  }
}

/**
 * Read the model under the cursor — or, for a CAD document, convert it to a mesh
 * in main first. The bytes are not drawn here: the viewer parses them, and the
 * box keeps its spinner until that viewer reports a frame is really there, so
 * the reveal in a display grows out of a thumbnail that has something in it.
 */
async function loadModel(token: number, target: PreviewTarget): Promise<void> {
  const result = await api.fs.readModel(target.path)
  if (token !== previewToken) return
  if (result.ok) {
    modelData.value = result.data
    previewState.value = 'loading'
  } else {
    previewState.value = 'failed'
  }
}

/** The footer's viewer has drawn its first frame: the box is no longer waiting. */
function onFooterModelReady(): void {
  if (previewState.value !== 'failed') previewState.value = 'ready'
}

/** The file would not parse as a model: release the box rather than spin on it. */
function onFooterModelError(): void {
  previewState.value = 'failed'
}

watch(
  () => previewKeyFor(previewTarget.value),
  (key) => {
    cancelPreviewRead()
    const token = (previewToken += 1)
    frame.value = null
    pdfFrame.value = null
    modelData.value = null
    videoTime.value = 0
    videoLength.value = null
    clipLength.value = null
    clipLengthKey = null
    footerFrom.value = 0

    const target = previewTarget.value
    if (key === null || !target) {
      sizeHint.value = null
      settled.value = false
      previewState.value = 'idle'
      return
    }

    // The row just left keeps its shape for the moment this takes — a header
    // read for an image, the element's metadata for a video — so the box neither
    // blinks between rows nor flashes a width it is about to leave.
    settled.value = false
    previewState.value = 'probing'
    // A video's shape comes from the element's own metadata, but *which* stream
    // to mount is settled by a header read: a container Chromium demuxes holds
    // a codec it cannot decode as often as one it can. The probe is issued here,
    // on the cursor move, so its answer is in before the settle lets the element
    // fetch anything — the same reason an image's shape is asked for here. A
    // PDF's shape and page count come from one header read of its own, which is
    // what lets the box be reserved at the page's ratio before it is rendered.
    if (target.kind === 'image') void loadImageSizeHint(token, target.path)
    else if (target.kind === 'video') probeVideoCodec(target)
    else if (target.kind === 'model') {
      // A model has no header to measure and no page to lay out, so the box is
      // reserved square — a solid reads as one either way — until the viewer's
      // own first frame arrives.
      sizeHint.value = { width: 1, height: 1 }
    } else {
      ensurePdfInfo(target, api)
      // A shape the header already gave keeps the box's ratio straight away; one
      // that has not answered yet leaves the row just left's shape standing, as
      // an image's does, rather than collapsing the box to nothing.
      const hint = pdfSizeHintFor(target)
      if (hint) sizeHint.value = hint
    }

    previewTimer = window.setTimeout(() => {
      previewTimer = null
      if (token !== previewToken) return
      // A video starts fetching by being mounted, which `settled` lets it do
      // from here; an image is read outright, and a PDF's page is rendered.
      settled.value = true
      if (target.kind === 'image') void loadImage(token, target.path)
      else if (target.kind === 'pdf') void loadPdfPage(token, target)
      else if (target.kind === 'model') void loadModel(token, target)
    }, PREVIEW_SETTLE_MS)
  }
)

/**
 * A PDF's page being stepped while its thumbnail is on screen: the new page is
 * rendered at the settle's own width, immediately rather than after a delay — a
 * step is a deliberate look at another page, not a row a key repeat flew over.
 * A step that arrives before the first page has been rendered is left to the
 * settle, which reads whatever page is current when it fires.
 */
watch(
  () => pdfPageFor(previewTarget.value),
  () => {
    const target = previewTarget.value
    if (!target || target.kind !== 'pdf' || props.transferred === true) return
    if (!settled.value) return
    const token = (previewToken += 1)
    void loadPdfPage(token, target)
  }
)

/**
 * The page count and shape arriving after the cursor has landed: the box takes
 * the page's ratio the moment the header answers, so a portrait page is not
 * reserved as a wide one.
 */
watch(
  () => (previewTarget.value?.kind === 'pdf' ? pdfSizeHintFor(previewTarget.value) : null),
  (hint) => {
    if (hint) sizeHint.value = hint
  }
)

/**
 * A PDF coming back from a display. Its box kept the page the footer last drew,
 * which is not the page the display was stepped to, so the renderer is asked for
 * the shared page again now that this pane draws it once more.
 */
watch(
  () => props.transferred === true,
  (transferred) => {
    if (transferred) return
    const target = previewTarget.value
    if (!target || target.kind !== 'pdf' || !settled.value) return
    const token = (previewToken += 1)
    void loadPdfPage(token, target)
  }
)

/**
 * A video reveals its shape in its metadata, which the element fetches as soon
 * as it is mounted (after the settle). That is also the moment the box can be
 * reserved: the clip is already starting to play behind the spinner.
 */
function onVideoMetadata(event: Event): void {
  const video = event.target
  if (!(video instanceof HTMLVideoElement)) return

  if (video.videoWidth > 0 && video.videoHeight > 0) {
    sizeHint.value = { width: video.videoWidth, height: video.videoHeight }
  }
  if (previewState.value === 'probing') previewState.value = 'loading'

  pickUpAt(video, previewKeyFor(previewTarget.value), null)
}

/**
 * The rectangle a display's media is actually drawn in. The element fills the
 * pane and letterboxes the media inside it (`object-contain`), so a gesture has
 * to be measured from the media's own rectangle rather than from the element's —
 * otherwise it starts and lands a letterbox away from the thumbnail it belongs
 * to. Null while the media's own size is not known.
 */
function drawnRect(element: HTMLElement, kind?: PreviewKind | null): DOMRect | null {
  const box = element.getBoundingClientRect()
  if (box.width <= 0 || box.height <= 0) return null

  // A PDF document's viewport draws in its whole box; a picture is letterboxed
  // inside its element, so its own rectangle is worked out from the intrinsic
  // size. Same gesture either way — the rectangle the media is *drawn* in.
  if (element instanceof HTMLImageElement || element instanceof HTMLVideoElement) {
    return letterboxRect(element, box)
  }

  // A model is drawn by three.js into a canvas, and its camera fits the model to
  // the box's *height* — the vertical field of view — with the width following the
  // aspect. So what it is drawn in is a centred square of that height, not the box:
  // the box's own width has nothing to do with how large the model looks, and the
  // flights scale by width, so a box-shaped rectangle makes them start at the wrong
  // size whenever the two boxes' aspects differ (a pane and the whole window).
  if (kind === 'model') {
    const side = box.height
    return new DOMRect(box.left + (box.width - side) / 2, box.top, side, side)
  }

  return box
}

/** Where a letterboxed picture is actually drawn inside its element. */
function letterboxRect(element: HTMLImageElement | HTMLVideoElement, box: DOMRect): DOMRect | null {
  const width = element instanceof HTMLVideoElement ? element.videoWidth : element.naturalWidth
  const height = element instanceof HTMLVideoElement ? element.videoHeight : element.naturalHeight
  if (width <= 0 || height <= 0) return null

  const scale = Math.min(box.width / width, box.height / height)
  const drawnWidth = width * scale
  const drawnHeight = height * scale
  return new DOMRect(
    box.left + (box.width - drawnWidth) / 2,
    box.top + (box.height - drawnHeight) / 2,
    drawnWidth,
    drawnHeight
  )
}

/**
 * The transform that lays a media's own rectangle onto `target`, for an element
 * transformed about its own top-left corner — which is what a reveal and a
 * shrink are: the media, where it is drawn, moving onto (or off) the thumbnail.
 *
 * The scale is by width, so the horizontal is exact. `center` is what the media
 * passes, so its rectangle is *centred* on the target rather than pinned by its
 * top corner: the two rarely share an aspect — a picture letterboxed in a pane, a
 * tile that is not the picture's shape, and above all a 3D model, whose drawn
 * rectangle is the whole stage area — and a corner-pinned flight of those starts
 * the media short of the middle and lands it beside the thumbnail it belongs to.
 * The transport bar passes false: it grows out from *under* the thumbnail, so its
 * top edge is the thing that has to sit on the target.
 */
function handoffTransform(target: DOMRect, drawn: DOMRect, box: DOMRect, center = false): string {
  const scale = target.width / drawn.width
  const x = target.left - box.left - scale * (drawn.left - box.left)
  const top = center ? target.top + (target.height - drawn.height * scale) / 2 : target.top
  const y = top - box.top - scale * (drawn.top - box.top)
  return `translate(${x}px, ${y}px) scale(${scale})`
}

/**
 * Carry on where the display left off, now that this element knows enough to be
 * moved — the clip was already part way through there, so playing it from the
 * beginning again reads as a restart rather than as a hand-back.
 */
function pickUpAt(element: HTMLVideoElement, key: string | null, fallback: number | null): void {
  const pending = pickUpFrom.value
  const held = pending !== null && pending.key === key ? pending : null
  if (held !== null) pickUpFrom.value = null

  // A stream has already been asked for from that position: there is nothing to
  // move, and a seek within the rest of the clip would be the wrong place.
  if (isStream(element)) return

  const at = held !== null ? held.time : fallback
  if (at === null) return

  const clamped = Math.min(at, element.duration)
  if (!Number.isFinite(clamped) || !canMoveWithin(element, clamped)) return
  element.currentTime = clamped
}

/**
 * Frames are flowing: the spinner has done its job, and the clock is read from
 * here rather than from `durationchange` — that fires before `loadedmetadata`,
 * where a clip handed back is moved to where the display had it, so reading it
 * there would show the 0:00 a fresh element starts at.
 */
function onVideoStarted(): void {
  if (previewState.value !== 'failed') previewState.value = 'ready'
  readVideoClock()
}

function onVideoError(): void {
  previewState.value = 'failed'
}

/**
 * A format whose header the probe cannot measure still reveals its shape when it
 * renders, so adopt it then rather than leaving the default box for good.
 */
function onImageLoad(event: Event): void {
  if (sizeHint.value) return
  const image = event.target
  if (!(image instanceof HTMLImageElement)) return
  if (image.naturalWidth > 0 && image.naturalHeight > 0) {
    sizeHint.value = { width: image.naturalWidth, height: image.naturalHeight }
  }
}

function onImageError(): void {
  // A mapped extension can still fail to decode (a truncated or malformed file),
  // which surfaces here rather than as a rejected read.
  previewState.value = 'failed'
}

/**
 * A rendered page takes the box's own shape: the header's size is the *first*
 * page's, and pages of a document can differ, so the picture that actually
 * arrived is the one to trust. It is also what fills the gap when the header
 * could not give a size at all.
 */
function onPdfFooterLoad(event: Event): void {
  const image = event.target
  if (image instanceof HTMLImageElement && image.naturalWidth > 0 && image.naturalHeight > 0) {
    sizeHint.value = { width: image.naturalWidth, height: image.naturalHeight }
  }
  // The frame is on screen: whatever the box was waiting to show has arrived.
  if (previewState.value !== 'failed') previewState.value = 'ready'
}

/**
 * How far the pane's own content is blurred while a display covers it. Enough
 * that the listing behind reads as a backdrop rather than as something to read,
 * with the media on top of it standing out.
 *
 * It is a filter on the content itself rather than a `backdrop-filter` on the
 * display: the content is the thing being blurred, and blurring it directly
 * leaves the display with nothing of its own to paint underneath.
 */
const STAGE_BLUR_PX = 8

/**
 * How long a display takes to grow out of the thumbnail it was asked for, and to
 * shrink back into it. It is a translate *and* a scale of the same element — the
 * media, laid out at its final size, is animated back onto the footer's
 * thumbnail and forward again — so the two motions are one gesture rather than a
 * move then a resize. An enlarged clip's sound is ramped over the same length, so
 * that it arrives and leaves with the picture it belongs to.
 */
const STAGE_REVEAL_MS = 220

/**
 * The display on screen, which outlives the request for it while it is being
 * dismissed: the media has to still be there to shrink back onto its thumbnail.
 */
const shownStage = ref<StageRequest | null>(null)

/** The pane's own content — bar, listing, footer — which a display blurs. */
const paneContent = ref<HTMLElement | null>(null)

/** The blur in flight on the pane's own content, so a change of mode can replace it. */
let contentBlur: Animation | null = null

/** The stream URL of the media another pane is displaying. */
const stageVideoUrl = computed(() => {
  const stage = shownStage.value
  if (!stage || stage.target.kind !== 'video') return null
  return mediaUrlFor(stage.target.path, stage.target.encode ? stageFrom.value : 0)
})

/** An image being displayed on behalf of another pane, as a `data:` URL. */
const stageFrame = ref<string | null>(null)

/** A model being displayed on behalf of another pane: the payload the viewer parses. */
const stageModel = ref<ModelData | null>(null)

/**
 * Where the display has got to. It is kept out of sight until the frame itself
 * is there — an element has no size until its media does, and the reveal is
 * measured off that size — and a failure leaves the pane empty rather than
 * showing a broken frame.
 */
type StageState = 'idle' | 'loading' | 'ready' | 'failed'
const stageState = ref<StageState>('idle')

const showStageImage = computed(() => stageFrame.value !== null && stageState.value !== 'failed')
const showStageVideo = computed(
  () => stageVideoUrl.value !== null && stageState.value !== 'idle' && stageState.value !== 'failed'
)
/**
 * The displayed PDF: a scrollable stack of pages rather than one raster. The
 * document's own geometry is known from its header, so it can be laid out before
 * a page is rendered; the pages near the viewport are the ones fetched.
 */
const showStagePdf = computed(
  () => shownStage.value?.target.kind === 'pdf' && stageState.value !== 'failed'
)

/** The reveal already played for this entry into the mode, so a swap in place is not re-animated. */
let stageAnimation = -1

/**
 * The element being displayed, for measuring the reveal and its reverse. A clip
 * is a `<video>`, a still an `<img>`, and a PDF the box its pages are scrolled
 * within — so the reveal, the travel between presentations and the wheel's own
 * hit test work on whichever is up.
 */
const stageMedia = ref<HTMLElement | null>(null)

/**
 * The window the display sits on when it is opened over everything; with the
 * display in its pane, the pane's own listing is what it sits on. It is laid out
 * window-sized whichever way the display is presented, because its fade — out, as
 * the media settles back into its pane — has to go on covering what the media is
 * still hanging over at the time.
 */
const stageBackdrop = ref<HTMLElement | null>(null)

/** The dismissal in flight, so that a display asked for again can call it off. */
let stageDismissal: Animation | null = null

/** The transport bar's own flight, so a reveal and a dismissal replace rather than stack. */
let stageBarFlight: Animation | null = null

/**
 * The media's own flight, so that a change of presentation replaces a reveal in
 * flight rather than stacking a second motion on the same picture.
 */
let stageMediaFlight: Animation | null = null

/** The backdrop's fade in flight, replaced rather than stacked by the next one. */
let stageBackdropFade: Animation | null = null

/** Whether a dismissal is running, so that its gesture is neither doubled nor cut short. */
let stageDismissing = false

/** Which sound ramp is the current one, so a leaving one stops when another starts. */
let stageSound = 0

let stageToken = 0

/**
 * The enlarged clip's position and length, for the full-width play bar under it.
 * A clip main has to encode is a live stream and cannot report a length, so the
 * file itself is asked — separately from the footer's own query, since this pane
 * may be previewing a different row.
 */
const stageTime = ref(0)
const stageDuration = ref<number | null>(null)
const stageClipLength = ref<number | null>(null)
let stageClipLengthKey: string | null = null

/**
 * The displayed media's own aspect, which the transport's width follows. A clip
 * reveals it in its metadata, a PDF page in its rendered image; a still has no
 * transport and so never sets it.
 */
const stageAspect = ref<number | null>(null)

/**
 * Where the stream the display is *playing* was started, as opposed to where the
 * next one will be asked for. A stream counts from zero, so the clip's position
 * is this origin plus the element's own clock — and changing `stageFrom` while
 * the old element is still playing must not move the bar with it.
 */
const stageStreamOrigin = ref(0)

/** Whether a stream has been asked for again and its element has not caught up yet. */
let stageSeekPending = false

/**
 * Where a clip Chromium plays was just asked to go. A seek is asynchronous, so
 * for the moment before the element catches up its clock still reports the old
 * position — which would snap the bar back right after the user let go of it.
 * The bar holds where it was dropped until the element agrees (or the backstop
 * expires, for a seek that never lands exactly).
 */
let stageSeekHold: number | null = null
let stageSeekHoldTimer: number | null = null

function holdStageSeek(position: number): void {
  stageSeekHold = position
  if (stageSeekHoldTimer !== null) window.clearTimeout(stageSeekHoldTimer)
  stageSeekHoldTimer = window.setTimeout(() => {
    stageSeekHold = null
    stageSeekHoldTimer = null
  }, 1000)
}

function releaseStageSeek(): void {
  stageSeekHold = null
  if (stageSeekHoldTimer !== null) {
    window.clearTimeout(stageSeekHoldTimer)
    stageSeekHoldTimer = null
  }
}

/**
 * A right-button scrub is not a click. Some platforms still deliver a click
 * when that button is released, so for a moment after a scrub the display's
 * play/pause handler ignores one — the wheel's ten-minute step must not also
 * toggle the clip.
 */
let stageClickSuppressedUntil = 0

/** The drag in flight on the enlarged play bar. */
let stageScrub: { length: number; stream: boolean; pending: number } | null = null

/** Whether the play bar is being dragged, so its handle stays visible. */
const stageScrubbing = ref(false)

/** Whether the displayed clip is playing, for the button that pauses it. */
const stagePlaying = ref(false)

/** Put the display's clock back to nothing, for a new clip or for leaving the mode. */
function clearStageClock(): void {
  stageTime.value = 0
  stageDuration.value = null
  stageClipLength.value = null
  stageClipLengthKey = null
  stageStreamOrigin.value = 0
  stageSeekPending = false
  releaseStageSeek()
  stageClickSuppressedUntil = 0
  stageScrub = null
  stageScrubbing.value = false
  stagePlaying.value = false
  stageAspect.value = null
}

/**
 * Whether the display is laid out over the whole window rather than this pane —
 * the full-screen viewing mode. It follows the prop, with one exception: leaving
 * the mode clears the prop in the same flush that tears the display down, and the
 * media has to still be laid out at the size it was when it animates back onto
 * its thumbnail — so the full-window layout is held until the dismissal has
 * landed rather than snapping back to the pane under the shrinking picture.
 */
const fullscreenPresentation = ref(false)

/**
 * Whether the display is on its way between the two boxes, which it is for the
 * length of that motion. It rides above the pane chrome while it travels —
 * above the divider that splits the panes, which is a `z-30` layer over their
 * `z-20` ones — because the picture hangs over the other pane on the way and
 * nothing of the panes should be drawn across it. At rest it is a `z-20` layer
 * like any other pane overlay, which is what lets the divider's grab band and
 * its re-centre button take a pointer at the pane's edge.
 */
const stageTravelling = ref(false)

/** Which travel is the current one, so a landed or called-off one ends only itself. */
let stageTravelToken = 0

/**
 * Where the display is laid out and how high it rides while it is there: over
 * everything as a full-screen display, or in its pane — above the pane chrome
 * while it is travelling, at the pane's own rank once it has settled.
 */
const stagePresentation = computed(() =>
  fullscreenPresentation.value
    ? 'fixed inset-0 z-50'
    : stageTravelling.value
      ? 'absolute inset-0 z-40'
      : 'absolute inset-0 z-20'
)

watch(
  () => props.fullscreen === true,
  (on) => {
    // A display that is up and stays up only changes its presentation, and the
    // media travels between the two boxes to show it.
    if (props.stage !== null) {
      void switchStagePresentation(on)
      return
    }

    if (on) {
      // Nothing up yet: the mode is being entered, and the reveal out of the
      // thumbnail is that gesture — this only lays the display out over the
      // window for it.
      fullscreenPresentation.value = true
      return
    }

    // The layout is held for exactly one case: the mode is being left while this
    // pane still has a display to shrink back onto its thumbnail — then
    // `runDismissal` clears it once the shrink has landed. The pane that is not
    // the display is handed the same flag and has no overlay to lay out, so it
    // drops it at once.
    if (shownStage.value === null) fullscreenPresentation.value = false
  }
)

/**
 * The presentation change of a display that stays up: it is laid out in the other
 * box — the pane's, or the window's — and then put back onto the rectangle it
 * occupied in the one it left, so the picture travels between the two instead of
 * jumping from one size to the other. The transport travels with it, and the
 * backdrop fades over the same length, so opening the display over the window and
 * settling it back into its pane are each one gesture rather than a resize under
 * a background that has already changed.
 *
 * The far end of that travel is measured rather than worked out: the media is
 * laid out in the other box first and then measured there — which keeps a clip
 * honest, since its box is *measured* from the area it sits in, so the new area
 * is fed in before the media is measured. Both flushes are microtasks of one
 * task, so the media is never painted at its new size before the motion that
 * brings it there: there is no frame in between to flash.
 */
async function switchStagePresentation(full: boolean): Promise<void> {
  const travel = (stageTravelToken += 1)
  const settle = (): void => {
    if (travel === stageTravelToken) stageTravelling.value = false
  }

  const element = stageMedia.value
  const stage = shownStage.value
  // Where the gesture starts from is whatever is on screen now, a half-finished
  // motion included, so a second switch carries on from what the last one showed.
  const from = element === null ? null : drawnRect(element, stage?.target.kind)
  const fromBar = stageBarEl.value?.getBoundingClientRect() ?? null

  // Each flight measures the box it is about to leave, so both are called off
  // before the layout turns: one still travelling would be measured where its
  // transform has put it rather than where its layout is.
  stageMediaFlight?.cancel()
  stageMediaFlight = null
  stageBarFlight?.cancel()
  stageBarFlight = null

  fullscreenPresentation.value = full
  stageTravelling.value = true
  animateStageBackdrop(full)

  if (element === null || from === null) {
    settle()
    return
  }

  await nextTick()
  const area = stageArea.value
  if (area !== null) stageAreaSize.value = { width: area.clientWidth, height: area.clientHeight }
  await nextTick()

  // The display can have been asked for again, or taken away, while the layout
  // turned: the element this gesture belongs to is the one it began on.
  if (shownStage.value !== stage || stageMedia.value !== element) {
    settle()
    return
  }

  const box = element.getBoundingClientRect()
  const drawn = drawnRect(element, stage?.target.kind)
  if (drawn === null || box.width <= 0 || box.height <= 0) {
    settle()
    return
  }

  const flight = element.animate(
    [{ transform: handoffTransform(from, drawn, box, true) }, { transform: 'none' }],
    { duration: STAGE_REVEAL_MS, easing: 'ease-out' }
  )
  stageMediaFlight = flight
  // The rank is given back when the picture has landed, which is also what keeps
  // it above the divider for the whole of the motion — a cancelled one included,
  // where the switch that replaced it owns the rank from here.
  void flight.finished.then(settle, settle)
  void animateStageBar(fromBar, false)
}

/**
 * Fade the window the display sits on when it is opened over everything: the
 * colour the letterbox is filled with, and what covers the tab strip, the panes
 * and the command line behind the media. Fading it with the media's own travel is
 * what makes a presentation change one gesture; in the pane it is simply
 * transparent, because the listing behind the media is the display's backdrop
 * there.
 */
function animateStageBackdrop(full: boolean): void {
  const backdrop = stageBackdrop.value
  if (backdrop === null) return

  // Read before the one in flight is called off, so the fade carries on from
  // wherever that had got to.
  const from = getComputedStyle(backdrop).opacity
  stageBackdropFade?.cancel()
  stageBackdropFade = backdrop.animate(
    [{ opacity: from }, { opacity: full ? '1' : '0' }],
    { duration: STAGE_REVEAL_MS, easing: full ? 'ease-out' : 'ease-in', fill: 'forwards' }
  )
}

/**
 * Blur the pane's own content while this pane is the display, and bring it back
 * into focus when the mode is left. It is the *mode* that blurs rather than the
 * media: navigating from a media file to an ordinary one empties the display for
 * a moment, and the pane should go on looking like the preview it still is.
 */
watch(
  () => props.displaying === true,
  (displaying) => {
    const content = paneContent.value
    if (content === null) return

    const from = getComputedStyle(content).filter
    contentBlur?.cancel()
    contentBlur = content.animate(
      [
        { filter: from === 'none' ? 'blur(0px)' : from },
        { filter: displaying ? `blur(${STAGE_BLUR_PX}px)` : 'blur(0px)' }
      ],
      { duration: STAGE_REVEAL_MS, easing: displaying ? 'ease-out' : 'ease-in', fill: 'forwards' }
    )

    // Leaving the mode is what takes a displayed clip away: whatever is up
    // shrinks back onto its thumbnail, which by then is the pane's own again.
    if (displaying !== true && shownStage.value !== null) void dismissStage()
  }
)

/**
 * Display the media another pane asked for. There is no settle here: the user
 * asked for this file by pressing Enter on it, so it loads at once — an image
 * through main's cache, which the footer's own read usually filled in already.
 * A request that arrives while the last display is still shrinking away calls
 * that off and keeps what is on screen.
 */
watch(
  () => props.stage,
  (stage, previous) => {
    if (stage) {
      stageDismissal?.cancel()
      stageDismissal = null
      // A dismissal that was shrinking the transport away is called off with it,
      // so the new reveal owns the bar rather than letting a stale shrink land.
      stageBarFlight?.cancel()
      stageBarFlight = null
      shownStage.value = stage

      // A request that names the *same* media is the same display, not a new one:
      // the panes re-derive it whenever their listing is re-read (`previewTargetFor`
      // builds a fresh target object every time), and reloading it would take the
      // element down for nothing — which for a PDF page is the text layer a
      // selection lives in, and for a clip is an element that would have to start
      // fetching and playing again. A different kind or a changed `encode` is a
      // different thing to show, and belongs to the load below.
      const sameMedia =
        previous != null &&
        previous.target.kind === stage.target.kind &&
        previous.target.encode === stage.target.encode &&
        previewKeyFor(previous.target) === previewKeyFor(stage.target)
      if (sameMedia) return

      // A clip main has to encode is asked for from where the mode began; a clip
      // Chromium plays is loaded as it is and moved to that position.
      stageFrom.value = stage.resumeAt ?? 0
      clearStageClock()
      stageTime.value = stageFrom.value
      stageStreamOrigin.value = stageFrom.value
      raiseStageSound()
      void loadStage(stage)
      return
    }
    if (shownStage.value === null) return

    // The mode is being left, and whatever is up shrinks back onto its
    // thumbnail. It is asked for from here as well as from the mode's own watch,
    // because the two arrive in one flush and either may be first; the dismissal
    // runs once either way.
    if (props.displaying !== true) {
      void dismissStage()
      return
    }

    // Nothing under the cursor to show, with the mode still on: the display
    // empties without a gesture. That gesture belongs to arriving in the mode and
    // leaving it, not to the cursor crossing a file there is nothing to show for
    // — nothing grew out of that thumbnail, so shrinking back onto it would make
    // no sense.
    if (stageDismissing) return

    stageDismissal?.cancel()
    stageDismissal = null
    shownStage.value = null
    stageModel.value = null
    stageState.value = 'idle'
    clearStageClock()
    emit('stage-clock', null)
  },
  { immediate: true }
)

async function loadStage(stage: StageRequest): Promise<void> {
  const key = previewKeyFor(stage.target)
  const token = (stageToken += 1)
  stageFrame.value = null
  stageModel.value = null
  stageState.value = key === null ? 'idle' : 'loading'

  if (stage.target.kind === 'model') {
    // A model is not a raster: main hands over the bytes (a CAD document meshed
    // through FreeCAD first) and the viewer parses them. Its first frame is what
    // reports `ready`, through `onStageShown` — which is also the reveal.
    const result = await api.fs.readModel(stage.target.path)
    if (token !== stageToken) return
    if (result.ok) stageModel.value = result.data
    else stageState.value = 'failed'
    return
  }

  if (stage.target.kind === 'pdf') {
    // A document is not one raster: its pages are stacked in a scroller, so
    // nothing is read here — the layout comes from the header and the pages near
    // the viewport are fetched as they are looked at.
    pdfFrames.value = new Map()
    pdfTexts.value = new Map()
    pdfLoading.clear()
    pdfTextLoading.clear()
    pdfScrollTop.value = 0
    await positionPdfStage(token, stage.target)
    return
  }

  if (stage.target.kind !== 'image') return

  const result = await api.fs.readImage(stage.target.path)
  if (token !== stageToken) return
  if (result.ok) stageFrame.value = result.data.dataUrl
  else stageState.value = 'failed'
}

/* The PDF display: a stacked, scrollable document. ---------------------------- */

/** Where the box is scrolled to, which is what decides the page in view. */
const pdfScrollTop = ref(0)

/** Rendered pages, by identity+page+width, so scrolling back is instant. */
const pdfFrames = ref<Map<string, string>>(new Map())

/**
 * Pages' text, by identity+page, for the selection layer. A page that has none
 * (a scan) is held as `null`, so it is asked for once rather than on every scroll.
 */
const pdfTexts = ref<Map<string, PdfPageText | null>>(new Map())

/** Pages being rendered right now, so one in view is asked for only once. */
const pdfLoading = new Set<string>()

/** Pages whose text is being extracted right now, so one is asked for once. */
const pdfTextLoading = new Set<string>()

/** The document this pane is displaying, or null when it is not one. */
const pdfDisplayTarget = computed<PreviewTarget | null>(() =>
  shownStage.value?.target.kind === 'pdf' ? shownStage.value.target : null
)

/**
 * The scroll box the pages live in, for reading and setting its scroll. It is the
 * same element the display reveals from and measures, which the template binds as
 * `stageMedia` — an element carries a single `ref`, so this is that one read back
 * only while a PDF is what is up, rather than a second binding that cannot exist.
 */
const pdfScrollEl = computed<HTMLElement | null>(() =>
  pdfDisplayTarget.value ? stageMedia.value : null
)

/**
 * The scroll box's own inner size, which the document is laid out against, and
 * its border-box height, which is what fit-page is measured against. The box is
 * measured rather than derived from the media area because its width is what a
 * page must fill; `boxHeight` is the *outer* height because a zoomed page that
 * overflows sideways raises a horizontal scrollbar, which would otherwise shrink
 * the height fit-page divides by and make the two chase each other.
 */
interface PdfViewport {
  width: number
  height: number
  boxHeight: number
}

const pdfViewport = ref<PdfViewport | null>(null)

let pdfScrollObserver: ResizeObserver | null = null

function measurePdfScroll(element: HTMLElement | null): void {
  pdfScrollObserver?.disconnect()
  pdfScrollObserver = null
  pdfViewport.value = null
  if (!element) return

  const measure = (): void => {
    pdfViewport.value = {
      width: element.clientWidth,
      height: element.clientHeight,
      boxHeight: element.offsetHeight
    }
  }
  pdfScrollObserver = new ResizeObserver(measure)
  pdfScrollObserver.observe(element)
  measure()
}

watch(pdfScrollEl, measurePdfScroll)

/**
 * The width the page is measured against: the box's own inner width. It is the
 * reference the magnification is read in — the thing on screen a reader can point
 * at — which is what makes fitting the width exactly 100%.
 */
const pdfBoxWidth = computed(() => pdfViewport.value?.width ?? 640)

/**
 * How wide a page is drawn. A *fit* fills the box: `width` takes its width,
 * `page` scales a whole page into it, so the page's own aspect sets the height that
 * has to fit and the width follows from that. A magnification of the page's own is
 * a fraction of the box's width, which is the same fraction whatever the pane does
 * — a page wider than the box then scrolls sideways.
 */
const pdfBaseWidth = computed(() => {
  const box = pdfBoxWidth.value
  const view = pdfView.value

  if (view.mode === 'free') return Math.max(120, box * view.scale)
  if (view.mode === 'width') return Math.max(200, box)

  const size = pdfSizeHintFor(pdfDisplayTarget.value)
  const aspect = size && size.height > 0 ? size.width / size.height : 612 / 792
  const boxHeight = pdfViewport.value?.boxHeight ?? 600
  return Math.max(120, Math.min(box, boxHeight * aspect))
})

const pdfColumnWidth = computed(() => Math.round(pdfBaseWidth.value))

/**
 * The magnification as a reader reads it: the page's width against the box's, so
 * 100% is the width exactly filled — what the fit-width button gives, to the pixel
 * — and a fit-page percentage is how much of the width a page takes when its
 * *height* is what was fitted. Above 100% the page is wider than the box and
 * scrolls sideways.
 */
const pdfZoom = computed(() => {
  const box = pdfViewport.value?.width ?? 0
  if (box <= 0) return 1
  return pdfColumnWidth.value / box
})

const pdfZoomLabel = computed(() => `${Math.round(pdfZoom.value * 100)}%`)

/** Whether the magnification is at either end of the ladder, so a button greys out. */
const pdfZoomAtMin = computed(() => pdfZoom.value <= PDF_MIN_SCALE + 1e-6)
const pdfZoomAtMax = computed(() => pdfZoom.value >= PDF_MAX_SCALE - 1e-6)

/**
 * Step the magnification to the next rung of the ladder, from whatever the
 * display is showing *now*: a fitted page's own percentage counts as the step it is
 * between, so `+` from a page fitted at 80% is 100% rather than 80% of a rung. It
 * leaves the fit behind (`free`), which is the point — a percentage chosen by hand
 * is the reader's, and it stays that fraction of the pane however the pane is
 * resized.
 */
async function stepPdfZoom(direction: 1 | -1): Promise<void> {
  const target = nextPdfZoom(pdfZoom.value, direction)
  if (Math.abs(target - pdfZoom.value) < 1e-6) return
  await setPdfZoom(target)
}

/** The width the pages are rasterized at, in device pixels, on a stable step. */
const pdfRenderWidth = computed(() => {
  const dpr = window.devicePixelRatio || 1
  const stepped = Math.round((pdfColumnWidth.value * dpr) / PDF_RENDER_STEP) * PDF_RENDER_STEP
  return Math.min(PDF_RENDER_MAX, Math.max(PDF_RENDER_MIN, stepped))
})

/** The stacked document's geometry, or null until its header has answered. */
const pdfLayout = computed(() =>
  pdfLayoutFor(pdfDisplayTarget.value, pdfColumnWidth.value, PDF_PAGE_GAP, PDF_PAGE_PAD)
)

/** How tall the scroll box is, which is how much of the document is in view. */
const pdfViewportHeight = computed(() => Math.max(1, pdfViewport.value?.height ?? 600))

/** The pages to keep in the document, from where the box is scrolled to. */
const pdfWindow = computed(() => {
  const layout = pdfLayout.value
  if (!layout) return { first: 0, last: 0 }

  const boxes = layout.boxes
  const top = pdfScrollTop.value
  const bottom = top + pdfViewportHeight.value

  let first = 0
  while (first < boxes.length && boxes[first]!.top + boxes[first]!.height <= top) first += 1
  first = Math.max(0, first - PDF_WINDOW_OVERSCAN)

  let last = first
  while (last < boxes.length && boxes[last]!.top < bottom) last += 1
  last = Math.min(boxes.length, last + PDF_WINDOW_OVERSCAN)
  return { first, last }
})

const pdfVisiblePages = computed(() => {
  const layout = pdfLayout.value
  if (!layout) return []
  const { first, last } = pdfWindow.value
  const pages: { page: number; top: number; height: number }[] = []
  for (let i = first; i < last; i += 1) {
    const box = layout.boxes[i]!
    pages.push({ page: i + 1, top: box.top, height: box.height })
  }
  return pages
})

/** The room the pages above the window stand in for, and the pages below it. */
const pdfTopPad = computed(() => {
  const layout = pdfLayout.value
  return layout ? (layout.boxes[pdfWindow.value.first]?.top ?? 0) : 0
})

const pdfBottomPad = computed(() => {
  const layout = pdfLayout.value
  if (!layout) return 0
  const { last } = pdfWindow.value
  // The last page rendered keeps the document's own trailing padding, so the
  // scroll height does not change by a gap as the end comes into view.
  if (last >= layout.boxes.length) return PDF_PAGE_PAD
  return Math.max(0, layout.total - (layout.boxes[last]?.top ?? layout.total))
})

/** The page a scroll position is on: the last page whose top has reached it. */
function pdfPageAtScroll(top: number): number {
  const layout = pdfLayout.value
  if (!layout) return 1
  let page = 1
  for (let i = 0; i < layout.boxes.length; i += 1) {
    if (layout.boxes[i]!.top <= top + 4) page = i + 1
    else break
  }
  return page
}

/** The box was scrolled: read the page from it, so the footer and the bar follow. */
function onPdfScroll(): void {
  const el = pdfScrollEl.value
  if (!el) return
  pdfScrollTop.value = el.scrollTop
  const target = pdfDisplayTarget.value
  if (target) setPdfPage(target, pdfPageAtScroll(el.scrollTop))
}

/** Scroll the document so `page` is at its top, and make that the current page. */
function scrollToPdfPage(page: number): void {
  const target = pdfDisplayTarget.value
  const layout = pdfLayout.value
  if (!target || !layout) return
  setPdfPage(target, page)

  const box = layout.boxes[pdfPageFor(target) - 1]
  const el = pdfScrollEl.value
  if (!box || !el) return
  el.scrollTop = box.top
  pdfScrollTop.value = el.scrollTop
}

/**
 * Lay a freshly opened document out: wait for its header, put the top of the
 * shared page at the top of the box, and reveal the display. A page shared with
 * the footer — where the cursor stepped through the thumbnail, or a display was
 * dismissed on — is picked up here rather than starting at the first page.
 */
async function positionPdfStage(token: number, target: PreviewTarget): Promise<void> {
  const info = await ensurePdfInfo(target, api)
  if (token !== stageToken) return
  if (!info) {
    stageState.value = 'failed'
    return
  }
  await nextTick()
  if (token !== stageToken) return
  scrollToPdfPage(pdfPageFor(target))
  onStageShown()
}

/** A rendered page's cache key, so identity, page and width all have a say. */
function pdfFrameKey(page: number): string {
  const key = previewKeyFor(pdfDisplayTarget.value)
  return key === null ? '' : `${key}\u0000${page}\u0000${pdfRenderWidth.value}`
}

/** The raster for a page, or null while it is still on its way. */
function pdfFrameFor(page: number): string | null {
  const key = pdfFrameKey(page)
  return key === '' ? null : (pdfFrames.value.get(key) ?? null)
}

/**
 * A page's text key. It carries no width: a text layer is the page's own words
 * with their own boxes, and the scale that lays them over the raster is worked
 * out when they are drawn, so a zoom does not need the text asked for again.
 */
function pdfTextKey(page: number): string {
  const key = previewKeyFor(pdfDisplayTarget.value)
  return key === null ? '' : `${key}\u0000${page}`
}

/** The text of a page, or null while it is still on its way (or has none). */
function pdfTextFor(page: number): PdfPageText | null {
  const key = pdfTextKey(page)
  return key === '' ? null : (pdfTexts.value.get(key) ?? null)
}

/** The words of a page, or none, for the text layer's spans. */
function pdfWordsFor(page: number): PdfWord[] {
  return pdfTextFor(page)?.words ?? []
}

/**
 * Select a word in a text layer, by putting the document selection over its span.
 * Word spans are keyed by their index in the page's `words`, so the DOM order and
 * the text order agree and a range can be built from the two by index. The highlight
 * is re-read from the selection here as well as from `selectionchange`, since a
 * selection we made ourselves is not a *change* to anything the browser watches.
 */
function selectPdfRange(
  from: { layer: HTMLElement; index: number },
  to: { layer: HTMLElement; index: number }
): void {
  const start = from.layer.children[from.index]?.firstChild
  const end = to.layer.children[to.index]?.firstChild
  if (!start || !end) return

  const range = document.createRange()
  range.setStart(start, 0)
  range.setEnd(end, end.textContent?.length ?? 0)
  const selection = document.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  updatePdfSelections()
}

/** The first and last word of the text block (the paragraph) a word sits in. */
function pdfBlockBounds(text: PdfPageText, index: number): { first: number; last: number } {
  const block = text.words[index]?.block
  let first = index
  while (first > 0 && text.words[first - 1]!.block === block) first -= 1
  let last = index
  while (last < text.words.length - 1 && text.words[last + 1]!.block === block) last += 1
  return { first, last }
}

/**
 * The paragraph a triple-click drag is anchored to, and the button that started it.
 * A triple-click selects the paragraph under the pointer, and holding the button
 * and dragging extends the selection a *paragraph* at a time — the gesture a
 * reader expects of a triple-click, which the browser cannot give here: its own
 * paragraph is the word (a word span has to be a block to sit at its box), so the
 * paragraphs come from poppler's blocks and the extending is ours.
 */
let paragraphDrag: { layer: HTMLElement; page: number; first: number; last: number } | null = null

/**
 * The word nearest a point, in the page's own points — worked out from the word
 * boxes rather than from the DOM, so a point between two words (there are gaps
 * between the boxes, and the layer's own background fills them) still names the
 * word it is nearest: the nearest line first, then the nearest word on it.
 */
function pdfWordIndexAt(layer: HTMLElement, page: number, clientX: number, clientY: number): number | null {
  const text = pdfTextFor(page)
  if (!text || text.width <= 0 || text.words.length === 0) return null

  const box = layer.getBoundingClientRect()
  if (box.width <= 0) return null
  const scale = box.width / text.width
  const x = (clientX - box.left) / scale
  const y = (clientY - box.top) / scale

  let best = 0
  let bestDistance = Infinity
  for (let i = 0; i < text.words.length; i += 1) {
    const word = text.words[i]!
    if (x >= word.x && x <= word.x + word.width && y >= word.y && y <= word.y + word.height) return i

    const dy = y < word.y ? word.y - y : y > word.y + word.height ? y - (word.y + word.height) : 0
    const dx = x < word.x ? word.x - x : x > word.x + word.width ? x - (word.x + word.width) : 0
    // A line's distance counts for far more than a word's along it, so the word
    // chosen is the nearest one on the nearest line.
    const distance = dy * 1000 + dx
    if (distance < bestDistance) {
      bestDistance = distance
      best = i
    }
  }
  return best
}

/**
 * A triple-click selects the *paragraph*, which the browser cannot do here: a
 * word span is a block of its own (it has to be, to sit at its box), so the
 * browser's own paragraph is one word. The paragraph is the text block poppler
 * grouped the word into, and the whole block is selected as one range. The press's
 * own default is called off, since the one thing it would do is select the word
 * again — and the drag that may follow is ours from here (`onPdfParagraphDrag`).
 */
function onPdfWordsMouseDown(event: MouseEvent): void {
  if (event.button !== 0 || event.detail !== 3) return

  const span = event.target
  if (!(span instanceof HTMLElement)) return
  const layer = span.parentElement
  if (!layer || !layer.hasAttribute('data-pdf-text')) return

  const index = Array.prototype.indexOf.call(layer.children, span)
  const page = Number(layer.dataset.page ?? '1')
  const text = pdfTextFor(page)
  if (!text || !text.words[index]) return

  event.preventDefault()

  const { first, last } = pdfBlockBounds(text, index)
  paragraphDrag = { layer, page, first, last }
  selectPdfRange({ layer, index: first }, { layer, index: last })
}

/**
 * The drag that follows a triple-click: whole paragraphs at a time, from the one
 * that was clicked to the one under the pointer. Which side the pointer is on
 * decides which end grows, and the far end of the anchor's paragraph is always
 * kept, so dragging back and forth never loses the paragraph the gesture began
 * on. A pointer off the pages — over the transport, or outside the pane — leaves
 * the selection where it was.
 */
function onPdfParagraphDragMove(event: MouseEvent): void {
  const drag = paragraphDrag
  if (drag === null) return

  const target = document.elementFromPoint(event.clientX, event.clientY)
  const layer = target instanceof Element ? target.closest<HTMLElement>('[data-pdf-text]') : null
  if (layer === null) return

  const page = Number(layer.dataset.page ?? '1')
  const index = pdfWordIndexAt(layer, page, event.clientX, event.clientY)
  const text = pdfTextFor(page)
  if (index === null || !text) return

  const anchor = pdfTextFor(drag.page)
  if (!anchor) return

  // Is the word under the pointer past the anchor paragraph? Across pages the
  // layers' own order answers it; within one page the index does.
  const after =
    layer === drag.layer
      ? index >= drag.first
      : (drag.layer.compareDocumentPosition(layer) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

  if (after) {
    selectPdfRange(
      { layer: drag.layer, index: drag.first },
      { layer, index: pdfBlockBounds(text, index).last }
    )
    return
  }

  selectPdfRange(
    { layer, index: pdfBlockBounds(text, index).first },
    { layer: drag.layer, index: drag.last }
  )
}

function onPdfParagraphDragEnd(): void {
  paragraphDrag = null
}

/** The pan a middle-button drag is making: where the pointer went down, and where
 *  the box was scrolled to then. */
let pdfPan: { x: number; y: number; left: number; top: number } | null = null

/**
 * A middle-button drag pans the document — the gesture a reader brings from every
 * other viewer. It is the box's own scroll that moves, both ways, since a magnified
 * page can be wider than the box as well as taller, and it starts anywhere in the
 * display because the box is the whole of it. The press's default is called off, or
 * the middle button's paste (and, where a browser offers it, its autoscroll) would
 * be reading the same gesture.
 */
function onPdfPanStart(event: MouseEvent): void {
  if (event.button !== 1) return
  const el = pdfScrollEl.value
  if (el === null) return

  event.preventDefault()
  pdfPan = { x: event.clientX, y: event.clientY, left: el.scrollLeft, top: el.scrollTop }
  // The pointer leaves the box while it pans, so the cursor is the window's for
  // the length of the gesture — as the split's own drag does.
  document.body.style.cursor = 'grabbing'
}

function onPdfPanMove(event: MouseEvent): void {
  const pan = pdfPan
  if (pan === null) return
  const el = pdfScrollEl.value
  if (el === null) return

  el.scrollLeft = pan.left - (event.clientX - pan.x)
  el.scrollTop = pan.top - (event.clientY - pan.y)
  // Nothing else has to be told: the box's own scroll event carries the page in
  // view and the window of pages to keep in the document.
}

function onPdfPanEnd(): void {
  if (pdfPan === null) return
  pdfPan = null
  document.body.style.cursor = ''
}

/**
 * The one scale that maps a page's own points onto the width it is drawn at. Every
 * box in the text layer uses it — the words the browser selects and the highlight
 * drawn over them — so the two can never drift apart.
 */
function pdfTextScale(page: number): number | null {
  const text = pdfTextFor(page)
  if (text === null || text.width <= 0 || pdfColumnWidth.value <= 0) return null
  return pdfColumnWidth.value / text.width
}

/** One page's share of the document selection: the words it covers, and how much
 *  of the first and the last of them. */
interface PdfTextSelection {
  first: number
  last: number
  startFraction: number
  endFraction: number
}

/**
 * What is selected, per page, read from the document selection but not *measured*
 * by it. The browser's own highlight follows the substitute font's glyphs, and those
 * glyphs are invisible here — what is drawn on the page is the raster — so the
 * highlight is built from the word boxes the text was read from instead, and all
 * this keeps is which words the selection covers.
 */
const pdfSelections = ref<Map<number, PdfTextSelection>>(new Map())

/** The text layer a page is drawn in, or null while it is not in the document. */
function pdfTextLayerFor(page: number): HTMLElement | null {
  return (
    pdfScrollEl.value?.querySelector<HTMLElement>(`[data-pdf-text][data-page="${page}"]`) ?? null
  )
}

/** Where a selection endpoint sits: the layer, the word, and how far into it. */
function pdfEndpointOf(
  node: Node,
  offset: number
): { layer: HTMLElement; index: number; fraction: number } | null {
  const element = node instanceof Element ? node : node.parentElement
  const span = element?.closest('span')
  const layer = span?.parentElement
  if (!span || !layer || !layer.hasAttribute('data-pdf-text')) return null

  const index = Array.prototype.indexOf.call(layer.children, span)
  if (index < 0) return null

  const length = span.textContent?.length ?? 0
  const fraction = length > 0 ? Math.min(Math.max(offset / length, 0), 1) : 0
  return { layer, index, fraction }
}

/** Read the document selection into word ranges, one per page it covers. */
function updatePdfSelections(): void {
  const selection = document.getSelection()
  const range = selection !== null && !selection.isCollapsed ? selection.getRangeAt(0) : null
  const start = range === null ? null : pdfEndpointOf(range.startContainer, range.startOffset)
  const end = range === null ? null : pdfEndpointOf(range.endContainer, range.endOffset)

  if (start === null || end === null) {
    if (pdfSelections.value.size > 0) pdfSelections.value = new Map()
    return
  }

  const next = new Map<number, PdfTextSelection>()
  for (const item of pdfVisiblePages.value) {
    const layer = pdfTextLayerFor(item.page)
    const text = pdfTextFor(item.page)
    if (layer === null || text === null || text.words.length === 0) continue

    // A layer the selection runs through is covered whole; the two the endpoints
    // are in take only their own part of it.
    const afterStart =
      layer === start.layer ||
      (start.layer.compareDocumentPosition(layer) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    const beforeEnd =
      layer === end.layer ||
      (end.layer.compareDocumentPosition(layer) & Node.DOCUMENT_POSITION_PRECEDING) !== 0
    if (!afterStart || !beforeEnd) continue

    next.set(item.page, {
      first: layer === start.layer ? start.index : 0,
      last: layer === end.layer ? end.index : text.words.length - 1,
      startFraction: layer === start.layer ? start.fraction : 0,
      endFraction: layer === end.layer ? end.fraction : 1
    })
  }

  pdfSelections.value = next
}

/**
 * The bands the highlight is drawn as, in the box's own pixels: one per run of the
 * selection on a line — a run being words that share a line, so a paragraph reads
 * as a band per line rather than a box per word, with the spaces between them
 * covered — from the first word's left edge to the last one's right, and as tall as
 * the line the words sit on rather than as tall as their own ink. A word's box is
 * its *ink*, which is shorter for a word with no descender in it; a band that
 * changed height word by word would read as a fault rather than as a selection.
 */
function pdfHighlightRects(
  page: number
): { left: number; top: number; width: number; height: number }[] {
  const selection = pdfSelections.value.get(page)
  const text = pdfTextFor(page)
  const scale = pdfTextScale(page)
  if (selection === undefined || text === null || scale === null) return []

  const rects: { left: number; top: number; width: number; height: number }[] = []
  let runStart = selection.first

  for (let index = selection.first; index <= selection.last; index += 1) {
    const word = text.words[index]
    if (word === undefined) break
    if (index < selection.last && text.words[index + 1]?.line === word.line) continue

    const first = text.words[runStart]!
    const line = text.lines[word.line]
    const left =
      runStart === selection.first ? first.x + first.width * selection.startFraction : first.x
    const right =
      index === selection.last ? word.x + word.width * selection.endFraction : word.x + word.width

    rects.push({
      left: left * scale,
      top: (line?.y ?? word.y) * scale,
      width: Math.max(1, (right - left) * scale),
      height: Math.max(1, (line?.height ?? word.height) * scale)
    })
    runStart = index + 1
  }
  return rects
}

/**
 * Where a word's span sits over the rendered page. The page is drawn at
 * `pdfColumnWidth` for a page whose own width is `text.width` points, so one
 * uniform scale maps the word's box — and the same scale is what keeps a zoomed
 * page's selection on its glyphs. The font size is the box's height, so the
 * transparent glyphs are the size of the ones beneath them, and the box clips
 * whatever the substitute font draws wider than the word really is. None of that
 * geometry is *seen* — the span is transparent — it is what the pointer and the
 * selection hit, and the visible highlight is drawn from the same boxes by
 * `pdfHighlightRects`.
 */
function pdfWordStyle(page: number, word: PdfWord): Record<string, string> | undefined {
  const scale = pdfTextScale(page)
  if (scale === null) return undefined

  const height = Math.max(1, word.height * scale)
  return {
    left: `${(word.x * scale).toFixed(2)}px`,
    top: `${(word.y * scale).toFixed(2)}px`,
    width: `${Math.max(1, word.width * scale).toFixed(2)}px`,
    height: `${height.toFixed(2)}px`,
    fontSize: `${height.toFixed(2)}px`,
    lineHeight: `${height.toFixed(2)}px`
  }
}

/** A cache map held to `max` entries, least-recently-inserted first. */
function boundPdfCache<T>(map: Map<string, T>, max: number): Map<string, T> {
  while (map.size > max) {
    const oldest = map.keys().next()
    if (oldest.done) break
    map.delete(oldest.value)
  }
  return map
}

/**
 * Fetch what the pages in view need: their rasters, and their text for the
 * selection layer. Each is asked for once (a raster by identity+page+width, a
 * text by identity+page), the answers are kept in the renderer for scrolling
 * back, and a page whose key has changed under a slow answer is dropped rather
 * than drawn against the wrong page. Fetches are kept to a few at a time and the
 * pump is re-run as each lands, so a fast scroll starts a run for the pages it
 * settles on rather than for every page it crossed.
 */
function pumpPdfContent(): void {
  const target = pdfDisplayTarget.value
  if (!target) return
  const width = pdfRenderWidth.value

  for (const item of pdfVisiblePages.value) {
    if (pdfLoading.size + pdfTextLoading.size >= PDF_MAX_INFLIGHT * 2) break

    const frameKey = pdfFrameKey(item.page)
    if (frameKey !== '' && !pdfFrames.value.has(frameKey) && !pdfLoading.has(frameKey)) {
      pdfLoading.add(frameKey)
      void api.fs
        .pdfPage(target.path, item.page, width)
        .then((result) => {
          pdfLoading.delete(frameKey)
          if (!result.ok || frameKey !== pdfFrameKey(item.page)) return
          const next = new Map(pdfFrames.value)
          next.set(frameKey, result.data.dataUrl)
          pdfFrames.value = boundPdfCache(next, PDF_FRAME_CACHE_MAX)
        })
        .catch(() => pdfLoading.delete(frameKey))
        .finally(pumpPdfContent)
    }

    const textKey = pdfTextKey(item.page)
    if (textKey !== '' && !pdfTexts.value.has(textKey) && !pdfTextLoading.has(textKey)) {
      pdfTextLoading.add(textKey)
      void api.fs
        .pdfText(target.path, item.page)
        .then((result) => {
          pdfTextLoading.delete(textKey)
          if (textKey !== pdfTextKey(item.page)) return
          const next = new Map(pdfTexts.value)
          // A page whose text could not be read is remembered as having none, so
          // it is asked for once rather than on every scroll.
          next.set(textKey, result.ok ? result.data : null)
          pdfTexts.value = boundPdfCache(next, PDF_TEXT_CACHE_MAX)
        })
        .catch(() => pdfTextLoading.delete(textKey))
        .finally(pumpPdfContent)
    }
  }
}

// The guard keeps the getter off the layout until a display actually exists:
// before that there is no document and nothing to measure.
watch(
  () => (shownStage.value === null ? [] : ([pdfVisiblePages.value, pdfRenderWidth.value] as const)),
  pumpPdfContent
)

/**
 * A document re-laid out because its box was resized: the column width changed,
 * so the pages are taller or shorter and the scroll offset would otherwise point
 * at a different page. It is put back on the page it was showing. A presentation
 * change between the pane and the window resizes the box too, and this is what
 * keeps the page under the top through it as well — the travel animates the
 * media's transform, not its scroll, so the two do not fight.
 */
watch(
  () => (pdfDisplayTarget.value ? pdfColumnWidth.value : 0),
  () => {
    const target = pdfDisplayTarget.value
    if (!target || stageState.value === 'loading') return
    void nextTick(() => scrollToPdfPage(pdfPageFor(target)))
  }
)

/**
 * Ramp a clip's volume towards `to`, so its sound arrives with the picture it
 * belongs to rather than a beat before it — and leaves with it. A clip faded out
 * ends up muted, so nothing escapes after it. A ramp superseded by another stops
 * where it is, which is what lets a display that is coming back carry on from
 * the volume it had reached.
 *
 * The ramp follows frame callbacks, which is the smooth path — but those stop
 * while the window is hidden, and a dismissal waits on this, so it is bounded in
 * time as well and always finishes.
 */
function fadeVolume(element: HTMLMediaElement, to: number, duration: number): Promise<void> {
  const ramp = (stageSound += 1)

  return new Promise((resolve) => {
    const started = performance.now()
    const from = element.volume
    let backstop = 0
    let settled = false

    const finish = (): void => {
      if (settled) return
      settled = true
      window.clearTimeout(backstop)
      if (ramp === stageSound) {
        element.volume = to
        if (to === 0) element.muted = true
      }
      resolve()
    }

    backstop = window.setTimeout(finish, duration + 120)

    const step = (): void => {
      if (ramp !== stageSound) {
        finish()
        return
      }

      const elapsed = performance.now() - started
      const ratio = duration <= 0 ? 1 : Math.min(elapsed / duration, 1)
      element.volume = from + (to - from) * ratio
      if (ratio < 1) {
        requestAnimationFrame(step)
        return
      }
      finish()
    }

    requestAnimationFrame(step)
  })
}

/**
 * Bring an enlarged clip's sound up, from wherever it has got to. Called when a
 * display arrives, and when one that was leaving is asked for again.
 */
function raiseStageSound(): void {
  const element = stageMedia.value
  if (!(element instanceof HTMLVideoElement)) return

  element.muted = false
  void fadeVolume(element, 1, STAGE_REVEAL_MS)
}

/**
 * Reveal the display: measure where it has laid itself out, put it back onto the
 * thumbnail it grew out of, and let it travel forward into place. One element
 * carries both motions, so the translate and the scale are a single gesture
 * rather than a move followed by a resize.
 *
 * An enlarged clip is being watched rather than glanced at, so this is also
 * where its sound comes up — the footer's own thumbnail stays silent — from
 * silence, so that it arrives over the length the picture takes to arrive in.
 */
function onStageShown(): void {
  stageState.value = 'ready'

  const stage = shownStage.value
  const element = stageMedia.value
  if (!stage || !element) return

  readStageClock()

  if (element instanceof HTMLVideoElement) {
    element.muted = false
    element.volume = 0
    void fadeVolume(element, 1, STAGE_REVEAL_MS)
  }

  // One reveal per entry into the mode: a swap in place while the display is
  // already up is not something to re-animate for every row the cursor crosses.
  if (stage.animation === stageAnimation) return
  stageAnimation = stage.animation

  // The transport arrives with the picture rather than blinking into its final
  // place: it grows out from below the thumbnail the same way the media grows
  // out of it, so the whole player is one gesture and the bar stays under the
  // picture as both scale.
  void animateStageBar(stage.barFrom(), false)

  const from = stage.from()
  const drawn = drawnRect(element, stage.target.kind)
  if (!from || !drawn) return

  // A presentation change replaces a reveal that is still running rather than
  // stacking a second motion on the same picture, so this is the flight it owns.
  stageMediaFlight?.cancel()
  stageMediaFlight = element.animate(
    [{ transform: handoffTransform(from, drawn, element.getBoundingClientRect(), true) }, { transform: 'none' }],
    { duration: STAGE_REVEAL_MS, easing: 'ease-out' }
  )
}

/**
 * Move the display's transport between its own place and the rectangle below the
 * footer's thumbnail, for a reveal (`reverse` false) and a dismissal (`reverse`
 * true). It is the same translate-and-scale the media makes, applied to the
 * bar's own box — the bar is drawn at its final size and laid back to sit under
 * the small preview, so the two motions are one gesture. Answers a promise that
 * settles whether the flight finished or was superseded.
 */
function animateStageBar(target: DOMRect | null, reverse: boolean): Promise<void> {
  stageBarFlight?.cancel()
  stageBarFlight = null

  const bar = stageBarEl.value
  if (bar === null || target === null) return Promise.resolve()

  const box = bar.getBoundingClientRect()
  if (box.width <= 0 || box.height <= 0) return Promise.resolve()

  const transform = handoffTransform(target, box, box)
  const flight = bar.animate(
    reverse ? [{ transform: 'none' }, { transform }] : [{ transform }, { transform: 'none' }],
    {
      duration: STAGE_REVEAL_MS,
      easing: reverse ? 'ease-in' : 'ease-out',
      fill: reverse ? 'forwards' : 'none'
    }
  )
  stageBarFlight = flight
  return flight.finished.then(
    () => {},
    () => {}
  )
}

/**
 * Put the display away: shrink it back onto the thumbnail it came from, fade its
 * sound out with it, and only then take it off screen. The request is held onto
 * until this is done, because the element has to still be there to move.
 */
async function dismissStage(): Promise<void> {
  if (stageDismissing) return
  stageDismissing = true

  try {
    await runDismissal()
  } finally {
    stageDismissing = false
  }
}

async function runDismissal(): Promise<void> {
  const stage = shownStage.value
  const element = stageMedia.value

  // Leaving a full-screen display takes the window's backdrop with it, over the
  // same length the picture takes to shrink back into its pane — whether or not
  // there is anything to move, since an empty display sits on it too.
  animateStageBackdrop(false)

  if (stage === null || element === null) {
    shownStage.value = null
    stageModel.value = null
    stageState.value = 'idle'
    fullscreenPresentation.value = false
    clearStageClock()
    emit('stage-clock', null)
    return
  }

  const to = stage.from()
  const drawn = drawnRect(element, stage.target.kind)

  let moving: Promise<void> = Promise.resolve()
  let shrink: Animation | null = null
  if (to !== null && drawn !== null) {
    shrink = element.animate(
      [
        { transform: 'none' },
        { transform: handoffTransform(to, drawn, element.getBoundingClientRect(), true) }
      ],
      { duration: STAGE_REVEAL_MS, easing: 'ease-in', fill: 'forwards' }
    )
    stageDismissal = shrink
    // A cancelled animation rejects here, which is not a failure: the request
    // that replaced this one owns the display now.
    moving = shrink.finished.then(
      () => {},
      () => {}
    )
  }

  // The transport shrinks back under the small preview as the picture shrinks
  // onto its thumbnail, so leaving the mode is the reveal played backwards.
  const bars = animateStageBar(stage.barFrom(), true)

  const silenced =
    element instanceof HTMLVideoElement ? fadeVolume(element, 0, STAGE_REVEAL_MS) : Promise.resolve()

  await Promise.all([moving, bars, silenced])

  if (stageDismissal === shrink) stageDismissal = null
  if (shownStage.value !== stage) return

  shownStage.value = null
  stageModel.value = null
  stageState.value = 'idle'
  fullscreenPresentation.value = false
  clearStageClock()
  emit('stage-clock', null)
}

/**
 * Carry on where the pane that asked had got to. The clip was already part way
 * through there, so a display that began it again would read as a restart rather
 * than as the same clip changing place.
 */
function resumeStage(event: Event): void {
  const element = event.target
  const stage = shownStage.value
  if (!(element instanceof HTMLVideoElement) || !stage) return

  // This element was started at the offset its URL carries, and it is now the
  // one the bar must count from.
  stageStreamOrigin.value = stageFrom.value
  stageSeekPending = false
  if (element.videoWidth > 0 && element.videoHeight > 0) {
    stageAspect.value = element.videoWidth / element.videoHeight
  }
  pickUpAt(element, previewKeyFor(stage.target), stage.resumeAt)
}

function onStageError(): void {
  stageState.value = 'failed'
}

/**
 * A left click on the enlarged clip itself, or on its play/pause button: pause
 * it, or play it again. Only the primary button is a click here — releasing the
 * right button after a wheel scrub must not count as one.
 */
function onStageVideoClick(event: MouseEvent): void {
  if (event.button !== 0) return
  if (performance.now() < stageClickSuppressedUntil) return
  togglePlayback(stageMedia.value)
}

/**
 * A double left-click on the enlarged media switches it between its pane and the
 * whole window — the mouse's way of the Ctrl+Enter the mode already answers, and
 * the gesture a viewer is expected to make on the picture itself. It is the same
 * for a clip and a still: on a video the two clicks that make up the double-click
 * have each toggled play/pause already, so they cancel out and only the
 * presentation is left to change; an image has no such click of its own.
 */
function onStageMediaDblclick(event: MouseEvent): void {
  if (event.button !== 0) return
  emit('toggle-fullscreen')
}

/**
 * The YouTube-style on-screen display: a glyph flashed over the picture on a
 * pause, a resume or a seek, which the overlay fades on its own and reports back
 * with `done`. The footer thumbnail and the enlarged display keep one each —
 * the two can be showing different clips, and either can be the one driven.
 */
const footerOsd = ref<OsdFlash | null>(null)
const stageOsd = ref<OsdFlash | null>(null)

/** Identity of one flash, so a repeat of an action is a new element that animates. */
let osdSeq = 0

/**
 * Flash the display over whichever clip an action was on: the enlarged pane's,
 * or this pane's footer thumbnail. `delta` is a seek's step in seconds, positive
 * forward. Nothing is flashed for an action on an image, which has none of this.
 */
function flashOsd(
  element: HTMLElement | null,
  kind: OsdFlash['kind'],
  delta = 0
): void {
  if (!(element instanceof HTMLVideoElement)) return
  const flash: OsdFlash = { kind, delta, id: ++osdSeq }
  if (element === stageMedia.value) stageOsd.value = flash
  else footerOsd.value = flash
}

/** Pause or resume one video, answering whether there was one to toggle. */
function togglePlayback(element: HTMLElement | null): boolean {
  if (!(element instanceof HTMLVideoElement)) return false
  const resuming = element.paused
  if (resuming) void element.play().catch(() => {})
  else element.pause()
  flashOsd(element, resuming ? 'play' : 'pause')
  return true
}

/** Space: the clip this pane is displaying, when there is one. */
function toggleStagePlayback(): boolean {
  return togglePlayback(stageMedia.value)
}

/** Space without a display: the footer's own preview of the cursor's clip. */
function togglePreviewPlayback(): boolean {
  return togglePlayback(previewVideo.value)
}

/**
 * The footer thumbnail's box, so a pane showing this pane's media can grow it
 * out of the row it was asked for. Null while there is nothing to grow from.
 */
const previewEl = ref<HTMLElement | null>(null)

/** The footer's own clip, while one is playing there. */
const previewVideo = ref<HTMLVideoElement | null>(null)

/**
 * Whether an element is reading a clip main has to encode, which is a stream
 * rather than a file: it is moved about by asking for it from another position,
 * and its own clock counts from the start of whatever it was given rather than
 * from the start of the clip.
 */
function isStream(element: HTMLVideoElement): boolean {
  const target = element === stageMedia.value ? shownStage.value?.target : previewTarget.value
  return target !== null && target !== undefined && target.encode
}

/** Where the footer's clip has got to, and how long it is once that is knowable. */
const videoTime = ref(0)
const videoLength = ref<number | null>(null)

/**
 * The length of a clip main has to encode, asked of the file: while it is being
 * encoded the element has only a live stream, which cannot report one.
 */
const clipLength = ref<number | null>(null)
let clipLengthKey: string | null = null

/**
 * Where a clip has got to, as its own element reports it: its position always,
 * and its length only once it is a whole file with a range that is really there.
 * A clip main is still encoding arrives as a live stream, whose "length" is a
 * growing estimate of what has been encoded so far — a bar drawn from that would
 * misstate a three-minute file as a four-second one.
 */
function clockOf(element: HTMLVideoElement): PlaybackClock {
  const ranges = element.seekable
  const measured =
    Number.isFinite(element.duration) && ranges.length > 0 && ranges.end(ranges.length - 1) > 0
  return { time: element.currentTime, length: measured ? element.duration : null }
}

/**
 * Ask the file itself how long a clip is, for one whose stream cannot say. Asked
 * once per file, and only for a clip main has to encode.
 */
function ensureClipLength(target: PreviewTarget): void {
  if (!target.encode) return

  const key = previewKeyFor(target)
  if (key === null || key === clipLengthKey) return
  clipLengthKey = key
  void api.fs.videoDuration(target.path).then((seconds) => {
    if (clipLengthKey !== key) return
    clipLength.value = seconds
  })
}

/** The length of a displayed clip main has to encode, asked of the file once. */
function ensureStageLength(target: PreviewTarget): void {
  if (!target.encode) return

  const key = previewKeyFor(target)
  if (key === null || key === stageClipLengthKey) return
  stageClipLengthKey = key
  void api.fs.videoDuration(target.path).then((seconds) => {
    if (stageClipLengthKey !== key) return
    stageClipLength.value = seconds
  })
}

/**
 * Follow the footer's clip for the play bar beside its thumbnail.
 */
function readVideoClock(): void {
  const element = previewVideo.value
  if (!(element instanceof HTMLVideoElement)) return

  const clock = clockOf(element)
  const stream = isStream(element)
  // A stream counts from the start of whatever it was given, so the clip's
  // position is the offset it was started at plus this element's own clock — and
  // its length is what is left of the clip rather than the clip, which is what
  // the file itself is asked for instead.
  videoTime.value = (stream ? footerFrom.value : 0) + clock.time
  videoLength.value = stream ? null : clock.length

  // A held position has done its job now that this element has been read — and
  // not before: until it can be read the element is a fresh one at 0:00, so
  // dropping the position a moment earlier would flash the bar back to a stale
  // value on the way.
  pickUpFrom.value = null

  // A clip still being encoded is a live stream, which has no length of its own
  // to report: ask the file, once, for the row the cursor has settled on.
  const target = previewTarget.value
  if (clock.length === null && target) ensureClipLength(target)
}

/**
 * Where the enlarged clip has got to, published for the pane that asked for it:
 * that pane no longer holds an element of its own to read it from.
 */
function readStageClock(): void {
  const element = stageMedia.value
  if (!(element instanceof HTMLVideoElement)) {
    emit('stage-clock', null)
    return
  }
  const clock = clockOf(element)
  const stream = isStream(element)
  // A stream counts from the origin it was started at, which is not the offset
  // the next stream will be asked for once the bar seeks it again.
  const time = (stream ? stageStreamOrigin.value : 0) + clock.time
  const length = stream ? null : clock.length

  // A seek still in flight reported the old position: once the element has
  // reached where it was sent, the hold has done its job.
  if (stageSeekHold !== null && Math.abs(time - stageSeekHold) < 0.35) releaseStageSeek()

  emit('stage-clock', { time: stageSeekHold ?? time, length })

  // The bar being dragged is the thing showing the position, a stream that has
  // been asked for again has not caught up with it yet, and a clip being seeked
  // is held where it was dropped until the element agrees.
  if (stageScrub === null && stageSeekHold === null && !(stream && stageSeekPending)) {
    stageTime.value = time
  }
  if (!stream) stageDuration.value = length

  const target = shownStage.value?.target
  if (length === null && target) ensureStageLength(target)
}

/**
 * A clip that has run out: the display plays once rather than looping, so the
 * last frame stays on screen and the transport says `Play` again — an element
 * that has ended is not marked paused by a `pause` event, so the button's own
 * `stagePlaying` has to be told here rather than waiting for one that never
 * comes. Stepping back into the clip plays on from there (`seek`), which is
 * where `@play` turns it back.
 */
function onStageEnded(): void {
  readStageClock()
  stagePlaying.value = false
}

/**
 * The clock the bar is drawn from, which has to be continuous across the hand-off
 * in both directions: the display's while it has the clip, the last position the
 * display was at while the clip is on its way back (the element is fresh and has
 * not been moved yet), and this pane's own element otherwise.
 */
const playTime = computed(() => {
  if (props.transferred) return props.displayedClock?.time ?? videoTime.value

  const held = pickUpFrom.value
  if (held !== null && held.key === previewKeyFor(previewTarget.value)) return held.time
  return videoTime.value
})

const playLength = computed(() => {
  // The file's own length, where it has been asked for, over the element's: a
  // stream's length is only what is left of the clip, not the clip.
  const own = clipLength.value ?? videoLength.value
  if (!props.transferred) return own
  return props.displayedClock?.length ?? own
})

/** How much of the clip the bar has filled. */
const playProgress = computed(() => {
  const length = playLength.value
  if (length === null || length <= 0) return '0%'
  const ratio = Math.min(Math.max(playTime.value / length, 0), 1)
  return `${(ratio * 100).toFixed(2)}%`
})

/**
 * Whether the play bar belongs in the footer at all. Not while a clip is still
 * being encoded and nothing has played yet: there is no length to show and no
 * position to show, and a dead `0:00` beside a spinner says less than the
 * spinner alone.
 */
const showPlayBar = computed(
  () =>
    previewTarget.value?.kind === 'video' &&
    (props.transferred === true || showVideo.value) &&
    (playLength.value !== null || playTime.value > 0)
)

/**
 * The footer's own page readout for a PDF: which page of how many is on screen.
 * It is the clip's play bar in the same place — the footer says where in the
 * media the box is — but a page is a step rather than a position, so there is no
 * clock to follow and the answer is the shared page both this box and a display
 * read. It is shown whether or not this pane still draws the page itself, so a
 * display taking the thumbnail over leaves the readout where it was.
 */
const showPageBar = computed(
  () => previewTarget.value?.kind === 'pdf' && (props.transferred === true || showPdf.value)
)

const pdfPageCount = computed(() => pdfPageCountFor(previewTarget.value))
const pdfPageNumber = computed(() => pdfPageFor(previewTarget.value))

/** How far through the document the page is, for the little bar beside it. */
const pdfPageProgress = computed(() => {
  const count = pdfPageCount.value
  if (count === null || count <= 1) return '0%'
  const ratio = (pdfPageNumber.value - 1) / (count - 1)
  return `${(Math.min(Math.max(ratio, 0), 1) * 100).toFixed(2)}%`
})

/**
 * A position an element has to pick up at, held with the clip it belongs to so
 * that it can never be applied to a different one. Two things put one there: a
 * display handing the clip back, and a seek that had to replace the element —
 * because the file behind it was still being encoded, and only became something
 * the keys can move about once the encode was done. Until the fresh element has
 * been moved, this is also what the bar shows, so the strip does not flicker
 * down to 0:00 on the way.
 */
const pickUpFrom = ref<{ key: string; time: number } | null>(null)

watch(
  () => props.displayedClock,
  (clock) => {
    const key = previewKeyFor(previewTarget.value)
    if (props.transferred !== true || !clock || key === null) return
    pickUpFrom.value = { key, time: clock.time }
  }
)

// A clip coming back to this pane's own element, which has to be read from where
// the display left it: by then the element is a fresh one, and asking the stream
// for that position is the only way a clip main has to encode can start there.
watch(
  () => props.transferred === true,
  (transferred) => {
    if (transferred) return
    const held = pickUpFrom.value
    const target = previewTarget.value
    if (held === null || target === null || held.key !== previewKeyFor(target)) return
    footerFrom.value = held.time
  }
)

/**
 * The clip a display has taken over is played *there*, so this pane asks the file
 * for its length itself: nothing of this pane's own will report one.
 */
watch(
  () => (props.transferred === true ? previewKeyFor(previewTarget.value) : null),
  (key) => {
    if (key === null) return
    const target = previewTarget.value
    if (target) ensureClipLength(target)
  },
  { immediate: true }
)

/**
 * The box this pane's own content is drawn in, for the copies a Ctrl+U exchange
 * travels: a display blurs that content with a filter the app applied through the
 * Web Animations API, which a clone carries neither directly nor as a style
 * attribute — so the copy reads it from here.
 */
function contentEl(): HTMLElement | null {
  return paneContent.value
}

function previewRect(): DOMRect | null {
  // In the wall a display is revealed out of the cursor's own *tile* — the
  // picture the user is looking at — rather than the footer's little box, which
  // the wall does not even draw for a model.
  if (thumbnails.value) {
    const tile = gridEl.value?.cellRect()
    if (tile) return tile
  }

  const element = previewEl.value
  if (!element || element.offsetParent === null) return null
  return element.getBoundingClientRect()
}

/**
 * The rectangle a clip's transport grows out of: the footer's thumbnail box,
 * dropped to its own bottom edge — directly below the small preview, so the bar
 * travels hugging the picture all the way rather than from wherever the strip's
 * own little bar happens to sit. Null when this pane has no thumbnail up, since
 * there is then nothing for a display to grow from. In the wall the same is done
 * for the cursor's tile, so the transport comes out from under the picture being
 * enlarged.
 */
function previewBarRect(): DOMRect | null {
  if (thumbnails.value) {
    const tile = gridEl.value?.cellRect()
    if (tile) return new DOMRect(tile.left, tile.bottom, tile.width, tile.height)
  }

  const element = previewEl.value
  if (!element || element.offsetParent === null) return null
  const box = element.getBoundingClientRect()
  if (box.width <= 0 || box.height <= 0) return null
  return new DOMRect(box.left, box.bottom, box.width, box.height)
}

/**
 * Where this pane's own preview of the clip has got to, for a display about to
 * take the clip over — with the clip it belongs to, so that it can never be
 * carried onto a different one. Null when there is no element (which is what a
 * pane whose clip is already displayed has) and at the very start, where there
 * is nothing to carry over.
 */
function previewPosition(): { key: string; time: number } | null {
  const element = previewVideo.value
  const key = previewKeyFor(previewTarget.value)
  if (!(element instanceof HTMLVideoElement) || key === null) return null

  // Where the clip is, not where this element is: a stream counts from the start
  // of whatever it was given, so a clip that has been moved about is further
  // along than the element's own clock says.
  const at = (isStream(element) ? footerFrom.value : 0) + element.currentTime

  // A preview that has played itself out has nothing to hand over: the display
  // is where the clip is watched, so it starts it again rather than sitting on
  // the last frame the thumbnail stopped at.
  if (element.ended || at <= 0) return null
  return { key, time: at }
}

/**
 * Step through a clip by `delta` seconds, which is what the arrow keys do while
 * the command line has nothing typed in it.
 *
 * Stepping back into a clip that had played itself out plays on from there,
 * rather than leaving a frozen last frame behind a key that clearly asked to see
 * more; stepping past its end does not, so the end of a clip is the end of it
 * and not quietly the beginning again.
 */
function seek(element: HTMLElement | null, delta: number): void {
  if (!(element instanceof HTMLVideoElement)) return

  const duration = element.duration
  if (!Number.isFinite(duration) || duration <= 0) return

  flashOsd(element, 'seek', delta)

  // Reading `ended` has to happen before the seek: moving the playhead anywhere
  // but the end is what clears it.
  const wasEnded = element.ended
  const at = Math.min(Math.max(element.currentTime + delta, 0), duration)

  // A clip main has to encode is a live stream, which reports no range to move
  // within — so there is nothing for this element to seek to. Moving about such
  // a clip means asking for its stream again from the position wanted, which is
  // what the offset in that element's URL is for: it reloads there and plays on.
  // It is never moved by seeking the element itself, even where the stream has
  // grown a range: that range is the rest of the clip, and its clock is rebased.
  if (!canMoveWithin(element, at) || isStream(element)) {
    const onStage = element === stageMedia.value
    const wanted = Math.max(0, (onStage ? stageFrom.value : footerFrom.value) + element.currentTime + delta)
    if (onStage) {
      // Asking for the origin the stream already starts at would change nothing
      // to load; move within what is playing instead.
      if (!stageSeekPending && wanted === stageStreamOrigin.value) {
        const at = wanted - stageStreamOrigin.value
        if (canMoveWithin(element, at)) element.currentTime = at
      } else {
        stageSeekPending = true
        stageFrom.value = wanted
      }
      // The bar keeps showing where the clip is being taken while it reloads.
      stageTime.value = wanted
    } else {
      footerFrom.value = wanted
      // The bar keeps showing where the clip is being taken while it reloads.
      const key = previewKeyFor(previewTarget.value)
      if (key !== null) pickUpFrom.value = { key, time: wanted }
    }
    return
  }

  element.currentTime = at
  if (element === stageMedia.value) holdStageSeek(at)
  if (wasEnded && at < duration) void element.play().catch(() => {})
}

/**
 * Whether a clip has a real range covering `at`: a clip main is still
 * transcoding arrives as a growing stream, and a stream has nothing to move
 * within — Chromium gives a live source a single empty range. Once the encode is
 * done the same clip is served as a whole file, ranges and all.
 */
function canMoveWithin(element: HTMLVideoElement, at: number): boolean {
  const ranges = element.seekable
  for (let i = 0; i < ranges.length; i += 1) {
    if (ranges.end(i) > 0 && at >= ranges.start(i) && at <= ranges.end(i)) return true
  }
  return false
}

function seekPreview(delta: number): void {
  // A PDF has no playhead to move: its position is a page, so a step key turns
  // one. While a display has the file, the page is the display's to turn — the
  // same reason a clip being displayed is stepped there rather than here — so
  // this acts only while the thumbnail is the only thing showing it.
  const target = previewTarget.value
  if (target?.kind === 'pdf') {
    if (props.transferred !== true) stepPdfPage(target, delta < 0 ? -1 : 1)
    return
  }
  seek(previewVideo.value, delta)
}

function seekStage(delta: number): void {
  const target = shownStage.value?.target
  if (target?.kind === 'pdf') {
    // A displayed PDF is a document: a step scrolls it a page rather than
    // swapping a raster, so the motion reads as the document moving.
    scrollToPdfPage(pdfPageFor(target) + (delta < 0 ? -1 : 1))
    return
  }
  seek(stageMedia.value, delta)
}

/**
 * The enlarged clip's length: what its own element reports for a whole file, and
 * the file's own length for one main has to encode — its live stream can only
 * say what is left of the clip.
 */
const stagePlayLength = computed(() => stageClipLength.value ?? stageDuration.value)

/** How much of the enlarged clip the bar has filled. */
const stageProgress = computed(() => {
  const length = stagePlayLength.value
  if (length === null || length <= 0) return '0%'
  const ratio = Math.min(Math.max(stageTime.value / length, 0), 1)
  return `${(ratio * 100).toFixed(2)}%`
})

/** The handle's position, held inside the track at both ends rather than half over it. */
const stageThumbLeft = computed(
  () => `clamp(6px, ${stageProgress.value}, calc(100% - 6px))`
)

/**
 * The page transport of a displayed PDF. Its "position" is the shared page, or
 * the one a drag in flight is asking for; its "length" is the page count. Both
 * numbers come from the document rather than from the element, since a page has
 * no clock of its own.
 */
const stagePdfPages = computed(() => pdfPageCountFor(shownStage.value?.target ?? null))
const stagePdfPage = computed(() =>
  pdfScrubPage.value ?? pdfPageFor(shownStage.value?.target ?? null)
)

const stagePdfProgress = computed(() => {
  const pages = stagePdfPages.value
  const page = stagePdfPage.value
  if (pages === null || pages <= 1) return '0%'
  const ratio = (page - 1) / (pages - 1)
  return `${(Math.min(Math.max(ratio, 0), 1) * 100).toFixed(2)}%`
})

const stagePdfThumbLeft = computed(
  () => `clamp(6px, ${stagePdfProgress.value}, calc(100% - 6px))`
)

/** Turn the displayed PDF's page from the transport's own buttons. */
function stepStagePdfPage(delta: number): void {
  const target = shownStage.value?.target
  if (target?.kind === 'pdf') scrollToPdfPage(pdfPageFor(target) + delta)
}

const canPdfPrev = computed(() => stagePdfPage.value > 1)
const canPdfNext = computed(() => {
  const pages = stagePdfPages.value
  return pages === null || stagePdfPage.value < pages
})

/**
 * The media area and the video's own box. The bar under a clip has to be as wide
 * as the picture, not the pane, so the video is laid out at the size its aspect
 * allows inside the area and the bar shares that width. Both are measured,
 * because the pane can be resized at any moment.
 */
const stageArea = ref<HTMLElement | null>(null)
const stageBarEl = ref<HTMLElement | null>(null)
const stageAreaSize = ref<PixelSize | null>(null)
const stageBarHeight = ref(0)

/** The breathing room between the clip and the bar under it. */
const STAGE_BAR_GAP = 0

let stageAreaObserver: ResizeObserver | null = null
let stageBarObserver: ResizeObserver | null = null

function measureStageArea(element: HTMLElement | null): void {
  stageAreaObserver?.disconnect()
  stageAreaObserver = null
  stageAreaSize.value = null
  if (!element) return

  const measure = (): void => {
    stageAreaSize.value = { width: element.clientWidth, height: element.clientHeight }
  }
  stageAreaObserver = new ResizeObserver(measure)
  stageAreaObserver.observe(element)
  measure()
}

function measureStageBar(element: HTMLElement | null): void {
  stageBarObserver?.disconnect()
  stageBarObserver = null
  stageBarHeight.value = 0
  if (!element) return

  const measure = (): void => {
    stageBarHeight.value = element.offsetHeight
  }
  stageBarObserver = new ResizeObserver(measure)
  stageBarObserver.observe(element)
  measure()
}

watch(stageArea, measureStageArea)
watch(stageBarEl, measureStageBar)

/**
 * The media's box with its transport: its aspect fitted into the media area with
 * room kept for the bar, so the transport beneath it is exactly as wide as the
 * picture. A clip and a PDF page both have a bar; a still has none.
 */
const stageMediaSize = computed(() => {
  const area = stageAreaSize.value
  const aspect = stageAspect.value
  if (area === null || aspect === null || aspect <= 0) return null

  const height = Math.max(1, area.height - stageBarHeight.value - STAGE_BAR_GAP)
  const width = Math.max(1, Math.min(area.width, height * aspect))
  return { width, height: width / aspect }
})

const stageColumnStyle = computed(() => {
  const size = stageMediaSize.value
  return size === null ? { width: '100%' } : { width: `${Math.round(size.width)}px` }
})

const stageMediaStyle = computed(() => {
  const size = stageMediaSize.value
  return size === null ? { height: '100%' } : { height: `${Math.round(size.height)}px` }
})

/** How far along the bar a pointer is, from 0 to 1. */
function stageRatioAt(event: PointerEvent): number {
  const bar = event.currentTarget
  if (!(bar instanceof HTMLElement)) return 0
  const rect = bar.getBoundingClientRect()
  if (rect.width <= 0) return 0
  return Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1)
}

/**
 * Move the enlarged clip to `position`. A clip Chromium plays is seeked where it
 * stands, frame by frame while the bar is dragged; one main has to encode is a
 * live stream, so its position is held for the reload on release rather than
 * asking for a new encode for every pixel the pointer crosses.
 */
function scrubStageTo(
  position: number,
  settle: boolean,
  stream = stageScrub?.stream === true
): void {
  const element = stageMedia.value
  const target = shownStage.value?.target
  if (!(element instanceof HTMLVideoElement) || !target) return

  const length = stagePlayLength.value
  const wanted = Math.max(0, length === null ? position : Math.min(position, length))
  stageTime.value = wanted

  if (stream) {
    if (!settle) return
    // A stream that already starts here is still the one playing: there is
    // nothing to reload, only a position within what it has. Without this, a
    // drag back to the origin would wait for a reload that never comes.
    if (!stageSeekPending && wanted === stageStreamOrigin.value) {
      const at = wanted - stageStreamOrigin.value
      if (canMoveWithin(element, at)) element.currentTime = at
      return
    }
    stageSeekPending = true
    stageFrom.value = wanted
    return
  }

  const duration = element.duration
  if (!Number.isFinite(duration) || duration <= 0) return
  const wasEnded = element.ended
  const at = Math.min(wanted, duration)
  element.currentTime = at
  // Hold the bar where it was dropped until the element has really moved there,
  // or it would flash back to the old position for the length of the seek.
  if (settle) holdStageSeek(at)
  if (wasEnded && at < duration) void element.play().catch(() => {})
}

function onStageBarPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return

  const element = stageMedia.value
  const length = stagePlayLength.value
  if (!(element instanceof HTMLVideoElement) || length === null || length <= 0) return

  event.preventDefault()
  event.stopPropagation()

  const bar = event.currentTarget
  if (bar instanceof HTMLElement) bar.setPointerCapture(event.pointerId)

  const wanted = stageRatioAt(event) * length
  stageScrub = { length, stream: isStream(element), pending: wanted }
  stageScrubbing.value = true
  scrubStageTo(wanted, false)
}

function onStageBarPointerMove(event: PointerEvent): void {
  if (stageScrub === null) return
  stageScrub.pending = stageRatioAt(event) * stageScrub.length
  scrubStageTo(stageScrub.pending, false)
}

function onStageBarPointerUp(event: PointerEvent): void {
  const scrub = stageScrub
  if (scrub === null) return
  stageScrub = null
  stageScrubbing.value = false

  const bar = event.currentTarget
  if (bar instanceof HTMLElement && bar.hasPointerCapture(event.pointerId)) {
    bar.releasePointerCapture(event.pointerId)
  }

  scrubStageTo(scrub.pending, true, scrub.stream)
}

/**
 * Dragging across the page transport. A page is a step, not a frame, so the
 * label follows the pointer while the drag is in flight but nothing is rendered
 * until it is let go: crossing a hundred pages must not ask main for a hundred
 * rasters. The page the pointer names is what is committed on release.
 */
let pdfScrub: { pages: number; page: number } | null = null

/** Where the drag is, for the label, while the pointer owns it. */
const pdfScrubPage = ref<number | null>(null)

/** Whether the page transport is being dragged, so its handle stays visible. */
const pdfScrubbing = ref(false)

/** The page a pointer on the transport is asking for, from where it sits. */
function pdfPageAt(event: PointerEvent): number {
  const bar = event.currentTarget
  if (!(bar instanceof HTMLElement)) return 1
  const rect = bar.getBoundingClientRect()
  if (rect.width <= 0) return 1

  const pages = pdfScrub?.pages ?? pdfPageCountFor(shownStage.value?.target ?? null) ?? 1
  if (pages <= 1) return 1
  const ratio = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1)
  return Math.round(ratio * (pages - 1)) + 1
}

function onPdfBarPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return
  const target = shownStage.value?.target
  const pages = pdfPageCountFor(target ?? null)
  if (!target || target.kind !== 'pdf' || pages === null) return

  event.preventDefault()
  event.stopPropagation()

  const bar = event.currentTarget
  if (bar instanceof HTMLElement) bar.setPointerCapture(event.pointerId)

  pdfScrub = { pages, page: pdfPageAt(event) }
  pdfScrubPage.value = pdfScrub.page
  pdfScrubbing.value = true
  scrollToPdfPage(pdfScrub.page)
}

function onPdfBarPointerMove(event: PointerEvent): void {
  if (pdfScrub === null) return
  pdfScrub.page = pdfPageAt(event)
  pdfScrubPage.value = pdfScrub.page
  // The document follows the pointer while it is dragged: moving a slider over
  // the pages is scrolling, so what is on screen should be what is under it.
  scrollToPdfPage(pdfScrub.page)
}

function onPdfBarPointerUp(event: PointerEvent): void {
  const scrub = pdfScrub
  if (scrub === null) return
  pdfScrub = null
  pdfScrubbing.value = false
  pdfScrubPage.value = null

  const bar = event.currentTarget
  if (bar instanceof HTMLElement && bar.hasPointerCapture(event.pointerId)) {
    bar.releasePointerCapture(event.pointerId)
  }

  scrollToPdfPage(scrub.page)
}

/**
 * The wheel's steps. A plain wheel matches the ten-second arrows and the two
 * modifiers match the Ctrl keys: the left button a minute, the right button ten.
 */
const WHEEL_STEP_SECONDS = 10
const WHEEL_STEP_MINUTE = 60
const WHEEL_STEP_TEN_MINUTES = 600

/**
 * Scrub the clip under the wheel. A wheel-up goes forward and a wheel-down
 * back, by the step the held button picks out. Answers whether it scrubbed, so
 * a caller can tell a wheel that moved the clip from one that found nothing to
 * move.
 *
 * Scoped to the media itself: the wheel over a clip scrubs it, while the wheel
 * over the listing still scrolls the listing, and a box with no clip leaves the
 * event alone so nothing is swallowed on its account.
 */
function wheelScrub(event: WheelEvent, element: HTMLElement | null): boolean {
  if (!(element instanceof HTMLVideoElement) || event.deltaY === 0) return false

  const step =
    event.buttons & 2
      ? WHEEL_STEP_TEN_MINUTES
      : event.buttons & 1
        ? WHEEL_STEP_MINUTE
        : WHEEL_STEP_SECONDS

  event.preventDefault()
  event.stopPropagation()
  seek(element, event.deltaY < 0 ? step : -step)
  return true
}

function onFooterWheel(event: WheelEvent): void {
  // A footer thumbnail is not a document to scroll: a wheel over a PDF's page
  // leaves the pages where they are, and only a clip's own wheel scrubs it.
  wheelScrub(event, previewVideo.value)
}

/**
 * Whether the current press has wheel-scrubbed the clip, and when the right
 * press went down. A press that scrolls is the wheel's step rather than a
 * click: the left button's release would otherwise reach the picture as an
 * ordinary click, and a right press that is held or scrolls is not the quick
 * click that leaves the mode.
 */
let leftScrubbed = false
let rightPress = false
let rightDownAt = 0
let rightScrubbed = false

/** How quick a right press must be to count as the click that leaves the mode. */
const RIGHT_CLICK_MS = 300

/**
 * A wheel turned while a button is down is part of that press's gesture, so its
 * release must not leave the mode or count as a click — whatever `buttons` the
 * platform reports for a wheel event. Which button is held is `wheelScrub`'s
 * business, not this: it picks the size of the step.
 */
function noteWheelPress(event: WheelEvent): void {
  if (rightPress || (event.buttons & 2) !== 0) rightScrubbed = true
  if ((event.buttons & 1) !== 0) leftScrubbed = true
}

/**
 * Whether a wheel is over what the display is showing rather than over the pane
 * around it: the picture's own rectangle — for an image the element is the whole
 * stage with the picture letterboxed inside it, so this is `drawnRect`, not the
 * element's box — and the transport that belongs to a clip, directly beneath the
 * picture and exactly as wide as it, which is where a wheel is expected to seek.
 */
function overStageMedia(event: WheelEvent): boolean {
  const media = stageMedia.value
  if (media === null) return false

  const within = (box: DOMRect | null): boolean =>
    box !== null &&
    event.clientX >= box.left &&
    event.clientX <= box.right &&
    event.clientY >= box.top &&
    event.clientY <= box.bottom

  const bar = stageBarEl.value
  return (
    within(drawnRect(media) ?? media.getBoundingClientRect()) ||
    within(bar === null ? null : bar.getBoundingClientRect())
  )
}

/**
 * The wheel in the display. Over a clip it is the scrubber it has always been:
 * what is playing steps through what is on screen, and the transport beneath it
 * belongs to the same gesture. A wheel over a picture is not the clip's — an
 * image has nothing to move within — so it steps the folder being browsed: up
 * for the row above and down for the one below, which the display follows on its
 * own. So does the wheel anywhere else in the pane — the letterbox, the padding,
 * an emptied display — where there is nothing of the clip under the pointer
 * either.
 */
function onStageWheel(event: WheelEvent): void {
  // A displayed PDF is a document: the wheel scrolls the page stack natively, so
  // it is left to the browser rather than turned into a folder step or a page
  // flip. The press is still noted, so a scroll with a button held does not read
  // as a click that leaves the mode.
  if (shownStage.value?.target.kind === 'pdf') {
    noteWheelPress(event)
    return
  }

  // A model is turned with the pointer and zoomed with the wheel, so the wheel
  // is left to the viewer's own controls rather than turned into a folder step.
  // The press is still noted, so a scroll with a button held does not read as
  // the click that leaves the mode.
  if (shownStage.value?.target.kind === 'model') {
    noteWheelPress(event)
    return
  }

  if (overStageMedia(event) && wheelScrub(event, stageMedia.value)) {
    noteWheelPress(event)
    return
  }

  if (event.deltaY === 0) return

  event.preventDefault()
  event.stopPropagation()
  noteWheelPress(event)
  emit('step', event.deltaY < 0 ? -1 : 1)
}

/**
 * A left-click on the footer's thumbnail — the clip's own play/pause, the
 * gesture the enlarged display already answers, brought to the small preview.
 * The two clicks of a double-click toggle it there and back, so the
 * double-click that follows — the mouse's Enter, opening the row's media in the
 * other pane — leaves the clip as it found it; a third click escalates once
 * more, over the whole window, exactly as a triple-click on the row's name
 * does. An image has nothing to pause, so a single click on one is simply
 * nothing.
 */
function onPreviewClick(event: MouseEvent): void {
  if (event.button !== 0) return
  if (event.detail === 3) {
    emit('fullscreen')
    return
  }
  togglePreviewPlayback()
}

/**
 * A double left-click on the footer's thumbnail — the mouse's Enter on the
 * cursor row: show this pane's media at full size in the other one.
 */
function onPreviewDblclick(event: MouseEvent): void {
  if (event.button !== 0) return
  emit('stage-on')
}

/**
 * Mouse events on the pane that is displaying the other pane's media. They stop
 * here so a click cannot reach the listing blurred behind them. A quick
 * right-click leaves the mode — the mouse's Escape — but a press that scrolls
 * is the wheel's ten-minute step, and one held for longer is not a click at
 * all, so neither leaves.
 */
function onStagePointerDown(event: MouseEvent): void {
  event.stopPropagation()
  if (event.button === 0) {
    leftScrubbed = false
    return
  }
  if (event.button !== 2) return
  rightPress = true
  rightDownAt = performance.now()
  rightScrubbed = false
}

function onStagePointerUp(event: MouseEvent): void {
  if (event.button === 0) {
    // A left press that wheel-scrubbed is a seek, not the click that pauses.
    if (leftScrubbed) stageClickSuppressedUntil = performance.now() + 300
    leftScrubbed = false
    return
  }
  if (event.button !== 2) return
  const scrubbed = rightScrubbed
  const quick = performance.now() - rightDownAt <= RIGHT_CLICK_MS
  const leave = rightPress && !scrubbed && quick
  rightPress = false
  rightScrubbed = false
  // A right-button release is never a click on the picture or its play/pause
  // button, however the platform reports the gesture that followed it.
  stageClickSuppressedUntil = performance.now() + 300
  if (leave) emit('stage-off')
}

/**
 * Where this pane's cursor row is, for a menu asked for from the keyboard rather
 * than from a press — Shift+F10 has nothing to be pointed at, so the row itself is
 * the anchor. It is the same index-against-`ROW_HEIGHT` arithmetic the windowed
 * listing is built on, deliberately: the row's element may not be in the document
 * at all (scrolled out, or under the spacers), and the row's place is still known
 * exactly.
 */
function cursorMenuAnchor(): PaneMenuRequest | null {
  const entry = props.controller.current()
  const list = listEl.value
  if (!entry || entry.isParent || !list) return null

  const box = list.getBoundingClientRect()
  return {
    path: entry.path,
    x: box.left + ROW_INSET_X,
    y: box.top + props.controller.state.cursor * ROW_HEIGHT - list.scrollTop
  }
}

defineExpose({
  contentEl,
  previewRect,
  previewBarRect,
  previewPosition,
  seekPreview,
  seekStage,
  toggleStagePlayback,
  togglePreviewPlayback,
  cursorMenuAnchor,
  openColumnPicker,
  addColumnAtFocus,
  stepPdfZoom,
  toggleView
})

// Kept out of the <ul> on purpose: the row list must contain exactly the
// entries, or index-based scrolling and the cursor watch would be off by one.
const notice = computed(() => {
  const state = props.controller.state
  if (state.error) return { text: state.error, error: true }
  // An empty folder says nothing worth a notice: a lone `..` is already the whole
  // answer, on disk and inside an archive alike. Only a search that came up empty
  // is worth saying, because the query is what emptied the listing.
  if (state.itemCount === 0 && state.searchQuery) {
    return { text: `No matches for "${state.searchQuery}"`, error: false }
  }
  // An empty quick cd list is worth saying: the pane is showing nothing at all,
  // and where the folders to put there come from is not something the pane itself
  // makes visible.
  if (state.quickCd && state.itemCount === 0) {
    return {
      text: 'No quick cd directories yet. Shift+F10 or a long right-click on a folder adds one.',
      error: false
    }
  }
  return null
})

/**
 * What git thinks of this pane's directory, when it is inside a work tree. Null
 * outside one and on a machine with no git to ask — the same nothing, and drawn
 * as nothing: no dot on any row, and no chip in the title bar.
 */
const gitView = computed(() => props.controller.state.git)

/**
 * The work tree's HEAD, as the title bar's chip names it: the branch, or the
 * short commit when HEAD is not on one.
 */
const gitBranch = computed(() => {
  const view = gitView.value
  if (!view) return ''
  if (view.detached || view.branch === null) {
    return view.oid === null ? 'detached' : `detached@${view.oid.slice(0, 7)}`
  }
  return view.branch
})

/** How far HEAD has drifted from its upstream, or nothing with no upstream. */
const gitDrift = computed(() => {
  const view = gitView.value
  if (!view || (view.ahead === 0 && view.behind === 0)) return ''
  return `${view.ahead > 0 ? `↑${view.ahead}` : ''}${view.behind > 0 ? `↓${view.behind}` : ''}`
})

/**
 * How dirty the work tree is, as one count beside the branch. It is the
 * repository's own total rather than the directory's or the cursor's — the branch
 * name is already an answer about the whole work tree, and a count that answered
 * about a corner of it would read as a contradiction.
 *
 * Nothing at all when the tree is clean, so a tidy repository's title bar says only
 * where it is.
 */
const gitSummaryText = computed(() => {
  const view = gitView.value
  if (!view || view.summary.changed === 0) return ''
  return view.summary.changed === 1 ? '1 change' : `${view.summary.changed} changes`
})

/** The dot beside that count: the highest thing anywhere in the work tree. */
const gitSummaryColor = computed(() => {
  const view = gitView.value
  return view ? sideColor(view.summary.dominant) : 'transparent'
})

/**
 * The breakdown the count cannot fit, in the chip's own title: what each kind was,
 * counted so that no entry is in two of them, or the word for a tree with nothing
 * to report.
 */
const gitSummaryDetail = computed(() => {
  const view = gitView.value
  if (!view) return ''

  const sum = view.summary
  if (sum.changed === 0) return 'nothing changed'

  const parts: string[] = []
  if (sum.conflicted > 0) parts.push(`${sum.conflicted} conflicted`)
  if (sum.staged > 0) parts.push(`${sum.staged} staged`)
  if (sum.both > 0) parts.push(`${sum.both} staged and changed again`)
  if (sum.unstaged > 0) parts.push(`${sum.unstaged} modified`)
  if (sum.untracked > 0) parts.push(`${sum.untracked} untracked`)

  const entries = sum.changed === 1 ? '1 changed entry' : `${sum.changed} changed entries`
  return `${entries}: ${parts.join(', ')}`
})

const gitTitle = computed(() => {
  const view = gitView.value
  if (!view) return ''
  const counts =
    view.ahead || view.behind ? ` (${view.ahead} ahead, ${view.behind} behind)` : ''
  return [`${gitBranch.value}${counts}`, gitSummaryDetail.value, view.root]
    .filter((line) => line !== '')
    .join('\n')
})

/**
 * The mark a row shows, read from the pane's own git view: the entry's own
 * status, or a roll-up of what is under a folder — one shared reader, so the
 * detail listing and the thumbnail wall draw the same dot (`rowMarkFor`). Quick
 * cd's rows are paths rather than entries of a work tree, so they carry none.
 */
function markAt(entry: PaneEntry): GitRowMark | null {
  if (props.controller.state.quickCd) return null
  return rowMarkFor(gitView.value, entry)
}

/**
 * What git thinks of the row under the cursor, for the footer: the same mark the
 * row itself carries, which the status bar names in words beside a dot carrying
 * its colour. Null on a row git has nothing to say about, and the footer then
 * says nothing either.
 */
const entryGit = computed(() => {
  const current = entry.value
  return current ? markAt(current) : null
})

/**
 * The rows to render: the entries the viewport covers, widened by the overscan
 * band and carried with their absolute index, so every handler and the per-row
 * class helpers key off the same index the controller's cursor uses. The
 * arithmetic is index-against-`ROW_HEIGHT` only — no DOM measurement — which is
 * what lets the window be computed before the rows it describes exist.
 *
 * Each row carries its git mark too, looked up once here rather than four times
 * in the markup: the mark is read from the same window, so a status read landing
 * re-renders exactly the rows it could mark.
 */
const visibleRows = computed<{ entry: PaneEntry; index: number; git: GitRowMark | null }[]>(() => {
  const entries = props.controller.state.entries
  const total = entries.length
  if (total === 0) return []

  // `markAt` below reads the git view first thing, which is what makes this
  // window — like the rows in it — depend on the status read as well as on the
  // listing, so a mark arriving re-renders exactly the rows it could mark.
  const height = viewportHeight.value || ROW_HEIGHT * VIEWPORT_FALLBACK_ROWS
  // Clamped so a stale `scrollTop` (a shorter directory than the one scrolled in)
  // still renders its last row rather than an empty band.
  const first = Math.min(
    Math.max(Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN_ROWS, 0),
    total - 1
  )
  const last = Math.min(
    Math.max(Math.ceil((scrollTop.value + height) / ROW_HEIGHT) + OVERSCAN_ROWS, first + 1),
    total
  )

  const rows: { entry: PaneEntry; index: number; git: GitRowMark | null }[] = []
  for (let i = first; i < last; i += 1) {
    const entry = entries[i]
    if (entry) rows.push({ entry, index: i, git: markAt(entry) })
  }
  return rows
})

/** The rows hidden above the window, as a spacer of their exact height. */
const topPad = computed(() =>
  visibleRows.value.length > 0 ? visibleRows.value[0]!.index * ROW_HEIGHT : 0
)

/** The rows hidden below the window, as a spacer of their exact height. */
const bottomPad = computed(() => {
  const rows = visibleRows.value
  if (rows.length === 0) return 0
  return (props.controller.state.entries.length - rows[rows.length - 1]!.index - 1) * ROW_HEIGHT
})

/**
 * The rows the pane rendered last, in order. It is the view's own memory of the
 * listing, kept because the mode's animation needs the arrangement that was on
 * screen a moment ago and the controller, by the time this runs, already holds
 * only the new one.
 */
let rowsRendered: PaneEntry[] = []
/** The `hideTick` these rows were rendered for, so only a mode change animates. */
let hideTickSeen = props.controller.state.hideTick

/**
 * Show a change the hide mode made to this pane's rows as those rows leaving and
 * arriving (see lib/hideAnimation.ts). It runs *before* the render — the default
 * flush — on purpose: the rows the mode has just covered are still in the
 * document here, and a copy taken now is the only chance to draw them on their
 * way out. The animating itself waits a tick, for the new arrangement to be in
 * the document to move the surviving rows within.
 *
 * Every other change to the listing — a navigation, a sort, a refresh — leaves
 * `hideTick` alone and passes through untouched.
 */
watch(
  () => props.controller.state.entries,
  (entries) => {
    if (props.controller.state.hideTick === hideTickSeen) {
      rowsRendered = entries
      return
    }
    hideTickSeen = props.controller.state.hideTick

    const isThere = new Set(entries.map((entry) => entry.path))
    const leaving: { el: HTMLElement; index: number }[] = []
    for (const [index, row] of rowsRendered.entries()) {
      if (row.isParent || isThere.has(row.path)) continue
      const el = listEl.value?.querySelector<HTMLElement>(
        `li[data-path="${CSS.escape(row.path)}"]:not(.hide-ghost)`
      )
      if (el) leaving.push({ el: el.cloneNode(true) as HTMLElement, index })
    }

    const before = rowsRendered.map((row) => row.path)
    const after = entries.map((entry) => entry.path)
    rowsRendered = entries

    void nextTick(() => {
      const list = listEl.value
      if (list) playHideAnimation({ list, rowHeight: ROW_HEIGHT, before, after, leaving })
    })
  }
)

function onListScroll(): void {
  const element = listEl.value
  if (element) scrollTop.value = element.scrollTop
}

let listObserver: ResizeObserver | null = new ResizeObserver(() => onListResize())
/** The footer's height at the last resize, to tell a strip move from the rest. */
let lastFooterHeight: number | null = null

/**
 * The listing's own element comes and goes with the view mode: leaving
 * thumbnails mounts a fresh `<ul>`, and the resize observer has to follow it or
 * the pane stops re-windowing itself after one switch. Post-flush, so the
 * element the reference names is already in the document when it is observed.
 */
watch(
  listEl,
  (element) => {
    listObserver?.disconnect()
    if (element) listObserver?.observe(element)
    measurePageRows()
  },
  { flush: 'post' }
)

/**
 * Coming back from a thumbnail wall, the detail listing is a fresh `<ul>` at its
 * own top, while the cursor is wherever the wall left it — so the row it is on
 * is revealed again rather than left scrolled out of sight. The other direction
 * needs nothing here: the grid reveals the cursor's cell as it mounts.
 */
watch(thumbnails, async (on) => {
  if (on) return
  await nextTick()
  measureListSlack()
  scrollRowIntoView(props.controller.state.cursor, 'nearest')
})

function measurePageRows(): void {
  const element = listEl.value
  if (!element) return
  // Only top padding is room the rows have lost: the bottom padding is the band
  // the listing scrolls into (see `listSlackStyle`), with the rows above it.
  const padding = parseFloat(getComputedStyle(element).paddingTop)
  const usable = element.clientHeight - padding
  props.controller.state.pageRows = Math.max(1, Math.floor(usable / ROW_HEIGHT))
  // The window is sized from the same box the page count is, so a resize (a
  // footer growing, the terminal taking room) re-windows the listing with it.
  viewportHeight.value = element.clientHeight
}

/**
 * Measure the band the listing needs at its end, from the room it has or is
 * about to have — whichever is more, since a strip on its way out is not yet
 * giving its room back (measuring the room it *will* have there would drop the
 * band too early and the view would be dragged down after all). A move is what
 * measures it, before the room changes, so the band is already in place for the
 * layout that would otherwise clamp the scroll: a listing that ends above the
 * view has no band at all, and the band is never wider than the strip's growth.
 */
function measureListSlack(): void {
  const element = listEl.value
  const footer = footerEl.value
  const rows = props.controller.state.entries.length
  if (element === null || footer === null || rows === 0) {
    listSlack.value = 0
    return
  }

  const settled = footerTall.value ? FOOTER_PREVIEW_HEIGHT : FOOTER_HEIGHT
  const room = element.clientHeight + Math.max(0, footer.offsetHeight - settled)
  // The bottom of the last row, in the listing's own content coordinates. It is
  // worked out from the row count rather than measured off the last child: the
  // listing is windowed, so the last row is usually not in the document at all.
  const contentEnd = rows * ROW_HEIGHT
  listSlack.value = Math.min(Math.max(element.scrollTop + room - contentEnd, 0), FOOTER_GROWTH)
}

/**
 * The listing just changed height, and what should happen to the view depends on
 * which of two things changed it. The strip growing *inside* the pane is
 * arriving in room the cursor's row needs, so it wants that row revealed — the
 * band in `measureListSlack` is what keeps the rows themselves from moving. The
 * pane's own box changing — the terminal taking room for a program, and giving it
 * back when the program ends — must instead leave the view where it is: nothing
 * in the listing moved, and a reveal would scroll the view down into the
 * shrunken pane with nothing to scroll it back, since the pane growing again is
 * not itself a reason to move.
 *
 * The two are told apart by the footer's own height, which only a strip change
 * moves.
 */
function onListResize(): void {
  measurePageRows()

  const footer = footerEl.value?.offsetHeight ?? 0
  const stripMoved = lastFooterHeight !== null && footer !== lastFooterHeight
  lastFooterHeight = footer
  if (stripMoved) scrollRowIntoView(props.controller.state.cursor, 'nearest')
}

/**
 * A quick, fixed-length scroll for a move that jumps a page or the whole list:
 * long enough to read as motion, short enough that a held key never overtakes
 * it. One animation runs at a time — a new move cancels the one before and
 * starts from wherever it had got to, so the rows never chase two targets.
 */
const SCROLL_ANIM_MS = 140
let scrollAnimation = 0

function animateScrollTop(element: HTMLElement, target: number): void {
  cancelAnimationFrame(scrollAnimation)
  const from = element.scrollTop
  const delta = target - from
  if (delta === 0) return

  const start = performance.now()
  const step = (now: number): void => {
    const t = Math.min((now - start) / SCROLL_ANIM_MS, 1)
    const eased = 1 - Math.pow(1 - t, 3)
    element.scrollTop = from + delta * eased
    if (t < 1) scrollAnimation = requestAnimationFrame(step)
  }
  scrollAnimation = requestAnimationFrame(step)
}

function setScrollTop(element: HTMLElement, target: number, animated: boolean): void {
  if (animated) animateScrollTop(element, target)
  else {
    cancelAnimationFrame(scrollAnimation)
    element.scrollTop = target
  }
}

function scrollRowIntoView(index: number, align: ScrollAlign, animated = false): void {
  const element = listEl.value
  if (!element) return

  const rowTop = index * ROW_HEIGHT
  const rowBottom = rowTop + ROW_HEIGHT
  const viewTop = element.scrollTop
  const viewBottom = viewTop + element.clientHeight

  if (align === 'start') {
    setScrollTop(element, rowTop, animated)
    return
  }

  if (align === 'end') {
    setScrollTop(element, Math.max(rowBottom - element.clientHeight, 0), animated)
    return
  }

  if (rowTop < viewTop) {
    setScrollTop(element, rowTop, animated)
  } else if (rowBottom > viewBottom) {
    setScrollTop(element, rowBottom - element.clientHeight, animated)
  } else if (animated) {
    setScrollTop(element, viewTop, false)
  }
}

watch(
  [() => props.controller.state.path, () => props.controller.state.cursor],
  async () => {
    // The thumbnail wall is its own windowing: it reveals the cursor's cell
    // from its own geometry, and this watcher's reset would take the page-jump
    // alignment out from under it before it could read it.
    if (thumbnails.value) return
    const { cursor, scrollAlign, animateScroll } = props.controller.state
    props.controller.state.scrollAlign = 'nearest'
    props.controller.state.animateScroll = false
    measureListSlack()
    await nextTick()
    scrollRowIntoView(cursor, scrollAlign, animateScroll)
  }
)

watch(
  () => props.controller.state.searchActive,
  async (active) => {
    await nextTick()
    if (!active) return
    searchInput.value?.focus()
    searchInput.value?.select()
  }
)

onMounted(() => {
  if (listEl.value) listObserver?.observe(listEl.value)
  measurePageRows()
  window.addEventListener('mouseup', endPointerDrag)
  window.addEventListener('mousemove', onHoldMove)
  // The third press of a run can land outside this pane entirely — over the
  // terminal, which stops the press on its way up, or the pane row — so the watch
  // is in the *capture* phase, where it runs before any handler that stops it
  // (`onWindowMouseDown`).
  window.addEventListener('mousedown', onWindowMouseDown, true)
  // The drag that follows a triple-click on a PDF page's paragraph is watched
  // window-wide, like the hold: the pointer leaves the word it started on at once.
  window.addEventListener('mousemove', onPdfParagraphDragMove)
  window.addEventListener('mouseup', onPdfParagraphDragEnd)
  // A middle-button pan is watched the same way — the pointer leaves the box as
  // soon as it is dragged to an edge — and abandoned if the window loses focus
  // with the button still down, since no release is coming that this will hear.
  window.addEventListener('mousemove', onPdfPanMove)
  window.addEventListener('mouseup', onPdfPanEnd)
  window.addEventListener('blur', onPdfPanEnd)
  // The selection itself is what the highlight is drawn from, and it changes
  // without a key or a press of this pane's making: a drag, a triple-click, a
  // shift-click. The document's own event is the one place that is all reported.
  document.addEventListener('selectionchange', updatePdfSelections)
  // A hold outlives the window's focus if the user leaves mid-press: the release
  // then happens somewhere this one will never hear about.
  window.addEventListener('blur', cancelHold)
})

onBeforeUnmount(() => {
  listObserver?.disconnect()
  listObserver = null
  window.clearTimeout(viewEnterTimer)
  stageAreaObserver?.disconnect()
  stageAreaObserver = null
  stageBarObserver?.disconnect()
  stageBarObserver = null
  pdfScrollObserver?.disconnect()
  pdfScrollObserver = null
  releaseStageSeek()
  cancelPreviewRead()
  cancelAnimationFrame(scrollAnimation)
  window.removeEventListener('mouseup', endPointerDrag)
  window.removeEventListener('mousemove', onHoldMove)
  window.removeEventListener('mousedown', onWindowMouseDown, true)
  window.removeEventListener('mousemove', onPdfParagraphDragMove)
  window.removeEventListener('mouseup', onPdfParagraphDragEnd)
  window.removeEventListener('mousemove', onPdfPanMove)
  window.removeEventListener('mouseup', onPdfPanEnd)
  window.removeEventListener('blur', onPdfPanEnd)
  document.removeEventListener('selectionchange', updatePdfSelections)
  window.removeEventListener('blur', cancelHold)
  clearHold()
})

function onSearchInput(event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  // A keystroke that would leave the listing with nothing to find is refused:
  // the input snaps back to the last query that did and the field pulses, so the
  // typing goes nowhere instead of blanking the pane.
  if (!props.controller.updateSearch(target.value)) {
    // Put the last good query back, with the caret where the refused insertion
    // began: assigning `value` drops the caret at the end, which would move it
    // for a keystroke made mid-word.
    const caretAfter = target.selectionStart ?? target.value.length
    const inserted = target.value.length - props.controller.state.searchQuery.length
    target.value = props.controller.state.searchQuery
    const caret = Math.max(0, caretAfter - inserted)
    target.setSelectionRange(caret, caret)
    pulseSearchReject()
  }
}

/**
 * Flash the field red for one beat. The class goes off and back on around a
 * forced layout read, so a second refused keystroke right after the first is not
 * swallowed as "no change" and the pulse replays every time.
 */
function pulseSearchReject(): void {
  const el = searchInput.value
  if (!el) return
  el.classList.remove('search-reject')
  void el.offsetWidth
  el.classList.add('search-reject')
}

function onPointerDown(event: MouseEvent): void {
  emit('select')

  const target = event.target
  if (target instanceof HTMLElement && target.closest('[data-search]')) return

  emit('pointer-down')
  countPressRun(event)
}

/**
 * What opening the row under the cursor means is the App's call, not this pane's:
 * a directory descends, an ordinary file goes to whatever the system opens it
 * with, and an image or a video is displayed in the *other* pane instead. The
 * click that came first has already put the cursor here (`onRowClick`), which is
 * the row this asks about.
 */
function onRowDblclick(): void {
  emit('activate')
}

/**
 * A left press that did not land in this pane at all: the third of a run, when the
 * layout the second press started has put the pointer over something else — the
 * terminal strip, the row of panes, the window itself. It only ever *continues* a run
 * (`countPressRun`): with none in progress there is nothing to count, so an ordinary
 * press on chrome cannot escalate anything, and a press on another listing's row or
 * tile is that pane's business — every listing carries `data-list`, and its own pane
 * counts it.
 *
 * Watched in the capture phase, which is the point of it: the terminal *stops* a
 * press on its way up (xterm handles its own), so a listener on the window in the
 * bubbling phase never hears a press that landed on it — and a press that landed on
 * it is exactly the case this exists for.
 */
function onWindowMouseDown(event: MouseEvent): void {
  if (event.button !== 0) return
  const target = event.target
  if (!(target instanceof Node)) return
  if (sectionEl.value?.contains(target)) return
  if (target instanceof Element && target.closest('[data-list]') !== null) return
  countPressRun(event)
}

/**
 * The entry a click was about: the row or tile it landed on, or null when it landed
 * on neither (the scroller's own background, the ground below the last one).
 */
function entryIndexAt(event: MouseEvent): number | null {
  const target = event.target
  const path =
    target instanceof Element ? (target.closest('[data-path]')?.getAttribute('data-path') ?? null) : null
  if (path === null) return null
  const found = props.controller.state.entries.findIndex((entry) => entry.path === path)
  return found >= 0 ? found : null
}

const TRIPLE_CLICK_MS = 600
let clickRun = { index: -1, at: 0, count: 0 }

/**
 * A left press in the pane. The run of presses that opens a file over the whole
 * window is counted here — *presses*, not clicks, and that is the whole of it. A
 * `click` needs its press and its release to share a box, and the second press is
 * what starts the pane display: the work that takes lands between them (a model read
 * and parsed, a clip mounted, the strip it grows), so by the third press the layout
 * has moved under the pointer and the press goes down on one element and comes up on
 * another. The browser then hands that `click` to their nearest common ancestor —
 * above the pane, sometimes above the document — and a handler there hears nothing at
 * all. A `mousedown` is always dispatched, to whatever is under the pointer at that
 * moment, so the gesture is built from those.
 *
 * A run already in progress continues on the entry it began on, wherever the next
 * press lands: the layout moving is the display's doing, not the user pointing at
 * something else. Only the press that starts a run takes the entry from the pointer.
 */
function countPressRun(event: MouseEvent): void {
  if (event.button !== 0) return

  const at = event.timeStamp
  const within = clickRun.count > 0 && at - clickRun.at <= TRIPLE_CLICK_MS
  const index = entryIndexAt(event)

  // A press that landed on no row at all — the layout the second press started has
  // put the pointer over the terminal, the divider, the pane row — *continues* the
  // run on the entry the presses began on. That is not the user pointing somewhere
  // else: it is the layout moving out from under them.
  if (index === null) {
    if (within) countEntryClick(clickRun.index, event)
    return
  }

  // A press that landed on a row is that row's, and continues the run only when it is
  // the *same* entry: a press on another item starts a new run however quickly it
  // follows, or clicking down a folder would open one of them over the whole window.
  countEntryClick(index, event)
}

/**
 * The run itself: three presses on one entry, within `TRIPLE_CLICK_MS`, open it over
 * the whole window — the mouse's `Ctrl+Enter`. It is counted rather than asked of the
 * browser's `detail`, because the work the second press starts lands between it and
 * the third, which outlasts a count the browser takes from how the presses are
 * *handled* (and the third `click` may not be dispatched at all). The timing is the
 * events' own `timeStamp`s — stamped as the presses arrive, not when the main thread
 * gets round to them. A press on a row there is nothing to show for clears the run,
 * so one cannot be carried from a folder onto the media beside it.
 */
function countEntryClick(index: number, event: MouseEvent): void {
  if (previewTargetFor(props.controller.state.entries[index]) === null) {
    clickRun = { index: -1, at: 0, count: 0 }
    return
  }

  const previousAt = clickRun.at
  const at = event.timeStamp
  const count = index === clickRun.index && at - previousAt <= TRIPLE_CLICK_MS ? clickRun.count + 1 : 1
  clickRun = { index, at, count }

  if (count === 3) emit('fullscreen')
}

/**
 * A *dragged* right button paints a mark across the rows it sweeps over — the
 * swipe-to-select gesture, which is where the right button's marking lives: a
 * press that stays put is the same mark made on the release, and one that is held
 * is that row's menu (see `HoldGesture` below). The paint mode is decided once,
 * from the row the gesture started on: starting on an unmarked row selects,
 * starting on a marked row clears.
 *
 * `last` is the row the sweep most recently painted, which is what the next row
 * it reaches fills *from* — the pointer is only reported at a certain rate, so
 * the rows between two of its reports are exactly the ones a fast flick would
 * otherwise leave out of the region being drawn.
 */
let painting: { select: boolean; last: number } | null = null

/**
 * The left button held down over the listing: the cursor follows the pointer
 * from row to row, so pressing and dragging picks a row the way moving the
 * pointer over it would. A plain click still ends here too, but the cursor
 * move it makes on the way down is the same one it would make on the way up.
 */
let draggingCursor = false

/**
 * How long the right button has to be held, without moving, before the row asks
 * for its menu — the clock that tells a hold from a click, where `HOLD_SLOP_PX`
 * tells one from a drag. It is the answer Total Commander settled on for the same
 * collision (a marking right button meeting a context menu), where the hold is
 * about a second; it can be shorter here because the hold is *shown* while it
 * happens (`HOLD_HINT_MS`), where that one gives nothing to look at until the
 * menu appears.
 */
const HOLD_MENU_MS = 450

/**
 * How long the hold has to last before the pointer says so. A plain right-click —
 * the selection — is over well inside this, so the ring never flashes on one, and
 * what it leaves is the wait that is actually there.
 */
const HOLD_HINT_MS = 150

/** The rest of the hold, which is therefore how long the ring takes to fill. */
const HOLD_FILL_MS = HOLD_MENU_MS - HOLD_HINT_MS

/**
 * How far the pointer may drift while held before the gesture is the *other* one:
 * a right-drag painting a mark across rows. A trackpad's press wobbles under the
 * finger, so the slack is real pixels rather than none.
 */
const HOLD_SLOP_PX = 6

/**
 * The right button down on a row, before it is known which of the gesture's three
 * endings it is. The press itself moves nothing — not the cursor and not a mark —
 * because which ending it is is exactly what it has not said yet:
 *
 * - the pointer travels past `HOLD_SLOP_PX` (`beginPaintFromHold`) — the
 *   swipe-to-select, painting the rows it sweeps over;
 * - another row is reached (`onRowEnter`, for a flick that crosses one before the
 *   pointer's movement is reported) — the same sweep;
 * - the hold runs out (`endHoldWithMenu`) — the row's menu, at the pointer;
 * - the button comes up first (`endPointerDrag`) — the *click*, whose mark is made
 *   on the release.
 *
 * Nothing is marked while it is pending, for the same reason the press does not
 * mark: a mark made on the way down would have to be taken back when the gesture
 * turns out to be the menu, and taking back something the user just did is
 * exactly the flicker this avoids. Each ending but the release clears the gesture,
 * so the release that follows a menu or a sweep has nothing left to do.
 */
interface HoldGesture {
  /** The row it went down on, by path: the pane re-lists under a held button. */
  path: string
  /** Its place in the listing then, which a sweep re-reads from the path. */
  index: number
  /** The mark a click or a sweep would set, decided from the row as it was pressed. */
  select: boolean
  x: number
  y: number
  /** The timer that ends the hold. */
  timer: number
  /** The timer that puts the ring on the pointer. */
  hint: number
}

let hold: HoldGesture | null = null

/** Where the ring is drawn, while there is one to draw. */
const holdHint = ref<{ x: number; y: number } | null>(null)

function clearHold(): void {
  if (!hold) return
  window.clearTimeout(hold.timer)
  window.clearTimeout(hold.hint)
  hold = null
  holdHint.value = null
}

/**
 * The hold has run out: this row wants its menu. Nothing has been marked — the
 * ring is taken down first, so the menu is what the pointer's wait turned into
 * rather than something drawn over the feedback.
 */
function endHoldWithMenu(): void {
  const gesture = hold
  if (!gesture) return
  clearHold()
  emit('context-menu', { path: gesture.path, x: gesture.x, y: gesture.y })
}

/**
 * Where a row is in the listing *now*, falling back to the index the gesture
 * recorded when the row it names is gone: the pane re-lists on its own — under a
 * held button as much as at rest — so an index taken at the press can point at a
 * different row by the time the sweep reads it, while the path is what the row
 * *is*.
 */
function listingIndexOf(path: string, fallback: number): number {
  const index = props.controller.state.entries.findIndex((row) => row.path === path)
  return index >= 0 ? index : fallback
}

/**
 * The pointer left the row it went down on, so the gesture is a sweep rather than
 * a hold or a click. The run starts on the row the button went down on — the mark
 * it would have set was decided from that row's state as it was pressed — which is
 * what keeps a swipe beginning exactly where it always did.
 */
function beginPaintFromHold(): void {
  const gesture = hold
  if (!gesture) return
  clearHold()
  props.controller.setSelected(gesture.path, gesture.select)
  painting = { select: gesture.select, last: listingIndexOf(gesture.path, gesture.index) }
}

/**
 * Paint every row between the one the sweep last painted and the one the pointer
 * has just reached, so the mark covers the whole region swept rather than the rows
 * the pointer happened to be *reported* over: pointer events arrive at their own
 * rate, so a flick crosses a dozen rows between two of them, and those rows are
 * exactly the ones the gesture was drawing a line through. The value is the
 * sweep's own — a paint, not a per-row toggle — so crossing a row twice, or coming
 * back over it, leaves it as the gesture first set it. The ".." row is skipped
 * like every other selection.
 */
function paintSweepTo(index: number): void {
  const sweep = painting
  if (!sweep) return

  const last = props.controller.state.entries.length - 1
  const to = Math.min(Math.max(index, 0), last)
  const from = Math.min(Math.max(sweep.last, 0), last)
  const step = to >= from ? 1 : -1

  for (let i = from; ; i += step) {
    const row = props.controller.state.entries[i]
    if (row && !row.isParent) props.controller.setSelected(row.path, sweep.select)
    if (i === to) break
  }

  sweep.last = to
}

/**
 * The pointer moved with the button held. A hold that drifts is not a hold: the
 * gesture it becomes is the one the button already had.
 */
function onHoldMove(event: MouseEvent): void {
  const gesture = hold
  if (!gesture) return
  if (
    Math.abs(event.clientX - gesture.x) > HOLD_SLOP_PX ||
    Math.abs(event.clientY - gesture.y) > HOLD_SLOP_PX
  ) {
    beginPaintFromHold()
  }
}

/**
 * Focus left the window with the button still down, so no release is coming that
 * this pane will hear. The gesture is abandoned rather than resolved: none of its
 * endings was asked for.
 */
function cancelHold(): void {
  clearHold()
}

function onRowLeftDown(index: number): void {
  draggingCursor = true
  props.controller.moveTo(index)
}

function onRowRightDown(index: number, event: MouseEvent): void {
  const entry = props.controller.state.entries[index]
  if (!entry || entry.isParent) return

  // The press says *which* row the gesture is about and nothing more — by path,
  // because the pane re-lists under a held button — and the release is what says
  // whether it was a click. The cursor is deliberately left alone: a right-click
  // marks a row, and where the keyboard is standing is not a thing marking moves
  // (the menu moves it, since the menu's items are the keys' own operations).
  event.preventDefault()

  // Ctrl+right-click asks for the menu outright — the immediate half of the
  // gesture, for when a hold is a wait too long.
  if (event.ctrlKey || event.metaKey) {
    emit('context-menu', { path: entry.path, x: event.clientX, y: event.clientY })
    return
  }

  clearHold()
  hold = {
    path: entry.path,
    index,
    select: !props.controller.isSelected(entry),
    x: event.clientX,
    y: event.clientY,
    timer: window.setTimeout(endHoldWithMenu, HOLD_MENU_MS),
    hint: window.setTimeout(() => {
      if (hold) holdHint.value = { x: hold.x, y: hold.y }
    }, HOLD_HINT_MS)
  }
}

function onRowEnter(index: number): void {
  if (draggingCursor) props.controller.moveTo(index)

  // A held button that has reached another row is a sweep, not a hold: the pointer
  // is no longer on the row the press started on. The row it entered is then
  // painted by the same pass, since a fast flick can cross a row before the
  // pointer's own movement is reported.
  if (hold && props.controller.state.entries[index]?.path !== hold.path) beginPaintFromHold()

  paintSweepTo(index)
}

function endPointerDrag(): void {
  // A right press still pending is the *click*, and its mark is made now, on the
  // release, rather than on the way down: that is what leaves the hold free to be
  // the menu instead, and it is why a press that becomes either of the other two
  // endings — both of which clear the gesture — marks nothing at all. The row is
  // looked up by path because the listing may have been re-read under the press,
  // and the mark is the one the press decided: the value that row was not.
  const pending = hold
  clearHold()
  painting = null
  draggingCursor = false
  if (!pending) return

  const entry = props.controller.state.entries.find((row) => row.path === pending.path)
  if (entry && !entry.isParent) props.controller.setSelected(entry.path, pending.select)
}

function rowClass(index: number): string {
  const entry = props.controller.state.entries[index]
  const cursor = index === props.controller.state.cursor

  // A marked row takes the gold band (`bg-marked`) and nothing else, so every
  // text color on the row goes on reading as itself. When the cursor lands on
  // one, the band stays the cursor's — the plain cursor row's own band, so the
  // only thing telling the two apart is the mark — and the mark is added to it
  // as `row-mark` (styles/mark.css): gold woven through the band on a diagonal,
  // and a gold frame around the row. The background goes on saying where the
  // keyboard is, the weave and the frame say this is one of the rows F5/F6/F8 act
  // on, and the name, the size and the date keep their own colors — including the
  // green of something runnable, which an answer carried in the text would have
  // had to spend.
  const cursorBand = props.active ? 'bg-accent text-fg-bright' : 'bg-selection-inactive text-fg'

  let base: string
  if (entry && props.controller.isSelected(entry)) {
    base = cursor ? `${cursorBand} row-mark` : 'bg-marked'
  } else if (cursor) {
    base = cursorBand
  } else {
    base = 'text-fg'
  }

  // `fresh` holds the paths a refresh just found new or changed; membership is
  // all the row needs to run its highlight (see styles/flash.css).
  const flash = entry && props.controller.state.fresh.has(entry.path) ? ' flash-row' : ''
  return `${base}${flash}`
}

/**
 * The name's own color: the green of a file the user can run (`--color-runnable`,
 * lib/executable.ts). A marked row keeps it, the one under the cursor included —
 * that row carries the mark in its band (see `rowClass`), so nothing here has to
 * take the green away.
 */
function nameClass(index: number): string {
  const entry = props.controller.state.entries[index]
  if (!entry) return ''
  return isRunnable(entry) ? 'text-runnable' : ''
}

/**
 * The target beside a symlink's name: normally the dim gray that keeps it
 * secondary to the name, and `text-danger` when the link does not resolve.
 * `kind` is what says so — a row is a `symlink` only when `stat` through the
 * link failed, which is a loop, a permission, or by far the common case a
 * target that is not there — so a broken `~/.steampath` reads as broken at a
 * glance. Only the target takes the color; the name goes on reading as the
 * name, and this span is its own either way, so a broken link is red on a marked
 * row too.
 */
function symlinkTargetClass(index: number): string {
  const entry = props.controller.state.entries[index]
  return entry?.kind === 'symlink' ? 'text-danger' : 'text-fg-dim'
}

/**
 * Whether a folder row's walk has been running long enough to show its bar.
 * Short walks are deliberately silent: a bar that blinked for a folder of a few
 * files would say nothing useful.
 */
function rowBar(entry: PaneEntry): boolean {
  return entry.kind === 'directory' && props.controller.state.sizeSlow.has(entry.path)
}

/**
 * Whether the number in the size column is an old answer whose recalculation is
 * still queued: the row draws it dimmed until the walk starts, so a stale total
 * is never mistaken for a fresh one.
 */
function rowStale(entry: PaneEntry): boolean {
  return entry.kind === 'directory' && props.controller.state.sizeStale.has(entry.path)
}

/**
 * The bytes the size column is showing for an entry, or `undefined` where it
 * shows no number at all: the `..` row, or a folder whose walk has not answered.
 * Both the text and its heat are read from this one answer.
 */
function sizeBytes(entry: PaneEntry): number | undefined {
  if (entry.isParent) return undefined
  if (entry.kind === 'directory') return props.controller.state.dirSizes.get(entry.path)
  return entry.size
}

/**
 * The size column's text. A file's size is its own metadata; a folder's is not
 * something a listing knows, so a folder's column stays blank until Space walks
 * it — and then it holds the running total, in the same column and the same
 * units as a file's, with an ellipsis only until the walk counts its first byte.
 */
function sizeText(entry: PaneEntry): string {
  const bytes = sizeBytes(entry)
  if (bytes !== undefined) return formatSize(bytes)
  return entry.kind === 'directory' && props.controller.state.sizing.has(entry.path) ? '…' : ''
}

/**
 * The heat a size is drawn in (lib/format.ts), or nothing to leave the row's own
 * colour alone: a folder total whose recalculation is still queued keeps the
 * plain dim, so an old answer is never dressed as a fresh one, and a row with no
 * number — the `..` row, an unsized folder — has nothing to colour.
 */
function sizeColorStyle(entry: PaneEntry): { color: string } | undefined {
  if (props.controller.state.sizeStale.has(entry.path)) return undefined
  const bytes = sizeBytes(entry)
  if (bytes === undefined) return undefined
  const color = sizeColor(bytes)
  return color === null ? undefined : { color }
}

/** The footer's own size, where an unsized folder still reads as a folder. */
function footerSizeText(entry: PaneEntry): string {
  const text = sizeText(entry)
  return text === '' && entry.kind === 'directory' ? 'dir' : text
}

/**
 * In-place rename. The input is rendered only for the entry the controller is
 * editing, but it lives inside the v-for, so a string ref would collect an
 * array — a function ref keeps a single element handle. Focus and select the
 * basename once the row has swapped to an input.
 */
let renameInput: HTMLInputElement | null = null

/**
 * The text the rename input is showing, held apart from the row it was started
 * from. The pane re-renders for reasons of its own — a footer clip reports its
 * position several times a second while it plays, a `git` read lands, a
 * `fs:changed` refresh arrives — and a `:value` bound straight to the entry's
 * name would be written back over whatever the user had typed on each of those
 * renders. Binding the input to this draft instead keeps the two in step: a
 * re-render patches it with the very text it already holds, so the caret and
 * the selection stay where the user left them.
 */
const renameDraft = ref('')

function setRenameInput(el: Element | ComponentPublicInstance | null): void {
  renameInput = el instanceof HTMLInputElement ? el : null
}

watch(
  () => props.controller.state.renaming,
  async (renaming) => {
    if (!renaming) return
    // Seed the draft from the entry once, so the input opens on the name it is
    // about to replace (and not on the previous rename's leftovers).
    renameDraft.value =
      props.controller.state.entries.find((entry) => entry.path === renaming)?.name ?? ''
    await nextTick()
    const input = renameInput
    if (!input) return
    input.focus()
    // Preselect the stem so typing replaces the name but keeps the extension —
    // the classic rename gesture. A dotfile or extension-less name selects whole.
    const dot = input.value.lastIndexOf('.')
    if (dot > 0) input.setSelectionRange(0, dot)
    else input.select()
  }
)

function onRenameKey(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault()
    const input = event.target as HTMLInputElement
    void props.controller.commitRename(input.value)
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    props.controller.cancelRename()
  }
}

function onRenameBlur(): void {
  // Commit already cleared `renaming` before the input can lose focus, so a
  // blur that still sees an edit in progress is a real cancellation.
  if (props.controller.state.renaming !== null) props.controller.cancelRename()
}
</script>

<template>
  <section
    ref="sectionEl"
    class="relative flex min-w-0 flex-1 flex-col border"
    :class="active ? 'border-accent' : 'border-transparent'"
    @mousedown="onPointerDown"
    @contextmenu.prevent
  >
    <!-- The pane's own content, which a display blurs as a whole. Clipped to
         its own box: a filter's output is not held inside the element it is on,
         so the blur would spill over the border into the pane next door. -->
    <div ref="paneContent" class="flex min-h-0 grow flex-col [clip-path:inset(0)]">
      <div
        class="relative flex h-7 shrink-0 items-center gap-2 border-b border-border-subtle px-3"
        :class="active ? 'bg-accent text-fg-bright' : 'bg-surface text-fg-dim'"
      >
        <span class="flex min-w-0 flex-1 items-center text-ui-sm">
          <!-- An archive the pane is inside: the archive's own name is drawn in
               the archive hue, so it reads as set apart from the entry path after
               it. A folder merely *named* `foo.zip` keeps the plain title colour,
               which is how the two are told apart in the title. The segments
               carry no space between them, so the title stays one path. -->
          <span v-if="quickCdMode" class="min-w-0 flex-1 truncate font-medium text-fg-bright">
            Quick cd
          </span>
          <template v-else-if="archiveTitle">
            <span v-if="archiveTitle.dir" class="min-w-0 truncate">{{
              archiveTitle.dir
            }}/</span>
            <!-- The archive's own name, in the archive hue — the gold its own
                 icon is drawn in — so a name and its icon agree about what the
                 entry is, without competing with the green of a runnable file or
                 the gold of a mark. -->
            <span class="shrink-0 text-archive" :title="archiveTitle.full">{{
              archiveTitle.name
            }}</span>
            <template v-if="archiveTitle.inner">
              <span class="shrink-0">/</span>
              <span class="min-w-0 truncate">{{ archiveTitle.inner }}</span>
            </template>
          </template>
          <span v-else class="min-w-0 flex-1 truncate">{{ controller.state.path || '—' }}</span>
        </span>
        <!-- The work tree this pane is in: its HEAD, how far that has drifted
             from its upstream, and how much of the tree is changed. Per-pane,
             because the two panes can be in different repositories — and in the
             title's own color rather than the gold the marks take, so nothing up
             here competes with a selection further down. -->
        <span
          v-if="gitView && !quickCdMode"
          class="flex min-w-0 shrink-0 items-center gap-1 text-ui-sm"
          :title="gitTitle"
        >
          <svg
            viewBox="0 0 24 24"
            class="h-3 w-3 shrink-0"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <line x1="6" y1="3" x2="6" y2="15" />
            <circle cx="18" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
          </svg>
          <span class="max-w-40 truncate">{{ gitBranch }}</span>
          <span v-if="gitDrift" class="opacity-80">{{ gitDrift }}</span>
          <!-- How dirty the work tree is, as one count: the branch already
               answers for all of it, so this does too, and the breakdown the
               count cannot fit is in the chip's title. -->
          <span v-if="gitSummaryText" class="flex shrink-0 items-center gap-1 pl-1 opacity-80">
            <!-- The dot is always filled here (the tree has something changed),
                 so its outline is the pane's own background rather than the
                 colour it holds — the same dark ring a row's dot wears, which is
                 what keeps the mark's hue from bleeding into the title bar. It
                 is a shadow rather than a border, so the ring sits *around* the
                 dot instead of eating into its size. -->
            <span
              class="h-1.5 w-1.5 shrink-0 rounded-full"
              :style="{ backgroundColor: gitSummaryColor, boxShadow: '0 0 0 1px var(--color-bg)' }"
            />
            <span>{{ gitSummaryText }}</span>
          </span>
        </span>
        <!-- How full this pane's filesystem is, left of the hide icon so the two
             state chips share the title's tail; the tooltip carries the exact
             sizes and the mount point. -->
        <DiskUsage :usage="diskUsage" :active="active" />
        <!-- How the pane draws its own rows: the detail listing, or a wall of
             thumbnails. It is the same kind of state as the star beside it — a
             filled grid when the wall is up, an outline list when the rows are —
             and keeps the title's color, so nothing up here competes with a
             selection below. Alt+T is the key. -->
        <button
          type="button"
          class="flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-hover"
          :class="
            controller.state.viewMode === 'thumbnails'
              ? 'text-fg-bright'
              : 'text-fg-dim hover:text-fg'
          "
          :title="VIEW_MODE_TOOLTIP"
          aria-label="View mode"
          @click.stop="toggleView()"
          @wheel="onViewButtonWheel"
        >
          <svg
            v-if="controller.state.viewMode === 'thumbnails'"
            viewBox="0 0 24 24"
            class="h-3.5 w-3.5"
            fill="currentColor"
            aria-hidden="true"
          >
            <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
            <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
            <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
            <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
          </svg>
          <svg
            v-else
            viewBox="0 0 24 24"
            class="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <!-- Quick cd is reached by Alt+C and by this button. Unlike the header's
             own controls, the title bar is still there while the mode is on, which
             is where the way *out* has to live. It is a state as much as a switch —
             a filled star for the mode on, an outline one for off — and it keeps
             the title's own color rather than the gold a mark takes, so nothing up
             here competes with a selection further down. -->
        <button
          type="button"
          class="flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-hover"
          :class="quickCdMode ? 'text-fg-bright' : 'text-fg-dim hover:text-fg'"
          :title="quickCdMode ? QUICK_CD_LEAVE_TOOLTIP : QUICK_CD_TOOLTIP"
          aria-label="Quick cd"
          @click.stop="controller.toggleQuickCd()"
        >
          <svg
            viewBox="0 0 24 24"
            class="h-3.5 w-3.5"
            :fill="quickCdMode ? 'currentColor' : 'none'"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path
              d="M12 3.5l2.6 5.27 5.82.85-4.21 4.1 1 5.78L12 16.78 6.79 19.5l1-5.78-4.21-4.1 5.82-.85z"
            />
          </svg>
        </button>
        <!-- The mode is otherwise invisible: the rows it covers are simply not
             there, so nothing in the listing says they were left out on purpose.
             The icon is a state as much as a notice — the dim open eye is the
             mode switched off in a folder that still has a list to apply, and the
             eye-off that says it is on is the title's own color rather than the
             gold the marks and the cursor take, so nothing here competes with a
             selection further down. -->
        <span
          v-if="hideListed && !quickCdMode"
          class="flex shrink-0 items-center"
          :class="hideMode && active ? 'text-fg-bright' : 'text-fg-dim'"
          :title="hideMode ? HIDE_MODE_TOOLTIP : HIDE_MODE_OFF_TOOLTIP"
          aria-hidden="true"
        >
          <svg
            v-if="hideMode"
            viewBox="0 0 24 24"
            class="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path
              d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"
            />
            <line x1="1" y1="1" x2="23" y2="23" />
          </svg>
          <svg
            v-else
            viewBox="0 0 24 24"
            class="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </span>
      </div>

      <div
        v-if="!quickCdMode && !thumbnails"
        ref="headerEl"
        class="pane-header-gutter group relative flex h-6 shrink-0 items-center gap-1.5 border-b border-border-subtle pl-3 text-ui-sm text-fg-dim transition-colors"
        :class="columnEdit ? 'bg-surface-2' : 'bg-bg'"
        @dragover.prevent="onHeaderDragOver"
        @drop.prevent="onHeaderDrop"
      >
        <template v-for="(col, i) in columnOrder" :key="col">
          <!-- The gap before this column: a column of the first unused type is
               inserted here. One of these leads every column, and one trails the
               last (below), so every gap — first, middle and last — can take a
               new column. -->
          <ColumnAddButton v-if="columnEdit" :disabled="!canAddColumn" @add="onAddColumn(i)" />

          <!-- The editor for one column, while the columns are being built. The
               grip, the picker and the remove button are one *capsule* — a
               bordered, rounded group with hairline dividers — so a column reads
               as a single closed control rather than three pieces loose in the
               header, and the add buttons in the gaps stay visibly apart from it.
               The grip drags the column to another place (the picker and the
               buttons cannot be the drag themselves, or the picker could not be
               opened), the picker is the column's type, and the button drops the
               column. The name column is essential: a listing without the entry's
               own name is not a listing, so its drop button is disabled. -->
          <div
            v-if="columnEdit"
            data-column
            class="relative flex items-center"
            :class="[editorClass(col), draggingColumn === col ? 'opacity-50' : '']"
            @mousedown="onColumnFocusMouse(i)"
          >
            <div
              class="flex items-center divide-x divide-border overflow-hidden rounded-md border border-border bg-surface transition-colors hover:border-fg-dim focus-within:border-accent-strong"
              :class="columnFocus === i ? 'border-accent-strong ring-1 ring-accent-strong' : ''"
            >
              <span
                draggable="true"
                class="flex h-5 w-4 shrink-0 cursor-grab items-center justify-center text-fg-dim transition-colors hover:bg-hover hover:text-fg active:cursor-grabbing"
                title="Drag to move the column"
                aria-hidden="true"
                @dragstart="onColumnEditDragStart(col, $event)"
                @dragend="onColumnDragEnd"
              >
                <svg viewBox="0 0 24 24" class="h-3 w-3" fill="currentColor" aria-hidden="true">
                  <circle cx="9" cy="6" r="1.5" />
                  <circle cx="15" cy="6" r="1.5" />
                  <circle cx="9" cy="12" r="1.5" />
                  <circle cx="15" cy="12" r="1.5" />
                  <circle cx="9" cy="18" r="1.5" />
                  <circle cx="15" cy="18" r="1.5" />
                </svg>
              </span>
              <select
                class="column-select h-5 min-w-0 max-w-full cursor-pointer bg-transparent text-ui-sm text-fg outline-none transition-colors hover:bg-hover focus:bg-hover"
                :value="col"
                :title="`Show ${COLUMN_LABELS[col]} in this column`"
                @mousedown.stop="onColumnFocusMouse(i)"
                @click.stop
                @change="onColumnTypeChange(i, $event)"
              >
                <option
                  v-for="type in COLUMN_TYPES"
                  :key="type"
                  :value="type"
                  :disabled="type !== col && columnOrder.includes(type)"
                >
                  {{ COLUMN_LABELS[type] }}
                </option>
              </select>
              <button
                type="button"
                class="flex h-5 w-5 shrink-0 items-center justify-center text-fg-dim transition-colors hover:bg-hover hover:text-danger disabled:cursor-default disabled:opacity-25 disabled:hover:bg-transparent"
                :disabled="col === 'name'"
                :title="col === 'name' ? 'The name column cannot be removed' : 'Remove this column'"
                :aria-label="col === 'name' ? 'The name column cannot be removed' : 'Remove this column'"
                @click.stop="onRemoveColumn(i)"
              >
                <svg
                  viewBox="0 0 24 24"
                  class="h-3 w-3"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  aria-hidden="true"
                >
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </div>
          </div>

          <!-- Each header is the column's own switch: clicking it orders the
               listing by that column, and dragging it moves the column to another
               place among the headers. The arrow sits to the right of the name and
               only on the column in use, so the header itself says what the listing
               is ordered by and which way it runs. -->
          <button
            v-else
            type="button"
            draggable="true"
            data-column
            class="relative flex cursor-pointer select-none items-center transition-colors hover:text-fg"
            :class="[
              headerClass(col),
              sortKey === col ? 'text-fg-bright' : '',
              draggingColumn === col ? 'opacity-50' : ''
            ]"
            :title="`Sort by ${COLUMN_LABELS[col]} — drag to move the column`"
            @click="onHeaderClick(col)"
            @dragstart="onColumnDragStart(col, $event)"
            @dragend="onColumnDragEnd"
          >
            <span :class="col === 'name' ? 'min-w-0 truncate' : ''">{{ COLUMN_LABELS[col] }}</span>
            <span v-if="sortArrow(col)" class="shrink-0">{{ sortArrow(col) }}</span>
          </button>

        </template>

        <!-- The trailing gap: a column put after the last one. Between it and
             the leading controls, every gap — first, middle and last — can take
             a new column. -->
        <ColumnAddButton
          v-if="columnEdit"
          :disabled="!canAddColumn"
          @add="onAddColumn(columnOrder.length)"
        />

        <!-- The edit-mode switch, pinned to the right edge of the header rather
             than sitting in the columns' row: in the flow it would reserve its own
             width past the last column, pushing the columns out of line with the
             rows below and leaving dead space at the right. Out of the flow it
             lives in the gutter the rows already keep for the scrollbar, so the
             columns line up and the header's right edge is where the listing's is.
             It stays out of the way until the pointer is on the header (or the
             mode is already on). -->
        <button
          type="button"
          class="absolute top-1/2 right-0 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-fg-dim opacity-0 transition-opacity hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
          :class="columnEdit ? 'text-accent-strong opacity-100' : ''"
          :title="columnEdit ? 'Done editing columns' : 'Edit columns (Alt+E)'"
          aria-label="Edit columns"
          @click.stop="onToggleColumnEdit"
        >
          <svg
            viewBox="0 0 24 24"
            class="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
        </button>

        <!-- The gap the drag would drop into, drawn once at the header's own
             level — it is the only box that can hold a marker overshooting the
             header's top over the title above. -->
        <ColumnDropMarker v-if="dropMarkerX !== null" :x="dropMarkerX" />
      </div>

      <!-- The bar opens the room it needs instead of appearing inside it: the
           clipping window's own height animates, so the listing below is pushed
           down and pulled back up with the bar rather than jumping when a row
           lands. The bar itself is what the window clips as it grows. -->
      <Transition name="search">
        <div v-if="controller.state.searchActive" class="shrink-0 overflow-hidden">
          <div
            data-search
            class="flex h-7 items-center gap-2 border-b border-border-subtle bg-bg-alt px-3"
          >
            <svg
              viewBox="0 0 24 24"
              class="h-3.5 w-3.5 shrink-0 text-fg-dim"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.6-3.6" />
            </svg>
            <input
              ref="searchInput"
              type="text"
              class="search-input min-w-0 flex-1 bg-transparent font-mono text-ui text-fg outline-none placeholder:text-fg-dim"
              placeholder="incremental search"
              spellcheck="false"
              autocomplete="off"
              :value="controller.state.searchQuery"
              @input="onSearchInput"
            />
            <span
              v-if="controller.state.searchQuery"
              class="shrink-0 tabular-nums text-ui-sm text-fg-dim"
            >
              {{ controller.state.itemCount }} matches
            </span>
          </div>
        </div>
      </Transition>

      <!-- The window clips, and its own height is what changes: the row slides
           from `0fr` to `1fr` so the listing below is pushed down by the same
           motion the message descends with, rather than being shoved down by the
           mount (see styles/notice.css). Keyed on its text so a new notice
           replaces the old one through the animation. -->
      <div class="notice-window shrink-0" :class="{ 'notice-window-open': notice }">
        <div class="overflow-hidden">
          <Transition name="notice" mode="out-in">
            <p
              v-if="notice"
              :key="notice.text"
              class="px-3 py-2 text-ui"
              :class="notice.error ? 'text-danger' : 'text-fg-dim'"
            >
              {{ notice.text }}
            </p>
          </Transition>
        </div>
      </div>

      <!-- A wall of thumbnails, in place of the rows: the same entries, drawn
           from their own pictures where one can be read. The listing's fixed-row
           arithmetic is this component's own here, so the two never share the
           scroll, the windowing or the page math. -->
      <ThumbnailGrid
        v-if="thumbnails"
        ref="gridEl"
        :controller="controller"
        :active="active"
        :enter="viewEnter"
        :name-for="entryName"
        @left-down="onRowLeftDown"
        @right-down="onRowRightDown"
        @enter="onRowEnter"
        @activate="onRowDblclick"
      />

      <!-- Only the rows the viewport covers are in the document (see
           `visibleRows`); the rows hidden above and below stand in as spacers of
           their exact height, so the scrollbar, the page arithmetic and the
           scroll-into-view all measure the whole listing as if it were there. -->
      <ul
        v-else
        ref="listEl"
        data-list
        class="pane-scrollbar relative min-h-0 flex-1 overflow-y-auto"
        :style="listSlackStyle"
        @scroll="onListScroll"
      >
        <li
          v-if="topPad > 0"
          aria-hidden="true"
          :style="{ height: `${topPad}px` }"
        />
        <li
          v-for="(row, order) in visibleRows"
          :key="row.entry.path"
          :data-path="row.entry.path"
          class="flex cursor-default items-center gap-1.5 px-3 text-ui"
          :style="[
            { height: `${ROW_HEIGHT}px` },
            { viewTransitionName: entryName(row.entry.path) },
            viewEnterStyle(order)
          ]"
          :class="[rowClass(row.index), viewEnterClass(order)]"
          @mousedown.left="onRowLeftDown(row.index)"
          @mousedown.right="onRowRightDown(row.index, $event)"
          @mouseenter="onRowEnter(row.index)"
          @contextmenu.prevent
          @dblclick="onRowDblclick"
        >
          <template v-for="col in displayColumns" :key="col">
            <!-- The name column carries the row's icon, its name and the link
                 that name may point to, so all of it travels together when the
                 column is dragged to another place. -->
            <span v-if="col === 'name'" class="flex min-w-0 flex-1 items-center gap-2">
              <span class="relative flex w-4 shrink-0 items-center justify-center">
                <FileIcon :entry="row.entry" />
                <!-- The row's whole mark: a dot on its own icon, the colour of the
                     status and nothing else — filled for the entry itself, a ring
                     for a folder that only holds one. What it means in words is in
                     the row's title. -->
                <span
                  v-if="row.git"
                  class="pointer-events-none absolute -right-1 -bottom-1 h-1.5 w-1.5 rounded-full border"
                  :style="dotStyle(row.git, true)"
                  :title="markTitle(row.git.mark, row.git.count, row.git.rollup)"
                />
              </span>

              <input
                v-if="controller.state.renaming === row.entry.path"
                :ref="setRenameInput"
                type="text"
                class="min-w-0 flex-1 rounded border border-accent-strong bg-bg px-1 font-mono text-ui text-fg outline-none"
                v-model="renameDraft"
                spellcheck="false"
                autocomplete="off"
                @keydown="onRenameKey"
                @blur="onRenameBlur"
                @mousedown.stop
                @click.stop
                @dblclick.stop
              />
              <span v-else class="flex min-w-0 flex-1 items-center gap-2">
                <span
                  class="min-w-0 shrink truncate"
                  :class="nameClass(row.index)"
                  >{{ row.entry.name }}</span
                >

                <span
                  v-if="row.entry.isSymlink && row.entry.symlinkTarget"
                  class="min-w-0 shrink truncate text-ui-sm"
                  :class="symlinkTargetClass(row.index)"
                  :title="row.entry.symlinkTarget"
                >
                  → {{ row.entry.symlinkTarget }}
                </span>
              </span>
            </span>

            <span
              v-else-if="col === 'size'"
              class="relative flex w-16 shrink-0 items-center justify-end tabular-nums"
              :class="[
                rowBar(row.entry) ? 'size-cell-bar' : '',
                rowStale(row.entry) ? 'text-fg-dim' : 'text-fg'
              ]"
              :style="sizeColorStyle(row.entry)"
            >
              {{ sizeText(row.entry) }}
            </span>
            <span
              v-else-if="col === 'modified'"
              class="w-24 shrink-0 text-right tabular-nums text-fg"
              :title="row.entry.isParent ? undefined : formatExactDate(row.entry.mtimeMs)"
            >
              {{ row.entry.isParent ? '' : formatRelativeDate(row.entry.mtimeMs) }}
            </span>

            <!-- The mode column, the one header left that is not the name, size or
                 date. The ".." row carries none of it and stays blank. -->
            <span v-else :class="cellClass()">
              {{ cellText(row.entry, col) }}
            </span>
          </template>
        </li>
        <li
          v-if="bottomPad > 0"
          aria-hidden="true"
          :style="{ height: `${bottomPad}px` }"
        />
      </ul>

      <div
        ref="footerEl"
        class="flex shrink-0 items-center justify-between gap-3 overflow-hidden border-t border-border-subtle bg-surface px-3 text-ui-sm text-fg-dim transition-[height] ease-out"
        :style="{
          height: `${footerTall ? FOOTER_PREVIEW_HEIGHT : FOOTER_HEIGHT}px`,
          transitionDuration: `${footerTall ? FOOTER_RESIZE_MS : 0}ms`
        }"
      >
        <div class="flex min-w-0 items-center gap-3">
          <!-- Shown/hidden with `v-show`, not `v-if`: a video hidden this way is
               still mounted, which is what lets it fetch its metadata, and so its
               shape, before the box is allowed on screen. -->
          <div
            v-show="previewVisible"
            ref="previewEl"
            :style="previewBoxStyle"
            class="relative flex shrink-0 items-center justify-center overflow-hidden rounded border border-border-subtle bg-bg"
            @wheel="onFooterWheel"
            @click="onPreviewClick"
            @dblclick="onPreviewDblclick"
          >
            <img
              v-if="showImage"
              :src="frame ?? undefined"
              alt=""
              draggable="false"
              class="h-full w-full object-contain"
              @load="onImageLoad"
              @error="onImageError"
            />
            <!-- One page of a PDF, rasterized by main. It is the shared page, so
                 stepping it here and in a display keeps the two in agreement; a
                 display that has taken the file over is the one rendering it, so
                 this box keeps its space and draws nothing. -->
            <img
              v-else-if="showPdf && !transferred"
              :src="pdfFrame ?? undefined"
              alt=""
              draggable="false"
              class="h-full w-full object-contain"
              @load="onPdfFooterLoad"
              @error="onImageError"
            />
            <!-- Muted and played once, never looped: a preview is a look at the
                 clip, not a viewing session, and a looping 4K file would decode
                 for as long as the cursor happens to rest on the row. -->
            <video
              v-else-if="showVideo && !transferred"
              ref="previewVideo"
              :src="videoUrl ?? undefined"
              muted
              autoplay
              preload="metadata"
              class="h-full w-full object-contain"
              @loadedmetadata="onVideoMetadata"
              @loadeddata="onVideoStarted"
              @playing="onVideoStarted"
              @timeupdate="readVideoClock"
              @seeked="readVideoClock"
              @ended="readVideoClock"
              @error="onVideoError"
            ></video>
            <!-- A 3D model, drawn into a canvas rather than read as a picture.
                 The thumbnail turns on its own; the display, in the other pane,
                 is where it is handled with the pointer. -->
            <ModelViewer
              v-else-if="previewModel && !transferred"
              :key="previewKeyFor(previewTarget) ?? undefined"
              :format="previewModel.format"
              :bytes="previewModel.bytes"
              @ready="onFooterModelReady"
              @error="onFooterModelError"
            />
            <!-- The play/pause or seek feedback for this thumbnail's own clip. -->
            <PlaybackOsd
              v-if="footerOsd"
              :key="footerOsd.id"
              :osd="footerOsd"
              compact
              @done="footerOsd = null"
            />
            <span
              v-if="showSpinner"
              class="absolute h-3.5 w-3.5 animate-spin rounded-full border border-fg border-t-transparent"
            />
          </div>

          <!-- The space the box will take, before its shape is known. Held at the
               box's own height so the footer is already the size it will be. -->
          <span v-if="previewWaiting" class="flex h-16 shrink-0 items-center">
            <span
              class="h-3.5 w-3.5 animate-spin rounded-full border border-fg border-t-transparent"
            />
          </span>

          <!-- Where the clip has got to: its position, a bar for how far that is
               through it, and its length — the last two only when the clip is a
               whole file whose length is really known. -->
          <span
            v-if="showPlayBar"
            class="flex shrink-0 items-center gap-2 tabular-nums text-ui-sm text-fg-dim"
          >
            <span>{{ formatDuration(playTime) }}</span>
            <span
              v-if="playLength !== null"
              class="h-1 w-20 overflow-hidden rounded-full bg-border"
            >
              <span
                class="block h-full rounded-full bg-accent-strong"
                :style="{ width: playProgress }"
              />
            </span>
            <span v-if="playLength !== null">{{ formatDuration(playLength) }}</span>
          </span>

          <!-- Which page of a PDF is in the box: the page, a bar for how far
               through the document that is, and the page count. The same answer
               a display shows, read from the one place both keep it. -->
          <span
            v-if="showPageBar"
            class="flex shrink-0 items-center gap-2 tabular-nums text-ui-sm text-fg-dim"
          >
            <span>{{ pdfPageNumber }}</span>
            <span
              v-if="pdfPageCount !== null"
              class="h-1 w-20 overflow-hidden rounded-full bg-border"
            >
              <span
                class="block h-full rounded-full bg-accent-strong"
                :style="{ width: pdfPageProgress }"
              />
            </span>
            <span v-if="pdfPageCount !== null">{{ pdfPageCount }}</span>
          </span>

          <span v-if="quickCdMode" class="shrink-0 tabular-nums">
            {{ controller.state.itemCount }} directories
          </span>
          <span v-else class="shrink-0 tabular-nums">{{ controller.state.itemCount }} items</span>
        </div>

        <div class="flex shrink-0 items-center gap-3">
          <!-- What git thinks of the row under the cursor. The status bar is
               where there is room for the words a row's own cell has none for,
               and the dot beside them is that row's own mark: filled when the
               entry is the thing that changed, a ring when the folder only holds
               what did. -->
          <span
            v-if="entryGit"
            class="flex min-w-0 shrink-0 items-center gap-1.5"
            :title="markTitle(entryGit.mark, entryGit.count, entryGit.rollup)"
          >
            <span
              class="h-2 w-2 shrink-0 rounded-full border"
              :style="dotStyle(entryGit, false)"
            />
            <span class="max-w-40 truncate">{{
              markSummary(entryGit.mark, entryGit.count, entryGit.rollup)
            }}</span>
          </span>

          <template v-if="entry && !entry.isParent && !quickCdMode">
            <span class="hidden tabular-nums lg:inline">{{ formatMode(entry.mode) }}</span>
            <span class="tabular-nums" :style="sizeColorStyle(entry)">
              {{ footerSizeText(entry) }}
            </span>
            <span class="hidden tabular-nums lg:inline" :title="formatExactDate(entry.mtimeMs)">{{
              formatRelativeDate(entry.mtimeMs)
            }}</span>
          </template>

          <span v-if="selectedCount > 0" class="tabular-nums text-selected">
            {{ selectedCount }} selected · {{ selectedSizeText }}
          </span>
        </div>
      </div>
    </div>

    <!-- What the pane being navigated has asked this one to display. The listing
         stays where it was and is blurred behind it — `paneContent` above takes
         the blur — so this pane has one thing to look at while the folder it was
         showing is still there. No chrome of its own: the media is the display.
         Pointer events stop here so a click cannot move the cursor's pane away
         from the one being navigated.

         In the full-screen viewing mode it is lifted out of the pane and fixed to
         the window (`fixed inset-0`, over the tab strip and the terminal), but it
         is the same display, laid out the same way: only the box the media is
         measured in changes, so the transport, the seeking and the reveal all
         carry over untouched. -->
    <div
      v-if="displaying || shownStage"
      class="flex flex-col"
      :class="stagePresentation"
      @mousedown="onStagePointerDown"
      @mouseup="onStagePointerUp"
      @click.stop
      @dblclick.stop
      @contextmenu.prevent
      @wheel="onStageWheel"
    >
      <!-- What the display sits on: the pane's own listing when it is shown in its
           pane (the strip is simply transparent there), and the window's
           background when it is opened over everything — where it is what covers
           the tab strip, the panes and the command line behind the media. It is
           window-sized in either case rather than following the layout, because
           it is faded rather than switched when the presentation changes: on the
           way back into the pane it has to go on covering what the media is still
           hanging over until the picture has landed. -->
      <span
        ref="stageBackdrop"
        class="pointer-events-none fixed inset-0 -z-10 bg-bg"
        :style="{ opacity: fullscreenPresentation ? 1 : 0 }"
        aria-hidden="true"
      ></span>
      <div
        v-if="shownStage"
        class="flex min-h-0 grow flex-col"
        :class="fullscreenPresentation ? '' : 'p-3'"
      >
        <div ref="stageArea" class="relative flex min-h-0 grow items-center justify-center">
          <div
            v-if="showStageVideo"
            class="flex min-h-0 flex-col items-stretch"
            :style="stageColumnStyle"
          >
            <!-- A display is for watching rather than glancing at, so the clip
                 plays here with its sound — the element stays muted until the
                 reveal has it fade up, and a failure to load leaves it silent.
                 It plays once, like the footer's own silent thumbnail rather
                 than looping: a clip that has run out stops where it ended, and
                 stepping past its end stops there too. A click on the picture
                 itself pauses or resumes. -->
            <video
              ref="stageMedia"
              :src="stageVideoUrl ?? undefined"
              muted
              autoplay
              class="w-full min-h-0 origin-top-left object-contain"
              :class="stageState === 'ready' ? '' : 'invisible'"
              :style="stageMediaStyle"
              @loadedmetadata="resumeStage"
              @loadeddata="onStageShown"
              @timeupdate="readStageClock"
              @seeked="readStageClock"
              @ended="onStageEnded"
              @play="stagePlaying = true"
              @pause="stagePlaying = false"
              @click="onStageVideoClick"
              @dblclick="onStageMediaDblclick"
              @error="onStageError"
            ></video>

            <!-- The clip's transport, as wide as the picture above it: a
                 play/pause button, a position, a full-width track and a length.
                 The track itself is thin, but its hit area is the whole row, so
                 it is easy to grab and drag. -->
            <div
              ref="stageBarEl"
              class="shrink-0 origin-top-left border-t border-border-subtle bg-surface px-2 py-2"
              :class="stageState === 'ready' ? '' : 'invisible'"
            >
              <div class="flex select-none items-center gap-2 tabular-nums text-ui-sm text-fg-dim">
                <button
                  type="button"
                  class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim transition-colors hover:bg-hover hover:text-fg"
                  :aria-label="stagePlaying ? 'Pause' : 'Play'"
                  @click="onStageVideoClick"
                >
                  <svg
                    v-if="stagePlaying"
                    viewBox="0 0 24 24"
                    class="h-3.5 w-3.5"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <path d="M7 5h4v14H7zM14 5h4v14h-4z" />
                  </svg>
                  <svg
                    v-else
                    viewBox="0 0 24 24"
                    class="h-3.5 w-3.5"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </button>
                <span class="shrink-0">{{ formatDuration(stageTime) }}</span>
                <div
                  class="group relative flex h-6 min-w-0 flex-1 cursor-pointer touch-none items-center"
                  role="slider"
                  aria-label="Clip position"
                  :aria-valuemin="0"
                  :aria-valuemax="stagePlayLength ?? 0"
                  :aria-valuenow="stageTime"
                  @pointerdown="onStageBarPointerDown"
                  @pointermove="onStageBarPointerMove"
                  @pointerup="onStageBarPointerUp"
                  @pointercancel="onStageBarPointerUp"
                >
                  <span class="h-1.5 w-full overflow-hidden rounded-full bg-border">
                    <span
                      class="block h-full rounded-full bg-accent-strong"
                      :style="{ width: stageProgress }"
                    />
                  </span>
                  <span
                    class="pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-surface bg-accent-strong transition-opacity"
                    :class="stageScrubbing ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'"
                    :style="{ left: stageThumbLeft }"
                  />
                </div>
                <span class="shrink-0">
                  {{ stagePlayLength !== null ? formatDuration(stagePlayLength) : '--:--' }}
                </span>
              </div>
            </div>
          </div>

          <!-- A displayed PDF is a document, not a picture: its pages are
               stacked and scrolled through, with the transport turning and
               jumping between them and the page a scroll position lands on being
               what the footer's counter says. Only the pages near the viewport
               are in the document (spacers stand in for the rest), so a long
               file is never all in the DOM at once. -->
          <div v-else-if="showStagePdf" class="flex min-h-0 w-full grow flex-col self-stretch">
            <div
              ref="stageMedia"
              tabindex="-1"
              data-pdf-scroll
              class="pane-scrollbar relative min-h-0 grow origin-top-left overflow-x-auto overflow-y-auto outline-none [scrollbar-gutter:stable]"
              :class="stageState === 'ready' ? '' : 'invisible'"
              @scroll="onPdfScroll"
              @mousedown="onPdfPanStart"
            >
              <div class="mx-auto flex flex-col" :style="{ width: `${pdfColumnWidth}px` }">
                <div
                  v-if="pdfTopPad > 0"
                  :style="{ height: `${pdfTopPad}px` }"
                  aria-hidden="true"
                />
                <div
                  v-for="item in pdfVisiblePages"
                  :key="item.page"
                  v-memo="[
                    item.page,
                    item.height,
                    pdfColumnWidth,
                    pdfFrameFor(item.page),
                    pdfTextFor(item.page),
                    pdfSelections.get(item.page)
                  ]"
                  class="relative shrink-0 overflow-hidden bg-surface-2"
                  :style="{ height: `${item.height}px`, marginBottom: `${PDF_PAGE_GAP}px` }"
                >
                  <img
                    v-if="pdfFrameFor(item.page)"
                    :src="pdfFrameFor(item.page) ?? undefined"
                    alt=""
                    draggable="false"
                    class="h-full w-full object-contain"
                  />

                  <!-- What is selected, drawn where the page's own glyphs are:
                       a band per run of words on a line, from the word boxes the
                       text was read from rather than from the browser's highlight,
                       which follows the invisible substitute font's line box and
                       would sit a little low and a little wide of the words. -->
                  <div
                    v-if="pdfSelections.get(item.page)"
                    class="pointer-events-none absolute inset-0"
                  >
                    <span
                      v-for="(rect, index) in pdfHighlightRects(item.page)"
                      :key="index"
                      class="pdf-selection absolute"
                      :style="{
                        left: `${rect.left}px`,
                        top: `${rect.top}px`,
                        width: `${rect.width}px`,
                        height: `${rect.height}px`
                      }"
                    />
                  </div>

                  <!-- The page's own text, drawn over the raster invisibly: what
                       is seen is the picture, and what is selected is this. Each
                       word is a span at the box `pdftotext` gave it, scaled to the
                       width the page is drawn at, so a drag lands on the glyphs
                       whatever the zoom — and `select-text` is what lets a
                       selection start inside a pane that is otherwise
                       `select-none`. The separating space is *in the expression*
                       on purpose: the template compiler's whitespace condensing
                       drops a trailing space written as template text, which
                       would run every word of the copied page together. -->
                  <div
                    v-if="pdfTextFor(item.page)"
                    data-pdf-text
                    :data-page="item.page"
                    class="absolute inset-0 select-text"
                    @mousedown="onPdfWordsMouseDown"
                  >
                    <span
                      v-for="(word, index) in pdfWordsFor(item.page)"
                      :key="index"
                      class="absolute cursor-text overflow-hidden whitespace-pre text-transparent"
                      :style="pdfWordStyle(item.page, word)"
                      >{{ word.text + ' ' }}</span
                    >
                  </div>
                </div>
                <div
                  v-if="pdfBottomPad > 0"
                  :style="{ height: `${pdfBottomPad}px` }"
                  aria-hidden="true"
                />
              </div>
            </div>

            <!-- The page transport: back a page, the page, a track over the
                 pages, the count and forward a page. It is the clip's bar in the
                 same place, but its position is the page the document has been
                 scrolled to rather than a playhead, so it follows the scroll as
                 much as it drives it. -->
            <div
              ref="stageBarEl"
              class="shrink-0 origin-top-left border-t border-border-subtle bg-surface px-2 py-2"
              :class="stageState === 'ready' ? '' : 'invisible'"
            >
              <div class="flex select-none items-center gap-2 tabular-nums text-ui-sm text-fg-dim">
                <button
                  type="button"
                  class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim transition-colors hover:bg-hover hover:text-fg disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
                  :disabled="!canPdfPrev"
                  aria-label="Previous page"
                  @click="stepStagePdfPage(-1)"
                >
                  <svg
                    viewBox="0 0 24 24"
                    class="h-3.5 w-3.5"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="m15 6-6 6 6 6" />
                  </svg>
                </button>
                <span class="shrink-0">{{ stagePdfPage }}</span>
                <div
                  class="group relative flex h-6 min-w-0 flex-1 cursor-pointer touch-none items-center"
                  role="slider"
                  aria-label="Page"
                  :aria-valuemin="1"
                  :aria-valuemax="stagePdfPages ?? 1"
                  :aria-valuenow="stagePdfPage"
                  @pointerdown="onPdfBarPointerDown"
                  @pointermove="onPdfBarPointerMove"
                  @pointerup="onPdfBarPointerUp"
                  @pointercancel="onPdfBarPointerUp"
                >
                  <span class="h-1.5 w-full overflow-hidden rounded-full bg-border">
                    <span
                      class="block h-full rounded-full bg-accent-strong"
                      :style="{ width: stagePdfProgress }"
                    />
                  </span>
                  <span
                    class="pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-surface bg-accent-strong transition-opacity"
                    :class="pdfScrubbing ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'"
                    :style="{ left: stagePdfThumbLeft }"
                  />
                </div>
                <span class="shrink-0">{{ stagePdfPages !== null ? stagePdfPages : '?' }}</span>
                <button
                  type="button"
                  class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim transition-colors hover:bg-hover hover:text-fg disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
                  :disabled="!canPdfNext"
                  aria-label="Next page"
                  @click="stepStagePdfPage(1)"
                >
                  <svg
                    viewBox="0 0 24 24"
                    class="h-3.5 w-3.5"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="m9 6 6 6-6 6" />
                  </svg>
                </button>

                <!-- How the document is fitted: the box's width, or a whole page
                     scaled into it. The choice is the app's and is remembered, so
                     it reads the same here as in the other pane's display. -->
                <span class="mx-0.5 h-4 w-px shrink-0 bg-border" aria-hidden="true" />
                <button
                  type="button"
                  class="flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors"
                  :class="
                    pdfView.mode === 'width'
                      ? 'bg-accent-strong text-fg-bright'
                      : 'text-fg-dim hover:bg-hover hover:text-fg'
                  "
                  :title="`Fit width — 100% (${PDF_FIT_WIDTH_KEY})`"
                  aria-label="Fit width"
                  :aria-pressed="pdfView.mode === 'width'"
                  @click="setPdfFit('width')"
                >
                  <svg
                    viewBox="0 0 24 24"
                    class="h-3.5 w-3.5"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <rect x="3" y="4" width="18" height="16" rx="2" />
                    <path d="M7.5 12h9" />
                    <path d="m10 9.5-2.5 2.5 2.5 2.5" />
                    <path d="m14 9.5 2.5 2.5-2.5 2.5" />
                  </svg>
                </button>
                <button
                  type="button"
                  class="flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors"
                  :class="
                    pdfView.mode === 'page'
                      ? 'bg-accent-strong text-fg-bright'
                      : 'text-fg-dim hover:bg-hover hover:text-fg'
                  "
                  :title="`Fit page — the whole page in the pane (${PDF_FIT_PAGE_KEY})`"
                  aria-label="Fit page"
                  :aria-pressed="pdfView.mode === 'page'"
                  @click="setPdfFit('page')"
                >
                  <svg
                    viewBox="0 0 24 24"
                    class="h-3.5 w-3.5"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <rect x="9" y="7" width="6" height="10" rx="1" />
                  </svg>
                </button>

                <!-- Magnification on top of the fit: `-` and `+` step the ladder
                     and the label is that step as a percentage of what the fit
                     chose. Past 100% a page is wider than the box and scrolls
                     sideways. -->
                <span class="mx-0.5 h-4 w-px shrink-0 bg-border" aria-hidden="true" />
                <button
                  type="button"
                  class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim transition-colors hover:bg-hover hover:text-fg disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
                  :disabled="pdfZoomAtMin"
                  :title="`Zoom out (${PDF_ZOOM_OUT_KEY})`"
                  aria-label="Zoom out"
                  @click="stepPdfZoom(-1)"
                >
                  <svg
                    viewBox="0 0 24 24"
                    class="h-3.5 w-3.5"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    aria-hidden="true"
                  >
                    <path d="M5 12h14" />
                  </svg>
                </button>
                <span
                  class="w-9 shrink-0 text-center tabular-nums"
                  :title="PDF_ZOOM_TOOLTIP"
                  >{{ pdfZoomLabel }}</span
                >
                <button
                  type="button"
                  class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim transition-colors hover:bg-hover hover:text-fg disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
                  :disabled="pdfZoomAtMax"
                  :title="`Zoom in (${PDF_ZOOM_IN_KEY})`"
                  aria-label="Zoom in"
                  @click="stepPdfZoom(1)"
                >
                  <svg
                    viewBox="0 0 24 24"
                    class="h-3.5 w-3.5"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    aria-hidden="true"
                  >
                    <path d="M12 5v14" />
                    <path d="M5 12h14" />
                  </svg>
                </button>
              </div>
            </div>
          </div>

          <img
            v-else-if="showStageImage"
            ref="stageMedia"
            :src="stageFrame ?? undefined"
            alt=""
            draggable="false"
            class="h-full w-full origin-top-left object-contain"
            :class="stageState === 'ready' ? '' : 'invisible'"
            @load="onStageShown"
            @dblclick="onStageMediaDblclick"
            @error="onStageError"
          />

          <!-- A model is drawn into a canvas rather than handed to a media
               element, so the wrapper is what the reveal measures and moves —
               exactly as a still's own element is. The viewer's first frame is
               what reports `ready`, which is what reveals the display. -->
          <div
            v-else-if="
              stageModel && shownStage?.target.kind === 'model' && stageState !== 'failed'
            "
            ref="stageMedia"
            class="relative h-full w-full origin-top-left"
            :class="stageState === 'ready' ? '' : 'invisible'"
            @dblclick="onStageMediaDblclick"
          >
            <ModelViewer
              :key="previewKeyFor(shownStage?.target ?? null) ?? undefined"
              :format="stageModel.format"
              :bytes="stageModel.bytes"
              interactive
              @ready="onStageShown"
              @error="onStageError"
            />
          </div>

          <!-- The play/pause or seek feedback for the clip being displayed —
               over the picture, and never a click of its own. -->
          <PlaybackOsd
            v-if="stageOsd"
            :key="stageOsd.id"
            :osd="stageOsd"
            @done="stageOsd = null"
          />

          <span
            v-if="stageState === 'loading'"
            class="absolute h-5 w-5 animate-spin rounded-full border-2 border-fg border-t-transparent"
          />
        </div>
      </div>

      <!-- The row the cursor is on has nothing to show: what this pane is, and
           how to leave it — an empty blurred pane should not read as a fault. -->
      <div
        v-else
        class="flex min-h-0 grow flex-col items-center justify-center gap-1 p-3 text-center"
      >
        <span class="text-ui text-fg">Preview mode</span>
        <span class="text-ui-sm text-fg-dim">Esc or right-click to exit</span>
      </div>
    </div>

    <!-- The right button held on a row, with nothing decided yet: the ring fills
         over the rest of the hold, and what the hold is waiting for depends on
         how it ends — the menu, or the paint of a drag (see `HoldGesture`). It is
         drawn in the pane rather than in the app because the gesture is the
         pane's, and `fixed` because the pointer it is a badge on knows nothing
         about panes. -->
    <HoldRing
      v-if="holdHint"
      :x="holdHint.x"
      :y="holdHint.y"
      :duration="HOLD_FILL_MS"
    />
  </section>
</template>
