import { ref } from 'vue'

/**
 * The quick cd directories, as one answer for the whole app: a pane whose quick
 * cd mode is on shows this list in place of its own directory (see
 * `toggleQuickCd` in `useDirectory`), and both panes read the same list, so a
 * folder added from one pane's menu is there in the other. The order is the
 * user's: it is only ever appended to and filtered, never sorted.
 */
export const quickCdDirs = ref<string[]>([])

/**
 * The user's home directory, asked for alongside the list so a bookmark under it
 * can be shown with `~` rather than the full prefix. Empty until it is read, and
 * left empty when it cannot be, in which case paths are shown as they are.
 */
export const homeDir = ref('')

/**
 * Ask main for the list that was left last time, and for the home directory the
 * rows are shown relative to. Called once on mount, like the hide mode's answer —
 * a pane cannot have its quick cd mode on before the user asks, so there is no
 * first paint to wait for.
 */
export async function loadQuickCd(): Promise<void> {
  try {
    quickCdDirs.value = await window.mc.quickCd.get()
  } catch {
    // Nothing to show is the honest answer when the list cannot be read.
    quickCdDirs.value = []
  }
  try {
    homeDir.value = await window.mc.fs.home()
  } catch {
    homeDir.value = ''
  }
}

/**
 * A directory's label on the quick cd list: the home directory and everything
 * under it is shown with `~`, so `~/projects` reads where
 * `/home/laci/projects` says the same thing longer. The path itself is never
 * changed — this is the row's display only.
 */
export function quickCdLabel(dir: string): string {
  const home = homeDir.value
  if (!home) return dir
  if (dir === home) return '~'
  if (dir.startsWith(`${home}/`) || dir.startsWith(`${home}\\`)) {
    return `~${dir.slice(home.length)}`
  }
  return dir
}

/** Whether a directory is already on the list. */
export function isQuickCd(dir: string): boolean {
  return quickCdDirs.value.includes(dir)
}

/**
 * Replace the stored list with `next`. The assignment is a fresh array so every
 * pane's watcher on the list sees the change — the list is replaced whole, never
 * mutated in place. Answers whether it was saved: a log that cannot be written
 * (a read-only home, a permission) is put back the way it was, so the rows never
 * show an entry the next launch will not have, and the caller can say so.
 */
async function persist(next: string[], previous: string[]): Promise<boolean> {
  quickCdDirs.value = next
  try {
    await window.mc.quickCd.set(next)
    return true
  } catch {
    quickCdDirs.value = previous
    return false
  }
}

/** Put a directory on the list, at the end, unless it is already there. */
export async function addQuickCd(dir: string): Promise<boolean> {
  if (!dir || isQuickCd(dir)) return true
  return persist([...quickCdDirs.value, dir], quickCdDirs.value)
}

/** Take a directory off the list. */
export async function removeQuickCd(dir: string): Promise<boolean> {
  if (!isQuickCd(dir)) return true
  return persist(
    quickCdDirs.value.filter((entry) => entry !== dir),
    quickCdDirs.value
  )
}
