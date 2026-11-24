import { readFileSync } from 'node:fs'

/**
 * Who owns an entry, as the names a status bar shows beside a row's mode: a
 * listing's metadata carries the numeric ids (`stats.uid` / `stats.gid`), and a
 * name is a lookup that would otherwise have to be made per row.
 *
 * The names come from `/etc/passwd` and `/etc/group`, each read once and kept —
 * a few kilobytes read for the whole table, which is cheaper than one lookup per
 * row and is where a uid is spelled on a Linux box. A directory of ten thousand
 * files asks about a handful of ids, so the map answers almost every call.
 *
 * An id the files do not name is shown as the number itself. That is not a
 * failure: a name can also come from a directory service (LDAP, sssd,
 * systemd-homed) that these files know nothing about, and asking `getent` per id
 * would spawn a process on the listing's hot path to learn it. A number is what
 * the metadata really holds, showing it is honest, and it never holds up a
 * listing.
 */

/** The id → name table one colon-separated file gives, or an empty map. */
function readIdTable(file: string, idIndex: number): Map<number, string> {
  const table = new Map<number, string>()

  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    // No such file — a platform that keeps identities elsewhere, or a sandbox
    // without `/etc`. Every id then reads as its own number.
    return table
  }

  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue
    const fields = line.split(':')
    const name = fields[0]
    const id = Number(fields[idIndex])
    if (fields.length <= idIndex || !name || !Number.isInteger(id)) continue
    // The first line naming an id wins: a NIS compatibility line can repeat one.
    if (!table.has(id)) table.set(id, name)
  }

  return table
}

let userNames: Map<number, string> | null = null
let groupNames: Map<number, string> | null = null

/** The name a uid is spelled with, or the number when no table names it. */
export function userNameFor(uid: number): string {
  userNames ??= readIdTable('/etc/passwd', 2)
  return userNames.get(uid) ?? String(uid)
}

/** The name a gid is spelled with, or the number when no table names it. */
export function groupNameFor(gid: number): string {
  groupNames ??= readIdTable('/etc/group', 2)
  return groupNames.get(gid) ?? String(gid)
}

/**
 * The owner and group of a stat as the listing carries them, or nulls where the
 * metadata has no ids at all (a platform whose `Stats` has no `uid`). It is what
 * a `readEntry` spreads into its entry, so the two names are decided in one
 * place and always travel together.
 */
export function identityOf(stats: { uid?: number; gid?: number }): {
  owner: string | null
  group: string | null
} {
  return {
    owner: typeof stats.uid === 'number' ? userNameFor(stats.uid) : null,
    group: typeof stats.gid === 'number' ? groupNameFor(stats.gid) : null
  }
}
