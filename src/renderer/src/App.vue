<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import FilePanel from '@renderer/components/FilePanel.vue'
import ConfirmTransfer from '@renderer/components/ConfirmTransfer.vue'
import ConfirmMkdir from '@renderer/components/ConfirmMkdir.vue'
import ConfirmDelete from '@renderer/components/ConfirmDelete.vue'
import ConfirmDiscard from '@renderer/components/ConfirmDiscard.vue'
import TerminalPane from '@renderer/components/TerminalPane.vue'
import WorkspaceTabs from '@renderer/components/WorkspaceTabs.vue'
import TitleBar from '@renderer/components/TitleBar.vue'
import FileViewer from '@renderer/components/FileViewer.vue'
import PaneContextMenu from '@renderer/components/PaneContextMenu.vue'
import { loadHideMode, hideMode, toggleHideMode } from '@renderer/composables/useHideMode'
import { createWorkspace, type Workspace } from '@renderer/composables/useWorkspace'
import type { PaneController, PaneEntry } from '@renderer/composables/useDirectory'
import {
  loadTranscodeSupport,
  previewKeyFor,
  previewTargetFor,
  type PlaybackClock,
  type StageRequest
} from '@renderer/lib/preview'
import type { PaneMenuChoice, PaneMenuItem, PaneMenuRequest } from '@renderer/lib/paneMenu'
import { HIDE_MARKER } from '@shared/hide'
import { playSwapAnimation } from '@renderer/lib/swapAnimation'
import type { FileContent, FsError, PanelSide } from '@shared/types'

/**
 * The app is a stack of workspaces — one tab each. A workspace owns its own
 * pair of file panes and its own shell, so switching tabs switches sessions
 * rather than just moving the cursor. Only the active workspace is rendered;
 * the others keep their state in their controllers and shells, and their
 * terminal view is recreated (replaying the session buffer) when they come
 * back, exactly as a reload does.
 */
let workspaceSeq = 0

/**
 * The exit-watch stops, one per workspace. The watch cannot live in the
 * workspace's own effect scope: answering a dead shell is the app's job — it is
 * the app that owns the tab strip the tab has to leave — so it is created here
 * and stopped here.
 */
const exitStops = new Map<Workspace, () => void>()

function makeWorkspace(): Workspace {
  workspaceSeq += 1
  const workspace = createWorkspace(`ws-${workspaceSeq}`, `Terminal ${workspaceSeq}`)

  // Watched per workspace, not just the active one: a shell that ends while its
  // tab is in the background must not be found dead only once it is revisited.
  exitStops.set(
    workspace,
    watch(workspace.shell.exitCode, (code) => {
      if (code !== null) closeExitedWorkspace(workspace)
    })
  )

  return workspace
}

const workspaces = shallowRef<Workspace[]>([makeWorkspace()])
const activeIndex = ref(0)

/** Retire a workspace: stop watching its shell, then tear it down. */
function releaseWorkspace(workspace: Workspace): void {
  exitStops.get(workspace)?.()
  exitStops.delete(workspace)
  workspace.dispose()
}

const activeWorkspace = computed(() => workspaces.value[activeIndex.value] ?? workspaces.value[0]!)

/**
 * The active workspace's bindings, surfaced as plain computeds so the rest of
 * the component (and the template) reads them the way the old single-workspace
 * code did. They re-evaluate when the active workspace, or one of its refs,
 * changes. `left` and `right` are the two panes themselves rather than the
 * columns they are drawn in: a Ctrl+U exchange does not re-bind them, it only
 * asks for them to be drawn in the other order (`columnsSwapped`).
 */
const left = computed(() => activeWorkspace.value.left.value)
const right = computed(() => activeWorkspace.value.right.value)
const activeSide = computed(() => activeWorkspace.value.activeSide.value)
const columnsSwapped = computed(() => activeWorkspace.value.columnsSwapped.value)
const activePane = computed(() => activeWorkspace.value.activePane.value)
const inactivePane = computed(() => activeWorkspace.value.inactivePane.value)
const activePanePath = computed(() => activeWorkspace.value.activePanePath.value)
const terminalExpanded = computed(() => activeWorkspace.value.terminalExpanded.value)
const terminalFocused = computed(() => activeWorkspace.value.terminalFocused.value)
const shell = computed(() => activeWorkspace.value.shell)
const shellInput = computed(() => shell.value.inputLine.value)

/**
 * The file shown in the Monaco viewer, or null when it is closed. The viewer is
 * an overlay over the panes and terminal, so a non-null value is what "the
 * viewer is open" means — exactly like the staged dialogs below. `viewerMode`
 * is whether it was opened read-only (F3) or for editing (F4).
 *
 * The read is done before the viewer is opened, so a file the editor could
 * never show — a binary, or one that is not a regular file — is answered by the
 * pane's own notice instead of an overlay the user has to dismiss; the viewer is
 * opened only for content that can be displayed, and is handed what was read
 * rather than reading it again.
 */
const viewerPath = ref<string | null>(null)
const viewerMode = ref<'view' | 'edit'>('view')
const viewerContent = ref<FileContent | null>(null)
const viewerRef = ref<InstanceType<typeof FileViewer> | null>(null)

/**
 * Whether the viewer is being closed with unsaved edits. Closing a dirty buffer
 * stages this dialog instead of discarding outright, so the app confirms with
 * its own popup the way the copy and delete dialogs do rather than handing the
 * question to an OS window. The name shown is the viewer's own file.
 */
const discardOpen = ref(false)
const viewerName = computed(() => (viewerPath.value === null ? '' : baseName(viewerPath.value)))

/**
 * F8 never deletes on its own: it stages the pane's targets here and the
 * dialog confirms them. A non-empty list is what "the dialog is open" means.
 */
const deleteTargets = ref<PaneEntry[]>([])

/**
 * F5 stages the active pane's targets and the other pane's directory here. Like
 * the delete dialog, a non-null value is what "the copy dialog is open" means.
 * The destination is only the field's initial value: the dialog can edit it,
 * and whatever it emits on confirm is what is copied.
 */
const copyJob = ref<{ entries: PaneEntry[]; destination: string } | null>(null)

/**
 * F6 stages the same thing for a move: the active pane's targets and the other
 * pane's directory, which the dialog can edit before confirming.
 */
const moveJob = ref<{ entries: PaneEntry[]; destination: string } | null>(null)

/**
 * F7 stages the name of a directory to make in the active pane. Like the other
 * dialogs, a true value is what "the dialog is open" means — the pane being
 * browsed is `activePane`, which cannot change while the dialog holds the
 * keyboard, so it is read when the name is confirmed rather than captured.
 */
const mkdirOpen = ref(false)

/**
 * The pane that is displaying another pane's media, or null when none is. Enter
 * on an image or a video puts the app in this mode: the cursor stays where it
 * is — in the pane that asked — and the *other* pane becomes a display for
 * whatever that cursor is on, following it from row to row until Escape.
 */
const stageSide = ref<PanelSide | null>(null)

/**
 * Whether the display fills the whole window rather than the pane it belongs to
 * — the full-screen viewing mode, which Ctrl+Enter and a triple-click on a
 * media file's name open. It is the *same* display, presented over everything
 * (the tab strip, both panes and the terminal) instead of in one pane: the pane
 * that asked goes on driving it, so the arrow keys still browse the folder and
 * the media follows the cursor as before.
 */
const stageFullscreen = ref(false)

/** The pane being navigated while a display is up: always the one that asked for it. */
const stageSource = computed<PanelSide | null>(() =>
  stageSide.value === null ? null : stageSide.value === 'left' ? 'right' : 'left'
)

/**
 * The media the display is showing, derived from the source pane's cursor — so
 * navigating updates it without anything having to be told, and leaving media
 * for an ordinary file empties the display rather than freezing the last one.
 */
const stageTarget = computed(() => {
  const side = stageSource.value
  if (side === null) return null
  return previewTargetFor((side === 'left' ? left.value : right.value).current())
})

/**
 * The reveal is for arriving in the mode, not for every row the cursor crosses
 * while one is up: this counts the times a display is asked for, so that the
 * media growing out of its thumbnail is the gesture of entering the mode — and
 * of the cursor coming back onto a file that has something to show, where
 * nothing grew out of a thumbnail in the first place.
 */
const stageAnimation = ref(0)

watch(stageSide, (side) => {
  if (side !== null) stageAnimation.value += 1
})

const leftPanel = ref<InstanceType<typeof FilePanel> | null>(null)
const rightPanel = ref<InstanceType<typeof FilePanel> | null>(null)

/**
 * What the displaying pane is asked to show. It reaches back through the source
 * pane's own footer box at the moment it is about to be revealed, rather than
 * holding a rectangle that would be stale as soon as the cursor moved.
 */
const stageRequest = computed<StageRequest | null>(() => {
  const target = stageTarget.value
  const side = stageSource.value
  if (target === null || side === null) return null

  const asking = side === 'left' ? leftPanel : rightPanel
  const held = stageResume.value

  return {
    target,
    animation: stageAnimation.value,
    resumeAt: held !== null && held.key === previewKeyFor(target) ? held.time : null,
    from: () => asking.value?.previewRect() ?? null,
    barFrom: () => asking.value?.previewBarRect() ?? null
  }
})

/**
 * Where the enlarged clip has got to, as the display reports it. The pane that
 * asked for the display no longer plays that clip itself, so this is what its
 * play bar is drawn from.
 */
const displayedClock = ref<PlaybackClock | null>(null)

/**
 * The pane whose cursor media a display has taken over: it is the one being
 * navigated, and the one that gives up its own copy of the clip.
 */
const transferredSide = computed<PanelSide | null>(() =>
  stageSide.value === null ? null : stageSource.value
)

/**
 * Where the clip was playing in the pane that asked for the display, taken when
 * it asked. It has to be taken *then* rather than read later: the ask is what
 * takes the element that was playing it away.
 */
const stageResume = ref<{ key: string; time: number } | null>(null)

/**
 * A position belongs to the clip it was taken from and to the request that took
 * it: once the display has moved on to another clip, it is not carried back.
 */
watch(stageTarget, (target) => {
  const held = stageResume.value
  if (held !== null && previewKeyFor(target) !== held.key) stageResume.value = null
})

/**
 * Open the row under `side`'s cursor — Enter, and a double-click on the row. An
 * image or a video is displayed in the *other* pane rather than handed to
 * whatever the system opens it with; anything else — a directory, an ordinary
 * file — opens exactly as it did.
 *
 * `again` is Enter's own extra: pressed once more on what a display is already
 * showing, it takes the display away. A double-click only ever asks for one,
 * since leaving the mode has gestures of its own (Escape, and a right-click on
 * the pane showing it).
 */
function activateRow(side: PanelSide, again: boolean): void {
  const pane = side === 'left' ? left.value : right.value

  if (previewTargetFor(pane.current()) === null) {
    void pane.activate()
    return
  }

  if (!again) {
    showStage(side)
    return
  }

  if (stageSide.value !== null) exitStage()
  else showStage(side)
}

/**
 * Step the pane a display is showing for, by `delta` rows — the wheel in the
 * display, outside the media it is showing. The display follows the cursor it is
 * showing for on its own, so this is the whole of it: a way of flicking through a
 * folder without leaving the mode, or taking a hand off the keyboard.
 */
function stepShownPane(delta: number): void {
  const side = stageSource.value
  if (side === null) return

  const pane = side === 'left' ? left.value : right.value
  pane.moveCursor(delta)
}

/**
 * Put `side`'s preview up in the other pane — clicking its thumbnail, or
 * double-clicking the row, the mouse's ways of the gesture Enter makes. Only ever
 * turns the display on: one already up is left alone, since leaving the mode has
 * its own gestures (Escape, or a right-click on the pane showing it).
 */
function showStage(side: PanelSide): void {
  if (stageSide.value !== null) return

  const asking = side === 'left' ? leftPanel : rightPanel
  // Taken before the display exists, because the display is what takes the
  // element that was playing the clip away.
  stageResume.value = asking.value?.previewPosition() ?? null
  stageSide.value = side === 'left' ? 'right' : 'left'
}

function exitStage(): void {
  stageSide.value = null
  stageFullscreen.value = false
  displayedClock.value = null
  stageResume.value = null
}

/**
 * Ctrl+Enter: the full-screen viewing mode. With no display up it starts one on
 * the row under the cursor and opens it over the whole window; with a display
 * already up — in a pane, or full screen — it toggles the presentation, so
 * Enter and then Ctrl+Enter is the natural "bigger". Escape (and a right-click
 * on the display) still leaves the mode outright.
 *
 * Nothing happens on a row there is nothing to show for while no display is up:
 * the gesture belongs to media, and an ordinary file or a directory is not one
 * to fill a screen with.
 */
function toggleFullscreen(side: PanelSide): void {
  if (stageSide.value === null) {
    const pane = side === 'left' ? left.value : right.value
    if (previewTargetFor(pane.current()) === null) return
    showStage(side)
  }

  stageFullscreen.value = !stageFullscreen.value
}

/**
 * A triple-click on a media file's name: like Ctrl+Enter, but always *into* the
 * full-screen mode rather than a toggle — the mouse gesture means "view this
 * big", so a display that is already up is enlarged rather than shrunk. The
 * double-click that came before it has already asked for the pane display, so
 * this only ever confirms the last step of the escalation.
 */
function openFullscreen(side: PanelSide): void {
  if (stageSide.value === null) {
    const pane = side === 'left' ? left.value : right.value
    if (previewTargetFor(pane.current()) === null) return
    showStage(side)
  }

  stageFullscreen.value = true
}

/**
 * A double left-click on the video being displayed: the same switch Ctrl+Enter
 * makes, but made on the picture itself — the pane and the whole window trade
 * places. It only ever arrives from a display that is already up, so there is
 * nothing to start; a double-click is not a way into the mode.
 */
function toggleDisplayFullscreen(): void {
  if (stageSide.value === null) return
  stageFullscreen.value = !stageFullscreen.value
}

/**
 * How far the arrow keys step through a clip while the command line is empty.
 */
const SEEK_SECONDS = 10

/**
 * How far the coarser playback keys step: Ctrl+J/Ctrl+L a minute back and
 * forward, Ctrl+H/Ctrl+; ten. Keyed by the lower-cased `event.key` that fires
 * each, so `;` needs no special case.
 */
const SEEK_STEPS: Readonly<Record<string, number>> = {
  j: -60,
  l: 60,
  h: -600,
  ';': 600
}

/**
 * Step through the clip being previewed: the one under the cursor of the pane
 * being navigated, and — when a display is up — the same clip as the other pane
 * is showing, so the two never drift apart.
 */
function seekPreview(delta: number): void {
  const active = activeSide.value === 'left' ? leftPanel : rightPanel
  active.value?.seekPreview(delta)

  if (stageSide.value === null) return
  const showing = stageSide.value === 'left' ? leftPanel : rightPanel
  showing.value?.seekStage(delta)
}

/**
 * Pause or resume the clip being watched: the display's when one is up, since
 * its pane no longer plays a copy of its own, and the footer's otherwise.
 * Answers whether there was a clip to toggle, so Space can stay the shell's
 * space when there is nothing to pause.
 */
function togglePlayback(): boolean {
  if (stageSide.value !== null) {
    const showing = stageSide.value === 'left' ? leftPanel : rightPanel
    return showing.value?.toggleStagePlayback() ?? false
  }

  const active = activeSide.value === 'left' ? leftPanel : rightPanel
  return active.value?.togglePreviewPlayback() ?? false
}

const panelHost = ref<HTMLElement | null>(null)
const terminalRef = ref<InstanceType<typeof TerminalPane> | null>(null)

/**
 * Where the two panes meet, as the left pane's share of the row. The line
 * between them is a handle rather than a fixed border, so dragging it moves the
 * boundary; it belongs to the window's layout and not to a workspace, so it
 * survives a tab switch like the title bar does. Both panes are `flex-1` (an
 * equal basis of zero), so weighting their grow is the whole of the sizing.
 */
const DEFAULT_SPLIT = 0.5

/** Keep a sliver of either pane, so the handle can always be found again. */
const MIN_SPLIT = 0.15
const MAX_SPLIT = 0.85

/** A drag that ends this near the middle reads as centred, so the handle snaps. */
const SPLIT_SNAP = 0.02

const splitRatio = ref(DEFAULT_SPLIT)

/** Off-centre is what puts the re-centre button on the handle. */
const splitCentered = computed(() => splitRatio.value === DEFAULT_SPLIT)

/**
 * Where each pane sits in the row. A Ctrl+U exchange is drawn by reordering the
 * two rather than by rebuilding either (see `swapPanels` in `useWorkspace.ts`),
 * so this is the whole of it: `order` moves the boxes, and the growth is given
 * to whichever pane is drawn on the left so that it is the *columns* that keep
 * the sizes they had — the divider stays where the user put it.
 */
const leftPaneStyle = computed(() => ({
  order: columnsSwapped.value ? 2 : 0,
  flexGrow: columnsSwapped.value ? 1 - splitRatio.value : splitRatio.value
}))

const rightPaneStyle = computed(() => ({
  order: columnsSwapped.value ? 0 : 2,
  flexGrow: columnsSwapped.value ? splitRatio.value : 1 - splitRatio.value
}))

function clampSplit(ratio: number): number {
  return Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, ratio))
}

function centerSplit(): void {
  splitRatio.value = DEFAULT_SPLIT
}

/**
 * Drag the boundary. The move is measured against the row's width rather than
 * the pane's, so the handle keeps up with the pointer wherever the split
 * currently is. The listeners are on the window, not the handle: the pointer
 * leaves a one-pixel line immediately, and it is the drag — not the element —
 * that owns the gesture until the button is released.
 */
function startSplitDrag(event: PointerEvent): void {
  if (event.button !== 0) return
  const host = panelHost.value
  if (!host) return
  const span = host.getBoundingClientRect().width
  if (span <= 0) return

  event.preventDefault()
  const startX = event.clientX
  const startRatio = splitRatio.value

  const move = (moveEvent: PointerEvent): void => {
    const ratio = clampSplit(startRatio + (moveEvent.clientX - startX) / span)
    splitRatio.value = Math.abs(ratio - DEFAULT_SPLIT) <= SPLIT_SNAP ? DEFAULT_SPLIT : ratio
  }

  const finish = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', finish)
    window.removeEventListener('pointercancel', finish)
    document.body.style.cursor = ''
  }

  document.body.style.cursor = 'col-resize'
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', finish)
  window.addEventListener('pointercancel', finish)
}

function setActive(side: PanelSide): void {
  activeWorkspace.value.activeSide.value = side
}

function swapPanels(): void {
  const host = panelHost.value
  const leftPane = leftPanel.value?.$el as HTMLElement | undefined
  const rightPane = rightPanel.value?.$el as HTMLElement | undefined

  if (!host || !leftPane || !rightPane) {
    activeWorkspace.value.swapPanels()
    return
  }

  playSwapAnimation({
    host,
    left: leftPane,
    right: rightPane,
    contents: [leftPanel.value?.contentEl() ?? null, rightPanel.value?.contentEl() ?? null],
    apply: () => activeWorkspace.value.swapPanels()
  })
}

function setTerminalFocused(value: boolean): void {
  activeWorkspace.value.terminalFocused.value = value
}

/**
 * Collapsed, the strip is the command line and holds focus so typing reaches
 * the shell. Expanded, it is a real terminal and owns the keyboard outright.
 */
function focusPanes(): void {
  if (terminalExpanded.value) {
    panelHost.value?.focus()
    return
  }
  terminalRef.value?.focusTerminal()
}

/**
 * Whether the element holding focus belongs to nothing the app cares about: the
 * document body, which is where a click on non-focusable chrome (the title bar,
 * a pane border, a footer strip) leaves it, or the panel host once the terminal
 * is collapsed and the command line is the default target again.
 */
function focusIsUnclaimed(): boolean {
  const active = document.activeElement
  if (!active || active === document.body) return true
  return active === panelHost.value && !terminalExpanded.value
}

/**
 * The command line is the app's default focus target, but DOM focus can fall to
 * an unclaimed element and stay there: clicking non-interactive chrome moves it
 * to `<body>`, and when the window manager reactivates the window with a click
 * it consumed for activation, nothing inside the app ever learns it happened.
 * The command line then renders its hollow, unfocused cursor and typing has
 * nowhere to go — the state a user can only escape by toggling the terminal,
 * which re-runs the focus path.
 *
 * Re-assert the focus model whenever focus lands on an unclaimed element.
 * Anything that legitimately owns the keyboard — the terminal, the search box,
 * a rename, the viewer, a dialog — is the active element, so it is never
 * disturbed, and the viewer and dialogs are excluded outright.
 */
function restoreFocus(): void {
  if (viewerPath.value !== null) return
  if (paneMenu.value !== null) return
  if (
    deleteTargets.value.length > 0 ||
    copyJob.value !== null ||
    moveJob.value !== null ||
    mkdirOpen.value
  ) {
    return
  }
  if (!focusIsUnclaimed()) return
  focusPanes()
}

// A focus change is one synchronous burst, so the check is deferred a macrotask:
// by then a real new target has taken focus and only a genuine drop is restored.
function onFocusDrop(): void {
  window.setTimeout(restoreFocus, 0)
}

function toggleTerminal(): void {
  if (terminalExpanded.value) {
    collapseTerminal()
    return
  }
  activeWorkspace.value.terminalExpanded.value = true
}

function collapseTerminal(): void {
  activeWorkspace.value.terminalExpanded.value = false
  void nextTick(() => terminalRef.value?.focusTerminal())
}

function toggleSearch(): void {
  const pane = activePane.value
  if (pane.state.searchActive) pane.closeSearch()
  else pane.openSearch()
}

/**
 * Quote one word for the shell the command line runs on. The value is pasted
 * as a literal argument, so anything with a space or a character the shell
 * would act on is wrapped in single quotes (with a quote inside it escaped the
 * usual way); plain filenames are left alone so an ordinary path reads as it
 * was typed.
 */
function shellQuote(text: string): string {
  if (text.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text
  return `'${text.replace(/'/g, `'\\''`)}'`
}

/**
 * A directory path closed with its separator (`/home/laci/`). The root is
 * already closed, so it is left alone rather than doubled.
 */
function closeDirectory(dir: string): string {
  return /[/\\]$/.test(dir) ? dir : `${dir}/`
}

/**
 * Alt+Enter puts the entry under the cursor on the command line, followed by a
 * space, and Alt+A the directory holding it, closed with a separator. Both are
 * typed into the shell's own line (the collapsed strip), exactly as if the user
 * had typed them, so the shell's echo, history and editing keys all see a real
 * line rather than a value set behind its back. The trailing space after a
 * pasted name is what lets the next argument be typed straight away, without
 * the user first reaching past the end of the name to separate it.
 *
 * The directory rather than the entry's own path, because the line is where a
 * command is typed and a folder is what a command is usually handed: the
 * cursor on a file is a way of saying where that file lives. The closing
 * separator is what keeps a pasted path a folder — the shell reads a path
 * closed this way as one it can go on completing *inside*, while the same path
 * bare could be taken for the entry itself and leave Tab nothing to offer.
 * The directory is the pane's own (the resolved one the entries were listed
 * from), so the entry's path only differs from it by the name.
 */
function pasteEntryName(): void {
  const entry = activePane.value.current()
  if (!entry || entry.isParent) return
  shell.value.sendInput(`${shellQuote(entry.name)} `)
}

function pasteEntryPath(): void {
  const entry = activePane.value.current()
  if (!entry || entry.isParent) return
  shell.value.sendInput(shellQuote(closeDirectory(activePane.value.state.path)))
}

/**
 * Workspace tabs. Ctrl+T opens a new terminal — a fresh pair of panes at home
 * plus a new shell — at the right of the strip and focuses it; Ctrl+W closes
 * the active one; Ctrl+PageDown / Ctrl+PageUp step to the next and previous
 * tab. The last workspace is never closed, so the app always has somewhere to
 * be.
 */
function addWorkspace(): void {
  exitStage()
  const workspace = makeWorkspace()
  workspaces.value = [...workspaces.value, workspace]
  activeIndex.value = workspaces.value.length - 1
  void workspace.init()
  void nextTick(() => focusPanes())
}

function selectWorkspace(index: number): void {
  if (index === activeIndex.value) {
    toggleTerminal()
    return
  }
  exitStage()
  activeIndex.value = index
  void nextTick(() => focusPanes())
}

function closeWorkspace(index: number): void {
  if (workspaces.value.length <= 1) return
  exitStage()
  const workspace = workspaces.value[index]
  if (!workspace) return

  const next = workspaces.value.filter((_, i) => i !== index)
  workspaces.value = next

  if (index < activeIndex.value) activeIndex.value -= 1
  else if (index === activeIndex.value) activeIndex.value = Math.min(index, next.length - 1)

  releaseWorkspace(workspace)
  void nextTick(() => focusPanes())
}

/**
 * A shell the user ended — `exit`, or Ctrl+D — takes its own tab with it: the
 * tab *is* that terminal, and a prompt-less session leaves the command line
 * useless. Unlike Ctrl+W the last tab is not spared: it is replaced by a fresh
 * workspace, so the app is never left with nothing but a dead terminal to come
 * back to.
 */
function closeExitedWorkspace(workspace: Workspace): void {
  const index = workspaces.value.indexOf(workspace)
  if (index === -1) return

  exitStage()
  const remaining = workspaces.value.filter((_, i) => i !== index)

  if (remaining.length === 0) {
    const fresh = makeWorkspace()
    workspaces.value = [fresh]
    activeIndex.value = 0
    void fresh.init()
  } else {
    workspaces.value = remaining
    if (index < activeIndex.value) activeIndex.value -= 1
    else if (index === activeIndex.value)
      activeIndex.value = Math.min(index, remaining.length - 1)
  }

  releaseWorkspace(workspace)
  void nextTick(() => focusPanes())
}

function switchWorkspace(delta: number): void {
  const count = workspaces.value.length
  if (count <= 1) return
  exitStage()
  activeIndex.value = (activeIndex.value + delta + count) % count
  void nextTick(() => focusPanes())
}

/**
 * Move a tab to another position in the strip, keeping it active. The list is a
 * shallowRef, so a splice has to go through a fresh array for the change to be
 * seen. Used by both Shift+Ctrl+PageUp/PageDown and drag-and-drop.
 */
function moveWorkspace(from: number, to: number): void {
  const count = workspaces.value.length
  if (from === to || from < 0 || from >= count || to < 0 || to >= count) return
  const next = [...workspaces.value]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved!)
  workspaces.value = next
  activeIndex.value = to
  void nextTick(() => focusPanes())
}

/**
 * The pending viewer read, so a stale one cannot open the viewer over a newer
 * request. Incremented when one starts, and when the viewer is closed.
 */
let viewerRequest = 0

/**
 * The last segment of a path. The renderer has no `node:path`, and the notice a
 * refused open leaves only needs the name to point at.
 */
function baseName(target: string): string {
  const slash = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'))
  return slash >= 0 ? target.slice(slash + 1) : target
}

/**
 * What the pane says when a file cannot be opened in the viewer. A binary file
 * is the one refusal worth explaining rather than quoting: the code and main's
 * diagnostic (`EBINARY: "x" looks binary`) say what the machine found, not what
 * the user asked for and did not get.
 */
function viewerRefusal(target: string, mode: 'view' | 'edit', error: FsError): string {
  if (error.code === 'EBINARY') {
    const wanted = mode === 'edit' ? 'editing' : 'viewing'
    return `"${baseName(target)}" looks binary — cannot be opened for ${wanted}`
  }
  return `${error.code}: ${error.message}`
}

/**
 * F3 opens a regular file read-only in the Monaco viewer, F4 opens it for
 * editing. Directories keep their previous F3 meaning (descend), and anything
 * that is not a regular file — a socket, FIFO or device — is left alone rather
 * than fed to a text editor.
 *
 * The read happens first, so what the editor cannot show is never opened at all:
 * a binary file (main refuses it) or a read that fails is reported in the pane's
 * own notice, the way a failed copy is, instead of an overlay whose only content
 * is that message. Escape dismisses that notice.
 */
async function openViewer(
  pane: PaneController,
  target: string,
  mode: 'view' | 'edit'
): Promise<void> {
  // A read is async, so the cursor can move — and another F3/F4 can start —
  // while this one is in flight. The token keeps a stale read from opening the
  // viewer over a newer request.
  const request = (viewerRequest += 1)

  const result = await window.mc.fs.read(target)
  if (request !== viewerRequest) return

  if (!result.ok) {
    pane.state.error = viewerRefusal(target, mode, result.error)
    return
  }

  pane.state.error = null
  discardOpen.value = false
  viewerContent.value = result.data
  viewerMode.value = mode
  viewerPath.value = target
}

/**
 * Closing a viewer with unsaved edits stages the app's own discard dialog; the
 * viewer is the only thing that knows whether the buffer is dirty, so it is
 * asked rather than the close being decided here.
 */
function closeViewer(): void {
  if (viewerRef.value?.isDirty()) {
    discardOpen.value = true
    return
  }
  dismissViewer()
}

/** Close the viewer outright — the confirmed discard, or a clean buffer. */
function dismissViewer(): void {
  discardOpen.value = false
  viewerRequest += 1
  viewerPath.value = null
  viewerContent.value = null
  focusPanes()
}

/** Cancel the discard: the buffer is untouched, so the editor takes focus back. */
function cancelDiscard(): void {
  discardOpen.value = false
  viewerRef.value?.focusEditor()
}

function requestDelete(): void {
  // Capture the targets now: the pane can refresh under the dialog, but what is
  // shown (and what is deleted on confirm) must be what was highlighted.
  const targets = activePane.value.deletionTargets()
  if (targets.length === 0) return
  deleteTargets.value = targets
}

function cancelDelete(): void {
  deleteTargets.value = []
  focusPanes()
}

async function confirmDelete(): Promise<void> {
  const pane = activePane.value
  deleteTargets.value = []
  await pane.deleteEntries()
  focusPanes()
}

/**
 * F5 copies into the other pane, so the source is the active pane and the
 * destination is the inactive one. Capture both now: the dialog is modal, but
 * the panes can still refresh under it.
 */
function requestCopy(): void {
  const targets = activePane.value.selectionTargets()
  const destination = inactivePane.value.state.path
  if (targets.length === 0 || !destination) return
  copyJob.value = { entries: targets, destination }
}

function cancelCopy(): void {
  copyJob.value = null
  focusPanes()
}

/**
 * The panes a transfer's new entries can appear in. The target always gains
 * them; the source does too when the destination field names something main
 * will resolve inside it — a relative path like `sub` becomes `<source>/sub`,
 * so a folder appears in the source pane. Both are marked as making the change
 * themselves, so neither sweeps what the user just copied or moved in.
 */
function transferPanes(
  source: PaneController,
  target: PaneController,
  destination: string
): PaneController[] {
  return destination.startsWith('/') ? [target] : [source, target]
}

async function confirmCopy(destination: string): Promise<void> {
  const source = activePane.value
  const target = inactivePane.value
  copyJob.value = null

  const panes = transferPanes(source, target, destination)
  for (const pane of panes) pane.beginSelfChange()
  try {
    // The handler resolves a relative destination against the source pane, so
    // the resolved directory is what a pane showing it must be compared against.
    const resolved = await source.copyEntries(destination)
    if (resolved && target.state.path === resolved) await target.refresh()
  } finally {
    for (const pane of panes) pane.endSelfChange()
  }
  focusPanes()
}

/**
 * F6 moves into the other pane, mirroring F5: the source is the active pane and
 * the destination is the inactive one. Capture both now, since the dialog is
 * modal but the panes can still refresh under it.
 */
function requestMove(): void {
  const targets = activePane.value.selectionTargets()
  const destination = inactivePane.value.state.path
  if (targets.length === 0 || !destination) return
  moveJob.value = { entries: targets, destination }
}

function cancelMove(): void {
  moveJob.value = null
  focusPanes()
}

async function confirmMove(destination: string): Promise<void> {
  const source = activePane.value
  const target = inactivePane.value
  moveJob.value = null

  const panes = transferPanes(source, target, destination)
  for (const pane of panes) pane.beginSelfChange()
  try {
    const resolved = await source.moveEntries(destination)
    if (resolved && target.state.path === resolved) await target.refresh()
  } finally {
    for (const pane of panes) pane.endSelfChange()
  }
  focusPanes()
}

/**
 * F7 stages the create-directory dialog for the active pane. The pane itself is
 * read when the name is confirmed, since the dialog only asks for the name.
 */
function requestMkdir(): void {
  if (!activePane.value.state.path) return
  mkdirOpen.value = true
}

function cancelMkdir(): void {
  mkdirOpen.value = false
  focusPanes()
}

/**
 * Make the directory the dialog named. The folder appears in every pane showing
 * the directory it was made in — both panes can show one — and it is the user's
 * own `mkdir`, so none of them sweeps it: they are told the change is the app's
 * own for its length, exactly as a hide-list write is (`hideEntry`). The pane
 * re-lists and lands its cursor on the new folder.
 */
async function confirmMkdir(name: string): Promise<void> {
  const pane = activePane.value
  mkdirOpen.value = false

  const showing = [left.value, right.value].filter((other) => other.state.path === pane.state.path)
  for (const other of showing) other.beginSelfChange()
  try {
    await pane.createDirectory(name)
  } finally {
    for (const other of showing) other.endSelfChange()
  }
  focusPanes()
}

watch(
  () => left.value.state.searchActive || right.value.state.searchActive,
  (anyActive, wasActive) => {
    if (!wasActive || anyActive) return
    if (!terminalExpanded.value) terminalRef.value?.focusTerminal()
  }
)

/**
 * The pane menu, while one is up: what it is about, and where. The row is
 * captured as the delete and copy dialogs capture their targets — the panes go on
 * watching their directories, and a refresh under the menu must not change what
 * its items say they will act on.
 */
const paneMenu = ref<{ side: PanelSide; target: PaneEntry; x: number; y: number } | null>(null)

/** The menu as a component, for the one question the app has to ask it: whose key is this. */
const paneMenuRef = ref<InstanceType<typeof PaneContextMenu> | null>(null)

function paneOf(side: PanelSide): PaneController {
  return side === 'left' ? left.value : right.value
}

/**
 * Open the menu for one of `side`'s rows, at a point in client coordinates. The
 * cursor moves to that row first, because the items are the keys' own operations —
 * `F5`, `F8`, `F3` — and those act on the cursor or on the marks, so the row the
 * menu is *about* has to be the row they would act on. A menu that opened on one
 * file and deleted another would be a trap rather than a shortcut.
 */
function openPaneMenu(side: PanelSide, request: PaneMenuRequest): void {
  const pane = paneOf(side)
  const index = pane.state.entries.findIndex((row) => row.path === request.path)
  const target = pane.state.entries[index]
  if (!target || target.isParent) return

  setActive(side)
  pane.moveTo(index)
  paneMenu.value = { side, target, x: request.x, y: request.y }
}

function closePaneMenu(): void {
  if (paneMenu.value === null) return
  paneMenu.value = null
  focusPanes()
}

/**
 * A pick: the menu goes first, and the action runs into the focus that gives back,
 * so a dialog or a rename the item starts is free to take the keyboard itself.
 */
function choosePaneMenuItem(choice: PaneMenuChoice): void {
  if (paneMenu.value === null) return
  closePaneMenu()
  choice.run()
}

/**
 * Ask for the menu on the active pane's cursor row — Shift+F10, or the keyboard's
 * own menu key. Nothing is pointed at, so the pane works the anchor out from the
 * row's place in the listing (see `cursorMenuAnchor`).
 */
function requestPaneMenuAtCursor(): void {
  // The full-screen presentation is the one with no listing to point at: the
  // panes are covered by the display, so a menu about a cursor nobody can see is
  // not a thing to offer. A display *in a pane* leaves the asking pane's own
  // listing where it was, and a menu there is that pane's business like any other.
  if (stageFullscreen.value) return

  const side = activeSide.value
  const host = side === 'left' ? leftPanel : rightPanel
  const anchor = host.value?.cursorMenuAnchor() ?? null
  if (anchor === null) return
  openPaneMenu(side, anchor)
}

/**
 * Put the row's name in its folder's `.mchide` file — the menu's answer to "I do
 * not want to keep seeing this one". The mode is switched on with it, because the
 * file only says what to leave out and the mode is what leaves it out: writing a
 * name into a list nothing is applying would read as the item having done
 * nothing. Alt+. is the way back, and the pane's title bar carries the mode's own
 * icon either way.
 */
async function hideEntry(pane: PaneController, entry: PaneEntry): Promise<void> {
  const result = await window.mc.fs.hideAdd(pane.state.path, entry.name)
  if (!result.ok) {
    pane.state.error = `${result.error.code}: ${result.error.message}`
    return
  }

  if (!hideMode.value) await toggleHideMode()

  // The names come from the listing rather than from a read of the file, so the
  // folder has to be listed again for the new one to be in hand. Every pane
  // showing this folder is told the change is the app's own: the watcher reports
  // the write like any other, and a row the user asked to hide must not sweep as
  // though something had happened behind the app's back.
  const showing = [left.value, right.value].filter((other) => other.state.path === pane.state.path)
  for (const other of showing) other.beginSelfChange()
  try {
    await pane.refresh()
  } finally {
    for (const other of showing) other.endSelfChange()
  }
}

/**
 * What the menu offers for the row it was opened on: the operations that are not
 * already one gesture away in the listing itself. Opening the row is deliberately
 * absent — `Enter`, or a double-click on it, is the row's own gesture, and a menu
 * that repeats what the pointer has just done is a longer way to the same place —
 * so what is left is what the listing cannot say with one click: the viewer, the
 * editor, the full-screen mode, the transfers, rename, delete, the mark, and the
 * folder's own hide list. Each item still carries the key that does the same thing
 * without a menu, since being where those are found is half of what the menu is
 * for.
 *
 * The groups are built first and the separators put *between* the ones that came
 * out with something in them: what the menu can offer depends on the row (a folder
 * has no view, edit or full-screen to offer), and a divider with nothing on one
 * side of it is a line the menu has nothing to say.
 */
const paneMenuItems = computed<PaneMenuItem[]>(() => {
  const menu = paneMenu.value
  if (menu === null) return []

  const entry = menu.target
  const pane = paneOf(menu.side)
  const folder = entry.kind === 'directory'
  const media = !folder && previewTargetFor(entry) !== null

  const reading: PaneMenuItem[] = []
  if (!folder) {
    reading.push({
      kind: 'action',
      label: 'View',
      hint: 'F3',
      run: () => void openViewer(pane, entry.path, 'view')
    })
    reading.push({
      kind: 'action',
      label: 'Edit',
      hint: 'F4',
      run: () => void openViewer(pane, entry.path, 'edit')
    })
  }
  if (media) {
    reading.push({
      kind: 'action',
      label: 'Full screen',
      hint: 'Ctrl+Enter',
      run: () => openFullscreen(menu.side)
    })
  }

  const acting: PaneMenuItem[] = [
    { kind: 'action', label: 'Copy to the other pane…', hint: 'F5', run: requestCopy },
    { kind: 'action', label: 'Move to the other pane…', hint: 'F6', run: requestMove },
    { kind: 'action', label: 'Rename', hint: 'Shift+F6', run: () => pane.beginRename() },
    { kind: 'action', label: 'Delete…', hint: 'F8', run: requestDelete }
  ]

  const marked = pane.isSelected(entry)
  const belonging: PaneMenuItem[] = [
    {
      kind: 'action',
      label: marked ? 'Unmark' : 'Mark',
      hint: 'Insert',
      run: () => pane.setSelected(entry.path, !marked)
    }
  ]

  // A folder's list may already cover this name — it is on screen only because
  // the mode is off, and the pane's own title bar says so with its dim icon — in
  // which case there is nothing to add and the item is left out rather than
  // offered as a second write of the same line.
  if (!pane.state.hideNames.has(entry.name)) {
    belonging.push({
      kind: 'action',
      label: `Hide (add to ${HIDE_MARKER})`,
      run: () => void hideEntry(pane, entry)
    })
  }

  const items: PaneMenuItem[] = []
  for (const group of [reading, acting, belonging]) {
    if (group.length === 0) continue
    if (items.length > 0) items.push({ kind: 'separator' })
    items.push(...group)
  }

  return items
})

/**
 * Claim a key for the app. `preventDefault` is not enough on its own: xterm
 * handles keys from a capture listener on its own textarea and does not consult
 * `defaultPrevented`, so without stopping propagation it would also forward the
 * key to the shell (Up recalling history, Home moving the line cursor).
 */
function consume(event: KeyboardEvent): void {
  event.preventDefault()
  event.stopPropagation()
}

function isPlainCtrl(event: KeyboardEvent): boolean {
  return event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey
}

function isCtrlShift(event: KeyboardEvent): boolean {
  return event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey
}

function handlePaneKey(event: KeyboardEvent): void {
  const pane = activePane.value
  const searching = pane.state.searchActive
  const hasInput = shellInput.value.length > 0

  // An in-place rename hands the keyboard to its input, exactly like search:
  // printable characters, Backspace and the arrow keys edit the text, and
  // Enter/Escape are the input's to commit or cancel.
  if (pane.state.renaming !== null) return

  if (event.key === 'Tab') {
    consume(event)
    setActive(activeSide.value === 'left' ? 'right' : 'left')
    return
  }

  // Ctrl+U swaps the panels. It is claimed here rather than beside Ctrl+O and
  // Ctrl+R so that an expanded, focused terminal keeps its own Ctrl+U
  // (kill-line): this function only runs once the terminal has been ruled out
  // as the owner of the keyboard.
  if (
    event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    event.key.toLowerCase() === 'u'
  ) {
    consume(event)
    swapPanels()
    return
  }

  // Ctrl+Enter is the full-screen viewing mode for the row under the cursor —
  // Enter's own "bigger", and the keyboard half of the gesture a triple-click on
  // the name makes with the mouse. It is claimed only with an empty command line
  // and no search box up, like the other media keys: a typed line, or a search
  // in progress, owns its keys.
  if (isPlainCtrl(event) && event.key === 'Enter' && !searching && !hasInput) {
    consume(event)
    toggleFullscreen(activeSide.value)
    return
  }

  // The coarser companions to the ten-second arrows: Ctrl+J/Ctrl+L step the
  // clip being previewed by a minute, Ctrl+H/Ctrl+; by ten. Like the arrows
  // they are the clip's only while the command line has nothing typed in it —
  // Ctrl+H is the line editor's backspace, Ctrl+L clears the terminal screen
  // and Ctrl+J accepts the line — and an expanded, focused terminal never
  // reaches here at all.
  if (isPlainCtrl(event) && !searching && !hasInput) {
    const step = SEEK_STEPS[event.key.toLowerCase()]
    if (step !== undefined) {
      consume(event)
      seekPreview(step)
      return
    }
  }

  if (event.ctrlKey || event.altKey || event.metaKey) return

  // Space is the clip's play/pause while the command line is empty — the
  // display's clip, or the footer preview under the cursor. With nothing to
  // play it stays a space for the shell, so a command can still start with one.
  if (event.key === ' ' && !event.repeat && !searching && !hasInput) {
    if (togglePlayback()) {
      consume(event)
      return
    }
  }

  if (event.key === 'Escape') {
    consume(event)
    if (searching) {
      pane.closeSearch()
      return
    }
    if (hasInput) {
      shell.value.clearInputLine()
      return
    }
    if (terminalExpanded.value) {
      collapseTerminal()
      return
    }
    // The pane's notice is the last thing Escape has to leave: a refused F3/F4
    // (a binary file), a failed copy or a directory that would not list. It
    // stays until dismissed or replaced, and this is the way to put it away.
    if (pane.state.error !== null) pane.state.error = null
    return
  }

  // Backspace belongs to whichever input owns the text — the shell's line
  // editor or the search box. It deliberately does not navigate the panel.
  if (event.key === 'Backspace' || event.key === 'Delete') return

  if (event.repeat && event.key === 'Enter') {
    consume(event)
    return
  }

  switch (event.key) {
    case 'ArrowLeft':
    case 'ArrowRight': {
      // With nothing typed on the command line the arrows have no line to edit,
      // so they step through the clip being previewed instead — back or forward
      // by ten seconds. A typed line, or an open search box, takes them back:
      // there they belong to the text, not to the clip.
      if (searching || hasInput) return
      consume(event)
      seekPreview(event.key === 'ArrowLeft' ? -SEEK_SECONDS : SEEK_SECONDS)
      break
    }
    case 'ArrowDown':
      consume(event)
      pane.moveCursor(1)
      break
    case 'ArrowUp':
      consume(event)
      pane.moveCursor(-1)
      break
    case 'PageDown':
      consume(event)
      pane.movePage(1)
      break
    case 'PageUp':
      consume(event)
      pane.movePage(-1)
      break
    case 'Home':
      consume(event)
      pane.moveTo(0)
      break
    case 'End':
      consume(event)
      pane.moveTo(pane.state.entries.length - 1)
      break
    case 'Insert':
      consume(event)
      pane.toggleSelection()
      break
    case '*': {
      // With nothing typed on the command line the star is "all of this pane":
      // it marks every file — or unmarks them when they are all marked already,
      // so one key answers both — and "file" is every row that is not a folder.
      // A folder is left alone either way, marked by hand when it is wanted,
      // while a symlink counts even when it dangles, since that is exactly what
      // the pane shows it as. A typed line keeps its star — that one is a glob
      // for the shell — and so does an open search box, which is where a star
      // typed with one up belongs. Held down, a repeat would only flip the pane
      // back and forth, so only the first press counts.
      if (searching || hasInput) return
      consume(event)
      if (!event.repeat) pane.toggleSelectAll()
      break
    }
    case 'F3': {
      consume(event)
      const entry = pane.current()
      if (!entry) break
      if (entry.isParent || entry.kind === 'directory') void pane.activate()
      else if (entry.kind === 'file') void openViewer(pane, entry.path, 'view')
      break
    }
    case 'F4': {
      consume(event)
      const entry = pane.current()
      if (entry && !entry.isParent && entry.kind === 'file') {
        void openViewer(pane, entry.path, 'edit')
      }
      break
    }
    case 'F5':
      consume(event)
      requestCopy()
      break
    case 'F8':
      consume(event)
      requestDelete()
      break
    case 'F6':
      consume(event)
      if (event.shiftKey) pane.beginRename()
      else requestMove()
      break
    case 'F7':
      consume(event)
      requestMkdir()
      break
    case 'Enter':
      // With a line typed, fall through to the shell and leave the terminal
      // exactly as the user left it.
      if (hasInput) return
      consume(event)
      activateRow(activeSide.value, true)
      break
    default:
      break
  }
}

function onKeydown(event: KeyboardEvent): void {
  // The pane menu holds the keyboard while it is up: Escape closes it, and its own
  // keys — the arrows, Home/End, Enter — are the menu's, which drives itself from
  // them because it is what is focused. A key that is *not* the menu's is dropped
  // here rather than left to drive whatever else happens to hold the focus: the
  // shell's line editor would take the arrows as history, and the panes as cursor
  // moves, behind a menu that is supposed to be the only thing listening.
  if (paneMenu.value !== null) {
    if (event.key === 'Escape') {
      consume(event)
      closePaneMenu()
      return
    }
    if (!paneMenuRef.value?.ownsKey(event.target)) consume(event)
    return
  }

  // The discard dialog sits over the viewer, so it is answered before the
  // viewer's own keys: Escape cancels it and hands the editor back its focus,
  // and every other key belongs to the dialog (its default button is focused,
  // arrows move between the buttons, Enter activates the focused one).
  if (discardOpen.value) {
    if (event.key === 'Escape') {
      consume(event)
      cancelDiscard()
    }
    return
  }

  // The viewer owns the keyboard while it is open — Monaco handles Ctrl+F and
  // the rest itself — so nothing here consumes keys except Escape, which closes
  // it. This also covers the error state, where no editor was created to close.
  if (viewerPath.value !== null) {
    if (event.key === 'Escape') {
      consume(event)
      closeViewer()
    }
    return
  }

  // The dialogs are modal. Escape cancels; every other key is left to the
  // dialog (its default button is focused, arrows move between the buttons,
  // Enter activates the focused one) instead of reaching the panes or shell.
  if (
    mkdirOpen.value ||
    deleteTargets.value.length > 0 ||
    copyJob.value !== null ||
    moveJob.value !== null
  ) {
    if (event.key === 'Escape') {
      consume(event)
      if (mkdirOpen.value) cancelMkdir()
      else if (deleteTargets.value.length > 0) cancelDelete()
      else if (moveJob.value !== null) cancelMove()
      else cancelCopy()
    }
    return
  }

  // A display *over the whole window* is the one presentation that is not the
  // panes' any more: it is drawn over everything, so it owns its keys wherever
  // the keyboard is, exactly like the viewer — a terminal nobody can see must not
  // be the thing that answers them. The presentation inside a pane is a mode of
  // the panes and keeps its keys below, with the rest of them.
  if (stageFullscreen.value) {
    if (event.key === 'Escape') {
      consume(event)
      exitStage()
      return
    }
    if (event.key === 'Tab') {
      consume(event)
      return
    }
  }

  const isTerminalToggle =
    event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    event.key.toLowerCase() === 'o'

  if (isTerminalToggle) {
    event.preventDefault()
    event.stopPropagation()
    toggleTerminal()
    return
  }

  // Shift+Ctrl+PageUp/PageDown reorder the active tab rather than stepping to
  // another one. Claimed globally, like the plain-Ctrl tab keys below.
  if (isCtrlShift(event) && (event.key === 'PageUp' || event.key === 'PageDown')) {
    consume(event)
    moveWorkspace(activeIndex.value, activeIndex.value + (event.key === 'PageUp' ? -1 : 1))
    return
  }

  // Workspace tabs are the app's own chrome rather than a pane's, so they are
  // claimed like Ctrl+O, above the terminal: a new terminal is wanted from
  // inside the one that is running, and a tab that could not be closed while it
  // was in front would be a tab the terminal owns.
  if (isPlainCtrl(event)) {
    const key = event.key.toLowerCase()
    if (key === 't') {
      consume(event)
      addWorkspace()
      return
    }
    if (key === 'w') {
      consume(event)
      closeWorkspace(activeIndex.value)
      return
    }
    if (event.key === 'PageDown') {
      consume(event)
      switchWorkspace(1)
      return
    }
    if (event.key === 'PageUp') {
      consume(event)
      switchWorkspace(-1)
      return
    }
  }

  // Expanded and focused means it is a real terminal, and that is the whole of
  // what decides the keys below: every one of them is a gesture for a *pane* —
  // its listing, the row under its cursor, the mode it is in — and an expanded
  // terminal leaves the panes no height to be seen in, so they have no claim on
  // the key. Handing it over is not a small thing either, because the programs
  // running there want these keys: midnight commander binds Alt+S to Search,
  // Alt+A to PutCurrentPath, Alt+Enter to PutCurrentSelected, Ctrl+R to Reread
  // and Alt+. to ShowHidden, and a plain shell's readline binds Ctrl+R to
  // reverse-search and Alt+. to yank-last-arg. What is claimed *above* this line
  // is the app's own chrome — the overlays, Ctrl+O, the tab keys, a display over
  // the whole window — which has to work wherever the keyboard is.
  if (terminalExpanded.value && terminalFocused.value) return

  // A display *inside a pane* is a mode of the panes rather than an overlay of
  // their own: the cursor stays in the pane that asked for it, so Tab must not
  // move the keyboard — and with it which cursor is being displayed — to the
  // other pane, and Escape is what leaves.
  if (stageSide.value !== null) {
    if (event.key === 'Escape') {
      consume(event)
      exitStage()
      return
    }
    if (event.key === 'Tab') {
      consume(event)
      return
    }
  }

  // Alt+S starts an incremental search in the pane being browsed, over the
  // listing the pane is showing — which is what makes it the panes' rather than
  // the shell's.
  const isSearchToggle =
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    event.code === 'KeyS'

  if (isSearchToggle) {
    consume(event)
    toggleSearch()
    return
  }

  // Alt+Enter and Alt+A paste the cursor's entry onto the command line: its
  // name, and the directory holding it closed with a separator. They are the
  // pane's own too — the entry they paste is the row under a cursor nobody can
  // see once the terminal has the room.
  const isPasteName =
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    event.key === 'Enter'

  if (isPasteName) {
    consume(event)
    pasteEntryName()
    return
  }

  const isPastePath =
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    event.code === 'KeyA'

  if (isPastePath) {
    consume(event)
    pasteEntryPath()
    return
  }

  // Ctrl+R re-lists the pane being browsed (mc's Reread), rather than clearing
  // the shell's screen, which is what Ctrl+L is for.
  const isRefresh =
    event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    event.key.toLowerCase() === 'r'

  if (isRefresh) {
    consume(event)
    void activePane.value.refresh()
    return
  }

  // Shift+F10 — and the keyboard's own menu key — ask for the pane menu: the
  // keyboard's half of the long right-press, on the cursor row. It is Shift+F10
  // rather than F10 because F10 alone is what the programs running in the
  // terminal use (mc's quit, vim's menu), and the menu key carries no modifier
  // because it *is* the gesture: nothing else means it. Both act on a row of the
  // pane's listing, so they are claimed here with the rest of the panes' keys.
  const isPaneMenu =
    event.key === 'ContextMenu' ||
    (event.key === 'F10' &&
      event.shiftKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey)

  if (isPaneMenu) {
    consume(event)
    requestPaneMenuAtCursor()
    return
  }

  // Alt+. switches the hide mode off and on: the panes' own gesture, for the
  // panes' own listing — and readline's yank-last-arg in a real terminal, which
  // is why it is claimed here rather than anywhere above.
  const isHideToggle =
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    (event.code === 'Period' || event.key === '.')

  if (isHideToggle) {
    consume(event)
    void toggleHideMode()
    return
  }

  handlePaneKey(event)
}

/**
 * Registered in setup, before any child mounts, so it runs ahead of xterm's own
 * capture listener. `stopPropagation` in `consume` is what actually keeps
 * navigation keys away from the shell.
 */
window.addEventListener('keydown', onKeydown, { capture: true })

// Focus can be lost to an element that owns nothing — a click on chrome, or the
// window manager's activation click — so the command line is re-asserted on both
// a window focus and any focus change that lands on an unclaimed element.
window.addEventListener('focus', restoreFocus)
document.addEventListener('focusout', onFocusDrop)

onMounted(async () => {
  // The remembered mode is asked for before the panes walk their first
  // directory, so a folder with a `.mchide` file is listed the way the mode was
  // left — rather than showing everything and hiding it a moment later.
  await loadHideMode()
  for (const workspace of workspaces.value) void workspace.init()
  // What a file is previewable as depends on whether main can transcode what
  // Chromium cannot play, so the answer is asked for before any cursor lands.
  void loadTranscodeSupport()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, { capture: true })
  window.removeEventListener('focus', restoreFocus)
  document.removeEventListener('focusout', onFocusDrop)
  for (const workspace of workspaces.value) releaseWorkspace(workspace)
})
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden bg-bg text-fg select-none">
    <TitleBar>
      <WorkspaceTabs
        :tabs="workspaces"
        :active-index="activeIndex"
        @select="selectWorkspace"
        @close="closeWorkspace"
        @create="addWorkspace"
        @reorder="moveWorkspace"
      />
    </TitleBar>

    <!-- The wrapper is the positioning context for the viewer overlay, which
         covers the panes and the terminal but leaves the title bar visible.
         `grow` keeps the panes' terminal-driven flex behaviour. -->
    <div class="relative flex min-h-0 grow flex-col">
      <!-- `isolate` keeps the panes' own z-ranks inside the row, but that also
           confines the full-screen display (`fixed inset-0 z-50` inside a pane):
           as a non-positioned element the row would be painted *before* the
           terminal that follows it, so the display could not cover the command
           line. `relative z-10` makes the row one positioned stacking context
           that paints over the terminal, while staying under the viewer (`z-20`,
           a later sibling) and the dialogs (`z-50`). -->
      <main
        ref="panelHost"
        tabindex="-1"
        class="relative isolate z-10 flex min-h-0 shrink basis-0 overflow-hidden outline-none transition-[flex-grow] duration-150 ease-out"
        :class="terminalExpanded ? 'grow-0' : 'grow'"
      >
        <FilePanel
          :key="`${activeWorkspace.id}:left`"
          ref="leftPanel"
          :controller="left"
          :active="activeSide === 'left'"
          :stage="stageSide === 'left' ? stageRequest : null"
          :displaying="stageSide === 'left'"
          :fullscreen="stageFullscreen"
          :transferred="transferredSide === 'left'"
          :displayed-clock="transferredSide === 'left' ? displayedClock : null"
          :style="leftPaneStyle"
          @select="setActive('left')"
          @pointer-down="focusPanes"
          @activate="activateRow('left', false)"
          @fullscreen="openFullscreen('left')"
          @toggle-fullscreen="toggleDisplayFullscreen()"
          @step="stepShownPane"
          @stage-clock="displayedClock = $event"
          @stage-on="showStage('left')"
          @stage-off="exitStage()"
          @context-menu="openPaneMenu('left', $event)"
        />
        <!-- The boundary between the panes, and the handle that moves it: the
             line stays a pixel, while an invisible band around it is what the
             pointer actually grabs. The re-centre button hangs off its bottom
             once the split has been dragged off-centre. The handle rides above
             the panes (`z-30`) because half the button overhangs one of them,
             and that pane's own overlays are `z-20` layers: under them, only the
             half hanging over the empty side took a click. A display counts
             itself `z-40` for the length of its travel between its pane and the
             window, since it hangs over both panes on the way and the divider
             would otherwise be drawn across the picture. `isolate` on the row
             above keeps that rank inside the row, so the viewer and the dialogs,
             which are outside it, still cover everything. It is drawn between
             the two panes whichever column each is in — `order` is what puts it
             back in the middle when a Ctrl+U exchange has moved them. -->
        <div class="relative z-30 w-px shrink-0 bg-border" :style="{ order: 1 }">
          <div
            class="absolute inset-y-0 -left-1 -right-1 z-10 cursor-col-resize"
            @pointerdown="startSplitDrag"
          ></div>
          <button
            v-if="!splitCentered"
            type="button"
            class="absolute bottom-1 left-1/2 z-20 flex h-5 w-5 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-surface text-fg-dim shadow transition-colors hover:bg-hover hover:text-fg"
            title="Center the panes"
            aria-label="Center the panes"
            @click="centerSplit"
          >
            <svg
              viewBox="0 0 24 24"
              class="h-3 w-3"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M12 3v18" />
              <path d="M5 9.5 8.5 12 5 14.5" />
              <path d="M19 9.5 15.5 12 19 14.5" />
            </svg>
          </button>
        </div>
        <FilePanel
          :key="`${activeWorkspace.id}:right`"
          ref="rightPanel"
          :controller="right"
          :active="activeSide === 'right'"
          :stage="stageSide === 'right' ? stageRequest : null"
          :displaying="stageSide === 'right'"
          :fullscreen="stageFullscreen"
          :transferred="transferredSide === 'right'"
          :displayed-clock="transferredSide === 'right' ? displayedClock : null"
          :style="rightPaneStyle"
          @select="setActive('right')"
          @pointer-down="focusPanes"
          @activate="activateRow('right', false)"
          @fullscreen="openFullscreen('right')"
          @toggle-fullscreen="toggleDisplayFullscreen()"
          @step="stepShownPane"
          @stage-clock="displayedClock = $event"
          @stage-on="showStage('right')"
          @stage-off="exitStage()"
          @context-menu="openPaneMenu('right', $event)"
        />
      </main>

      <TerminalPane
        ref="terminalRef"
        :key="activeWorkspace.id"
        :shell="activeWorkspace.shell"
        :expanded="terminalExpanded"
        :cwd="activePanePath"
        @focused-change="setTerminalFocused"
        @collapse="collapseTerminal"
      />

      <FileViewer
        v-if="viewerPath !== null && viewerContent !== null"
        ref="viewerRef"
        :key="`${viewerMode}:${viewerPath}`"
        :path="viewerPath"
        :mode="viewerMode"
        :content="viewerContent"
        @close="closeViewer"
      />
    </div>

    <PaneContextMenu
      v-if="paneMenu"
      ref="paneMenuRef"
      :title="paneMenu.target.name"
      :items="paneMenuItems"
      :x="paneMenu.x"
      :y="paneMenu.y"
      @choose="choosePaneMenuItem"
      @close="closePaneMenu"
    />

    <ConfirmTransfer
      v-if="copyJob"
      :entries="copyJob.entries"
      :destination="copyJob.destination"
      mode="copy"
      @confirm="confirmCopy"
      @cancel="cancelCopy"
    />

    <ConfirmTransfer
      v-if="moveJob"
      :entries="moveJob.entries"
      :destination="moveJob.destination"
      mode="move"
      @confirm="confirmMove"
      @cancel="cancelMove"
    />

    <ConfirmMkdir
      v-if="mkdirOpen"
      @confirm="confirmMkdir"
      @cancel="cancelMkdir"
    />

    <ConfirmDelete
      v-if="deleteTargets.length > 0"
      :entries="deleteTargets"
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />

    <ConfirmDiscard
      v-if="discardOpen"
      :name="viewerName"
      @confirm="dismissViewer"
      @cancel="cancelDiscard"
    />
  </div>
</template>
