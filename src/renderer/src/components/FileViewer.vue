<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type * as MonacoApi from 'monaco-editor'
import type { FileContent } from '@shared/types'
import { languageFor, loadMonaco } from '@renderer/lib/monaco'
import {
  diffDecorations,
  diffLineArrays,
  toLines,
  type InlineSpan,
  type LineChange
} from '@renderer/lib/diff'
import { injectTargetApi } from '@renderer/lib/targetContext'

/**
 * `content` is the file, already read by the pane that opened the viewer: main
 * refuses a file an editor cannot show — a binary, or anything that is not a
 * regular file — so a viewer that exists always has something to display. That
 * refusal is the pane's notice to give (see `openViewer` in App.vue), not an
 * overlay whose only content is the message.
 */
const props = defineProps<{
  path: string
  mode: 'view' | 'edit'
  content: FileContent
  /**
   * What HEAD holds for the file, when App.vue already read it — a head start
   * for a file the pane marks as changed, so the diff is on screen from the first
   * paint. Null means the viewer fetches its own baseline the first time the
   * buffer is edited; a file that is never edited is never diffed.
   */
  base: string | null
}>()

const emit = defineEmits<{ (event: 'close'): void }>()

// The file's target, so a save goes back to the host the file lives on rather
// than to a same-named path on the local disk.
const api = injectTargetApi()

const host = ref<HTMLElement | null>(null)
const loading = ref(true)
/**
 * A failure that leaves nothing to show — a Monaco that would not load, or an
 * edit of a read that had to be truncated. It replaces the editor area.
 */
const error = ref<string | null>(null)
/**
 * A failed save. Kept apart from `error` on purpose: the editor must stay on
 * screen (the buffer is still the user's work) so this shows as a strip beside
 * the header instead of replacing it.
 */
const saveError = ref<string | null>(null)
const truncated = computed(() => props.content.truncated)
const dirty = ref(false)
const saving = ref(false)
const saved = ref(false)

let editor: MonacoApi.editor.IStandaloneCodeEditor | null = null
let model: MonacoApi.editor.ITextModel | null = null
let changeSubscription: MonacoApi.IDisposable | null = null
/**
 * The keybindings the read-only remap registered (see the viewer's vertical
 * keys). They must be disposed with the editor: a standalone editor's
 * `addAction` hands back a disposable, and dropping it lets the binding outlive
 * the viewer and shadow the arrow keys in a later editor.
 */
let viewKeyDisposables: MonacoApi.IDisposable[] = []
let savedTimer: number | null = null
/**
 * The changed-line gutter: the decorations themselves, the subscription that
 * keeps them describing the current buffer, and the debounce that keeps a
 * keystroke from re-running the comparison for every character typed.
 */
let diffMarks: MonacoApi.editor.IEditorDecorationsCollection | null = null
let diffSubscription: MonacoApi.IDisposable | null = null
let diffTimer: number | null = null
/**
 * The inline view zones showing the lines a change removed — the baseline side,
 * which has no line in the buffer to decorate. They are rebuilt with the
 * decorations on every repaint, so what HEAD held moves with the text too.
 */
let diffZones: string[] = []
/**
 * What HEAD holds for the file, split into lines — the comparison's baseline, or
 * null before it is known. App.vue supplies it for a file its pane already marks
 * changed; any other file fetches it on the first edit (see `ensureBaseline`), so
 * a clean file pays for no `git show` until it is actually changed here.
 */
let baseLines: string[] | null = null
/** Whether the baseline has been settled — fetched, or found to be nothing. */
let baseSettled = false
/** Whether a baseline is being fetched right now. */
let baseAsking = false
/**
 * The Monaco import is awaited, so the view can be unmounted (Escape, another
 * F3/F4) before it settles. Without this the late continuation would create an
 * editor in a detached element and leak it.
 */
let disposed = false

/** How long after the last edit the changed-line gutter is brought up to date. */
const DIFF_DEBOUNCE_MS = 120

/**
 * The most removed lines one view zone will draw. A whole-file rewrite would
 * otherwise put every line of the baseline into the DOM at once; past this the
 * rest is counted in a final row instead.
 */
const MAX_REMOVED_LINES = 1000

const editable = computed(() => props.mode === 'edit')
const name = computed(() => props.path.split(/[\\/]/).pop() ?? props.path)

// Resolve the mono stack from the theme, exactly as the terminal does, so the
// editor and the shell cannot drift apart.
function monoFontStack(): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue('--font-mono')
    .trim()
  return value || 'monospace'
}

/**
 * The buffer's lines, read the way the baseline was (`toLines`). `getLinesContent`
 * hands back the lines already split, which is the form the comparison wants; a
 * text that ends in a newline leaves Monaco a final empty line — exactly as
 * splitting the text would — and that one is dropped to meet the baseline's line
 * numbers. A `\r` left on a CRLF model's lines is stripped for the same reason:
 * the baseline was split on `\r\n`, so the buffer has to meet it there.
 */
function bufferLines(): string[] {
  if (model === null) return []
  const lines = model.getLinesContent()
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (line.endsWith('\r')) lines[i] = line.slice(0, -1)
  }
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * The lines a change removed, as the DOM its view zone is drawn with: the
 * baseline's own text, each line on the editor's line height, so the interleaved
 * old content lines up with the buffer below it and the zone's reserved height is
 * exactly right. A line is drawn as it was and clipped at the right rather than
 * wrapped, because a zone reserves a fixed number of lines and how many a wrapped
 * line would need is not known before the zone is placed. At most
 * `MAX_REMOVED_LINES` are drawn — a whole-file rewrite must not become a hundred
 * thousand nodes — with the rest counted in a final row.
 *
 * A line a run paired with a buffer line carries the changed stretch (`spans`),
 * drawn as its own span so the words HEAD lost stand out from the whole-line
 * removal tint exactly as the buffer's changed words do above it.
 */
function removedLinesNode(
  monaco: typeof MonacoApi,
  lines: string[],
  spans: (InlineSpan | null)[] | null,
  hidden: number
): HTMLElement {
  const node = document.createElement('div')
  node.className = 'mc-diff-removed'
  node.style.fontFamily = monoFontStack()
  node.style.fontSize = `${editor?.getOption(monaco.editor.EditorOption.fontSize) ?? 12}px`
  node.style.tabSize = String(model?.getOptions().tabSize ?? 4)

  const lineHeight = editor?.getOption(monaco.editor.EditorOption.lineHeight) ?? 16
  const addRow = (text: string, span: InlineSpan | null, extra = ''): void => {
    const row = document.createElement('div')
    row.className = `mc-diff-removed-line${extra}`
    row.style.height = `${lineHeight}px`
    row.style.lineHeight = `${lineHeight}px`

    // Only a stretch that lost text is worth splitting out; an empty side (the
    // baseline of a pure insertion) leaves the line as it was.
    if (span && span.baseEnd > span.baseStart) {
      const before = text.slice(0, span.baseStart)
      const changed = text.slice(span.baseStart, span.baseEnd)
      const after = text.slice(span.baseEnd)
      if (before) row.appendChild(document.createTextNode(before))
      const mark = document.createElement('span')
      mark.className = 'mc-diff-removed-inline'
      mark.textContent = changed
      row.appendChild(mark)
      if (after) row.appendChild(document.createTextNode(after))
    } else {
      row.textContent = text
    }

    node.appendChild(row)
  }

  for (let k = 0; k < lines.length; k += 1) addRow(lines[k] ?? '', spans?.[k] ?? null)
  if (hidden > 0) addRow(`… ${hidden} more lines removed`, null, ' mc-diff-removed-more')
  return node
}

/**
 * Replace the removed-line view zones with the ones the current comparison asks
 * for, so the interleaved old content describes the buffer as it now stands. A
 * run with no baseline lines adds nothing; a run with buffer lines anchors its
 * zone above them, a removal after the line it sat behind (or the top).
 */
function paintRemovedLines(
  monaco: typeof MonacoApi,
  changes: LineChange[],
  baseLines: string[]
): void {
  if (editor === null) return
  // Nothing to draw and nothing drawn last time: no need to touch the zones.
  if (diffZones.length === 0 && !changes.some((change) => change.baseStart > 0)) return

  editor.changeViewZones((accessor) => {
    for (const id of diffZones) accessor.removeZone(id)
    diffZones = []

    for (const change of changes) {
      if (change.baseStart === 0) continue

      const removed = baseLines.slice(change.baseStart - 1, change.baseEnd)
      if (removed.length === 0) continue

      const shown = removed.slice(0, MAX_REMOVED_LINES)
      const hidden = removed.length - shown.length
      // The run's per-line spans index from its first baseline line, which is
      // where `removed` starts, so the slice lines up one to one.
      const shownSpans = change.spans?.slice(0, MAX_REMOVED_LINES) ?? null

      diffZones.push(
        accessor.addZone({
          afterLineNumber: change.currentStart > 0 ? change.currentStart - 1 : change.afterLine,
          heightInLines: shown.length + (hidden > 0 ? 1 : 0),
          domNode: removedLinesNode(monaco, shown, shownSpans, hidden),
          suppressMouseDown: true
        })
      )
    }
  })
}

async function save(): Promise<void> {
  const current = model
  if (!editable.value || !current || saving.value) return

  saving.value = true
  saveError.value = null

  const result = await api.fs.write(props.path, current.getValue())
  saving.value = false
  if (disposed) return

  if (!result.ok) {
    saveError.value = `${result.error.code}: ${result.error.message}`
    return
  }

  dirty.value = false
  saved.value = true
  if (savedTimer !== null) window.clearTimeout(savedTimer)
  savedTimer = window.setTimeout(() => {
    savedTimer = null
    saved.value = false
  }, 1500)
}

onMounted(async () => {
  // An edit of a truncated read would write back only the first chunk and
  // silently destroy the rest of the file, so that combination is refused
  // outright rather than opened read-only and hoped about.
  if (editable.value && truncated.value) {
    error.value = 'Too large to edit safely — only the first 8 MiB was read'
    loading.value = false
    return
  }

  let monaco: typeof MonacoApi
  try {
    monaco = await loadMonaco()
  } catch (cause) {
    if (disposed) return
    error.value = `Failed to load the editor: ${(cause as Error).message}`
    loading.value = false
    return
  }
  if (disposed) return

  const element = host.value
  if (!element) return

  model = monaco.editor.createModel(
    props.content.text,
    languageFor(monaco, props.content.path, props.content.text),
    monaco.Uri.file(props.content.path)
  )

  editor = monaco.editor.create(element, {
    model,
    // Viewing is strictly read-only; editing is a normal writable buffer whose
    // only persistence is an explicit Ctrl+S through fs:write.
    readOnly: !editable.value,
    domReadOnly: !editable.value,
    theme: 'vs-dark',
    automaticLayout: true,
    fontFamily: monoFontStack(),
    fontSize: 12,
    minimap: { enabled: true },
    scrollBeyondLastLine: false,
    renderWhitespace: 'selection',
    // A viewer has no caret to point the current line out with (see below), so
    // the highlight would sit on a line nothing is on.
    renderLineHighlight: editable.value ? 'line' : 'none',
    stickyScroll: { enabled: false },
    smoothScrolling: true,
    padding: { top: 6, bottom: 6 }
  })

  if (!editable.value) {
    // Viewing has no cursor — the caret is hidden by CSS (styles/viewer.css) —
    // so the vertical keys are a viewer's rather than an editor's: the arrows
    // walk the document a line at a time, the pages a screenful, and Home/End
    // go to its ends. Left as Monaco's own, they would move a caret the user
    // cannot see, and the view would not begin to move until that caret had
    // walked past the bottom of the screen.
    //
    // The remap goes through `addAction` rather than `addCommand` on purpose.
    // A standalone editor's `addCommand` registers a *global* dynamic
    // keybinding: its `when` clause is only the context given here, with no
    // editor scope, and nothing unregisters it when the viewer closes. Such a
    // binding then outlives the viewer and its weight beats Monaco's built-in
    // arrow keys, so a later edit-mode (F4) editor has its Up/Down swallowed by
    // a handler that triggers on the disposed view editor — the caret never
    // moves. `addAction` scopes the binding to this editor's own `editorId` and
    // returns a disposable, so the remap is the viewer's alone and ends with it.
    const verticalKeys: Array<[number, string]> = [
      [monaco.KeyCode.UpArrow, 'scrollLineUp'],
      [monaco.KeyCode.DownArrow, 'scrollLineDown'],
      [monaco.KeyCode.PageUp, 'scrollPageUp'],
      [monaco.KeyCode.PageDown, 'scrollPageDown'],
      [monaco.KeyCode.Home, 'scrollEditorTop'],
      [monaco.KeyCode.End, 'scrollEditorBottom']
    ]
    for (const [key, handler] of verticalKeys) {
      viewKeyDisposables.push(
        editor.addAction({
          id: `mc.viewer.${handler}`,
          label: handler,
          keybindings: [key],
          // 'textInputFocus' keeps these off the find box, exactly as Monaco's
          // own core navigation does.
          precondition: 'textInputFocus',
          run: (target) => target.trigger('viewer', handler, null)
        })
      )
    }
  }

  changeSubscription = model.onDidChangeContent(() => {
    dirty.value = true
  })

  // The changed-line view, when App.vue read a HEAD version to compare against.
  // It is painted once now and again, debounced, after every edit, so the marks
  // move with the text rather than being a snapshot that drifts under the caret.
  // A truncated read is never given a baseline in the first place (App.vue
  // checks), because the part it could not show would read as deleted.
  diffMarks = editor.createDecorationsCollection()

  if (props.base !== null) {
    baseLines = toLines(props.base)
    baseSettled = true
  }

  const paint = (): void => {
    if (disposed || diffMarks === null) return
    const lines = baseLines
    const changes = lines === null ? [] : diffLineArrays(lines, bufferLines())
    diffMarks.set(diffDecorations(monaco, changes))
    paintRemovedLines(monaco, changes, lines ?? [])
  }

  // A file App.vue already had a baseline for is drawn at once. Any other file
  // fetches one the first time it is edited — a clean file opened and changed
  // here must start showing its diff without being closed and reopened, and it
  // pays for no `git show` while it is only being looked at. The answer, success
  // or not (no repository, a symlink, a blob too large), is settled once.
  const ensureBaseline = (): void => {
    if (baseSettled || baseAsking) return
    baseAsking = true
    void api.git.fileBase(props.path).then((result) => {
      baseAsking = false
      baseSettled = true
      if (disposed) return
      if (result.ok) baseLines = toLines(result.data.text)
      paint()
    })
  }

  paint()

  diffSubscription = model.onDidChangeContent(() => {
    ensureBaseline()
    if (diffTimer !== null) window.clearTimeout(diffTimer)
    diffTimer = window.setTimeout(() => {
      diffTimer = null
      paint()
    }, DIFF_DEBOUNCE_MS)
  })

  if (editable.value) {
    // Ctrl/Cmd+S is the save gesture; the window-level handler lets it through
    // to the editor while the viewer is open. Registered through `addAction`
    // for the same reason as the read-only keys above: an unregistered global
    // binding from a previous viewer would shadow this one.
    viewKeyDisposables.push(
      editor.addAction({
        id: 'mc.viewer.save',
        label: 'Save',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
        run: () => {
          void save()
        }
      })
    )
  }

  loading.value = false
  editor.focus()
})

onBeforeUnmount(() => {
  disposed = true
  if (savedTimer !== null) window.clearTimeout(savedTimer)
  savedTimer = null
  if (diffTimer !== null) window.clearTimeout(diffTimer)
  diffTimer = null
  changeSubscription?.dispose()
  changeSubscription = null
  diffSubscription?.dispose()
  diffSubscription = null
  diffMarks?.clear()
  diffMarks = null
  diffZones = []
  for (const disposable of viewKeyDisposables) disposable.dispose()
  viewKeyDisposables = []
  editor?.dispose()
  editor = null
  model?.dispose()
  model = null
})

/**
 * Whether the buffer has unsaved edits. App.vue owns the open/closed state and
 * stages the in-app discard dialog when this is true, so a close never discards
 * work silently — the viewer only reports the state, it does not ask.
 */
function isDirty(): boolean {
  return dirty.value
}

/** Hand the keyboard back to the editor after a cancelled discard. */
function focusEditor(): void {
  editor?.focus()
}

defineExpose({ isDirty, focusEditor })
</script>

<template>
  <section
    class="absolute inset-0 z-20 flex flex-col overflow-hidden border border-border bg-bg"
  >
    <div class="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-surface px-3">
      <svg
        viewBox="0 0 24 24"
        class="h-3.5 w-3.5 shrink-0 text-fg-dim"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <path d="M14 3v5h5" />
      </svg>
      <span class="shrink-0 text-ui font-medium text-fg-bright">{{ name }}</span>
      <span
        v-if="editable && dirty"
        class="shrink-0 text-selected"
        title="Unsaved changes"
        aria-label="Unsaved changes"
        >●</span
      >
      <span class="truncate font-mono text-ui-sm text-fg-dim" :title="path">{{ path }}</span>

      <span
        v-if="truncated"
        class="shrink-0 rounded bg-bg-alt px-1.5 py-0.5 text-ui-sm text-selected"
        title="Only the beginning of this file is shown"
      >
        truncated
      </span>
      <span v-if="saved" class="shrink-0 text-ui-sm text-fg-dim">saved</span>
      <span
        v-if="saveError"
        class="min-w-0 truncate text-ui-sm text-danger"
        :title="saveError"
      >
        {{ saveError }}
      </span>

      <div class="min-w-0 flex-1"></div>

      <button
        v-if="editable"
        type="button"
        class="shrink-0 rounded px-1.5 py-0.5 text-ui-sm transition-colors"
        :class="dirty ? 'bg-accent text-fg-bright hover:bg-accent-strong' : 'text-fg-dim hover:bg-hover hover:text-fg'"
        :disabled="saving"
        title="Save (Ctrl+S)"
        @click="save"
      >
        Save
      </button>

      <button
        type="button"
        class="shrink-0 rounded p-0.5 text-fg-dim transition-colors hover:bg-hover hover:text-fg"
        title="Close the viewer (Esc)"
        @click="emit('close')"
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
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>

    <div class="relative min-h-0 flex-1">
      <p
        v-if="error"
        class="flex h-full items-center justify-center px-4 text-center text-ui text-danger"
      >
        {{ error }}
      </p>
      <div v-else ref="host" class="h-full w-full" :class="{ 'viewer-no-cursor': !editable }"></div>

      <p
        v-if="loading"
        class="absolute inset-0 flex items-center justify-center text-ui text-fg-dim"
      >
        Loading…
      </p>
    </div>
  </section>
</template>
