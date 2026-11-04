/**
 * A directory change asked for at the command line, read off the line itself.
 *
 * The command line is the real shell, so the app never runs the command — but a
 * `cd` that does not take leaves the shell, and the pane synced to it, where it
 * was, while the shell's own complaint about why sits a row above the prompt the
 * collapsed strip shows. To say something in the pane instead, the app has to
 * know that a directory change was asked for at all; this reads that off the
 * submitted line.
 *
 * The reading is deliberately conservative: anything it cannot resolve — a shell
 * expansion, a glob, an escape — is left to the shell rather than guessed at,
 * because a wrong answer here is a failure reported for a `cd` that worked.
 */

/** The word that asked for the change, and the path it named. */
export interface DirectoryChange {
  /** `cd`, or `pushd`, so the notice can echo the word the user typed. */
  name: string
  /**
   * The path the line names, as it was written (options, a `--` and quotes
   * removed). Empty when the line names no plain path — a bare `cd` (the home
   * directory), `cd -` (`$OLDPWD`), or a target the shell must expand itself —
   * where whether it worked is only the shell's to say.
   */
  target: string
}

/**
 * What a submitted command line really is, if it begins with a directory change.
 * Null when it begins with anything else — `ls`, `sudo cd x`, `builtin cd` — so
 * only a change the shell would read as one is answered for.
 */
export function directoryChange(command: string): DirectoryChange | null {
  const trimmed = command.trim()
  // A line that continues on the next one has not run yet: the shell is waiting
  // for its other half, not reporting on it, and the `cd` at its front has not
  // happened. (An open quote is caught by `tokens` below, the same way.)
  if (/(\|\||&&|\|)$/.test(trimmed) || trimmed.endsWith('\\')) return null

  // Only the first command of a line moved the shell: `ls; cd x` is a listing,
  // and whether the `cd` after it failed is not something a pane notice is owed.
  // The split is textual, so an operator inside a quote counts here too; the cost
  // of reading that wrong is a notice not shown, never a wrong one.
  const first = trimmed.split(/&&|\|\||;|\|/, 1)[0]?.trim() ?? ''
  const head = first.match(/^\S+/)?.[0] ?? ''
  if (head !== 'cd' && head !== 'pushd') return null

  const args = tokens(first.slice(head.length))
  if (args === null) return { name: head, target: '' }

  for (const arg of args) {
    // An option, the `--` that ends them, or `-` alone (`$OLDPWD`) is not the
    // path: only the shell can say whether any of those worked.
    if (arg.startsWith('-')) continue
    if (!isPlainPath(arg)) return { name: head, target: '' }
    return { name: head, target: arg }
  }
  return { name: head, target: '' }
}

/**
 * A command's tail split into arguments, quotes removed. Null for an
 * unterminated quote, where the shell is still waiting for the line to close and
 * nothing has run.
 */
function tokens(text: string): string[] | null {
  const out: string[] = []
  let i = 0

  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i]!)) i += 1
    if (i >= text.length) break

    const quote = text[i]
    if (quote === '"' || quote === "'") {
      let value = ''
      i += 1
      while (i < text.length && text[i] !== quote) {
        // A backslash escapes inside double quotes; inside single quotes it is a
        // character the shell keeps as it stands.
        if (quote === '"' && text[i] === '\\' && i + 1 < text.length) {
          i += 1
          value += text[i]!
          i += 1
          continue
        }
        value += text[i]
        i += 1
      }
      if (i >= text.length) return null
      i += 1
      out.push(value)
      continue
    }

    const start = i
    while (i < text.length && !/\s/.test(text[i]!)) i += 1
    out.push(text.slice(start, i))
  }
  return out
}

/**
 * Whether a target is written plainly enough to resolve against the shell's own
 * directory: no shell expansion (`$FOO`, a backtick, a glob, a brace, an escape)
 * and no `~user` — all of which the shell is the one to resolve, so the app has
 * no business reporting on whether they worked.
 */
function isPlainPath(target: string): boolean {
  if (/[$`*?[{\\]/.test(target)) return false
  if (target.startsWith('~') && target !== '~' && !target.startsWith('~/')) return false
  return true
}

/**
 * Where a plain target points, read the way the shell would: `~` is the home
 * directory, a leading `/` is absolute, and anything else is relative to the
 * directory the command ran in. Null when there is nothing to resolve against —
 * `~` with no home known, or a relative path with no cwd — in which case no one
 * should be told the change failed. `..` and `.` are left for the filesystem to
 * fold, which is what the check that follows asks anyway.
 */
export function resolveDirectoryTarget(
  target: string,
  cwd: string,
  home: string
): string | null {
  if (target === '~') return home || null
  if (target.startsWith('~/')) return home ? `${home}${target.slice(1)}` : null
  if (target.startsWith('/')) return target
  if (!cwd) return null
  return cwd.endsWith('/') ? `${cwd}${target}` : `${cwd}/${target}`
}

/**
 * The reason a directory change failed, in the shell's own words. The error is
 * the one `list` gave for the path — a real errno from the filesystem — so the
 * common ones are spelled as a shell would spell them and the rest are passed
 * through rather than flattened into a guess.
 */
export function directoryChangeReason(error: { code: string; message: string }): string {
  switch (error.code) {
    case 'ENOENT':
      return 'No such file or directory'
    case 'ENOTDIR':
      return 'Not a directory'
    case 'EACCES':
      return 'Permission denied'
    case 'ELOOP':
      return 'Too many levels of symbolic links'
    case 'ENAMETOOLONG':
      return 'File name too long'
    default:
      return error.message || error.code
  }
}
