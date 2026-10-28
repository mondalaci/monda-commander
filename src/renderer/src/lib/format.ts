const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

/**
 * A clip's position or length, as `m:ss` — or `h:mm:ss` once it runs past the
 * hour, which a camcorder tape's files do.
 */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  const pad = (value: number): string => String(value).padStart(2, '0')

  if (minutes < 60) return `${minutes}:${pad(rest)}`
  return `${Math.floor(minutes / 60)}:${pad(minutes % 60)}:${pad(rest)}`
}

/**
 * How far a clip was stepped, for the seek flash: whole minutes as `1m`/`10m` —
 * the coarser keys step by those — and seconds otherwise.
 */
export function formatSeekStep(seconds: number): string {
  const total = Math.abs(seconds)
  return total >= 60 && total % 60 === 0 ? `${total / 60}m` : `${total}`
}

export function formatSize(bytes: number): string {
  if (bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`

  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }

  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(decimals)} ${SIZE_UNITS[unit]}`
}

const relativeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

const RELATIVE_DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, unit: 'second' },
  { amount: 60, unit: 'minute' },
  { amount: 24, unit: 'hour' },
  { amount: 7, unit: 'day' },
  { amount: 4.34524, unit: 'week' },
  { amount: 12, unit: 'month' },
  { amount: Number.POSITIVE_INFINITY, unit: 'year' }
]

/**
 * How long ago a file was modified, as `2 hours ago` / `yesterday` / `last
 * month` — the listing's own sense of time, which cares about the order of
 * events rather than their exact instant. The exact timestamp is one hover
 * away (`formatExactDate`).
 */
export function formatRelativeDate(mtimeMs: number): string {
  let duration = (mtimeMs - Date.now()) / 1000

  for (const { amount, unit } of RELATIVE_DIVISIONS) {
    if (Math.abs(duration) < amount) return relativeFormatter.format(Math.round(duration), unit)
    duration /= amount
  }

  return ''
}

const exactFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
})

/** The timestamp behind a relative date, for the hover tooltip. */
export function formatExactDate(mtimeMs: number): string {
  return exactFormatter.format(new Date(mtimeMs))
}

const PERMISSION_SYMBOLS = [
  { mask: 0o400, symbol: 'r' },
  { mask: 0o200, symbol: 'w' },
  { mask: 0o100, symbol: 'x' },
  { mask: 0o040, symbol: 'r' },
  { mask: 0o020, symbol: 'w' },
  { mask: 0o010, symbol: 'x' },
  { mask: 0o004, symbol: 'r' },
  { mask: 0o002, symbol: 'w' },
  { mask: 0o001, symbol: 'x' }
] as const

export function formatMode(mode: number): string {
  let result = ''
  for (const { mask, symbol } of PERMISSION_SYMBOLS) {
    result += (mode & mask) === mask ? symbol : '-'
  }
  return result
}

/**
 * The permission bits in octal — the numeric half of `formatMode`, so a mode is
 * either `rw-r--r--` or `644`. The file-type bits are not a permission and are
 * left out, and the four-digit form appears on its own when a setuid, setgid or
 * sticky bit is set (`4755`), so the number is always at least three digits.
 */
export function formatModeNumeric(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(3, '0')
}
