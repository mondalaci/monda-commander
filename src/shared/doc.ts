import { joinArchivePath, splitArchivePath } from './archive'

/**
 * The two kinds of document the app typesets itself. A *markdown* file is prose
 * with markup; a *mermaid* file is one diagram's source and nothing else. Both
 * are read as text and rendered in the renderer — no external program has to be
 * installed, which is what makes the viewer native rather than a hand-off.
 */
export type DocFormat = 'markdown' | 'mermaid'

/**
 * Extensions the app renders as markdown. `.mdx` is included because the
 * markup it adds to a document is the kind a reader skips over: the prose is
 * still markdown, and showing it as such beats handing the file to an editor.
 * The list is a *rendering* promise, so it holds no format whose markup the
 * renderer cannot draw; a `.rst` or a `.adoc` is an ordinary text file.
 */
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkdn', 'mkd', 'mdwn', 'mdx'])

/**
 * Extensions the app renders as one mermaid diagram. `.mermaid` is mermaid's
 * own long spelling and is seen in the wild beside the `.mmd` most tools write.
 */
const MERMAID_EXTENSIONS = new Set(['mmd', 'mermaid'])

/** The document family a name belongs to, or null when it is not a document. */
export function docFormatFor(name: string): DocFormat | null {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return null
  const extension = name.slice(dot + 1).toLowerCase()
  if (MARKDOWN_EXTENSIONS.has(extension)) return 'markdown'
  if (MERMAID_EXTENSIONS.has(extension)) return 'mermaid'
  return null
}

/** Whether a name is one of the documents the display can typeset. */
export function isDocName(name: string): boolean {
  return docFormatFor(name) !== null
}

/**
 * The directory a location sits in, in the same shape the location uses — the
 * pane's own `navigateTo` takes it, so a link to another document can move the
 * cursor to it rather than handing the file to the system. An archive's inner
 * path is answered inside the archive, which is what keeps a link to a sibling
 * entry in the same archive.
 */
export function docParentDir(location: string): string {
  const archive = splitArchivePath(location)
  if (archive) {
    const slash = archive.inner.lastIndexOf('/')
    return joinArchivePath(archive.archive, slash < 0 ? '' : archive.inner.slice(0, slash))
  }
  const slash = location.lastIndexOf('/')
  if (slash < 0) return '.'
  return slash === 0 ? '/' : location.slice(0, slash)
}

/** A slash-separated path split into its segments. */
function segments(path: string): string[] {
  return path.split('/').filter((part) => part !== '')
}

/**
 * Resolve `.` and `..` in a slash-separated path. `absolute` keeps the leading
 * slash and clamps `..` at the root; a relative path that climbs above where it
 * started is not a path at all and answers null — which is what stops an
 * archive-relative reference from walking out of the archive's own root.
 */
function normalizePath(path: string, absolute: boolean): string | null {
  const out: string[] = []
  for (const part of segments(path)) {
    if (part === '.') continue
    if (part === '..') {
      if (out.length === 0) {
        if (absolute) continue
        return null
      }
      out.pop()
      continue
    }
    out.push(part)
  }
  const joined = out.join('/')
  return absolute ? `/${joined}` : joined
}

/**
 * The path a reference inside a document points at, resolved against the
 * document's own place — the base a browser would resolve a relative URL
 * against. Null for what the app cannot answer: an absolute URL (`https:`,
 * `data:`), a bare fragment, or a relative path that climbs above its root.
 *
 * It understands the archive location as well as the real one, so an image
 * beside a markdown entry inside a `.zip` resolves to that entry rather than to
 * a same-named file on disk. A reference is a URL, so a percent-encoded space
 * is decoded; the query and fragment are dropped, since neither names a file.
 */
export function resolveDocRef(docPath: string, reference: string): string | null {
  const raw = reference.trim()
  if (raw === '' || raw.startsWith('#')) return null
  // A scheme (`http:`, `data:`, `file:`) or a protocol-relative `//host`.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return null

  const cut = raw.search(/[?#]/)
  const withoutQuery = cut < 0 ? raw : raw.slice(0, cut)
  if (withoutQuery === '') return null
  let decoded = withoutQuery
  try {
    decoded = decodeURIComponent(withoutQuery)
  } catch {
    // A stray `%` is left as it is rather than failing the whole reference.
  }

  const archive = splitArchivePath(docPath)
  if (archive) {
    let inner: string
    let absolute: boolean
    if (decoded.startsWith('/')) {
      inner = decoded
      absolute = true
    } else {
      const slash = archive.inner.lastIndexOf('/')
      const base = slash < 0 ? '' : archive.inner.slice(0, slash + 1)
      inner = base + decoded
      absolute = false
    }
    const normalized = normalizePath(inner, absolute)
    if (normalized === null) return null
    return joinArchivePath(archive.archive, normalized)
  }

  if (decoded.startsWith('/')) {
    const normalized = normalizePath(decoded, true)
    return normalized === null ? null : normalized
  }

  const slash = docPath.lastIndexOf('/')
  const base = slash < 0 ? '' : docPath.slice(0, slash + 1)
  const combined = base + decoded
  const normalized = normalizePath(combined, combined.startsWith('/'))
  return normalized === null ? null : normalized
}
