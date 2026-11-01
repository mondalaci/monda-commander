/**
 * Where a pane is: a real directory, or a place inside an archive file.
 *
 * A location is one string, so every path-keyed thing in the app — marks, the
 * cursor anchor, the size-walk map, the watcher's match — keeps working by equal
 * string comparison, and no consumer has to learn a second shape. The two halves
 * are joined by NUL, which cannot occur in a POSIX path *or* in an archive entry
 * name (names are NUL-terminated), so the separator can never be mistaken for a
 * character a file or an entry really contains. `<archive>\0<inner>` is an
 * archive location; `<inner>` may be empty, which is the archive's own root.
 *
 * The NUL form is internal. Nothing is ever handed to a syscall or shown to the
 * user; `archiveDisplay` is the readable form the pane title draws.
 */
export const ARCHIVE_SEP = '\u0000'

/** Whether a path names a place inside an archive rather than a real path. */
export function isArchivePath(value: string): boolean {
  return value.includes(ARCHIVE_SEP)
}

/**
 * The two halves of an archive location: the archive file's real path, and the
 * entry path inside it (forward-slashed, no leading or trailing separator; empty
 * at the archive's root). Null for a real path.
 */
export function splitArchivePath(value: string): { archive: string; inner: string } | null {
  const at = value.indexOf(ARCHIVE_SEP)
  if (at < 0) return null
  return { archive: value.slice(0, at), inner: value.slice(at + 1) }
}

/**
 * Join an archive's real path and an entry path into one location string. The
 * inner path is normalized to the shape `splitArchivePath` returns — forward
 * slashes, no leading or trailing separator — so a location built here and one
 * read back from a listing are the same string.
 */
export function joinArchivePath(archive: string, inner: string): string {
  const clean = normalizeInner(inner)
  return `${archive}${ARCHIVE_SEP}${clean}`
}

/** An entry path with its separators normalized and its ends trimmed. */
export function normalizeInner(inner: string): string {
  const parts = inner.replaceAll('\\', '/').split('/').filter((part) => part !== '' && part !== '.')
  return parts.join('/')
}

/** The last path segment of a real path, for a name to show; both separators. */
export function baseName(value: string): string {
  const slash = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
  return slash >= 0 ? value.slice(slash + 1) : value
}

/**
 * What the pane title draws for an archive location: the archive's own name, the
 * directory that holds it, and the full path for the chip's tooltip, plus the
 * entry path to show after it. Null when the pane is not inside an archive, which
 * is when the title is the plain path.
 */
export function archiveDisplay(
  value: string
): { name: string; dir: string; full: string; inner: string } | null {
  const location = splitArchivePath(value)
  if (!location) return null
  const full = location.archive
  const slash = Math.max(full.lastIndexOf('/'), full.lastIndexOf('\\'))
  return {
    name: slash >= 0 ? full.slice(slash + 1) : full,
    dir: slash > 0 ? full.slice(0, slash) : slash === 0 ? '/' : '',
    full,
    inner: location.inner
  }
}

/**
 * Extensions a pane will offer to enter as a directory. This is deliberately its
 * own list, not the icon table's `archive` set: the icon table *colours* a name
 * (a `.img`, a `.dmg`), while entering one is a promise that the backend can
 * actually open it, and the icon table is not about that. The last extension is
 * what is tested, so a compound name like `tar.gz` is answered by `gz` — which is
 * the one 7z opens first, and listing then follows through to the tar inside.
 */
const ENTERABLE_ARCHIVE_EXTENSIONS = new Set([
  'zip',
  'zipx',
  '7z',
  'rar',
  'tar',
  'gz',
  'bz2',
  'xz',
  'zst',
  'lz',
  'lzma',
  'lzo',
  'z',
  'cab',
  'ar',
  'cpio',
  'iso',
  'deb',
  'rpm',
  'jar',
  'war',
  'ear',
  'apk',
  'aar',
  'whl',
  'xpi',
  'crx',
  'vsix',
  'nupkg',
  'ipa',
  'msi',
  'chm',
  'xar'
])

/**
 * Whether entering a file of this name means entering an archive. A name with no
 * extension, or one the backend does not open, answers false and is treated as an
 * ordinary file — which is the fallback whenever this is wrong in either
 * direction: a false negative just opens the file as it always did.
 */
export function isEnterableArchiveName(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return false
  return ENTERABLE_ARCHIVE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}
