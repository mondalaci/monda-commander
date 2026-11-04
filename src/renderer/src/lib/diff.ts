import type * as MonacoApi from 'monaco-editor'
import { DIFF_COLORS } from '@renderer/lib/gitMark'

/**
 * The viewer's changed-line view: which of a file's lines the working copy has
 * added, changed or taken away since HEAD, and — for the removed side, which has
 * no line of its own — the baseline's text the viewer shows inline. The
 * comparison is made here, in the renderer, against a baseline main read out of
 * git (`git:file-base`), so it can be recomputed as the user types and the marks
 * move with the text instead of being a snapshot that drifts under the caret.
 *
 * Monaco's own diff engine would answer this, but only through a second editor or
 * a deep import into its untyped internals; the comparison is therefore a plain
 * longest-common-subsequence over the two files' lines. The common head and tail
 * are trimmed first — an ordinary edit leaves only the stretch between the first
 * and last line that differ — and what is left rarely reaches the quadratic core
 * at all. A stretch too large to align exactly (`MAX_CELLS`) is reported as one
 * change rather than guessed at.
 */

/**
 * One run of lines that differs between HEAD and the working copy. Every number
 * is 1-based and inclusive, and a side that the run does not touch — the baseline
 * of an insertion, the buffer of a removal — is left at zero.
 */
export interface LineChange {
  /** Baseline lines the run takes away; 0 when it adds only. */
  baseStart: number
  baseEnd: number
  /** Buffer lines the run puts in their place; 0 when it removes only. */
  currentStart: number
  currentEnd: number
  /**
   * For a run with no buffer lines of its own, the line it sits after; 0 means
   * above the first line. Ignored when the run has buffer lines, which anchor it
   * from the line before they start.
   */
  afterLine: number
}

/**
 * The most cells the alignment matrix may hold before a stretch is given up on
 * and shown whole. It bounds the transient allocation rather than the files: with
 * the common head and tail already trimmed, only the changed stretch is measured,
 * so this is reached only by a file whose first and last lines both differ across
 * thousands of lines.
 */
const MAX_CELLS = 4_000_000

/**
 * The lines of a file as text, without their terminators, and without counting a
 * final newline as an extra empty line — so a file and the blob it came from
 * split the same way however each ends, and a CRLF checkout does not differ from
 * the LF blob line by line. Monaco's own `getLinesContent` lands one empty line
 * past this for a text that ends in a newline; the viewer drops that one so the
 * buffer meets the baseline here.
 */
export function toLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split(/\r\n|\r|\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Every run of lines the working copy has changed from the baseline, in file
 * order, from the two files' lines. Taking the lines rather than the text is what
 * lets the baseline be split once and the buffer come straight from the editor.
 */
export function diffLineArrays(a: string[], b: string[]): LineChange[] {
  // The common head and tail are the same lines on both sides, so they cannot be
  // part of any change and are dropped before the quadratic step. The head is
  // counted once because it is common to both.
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1

  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1
  }

  const runs = align(a.slice(head, a.length - tail), b.slice(head, b.length - tail))

  return runs.map((run) => {
    const hasBase = run.baseEnd > run.baseStart
    const hasCurrent = run.currentEnd > run.currentStart

    return {
      baseStart: hasBase ? head + run.baseStart + 1 : 0,
      baseEnd: hasBase ? head + run.baseEnd : 0,
      currentStart: hasCurrent ? head + run.currentStart + 1 : 0,
      currentEnd: hasCurrent ? head + run.currentEnd : 0,
      // A run with buffer lines is anchored above them; a removal has none, so it
      // names the line it sat after — or the top of the file.
      afterLine: hasCurrent ? 0 : head + run.anchor
    }
  })
}

/** A changed run within the trimmed regions, in half-open line indices. */
interface RegionRun {
  baseStart: number
  baseEnd: number
  currentStart: number
  currentEnd: number
  /** For a deletion-only run, the current line the removed block sat after. */
  anchor: number
}

/**
 * The runs that differ between two already-trimmed line sequences, via their
 * longest common subsequence. A sequence with no lines at all is one run of the
 * other; a stretch past `MAX_CELLS` is one run covering it.
 */
function align(a: string[], b: string[]): RegionRun[] {
  const n = a.length
  const m = b.length

  if (n === 0 && m === 0) return []
  if (n === 0 || m === 0 || n * m > MAX_CELLS) {
    return [{ baseStart: 0, baseEnd: n, currentStart: 0, currentEnd: m, anchor: 0 }]
  }

  // dp[i][j] is the length of the longest common subsequence of a[0..i) and
  // b[0..j). It is walked back from the far corner to recover which lines were
  // matched, and everything the walk did not match is a change.
  const width = m + 1
  const dp = new Uint32Array((n + 1) * width)
  for (let i = 1; i <= n; i += 1) {
    const row = i * width
    const previous = (i - 1) * width
    const line = a[i - 1]
    for (let j = 1; j <= m; j += 1) {
      dp[row + j] =
        line === b[j - 1]
          ? (dp[previous + j - 1] ?? 0) + 1
          : Math.max(dp[previous + j] ?? 0, dp[row + j - 1] ?? 0)
    }
  }

  // Each step says which side it consumed: `base` a line of the baseline, or
  // `current` a line of the working copy. A match consumes both.
  const steps: Array<{ matched: boolean; base: boolean; i: number; j: number }> = []
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      i -= 1
      j -= 1
      steps.push({ matched: true, base: false, i, j })
      continue
    }

    // Preferring the baseline side on a tie keeps a rewritten line reading as a
    // modification rather than a delete-then-add pair.
    if (
      j > 0 &&
      (i === 0 || (dp[i * width + j - 1] ?? 0) >= (dp[(i - 1) * width + j] ?? 0))
    ) {
      j -= 1
      steps.push({ matched: false, base: false, i, j })
    } else {
      i -= 1
      steps.push({ matched: false, base: true, i, j })
    }
  }

  steps.reverse()

  // Consecutive unmatched steps are one run; a matched step closes it. The
  // baseline and current ranges each grow from the lines they actually consumed,
  // so a run that has no line on one side stays empty there.
  const runs: RegionRun[] = []
  let run: RegionRun | null = null
  let sawBase = false
  let sawCurrent = false

  for (const step of steps) {
    if (step.matched) {
      run = null
      sawBase = false
      sawCurrent = false
      continue
    }

    if (!run) {
      run = {
        baseStart: 0,
        baseEnd: 0,
        currentStart: 0,
        currentEnd: 0,
        anchor: step.j
      }
      runs.push(run)
    }

    if (step.base) {
      run.baseStart = sawBase ? Math.min(run.baseStart, step.i) : step.i
      run.baseEnd = Math.max(run.baseEnd, step.i + 1)
      run.anchor = step.j
      sawBase = true
    } else {
      run.currentStart = sawCurrent ? Math.min(run.currentStart, step.j) : step.j
      run.currentEnd = Math.max(run.currentEnd, step.j + 1)
      sawCurrent = true
    }
  }

  return runs
}

/**
 * The Monaco decorations a set of changes is drawn with: the tinted line and the
 * gutter decoration for the buffer's side of a change, and a mark in the overview
 * ruler for both sides. The removed side is not a decoration at all — it has no
 * line in the buffer to sit on — and is shown by the viewer as an inline view
 * zone above the run; the triangle here is only the cue left in the gutter. The
 * classes themselves are in `styles/diff.css`.
 */
export function diffDecorations(
  monaco: typeof MonacoApi,
  changes: LineChange[]
): MonacoApi.editor.IModelDeltaDecoration[] {
  const decorations: MonacoApi.editor.IModelDeltaDecoration[] = []

  for (const change of changes) {
    if (change.currentStart > 0) {
      const added = change.baseStart === 0
      decorations.push({
        range: new monaco.Range(change.currentStart, 1, change.currentEnd, 1),
        options: {
          isWholeLine: true,
          className: added ? 'mc-diff-added' : 'mc-diff-modified',
          linesDecorationsClassName: added ? 'mc-diff-added-gutter' : 'mc-diff-modified-gutter',
          linesDecorationsTooltip: added ? 'Added since HEAD' : 'Changed since HEAD',
          overviewRuler: {
            color: added ? DIFF_COLORS.added : DIFF_COLORS.modified,
            position: monaco.editor.OverviewRulerLane.Left
          }
        }
      })
      continue
    }

    // A removal has no buffer line to tint; its removed text is the viewer's
    // inline zone, and all that is left here is the cue in the gutter.
    const at = Math.max(1, change.afterLine)
    decorations.push({
      range: new monaco.Range(at, 1, at, 1),
      options: {
        linesDecorationsClassName: 'mc-diff-deleted',
        linesDecorationsTooltip: 'Removed since HEAD',
        overviewRuler: {
          color: DIFF_COLORS.deleted,
          position: monaco.editor.OverviewRulerLane.Left
        }
      }
    })
  }

  return decorations
}
