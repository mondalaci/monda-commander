import { markFor, type GitView } from '@renderer/lib/gitMark'

/**
 * The commit gesture's small model, kept out of both the app and the dialog so
 * neither has to know how a pane's git view becomes a list of changed paths.
 */

/** One changed path, as the dialog lists it. */
export interface CommitEntry {
  /** Absolute path, as the pane's git view keys its marks. */
  path: string
  /** The mark's own single letter — what its colour is chosen from. */
  letter: string
  /** The pair in words, for the row's title. */
  label: string
  /** A wholly untracked directory, shown with a trailing separator. */
  directory: boolean
}

/**
 * What a wholly untracked directory is, in words. The same mark the rows use, so
 * the dialog and a folder's dot agree about it.
 */
const UNTRACKED = markFor('?', '?', null)

/**
 * Every changed path in the work tree, in path order so the list reads the same
 * way twice. Two sources, because git reports changes two ways: an ordinary
 * change is a file record (`view.files`, keyed by absolute path), while a *wholly
 * untracked directory* is one `/`-suffixed record that the view keeps apart
 * (`view.untracked`) — the folder's own row wants that collapse, but the dialog
 * has to list it or a tree whose only change is a new directory would count as a
 * change in the chip and read as nothing to commit here. Both sources together
 * are exactly what `summary.changed` counts.
 */
export function commitEntries(view: GitView): CommitEntry[] {
  const files = [...view.files.entries()].map(([path, mark]) => ({
    path,
    letter: mark.letter,
    label: mark.label,
    directory: false
  }))
  const directories = [...view.untracked].map((path) => ({
    path,
    letter: UNTRACKED.letter,
    label: UNTRACKED.label,
    directory: true
  }))
  return [...files, ...directories].sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * A path as the dialog shows it: relative to the work tree, forward-slashed the
 * way git prints it. The fallback (a path the root does not prefix) is the path
 * itself, which should not happen but reads better than an empty string.
 */
export function commitRelPath(root: string, path: string): string {
  const base = root.replace(/[\\/]+$/, '')
  const prefix = path.startsWith(base) ? path.slice(base.length) : path
  return prefix.replace(/^[\\/]+/, '') || base
}

/**
 * The message the dialog starts with, so the common case is a keystroke from
 * done. It is built from the *paths*, never from the calendar:
 *
 * - A **lone added entry** is named: a directory becomes its contents glob —
 *   `2026-11/* added`, the files that arrived under it — and a file is itself,
 *   `notes.md added`.
 * - Anything else is **counted** by kind, zero kinds left out, led by the folder
 *   the changes all share when there is one: `2026-11/ 3 added, 1 modified`, or
 *   `3 added, 1 modified` when they share none.
 *
 * "Added" is git's `A` or an untracked `?`; "deleted" is `D`; everything else —
 * a modification, a rename, a type change, a conflict — counts as modified, which
 * is the word a commit body would use for any of them.
 */
export function defaultCommitMessage(view: GitView): string {
  const entries = commitEntries(view)
  if (entries.length === 0) return ''

  const added = entries.filter((entry) => entry.letter === 'A' || entry.letter === '?')
  const deleted = entries.filter((entry) => entry.letter === 'D')
  const modified = entries.length - added.length - deleted.length

  // One added entry and nothing else: name what was added. A directory is named
  // by what landed inside it (`dir/*`), a file by itself, because "2026-11/* added"
  // says "the files of 2026-11" while "2026-11 added" could as well be a file.
  if (entries.length === 1 && added.length === 1) {
    const entry = entries[0]!
    const rel = commitRelPath(view.root, entry.path)
    return entry.directory ? `${rel}/* added` : `${rel} added`
  }

  const parts: string[] = []
  if (added.length > 0) parts.push(`${added.length} added`)
  if (modified > 0) parts.push(`${modified} modified`)
  if (deleted.length > 0) parts.push(`${deleted.length} deleted`)
  const counts = parts.join(', ')

  const shared = commonChangeDir(view.root, entries)
  return shared === '' ? counts : `${shared}/ ${counts}`
}

/**
 * The one folder every changed path sits in, or the empty string when they share
 * none (or sit at the work tree's root, which is not worth naming). A changed
 * *directory* is its own folder — the thing that changed is the folder — while a
 * changed file contributes the folder that holds it, so a run of edits under
 * `2026-11/` all answer `2026-11` and the message can lead with it.
 */
function commonChangeDir(root: string, entries: CommitEntry[]): string {
  let common: string | null = null

  for (const entry of entries) {
    const rel = commitRelPath(root, entry.path)
    const dir = entry.directory ? rel : rel.slice(0, Math.max(rel.lastIndexOf('/'), 0))
    if (dir === '') return ''
    common = common === null ? dir : sharedPrefixDir(common, dir)
    if (common === '') return ''
  }

  return common ?? ''
}

/** The deepest folder two paths share, compared a segment at a time. */
function sharedPrefixDir(a: string, b: string): string {
  const left = a.split('/')
  const right = b.split('/')
  const shared: string[] = []
  for (let i = 0; i < left.length && i < right.length; i += 1) {
    if (left[i] !== right[i]) break
    shared.push(left[i]!)
  }
  return shared.join('/')
}

/**
 * How the dialog names what HEAD is on: the branch, or the short commit when it
 * is detached — the same wording the pane title's chip uses, so the two agree.
 */
export function commitBranchLabel(view: GitView): string {
  if (!view.detached && view.branch !== null) return view.branch
  return view.oid === null ? 'detached' : `detached@${view.oid.slice(0, 7)}`
}
