import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'

/**
 * The quick cd directories, kept on disk so the list outlives the window. It is
 * a plain list of absolute directory paths — the order is the user's, so nothing
 * sorts or dedups it here beyond dropping entries that are not usable strings.
 * A pane shows this list in place of its directory (see `quickCd` in
 * `useDirectory`), and the row menu is what adds to and removes from it.
 */
interface PersistedQuickCd {
  directories: string[]
}

function statePath(): string {
  return join(app.getPath('userData'), 'quick-cd.json')
}

/** The remembered directories, or an empty list when nothing has been stored. */
export function readQuickCd(): string[] {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8')) as Partial<PersistedQuickCd>
    if (!Array.isArray(parsed.directories)) return []
    return parsed.directories.filter(
      (entry): entry is string => typeof entry === 'string' && entry.length > 0
    )
  } catch {
    // Absent or mangled state is simply an empty hotlist: there is nothing to
    // recover, and an error would only get in the way of adding the first one.
    return []
  }
}

export function writeQuickCd(directories: string[]): void {
  const clean = Array.isArray(directories)
    ? directories.filter((entry) => typeof entry === 'string' && entry.length > 0)
    : []
  try {
    const file = statePath()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ directories: clean }))
  } catch {
    // A list that cannot be written is not worth failing the gesture over; the
    // next add or remove tries again.
  }
}
