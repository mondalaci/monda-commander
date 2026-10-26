import type { GitFileStatus, GitStatus } from '@shared/types'

/**
 * Reading `git status --porcelain=v2`. Kept apart from the IPC handler, exactly
 * as the image header and the video codec readers are: this is the part with all
 * the parsing in it, and none of it needs Electron to be run.
 *
 * Porcelain v2, NUL-separated. The `-z` form is not a convenience: it is what
 * lets a path hold a space or a newline without being quoted, exactly as the
 * filesystem layer needs, and it is also what makes a rename's origin an
 * unambiguous field — for a `2` record the record that follows *is* the original
 * path, with no tag of its own.
 */
export function parseStatus(stdout: string, root: string): GitStatus {
  const records = stdout.split('\0')
  const files: GitFileStatus[] = []
  let branch: string | null = null
  let oid: string | null = null
  let detached = false
  let ahead = 0
  let behind = 0

  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]
    if (record === undefined || record === '') continue

    if (record.startsWith('# ')) {
      const header = record.slice(2)
      if (header.startsWith('branch.head ')) {
        const value = header.slice('branch.head '.length)
        if (value === '(detached)') detached = true
        else branch = value
      } else if (header.startsWith('branch.oid ')) {
        const value = header.slice('branch.oid '.length)
        // On a repository with no commits yet the oid is the literal `(initial)`.
        oid = value === '(initial)' ? null : value
      } else if (header.startsWith('branch.ab ')) {
        const counts = /^\+(\d+) -(\d+)$/.exec(header.slice('branch.ab '.length))
        if (counts) {
          ahead = Number(counts[1])
          behind = Number(counts[2])
        }
      }
      continue
    }

    if (record.startsWith('? ')) {
      files.push({ path: record.slice(2), index: '?', worktree: '?', from: null })
      continue
    }

    // `!` is an ignored path, and only ever appears when it was asked for.
    if (record.startsWith('! ')) continue

    if (record.startsWith('2 ')) {
      // `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>` — and the
      // original path rides in the record that follows.
      const parts = record.split(' ')
      const xy = parts[1] ?? '??'
      files.push({
        path: parts.slice(9).join(' '),
        index: xy[0] ?? '.',
        worktree: xy[1] ?? '.',
        from: records[i + 1] ?? null
      })
      i += 1
      continue
    }

    if (record.startsWith('1 ')) {
      // `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
      const parts = record.split(' ')
      const xy = parts[1] ?? '??'
      files.push({
        path: parts.slice(8).join(' '),
        index: xy[0] ?? '.',
        worktree: xy[1] ?? '.',
        from: null
      })
      continue
    }

    if (record.startsWith('u ')) {
      // `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
      const parts = record.split(' ')
      const xy = parts[1] ?? 'UU'
      files.push({
        path: parts.slice(10).join(' '),
        index: xy[0] ?? 'U',
        worktree: xy[1] ?? 'U',
        from: null
      })
    }
  }

  return { root, branch, oid, detached, ahead, behind, files }
}
