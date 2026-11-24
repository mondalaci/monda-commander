/**
 * The mask a commander's Select/Unselect group asks for: a shell pattern matched
 * against an entry's *name*, which is all the dialog's field ever promises. `*`
 * stands for any run of characters and `?` for exactly one; a `[...]` set is
 * passed through as a set (with `!` or `^` negating it), and everything else is
 * literal — so the dot in `*.tar.gz` is a dot and not the regex engine's "any
 * character". No path separator is ever crossed, because a name never holds one.
 *
 * The pattern is compiled once and the returned function is what the pane runs
 * over its rows, so a listing of a few thousand names costs one regex rather
 * than one per entry.
 */
export function compileMask(mask: string, caseSensitive: boolean): (name: string) => boolean {
  let source = ''
  for (let index = 0; index < mask.length; index++) {
    const char = mask.charAt(index)
    if (char === '*') {
      source += '.*'
      continue
    }
    if (char === '?') {
      source += '.'
      continue
    }
    if (char === '[') {
      const close = classEnd(mask, index)
      if (close >= 0) {
        source += classSource(mask.slice(index, close + 1))
        index = close
        continue
      }
    }
    source += REGEX_SPECIAL.test(char) ? `\\${char}` : char
  }

  try {
    const pattern = new RegExp(`^${source}$`, caseSensitive ? '' : 'i')
    return (name) => pattern.test(name)
  } catch {
    // A pattern the regex engine will not take — a reversed range, say — is not
    // a reason for the gesture to fail: it matches its own text, which is what a
    // mask with nothing special left in it would have done.
    const literal = caseSensitive ? mask : mask.toLowerCase()
    return (name) => (caseSensitive ? name : name.toLowerCase()) === literal
  }
}

const REGEX_SPECIAL = /[\\^$.*+?()[\]{}|]/

/**
 * Where the class opened at `open` ends, or -1 when it never closes — an
 * unterminated `[` is a literal bracket, exactly as a shell reads it. A `]`
 * immediately after `[` (or after its leading `!`/`^`) is a member of the class
 * rather than its end, which is the one odd rule POSIX bracketing has.
 */
function classEnd(mask: string, open: number): number {
  let index = open + 1
  if (mask[index] === '!' || mask[index] === '^') index++
  if (mask[index] === ']') index++
  return mask.indexOf(']', index)
}

/**
 * One `[...]` class, as the regex engine wants it: `!` negates in a glob where
 * `^` does in a regex, and a glob's backslash is a literal member while a
 * regex's would escape the character after it.
 */
function classSource(source: string): string {
  let inner = source.slice(1, -1)
  if (inner.startsWith('!')) inner = `^${inner.slice(1)}`
  // A backslash is a literal member of a glob's class but an escape in a
  // regex's, and a `]` written first in the class is a member rather than its
  // end only if it is escaped there too.
  return `[${inner.replace(/\\/g, '\\\\').replace(/]/g, '\\]')}]`
}
