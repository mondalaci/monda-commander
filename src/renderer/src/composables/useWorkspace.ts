import {
  computed,
  effectScope,
  onScopeDispose,
  ref,
  shallowRef,
  watch,
  type ComputedRef,
  type Ref
} from 'vue'
import { useDirectory, type PaneController, type PaneEntry } from '@renderer/composables/useDirectory'
import { createShell, type Shell } from '@renderer/composables/useShell'
import { createTargetApi, type TargetApi } from '@renderer/lib/targetApi'
import { isArchivePath, splitArchivePath } from '@shared/archive'
import type { Target } from '@shared/target'
import type { PanelSide } from '@shared/types'

/**
 * A workspace is one tab: its own pair of file panes and its own shell. The app
 * keeps several alive at once (see App.vue); each owns the per-tab state and
 * watchers that used to be global — the active side, the terminal's expanded
 * and focused flags, and the panel <-> shell cwd sync — so switching tabs is
 * just switching which one is rendered.
 */
export interface Workspace {
  readonly id: string
  readonly label: string
  /**
   * The connection this workspace lives on. Both panes and the shell belong to
   * it, so there is one filesystem in play and the panel ↔ shell sync stays
   * honest without a target-equality guard.
   */
  readonly target: Target
  readonly api: TargetApi
  readonly left: Ref<PaneController>
  readonly right: Ref<PaneController>
  readonly shell: Shell
  readonly activeSide: Ref<PanelSide>
  /**
   * Whether the two panes are drawn in the other order, which is the whole of a
   * Ctrl+U exchange: the panes change columns without anything inside them being
   * rebuilt for it (see `swapPanels`).
   */
  readonly columnsSwapped: Ref<boolean>
  readonly terminalExpanded: Ref<boolean>
  readonly terminalFocused: Ref<boolean>
  readonly activePane: ComputedRef<PaneController>
  readonly inactivePane: ComputedRef<PaneController>
  readonly activePanePath: ComputedRef<string>
  swapPanels(): void
  init(): Promise<void>
  dispose(): void
}

/**
 * Panel -> shell cwd sync has to type a real `cd` into a real prompt, so the
 * shell echoes it and the strip fills up with commands the user never issued.
 * Appending a printf that walks back over the echoed line and clears it hides
 * the sync, and `&&` means a failed `cd` still shows its error.
 *
 * The echo is not the only trace: readline adds the line to the history list
 * *before* running it, so Up would offer the sync as though the user had typed
 * it. The injected line therefore ends by deleting the entry it just became —
 * `history -d` on the number it is now, which is `$HISTCMD`. That is bash's own
 * builtin, hence the guard: `$SHELL` is whatever the user runs, and a shell
 * without it must not be handed a command that errors.
 *
 * The line deliberately starts at column 0. A *space*-prefixed line is the
 * usual way to ask a shell to forget a line, but `HISTCONTROL`/`HIST_IGNORE_SPACE`
 * drop it before it is ever numbered, so `$HISTCMD` would still name the user's
 * previous command and the delete would take that one instead. With no leading
 * space the entry is always ours: if a shell ignores the line anyway (bash's
 * `ignoredups`, on a repeat) the worst the delete can reach is an earlier copy
 * of this same line.
 */
const ERASE_ECHO = "printf '\\033[1A\\033[2K'"
const FORGET_LINE = '[ -n "$BASH_VERSION" ] && history -d "$HISTCMD" 2>/dev/null'

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

export function createWorkspace(id: string, label: string, target: Target): Workspace {
  const scope = effectScope()
  let api!: Workspace

  scope.run(() => {
    const targetApi = createTargetApi(target)
    const left = shallowRef<PaneController>(useDirectory('left', { run: runInShell, api: targetApi }))
    const right = shallowRef<PaneController>(useDirectory('right', { run: runInShell, api: targetApi }))
    const shell = createShell(id, targetApi.pty)

    const activeSide = ref<PanelSide>('left')
    const columnsSwapped = ref(false)
    const terminalExpanded = ref(false)
    const terminalFocused = ref(false)

    const activePane = computed(() => (activeSide.value === 'left' ? left.value : right.value))
    const inactivePane = computed(() => (activeSide.value === 'left' ? right.value : left.value))
    const activePanePath = computed(() => activePane.value.state.path)

    /**
     * Ctrl+U exchanges the two panels' *columns*, and nothing else. Each pane
     * keeps its directory, cursor, marks, filter and its own DOM: the two change
     * place rather than being re-bound to the other's state, and `App.vue` draws
     * them in the other order — so a display among them goes on playing, and a
     * footer goes on showing the picture it had, instead of both being taken
     * down and built again on the other side. The active pane is the one holding
     * the cursor, so it is still the active one; it has simply moved.
     */
    function swapPanels(): void {
      columnsSwapped.value = !columnsSwapped.value
    }

    // A filter belongs to the pane it was typed in.
    watch(activeSide, () => inactivePane.value.closeSearch())

    /**
     * cwd sync runs both ways, which needs care: the shell's cwd is polled, so
     * a read can be stale for a moment after we push a `cd`. `pendingPush` marks
     * the path we asked for so those stale reads are ignored instead of bouncing
     * the panel back to where it came from.
     */
    let pendingPush: string | null = null
    let pendingTimer: number | null = null

    /** The directory holding a real path; both separators, as `parentOf` is. */
    function parentDir(target: string): string {
      const slash = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'))
      if (slash > 0) return target.slice(0, slash)
      return slash === 0 ? '/' : target
    }

    /**
     * Where the shell belongs for the pane's location. A shell cannot be *inside*
     * an archive — an archive is not a directory it can hold — so a pane inside one
     * anchors the shell to the real directory that holds the archive: the closest
     * place the terminal can be to what the pane is showing, where `ls` lists the
     * archive and Tab completes it. Everywhere else this is the path itself.
     */
    function shellTargetFor(location: string): string {
      const inside = splitArchivePath(location)
      return inside ? parentDir(inside.archive) : location
    }

    function clearPendingPush(): void {
      pendingPush = null
      if (pendingTimer === null) return
      window.clearTimeout(pendingTimer)
      pendingTimer = null
    }

    function pushCwdToShell(): void {
      // Never write into a shell that is busy, or into a half-typed command
      // line: the text would be fed to whatever is running, or appended to the
      // command.
      if (!shell.started.value || !shell.idle.value) return
      if (shell.inputLine.value.length > 0) return

      const target = shellTargetFor(activePanePath.value)
      if (!target || target === shell.cwd.value || target === pendingPush) return

      pendingPush = target
      if (pendingTimer !== null) window.clearTimeout(pendingTimer)
      pendingTimer = window.setTimeout(clearPendingPush, 3000)

      shell.write(`cd ${shellQuote(target)} && ${ERASE_ECHO}; ${FORGET_LINE}\r`)
    }

    watch([activePanePath, shell.idle, shell.started, shell.inputLine], pushCwdToShell)

    watch(shell.cwd, (next) => {
      if (!next) return

      if (pendingPush !== null) {
        if (next === pendingPush) clearPendingPush()
        return
      }

      // While the pane is inside an archive the shell is anchored to the archive's
      // folder and must not drive the panel: a `cd` at the prompt would otherwise
      // pull the pane back out of the archive, undoing the gesture it was left for.
      if (isArchivePath(activePanePath.value)) return

      if (next === activePanePath.value) return
      void activePane.value.navigateTo(next)
    })

    /**
     * A command can add or remove entries without changing the cwd, which is
     * the only thing the panel otherwise reacts to — so `touch newfile` leaves
     * the list stale until the directory is re-entered. Re-list the pane the
     * shell ran in once the command finishes.
     *
     * The tricky part is noticing "finished": a fast command is over before the
     * next 300ms state poll, so it never shows up as busy and there is no idle
     * transition to wait for. After a short settle we therefore force a fresh
     * read and treat "already idle" as a completed command; a command still
     * running shows up busy here and the idle watch finishes the job when it
     * exits.
     */
    const COMMAND_SETTLE_MS = 150

    let commandPending = false
    let commandSettleTimer: number | null = null
    /** Whoever is waiting for the command the shell is running to be over. */
    let whenCommandFinished: (() => void) | null = null

    function refreshPanelsAtShellCwd(): void {
      const target = shell.cwd.value
      if (!target) return
      for (const pane of [left.value, right.value]) {
        if (pane.state.path === target) void pane.refresh()
      }
    }

    /**
     * The command the shell was running is over: unmute the panes it could have
     * changed, re-list them, and release whoever is waiting on it — which is a
     * file Enter started in the shell, whose terminal is shown until it is done.
     */
    function finishCommand(): void {
      if (!commandPending) return
      commandPending = false
      const resolve = whenCommandFinished
      whenCommandFinished = null
      unmuteShellPanes()
      refreshPanelsAtShellCwd()
      resolve?.()
    }

    /**
     * A command typed at the prompt is a change the user asked for, so the
     * panes showing the shell's directory are marked as making it themselves:
     * `mkdir foo` would otherwise sweep `foo` exactly like a file another
     * program wrote. They stay quiet while the command runs and for a short
     * tail after it, which also covers the watcher's delayed notification for
     * the same change. This is only ever the directories the shell is actually
     * in — a download finishing elsewhere still sweeps.
     */
    const shellPanes = new Set<PaneController>()

    function muteShellPanes(): void {
      const dir = shell.cwd.value
      if (!dir) return
      for (const pane of [left.value, right.value]) {
        if (pane.state.path !== dir || shellPanes.has(pane)) continue
        shellPanes.add(pane)
        pane.beginSelfChange()
      }
    }

    function unmuteShellPanes(): void {
      for (const pane of shellPanes) pane.endSelfChange()
      shellPanes.clear()
    }

    function noteCommandSubmitted(): void {
      commandPending = true
      muteShellPanes()
      if (commandSettleTimer !== null) window.clearTimeout(commandSettleTimer)
      commandSettleTimer = window.setTimeout(() => {
        commandSettleTimer = null
        void settleCommand()
      }, COMMAND_SETTLE_MS)
    }

    async function settleCommand(): Promise<void> {
      if (!commandPending) return
      await shell.refreshState()
      if (!commandPending || !shell.idle.value) return
      finishCommand()
    }

    watch(shell.commandSeq, noteCommandSubmitted)

    watch(shell.idle, (idleNow) => {
      if (idleNow) finishCommand()
    })

    // A shell that dies mid-command never reaches idle, so nothing else would
    // release the muting. Resuming on exit keeps the sweep working afterwards.
    watch(shell.started, (started) => {
      if (!started) finishCommand()
    })

    /**
     * Whether the terminal is up because a program this workspace started is
     * running, and whether anyone but us has touched it since: a Ctrl+O while it
     * runs means the user has the terminal, so the collapse at the end of a run
     * is only ours to make if nothing moved it in the meantime. The watcher is
     * synchronous so that our own two writes are still flagged when it fires.
     */
    let terminalForRun = false
    let writingTerminal = false

    watch(
      terminalExpanded,
      () => {
        if (writingTerminal) return
        terminalForRun = false
      },
      { flush: 'sync' }
    )

    /**
     * Run a file the user can run in the shell the panes already have, and
     * resolve when it is over. Its stdout and stderr are the terminal's, since
     * it is the shell's own foreground process rather than something spawned
     * behind its back; the terminal is shown for as long as it runs.
     *
     * The command is typed into the shell's own line, exactly as Alt+Enter types
     * a name, so it echoes and reaches the history like a real command line —
     * and "a submitted command is running", the state the panes already keep to
     * re-list and to stay quiet, is what says when it finished. `false` means
     * the shell was busy, and nothing was run.
     */
    async function runInShell(entry: PaneEntry): Promise<boolean> {
      if (!shell.started.value || !shell.idle.value) return false

      const restore = !terminalExpanded.value
      if (restore) {
        writingTerminal = true
        terminalForRun = true
        terminalExpanded.value = true
        writingTerminal = false
      }

      const finished = new Promise<void>((resolve) => {
        whenCommandFinished = resolve
      })
      shell.sendInput(`${shellQuote(entry.path)}\r`)
      await finished

      if (restore && terminalForRun) {
        writingTerminal = true
        terminalExpanded.value = false
        writingTerminal = false
      }
      return true
    }

    async function init(): Promise<void> {
      await Promise.all([left.value.init(), right.value.init()])
    }

    api = {
      id,
      label,
      target,
      api: targetApi,
      left,
      right,
      shell,
      activeSide,
      columnsSwapped,
      terminalExpanded,
      terminalFocused,
      activePane,
      inactivePane,
      activePanePath,
      swapPanels,
      init,
      dispose: () => scope.stop()
    }

    onScopeDispose(() => {
      if (pendingTimer !== null) window.clearTimeout(pendingTimer)
      if (commandSettleTimer !== null) window.clearTimeout(commandSettleTimer)
      shell.dispose()
    })
  })

  return api
}
