import type { GitStatus } from '@shared/types'

/**
 * How a row says what git thinks of it: a dot on the row's own icon, in the
 * colour its status carries, and that status in words wherever there is room for
 * them — the row's title, and the pane's footer.
 *
 * The colour is the whole of the mark, which is also why it cannot live on the
 * name: green already means runnable and gold means marked there, and a broken
 * symlink's target is red, so a file's own state would have to compete with three
 * meanings that are already spoken for.
 */

/**
 * The palette the mark is drawn in. Hard-coded rather than taken from the theme
 * for the reason `fileIcon.ts` is: the colour is chosen per entry, from what git
 * said about it, so it cannot be a class. These are the hues the ecosystem already
 * taught everyone — a staged change reads green, a modification amber, a deletion
 * red, an untracked path the brighter green — with the amber deliberately shared
 * with the code icon's, since VS Code reads that pair the same way.
 */
const PALETTE = {
  modified: '#e2c08d',
  added: '#81b88b',
  deleted: '#c74e39',
  untracked: '#73c991',
  conflicted: '#e4676b',
  renamed: '#7fb3d5',
  ignored: '#8c8c8c',
  none: '#8c8c8c'
} as const

/** The colour a single status character is drawn in. */
export function sideColor(side: string): string {
  switch (side) {
    case 'M':
    case 'T':
      return PALETTE.modified
    case 'A':
      return PALETTE.added
    case 'D':
      return PALETTE.deleted
    case 'R':
    case 'C':
      return PALETTE.renamed
    case '?':
      return PALETTE.untracked
    case 'U':
      return PALETTE.conflicted
    case '!':
      return PALETTE.ignored
    default:
      return PALETTE.none
  }
}

/**
 * Porcelain's unmerged pairs — every combination of "both added", "both deleted"
 * and "one side has the other's file". A pair, not a character: `AU` is a
 * conflict while `A ` is a staged addition, so the whole pair is what decides.
 */
const CONFLICT_PAIRS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

export function isConflicted(index: string, worktree: string): boolean {
  return CONFLICT_PAIRS.has(`${index}${worktree}`)
}

/**
 * The pair collapsed to one character: a conflict beats everything, an untracked
 * path is its own answer, and otherwise the index's character is what the user
 * wants first — a staged change is a decision already made.
 */
function letterFor(index: string, worktree: string): string {
  if (isConflicted(index, worktree)) return 'U'
  if (index === '?') return '?'
  if (index !== ' ') return index
  return worktree === ' ' ? '' : worktree
}

/**
 * How much a mark is worth showing on a folder, when the folder holds several.
 * A conflict is why a listing is interesting at all, then a staged change, then a
 * deletion (whose row is gone from the listing, so the folder is the only place
 * it can appear), then everything else.
 */
const RANKS: Record<string, number> = { U: 6, A: 5, D: 4, R: 3, C: 3, M: 2, T: 2, '?': 1 }

function rankFor(index: string, worktree: string): number {
  return RANKS[letterFor(index, worktree)] ?? 0
}

const NOUNS: Record<string, string> = {
  M: 'modification',
  A: 'addition',
  D: 'deletion',
  R: 'rename',
  C: 'copy',
  T: 'type change'
}

const PARTICIPLES: Record<string, string> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type changed'
}

/**
 * The pair in words, for the row's title — the whole point of a title here being
 * that the two characters are terse enough to need one.
 */
function describe(index: string, worktree: string, from: string | null): string {
  if (isConflicted(index, worktree)) return 'unmerged — a conflict to resolve'
  if (index === '?') return 'untracked'
  if (index === '!') return 'ignored'

  const origin = from === null ? '' : ` from ${from}`
  const staged = NOUNS[index] ?? index
  const loose = PARTICIPLES[worktree] ?? worktree

  if (index !== ' ' && worktree === ' ') return `staged ${staged}${origin}`
  if (index === ' ' && worktree !== ' ') return `${loose}${origin}`
  if (index !== ' ' && worktree !== ' ') return `staged ${staged}, ${loose} since${origin}`
  return 'unchanged'
}

/**
 * The pair in the fewest words that still say it, for the status bar. The dot
 * beside it already carries the kind, so a folder's own count is all the words
 * that are left to find.
 */
function summarize(index: string, worktree: string): string {
  if (isConflicted(index, worktree)) return 'conflicted'
  if (index === '?') return 'untracked'
  if (index === '!') return 'ignored'

  const staged = NOUNS[index] ?? index
  const loose = PARTICIPLES[worktree] ?? worktree

  if (index !== ' ' && worktree === ' ') return `staged ${staged}`
  if (index === ' ' && worktree !== ' ') return loose
  if (index !== ' ' && worktree !== ' ') return `staged + ${loose}`
  return 'unchanged'
}

/** What one path's status comes to, in every form a row might need it. */
export interface GitMark {
  /**
   * The index side of git's pair, its `.` shown as the blank it stands for. Not
   * drawn anywhere: the pair is what the kind, the label and the rank are read
   * from, and git's two sides are what tells one modification from two.
   */
  index: string
  /** The worktree side, likewise. */
  worktree: string
  /** The pair as one character, and what the mark's colour is chosen from. */
  letter: string
  /** The pair in words, for the row's title. */
  label: string
  /** The same, in as few words as a status bar has room for. */
  short: string
  /** Where it lands among the marks a folder might be showing. */
  rank: number
}

export function markFor(index: string, worktree: string, from: string | null): GitMark {
  const x = index === '.' ? ' ' : index
  const y = worktree === '.' ? ' ' : worktree
  return {
    index: x,
    worktree: y,
    letter: letterFor(x, y),
    label: describe(x, y, from),
    short: summarize(x, y),
    rank: rankFor(x, y)
  }
}

/** A folder's mark, and how many entries put it there. */
export interface GitDirMark {
  mark: GitMark
  count: number
}

/**
 * A work tree's own totals, for the title bar: how many entries git reported about
 * the repository as a whole, and what kind each was. The kinds do not overlap —
 * which is why "staged and changed again" is its own count rather than a member of
 * both others, so they add up to `changed` and no two of them describe one entry.
 *
 * `changed` counts *entries*, not files: a wholly untracked directory is one
 * record naming however many files are inside it, and pretending to know that
 * number would mean asking git to list them, which is the read the collapse
 * exists to save.
 */
export interface GitSummary {
  changed: number
  /** Staged only — the work tree agrees with the index. */
  staged: number
  /** Staged *and* changed again since. */
  both: number
  /** Changed in the work tree only. */
  unstaged: number
  untracked: number
  conflicted: number
  /** The highest-ranked status anywhere in the tree, for the summary's dot. */
  dominant: string
}

/**
 * What everything inside a wholly untracked directory is. `git status` reports
 * such a directory as one `/`-suffixed record rather than listing the files in it
 * — the cheaper answer, and the one the folder's own row wants — but a listing
 * *inside* that directory then has nothing of its own to go on, while everything
 * there is untracked, which the folder's record already said.
 */
const UNTRACKED_MARK = markFor('?', '?', null)

/**
 * The mark a row under a wholly untracked directory takes. The path is walked up
 * to the work tree's root rather than searched for, because a collapse is only
 * ever reported for the topmost untracked directory: one lookup per level of the
 * path, and only while such a directory exists at all.
 */
export function untrackedAbove(view: GitView, path: string): GitMark | null {
  if (view.untracked.size === 0) return null

  let current = path
  for (;;) {
    const slash = Math.max(current.lastIndexOf('/'), current.lastIndexOf('\\'))
    if (slash <= 0) return null

    current = current.slice(0, slash)
    if (view.untracked.has(current)) return UNTRACKED_MARK
    if (current === view.root) return null
  }
}

/**
 * A repository's status, arranged for a listing: what HEAD is on, every changed
 * file under its absolute path, and every folder holding one — also absolute, and
 * already rolled up, so a row's lookup is a `Map.get` and the window's thirty
 * rows cost nothing to mark.
 *
 * It is built once per status read and replaced whole, never edited, which is why
 * the pane can hold it raw instead of reactive.
 */
export interface GitView {
  root: string
  branch: string | null
  oid: string | null
  detached: boolean
  ahead: number
  behind: number
  files: Map<string, GitMark>
  dirs: Map<string, GitDirMark>
  /** Directories git collapsed into a single untracked record. */
  untracked: Set<string>
  /** The work tree's own totals, for the title bar's chip. */
  summary: GitSummary
}

/**
 * git prints paths relative to the work tree's root and forward-slashed on every
 * platform, while a listing's rows carry the absolute paths this app's own
 * filesystem calls returned. They have to meet, and on a platform whose separator
 * is not `/` the join has to hand back what the rest of the app compares against.
 */
function absolutePath(root: string, rel: string): string {
  const base = root.replace(/[\\/]+$/, '')
  const joined = rel === '' ? base : `${base}/${rel}`
  return base.includes('\\') ? joined.replace(/\//g, '\\') : joined
}

/** The work-tree-relative directories holding `rel`, the root itself first. */
function ancestorDirs(rel: string): string[] {
  const dirs = ['']
  const parts = rel.split('/')
  parts.pop()

  let acc = ''
  for (const part of parts) {
    acc = acc === '' ? part : `${acc}/${part}`
    dirs.push(acc)
  }
  return dirs
}

function noteDir(dirs: Map<string, GitDirMark>, path: string, mark: GitMark): void {
  const existing = dirs.get(path)
  if (!existing) {
    dirs.set(path, { mark, count: 1 })
    return
  }

  existing.count += 1
  if (mark.rank > existing.mark.rank) existing.mark = mark
}

export function buildGitView(status: GitStatus): GitView {
  const files = new Map<string, GitMark>()
  const dirs = new Map<string, GitDirMark>()
  const untrackedDirs = new Set<string>()
  const summary: GitSummary = {
    changed: 0,
    staged: 0,
    both: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    dominant: ''
  }
  let dominantRank = 0

  for (const file of status.files) {
    // A record ending in `/` names a whole untracked directory, which is the one
    // case where git's path is a folder the listing will show as a row of its own
    // — so that folder takes the mark as well as its parents.
    const isDirectory = file.path.endsWith('/')
    const rel = isDirectory ? file.path.slice(0, -1) : file.path
    if (rel === '') continue

    const mark = markFor(file.index, file.worktree, file.from)

    // An ignored path is not a change to count; it only appears when it was asked
    // for, which nothing here does.
    if (mark.index !== '!') {
      summary.changed += 1
      if (isConflicted(mark.index, mark.worktree)) summary.conflicted += 1
      else if (mark.index === '?') summary.untracked += 1
      else if (mark.index !== ' ' && mark.worktree !== ' ') summary.both += 1
      else if (mark.index !== ' ') summary.staged += 1
      else summary.unstaged += 1

      if (mark.rank > dominantRank) {
        dominantRank = mark.rank
        summary.dominant = mark.letter
      }
    }

    if (!isDirectory) files.set(absolutePath(status.root, rel), mark)
    else untrackedDirs.add(absolutePath(status.root, rel))

    const holders = isDirectory ? [...ancestorDirs(rel), rel] : ancestorDirs(rel)
    for (const dir of holders) noteDir(dirs, absolutePath(status.root, dir), mark)
  }

  return {
    root: status.root,
    branch: status.branch,
    oid: status.oid,
    detached: status.detached,
    ahead: status.ahead,
    behind: status.behind,
    files,
    dirs,
    untracked: untrackedDirs,
    summary
  }
}

/** What a row's title says — the mark in words, and a folder's own count. */
export function markTitle(mark: GitMark, count: number, rollup: boolean): string {
  if (!rollup) return mark.label
  // A folder below a wholly untracked directory is untracked too, but git said so
  // about the top of that tree rather than about this folder, so there is no
  // count to give.
  if (count <= 0) return `${mark.label} — this whole folder`
  const entries = count === 1 ? '1 changed entry' : `${count} changed entries`
  return `${entries} inside — ${mark.label}`
}

/**
 * The mark in the few words a footer has room for: a file's own status, or how
 * many entries put a folder's mark there — the dot beside it already carries what
 * kind they are, so repeating that would only take up the room the count needs.
 */
export function markSummary(mark: GitMark, count: number, rollup: boolean): string {
  if (!rollup) return mark.short
  if (count <= 0) return `${mark.short} — whole folder`
  return count === 1 ? '1 change inside' : `${count} changes inside`
}
