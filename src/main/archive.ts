import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { joinArchivePath, normalizeInner } from '@shared/archive'
import type { DirEntry, DirListing } from '@shared/types'

/**
 * Reading archives by asking `7z`, one memoized probe away from nothing — the
 * same shape as git (`MC_GIT`) and transcoding (`MC_FFMPEG`). A library was not
 * used because the reach is the point: 7z opens zip, 7z, tar, the tar
 * compressions, rar, cab, iso, deb, rpm and more, and a bundled JS library
 * covers a handful of those at best. `MC_7Z` names the binary when it is not the
 * `7z` on `PATH`.
 *
 * Nothing here touches Electron: this module is the pure reader, as
 * `gitStatus.ts` is, and `ipc/fs.ts` is what wires it to the bridge.
 */
const SEVEN_ZIP = process.env.MC_7Z ?? '7z'

/** Ceiling on a listing. A tree of hundreds of thousands of entries is text in
 * the tens of megabytes; past this the answer is refused rather than streamed
 * into the renderer. */
const MAX_LIST_BYTES = 256 * 1024 * 1024

/** How long one 7z invocation may run before it is killed. A wedged binary must
 * not hold the IPC answer forever. */
const COMMAND_TIMEOUT_MS = 120_000

interface ArchiveFailure extends Error {
  code?: string
}

function archiveFailure(message: string, code = 'EARCHIVE'): ArchiveFailure {
  return Object.assign(new Error(message), { code })
}

/** 7z's own stderr, stripped of the banner it prints on every call. */
function cleanStderr(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('7-Zip ') && !line.startsWith('Scanning '))
  return lines[lines.length - 1] ?? ''
}

/**
 * One 7z invocation, stdout collected as bytes. An ENOENT is reported as its own
 * code so the probe can tell "no 7z here" from "7z refused this archive".
 */
function run7z(args: string[], maxBytes = MAX_LIST_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(SEVEN_ZIP, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(archiveFailure((error as Error).message, 'EARCHIVE'))
      return
    }

    const chunks: Buffer[] = []
    let size = 0
    let stderr = ''
    let settled = false

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      fn()
    }

    const timer = setTimeout(
      () => finish(() => reject(archiveFailure('7z timed out', 'ETIMEDOUT'))),
      COMMAND_TIMEOUT_MS
    )

    child.stdout!.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > maxBytes) {
        finish(() => reject(archiveFailure('Archive data is too large to handle', 'E2BIG')))
        return
      }
      chunks.push(chunk)
    })
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          error.code === 'ENOENT'
            ? archiveFailure('7z is not installed', 'ENO7Z')
            : archiveFailure(error.message, error.code ?? 'EARCHIVE')
        )
      )
    })
    child.on('close', (code) => {
      if (settled) return
      if (code === 0) finish(() => resolve(Buffer.concat(chunks)))
      else finish(() => reject(archiveFailure(cleanStderr(stderr) || `7z exited with code ${code}`)))
    })
  })
}

/**
 * Two 7z invocations with the first's output piped into the second's input, so a
 * file inside a compressed tar can be read without the tar ever being written to
 * disk. `-si` is what tells the second 7z to read its archive from stdin, and
 * `-t<type>` what to read it as.
 */
function run7zPipe(stages: string[][], maxBytes = MAX_LIST_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const children = stages.map((args, index) => {
      const stdio: StdioOptions = [index === 0 ? 'ignore' : 'pipe', 'pipe', 'pipe']
      return spawn(SEVEN_ZIP, args, { stdio })
    })
    const last = children[children.length - 1]
    if (!last || !last.stdout) {
      reject(archiveFailure('Could not start 7z'))
      return
    }

    const errors = children.map(() => '')
    let settled = false

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }
      fn()
    }

    const timer = setTimeout(
      () => finish(() => reject(archiveFailure('7z timed out', 'ETIMEDOUT'))),
      COMMAND_TIMEOUT_MS
    )

    children.forEach((child, index) => {
      child.stderr?.on('data', (chunk: Buffer) => {
        errors[index] += chunk.toString('utf8')
      })
      child.on('error', (error: NodeJS.ErrnoException) => {
        finish(() =>
          reject(
            error.code === 'ENOENT'
              ? archiveFailure('7z is not installed', 'ENO7Z')
              : archiveFailure(error.message, error.code ?? 'EARCHIVE')
          )
        )
      })
    })

    for (let index = 0; index < children.length - 1; index += 1) {
      const from = children[index]
      const to = children[index + 1]
      if (!from || !to) continue
      from.stdout?.pipe(to.stdin as NodeJS.WritableStream)
      from.stdout?.on('error', () => undefined)
    }

    const chunks: Buffer[] = []
    let size = 0
    last.stdout.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > maxBytes) {
        finish(() => reject(archiveFailure('Archive data is too large to handle', 'E2BIG')))
        return
      }
      chunks.push(chunk)
    })
    last.on('close', (code) => {
      if (settled) return
      if (code === 0) finish(() => resolve(Buffer.concat(chunks)))
      else
        finish(() =>
          reject(
            archiveFailure(cleanStderr(errors[children.length - 1] ?? '') || `7z exited with code ${code}`)
          )
        )
    })
  })
}

/**
 * Whether 7z is there at all, asked once and remembered. False disables entering
 * archives rather than failing the gesture: Enter on a `.zip` then opens it with
 * the system, exactly as it did before this existed.
 */
let probe: Promise<boolean> | null = null

export function canArchive(): Promise<boolean> {
  if (!probe) {
    probe = run7z([]).then(
      () => true,
      (error: ArchiveFailure) => error.code !== 'ENO7Z'
    )
  }
  return probe
}

/** One entry of an archive as 7z reports it, its path normalized to the inner form. */
interface RawEntry {
  path: string
  size: number
  mtimeMs: number
  isDir: boolean
  symlinkTarget: string | null
}

/** 7z's `-slt` block for one entry, as the key/value pairs it printed. */
function parseRecord(lines: string[]): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const line of lines) {
    const at = line.indexOf(' = ')
    if (at < 0) continue
    fields[line.slice(0, at)] = line.slice(at + 3)
  }
  return fields
}

/**
 * Split 7z's `-slt` output into records. A record begins at a `Path = ` line and
 * runs to the next one or a blank line; the first record is the archive itself
 * (it carries `Type`), and every later one is an entry. Both are returned so the
 * caller can read the archive's own type as well as its members.
 */
function parseListing(text: string): { type: string | null; entries: RawEntry[] } {
  const records: string[][] = []
  let current: string[] | null = null
  for (const line of text.split('\n')) {
    if (line.startsWith('Path = ')) {
      if (current) records.push(current)
      current = [line]
      continue
    }
    if (current === null) continue
    if (line.trim() === '') {
      records.push(current)
      current = null
      continue
    }
    current.push(line)
  }
  if (current) records.push(current)

  let type: string | null = null
  const entries: RawEntry[] = []

  for (const record of records) {
    const fields = parseRecord(record)
    if (fields.Type !== undefined) {
      type = fields.Type
      continue
    }
    const raw = fields.Path
    if (raw === undefined) continue

    const entryPath = normalizeInner(raw)
    // The `.` record tar writes for its own root is the directory we are already
    // listing, not a row in it.
    if (entryPath === '') continue

    const attributes = (fields.Attributes ?? fields.Mode ?? '').trim()
    const isDir = fields.Folder === '+' || /^[Dd]/.test(attributes)
    const isSymlink = attributes.startsWith('l')
    const symlinkTarget = (fields['Symbolic Link'] ?? '').trim()

    entries.push({
      path: entryPath,
      size: Number(fields.Size ?? '0') || 0,
      mtimeMs: parseModified(fields.Modified ?? ''),
      isDir,
      symlinkTarget: isSymlink && symlinkTarget ? symlinkTarget : null
    })
  }

  return { type, entries }
}

/**
 * 7z's `Modified` stamp — `YYYY-MM-DD HH:MM:SS` with an optional fractional
 * second — read as local time, which is how 7z printed it. Fractions past the
 * millisecond are dropped rather than rounded.
 */
function parseModified(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(value.trim())
  if (!match) return 0
  const [, year, month, day, hour, minute, second, fraction] = match
  const ms = fraction ? Number(fraction.slice(0, 3).padEnd(3, '0')) : 0
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    ms
  ).getTime()
}

/**
 * The compression wrappers whose only member is the tar inside them: a `.tar.gz`
 * lists as a single `t.tar`, and what a pane wants to show is the tar's own
 * contents. Listing one is a second 7z, chained through a pipe (see
 * `run7zPipe`), which is why the wrapper is recognized before anything is
 * listed.
 */
const WRAPPER_TYPES = new Set(['gzip', 'bzip2', 'xz', 'zstd', 'lzma', 'lzma2', 'lz', 'lzo', 'z'])

function isWrapperType(type: string | null): boolean {
  return type !== null && WRAPPER_TYPES.has(type.toLowerCase())
}

/** The entries of one archive, with what was learned while getting them. */
interface ArchiveView {
  /** The single `.tar` member of a compression wrapper, or null for a plain archive. */
  innerTar: string | null
  entries: RawEntry[]
}

/**
 * A listing is re-read on every refresh, so the parsed answer is kept by the
 * archive's mtime — a rewrite of the file is a different question, a re-entry
 * into the same one is not. A handful are kept; listings can be large.
 */
const viewCache = new Map<string, { mtimeMs: number; view: ArchiveView }>()
const VIEW_CACHE_MAX = 8

async function loadView(archive: string): Promise<ArchiveView> {
  const stats = await fs.stat(archive)
  const cached = viewCache.get(archive)
  if (cached && cached.mtimeMs === stats.mtimeMs) return cached.view

  const direct = parseListing((await run7z(listArgs(archive))).toString('utf8'))

  let view: ArchiveView = { innerTar: null, entries: direct.entries }

  const only = direct.entries.length === 1 ? direct.entries[0] : undefined
  if (isWrapperType(direct.type) && only && !only.isDir && /\.tar$/i.test(only.path)) {
    const innerTar = only.path
    const chained = parseListing(
      (
        await run7zPipe([
          ['x', '-so', '-p-', '--', archive, innerTar],
          ['l', '-slt', '-si', '-ttar']
        ])
      ).toString('utf8')
    )
    view = { innerTar, entries: chained.entries }
  }

  viewCache.set(archive, { mtimeMs: stats.mtimeMs, view })
  if (viewCache.size > VIEW_CACHE_MAX) {
    const oldest = viewCache.keys().next()
    if (!oldest.done) viewCache.delete(oldest.value)
  }
  return view
}

function listArgs(archive: string): string[] {
  // `-p-` is an empty password: an encrypted archive is refused with an error
  // rather than 7z prompting on a stream nothing can answer.
  return ['l', '-slt', '-p-', '--', archive]
}

/**
 * The children of one directory inside an archive. Directories are synthesized
 * from the entry paths as well as read from explicit records, because zip often
 * stores no record for an intermediate directory at all — a `sub/deep` file
 * implies both `sub` and `sub/deep` without either appearing on its own.
 */
export async function listArchive(archive: string, inner: string): Promise<DirListing> {
  const abs = path.resolve(archive)
  const where = normalizeInner(inner)
  const view = await loadView(abs)

  const prefix = where === '' ? '' : `${where}/`
  const children = new Map<string, RawEntry>()

  for (const entry of view.entries) {
    if (where !== '' && !entry.path.startsWith(prefix)) continue
    const rest = entry.path.slice(prefix.length)
    if (rest === '') continue

    const slash = rest.indexOf('/')
    const segment = slash < 0 ? rest : rest.slice(0, slash)
    const isDir = slash >= 0 ? true : entry.isDir

    const existing = children.get(segment)
    // A directory wins over a file that shares the name, since the entries below
    // it are what makes it one.
    if (existing && (existing.isDir || !isDir)) continue

    children.set(segment, {
      path: prefix + segment,
      size: isDir ? 0 : entry.size,
      mtimeMs: entry.mtimeMs,
      isDir,
      symlinkTarget: isDir ? null : entry.symlinkTarget
    })
  }

  const entries: DirEntry[] = [...children.entries()].map(([name, child]) => ({
    name,
    path: joinArchivePath(abs, child.path),
    kind: child.isDir ? 'directory' : child.symlinkTarget !== null ? 'symlink' : 'file',
    isSymlink: child.symlinkTarget !== null,
    symlinkTarget: child.symlinkTarget,
    size: child.size,
    mtimeMs: child.mtimeMs,
    mode: child.isDir ? 0o040755 : child.symlinkTarget !== null ? 0o120777 : 0o100644
  }))

  return {
    path: joinArchivePath(abs, where),
    parent: archiveParent(abs, where),
    entries,
    hiddenNames: []
  }
}

/**
 * The row above a directory inside an archive. At the archive's root that is the
 * real directory holding the archive — the way out of it — and below that it is
 * the enclosing entry path, so the `..` row walks up the tree the same way it
 * does on disk.
 */
function archiveParent(archive: string, inner: string): string | null {
  if (inner === '') {
    const up = path.dirname(archive)
    return up === archive ? null : up
  }
  const slash = inner.lastIndexOf('/')
  return joinArchivePath(archive, slash < 0 ? '' : inner.slice(0, slash))
}

/**
 * The names to hand 7z for one entry. A tar rooted at `.` stores its members as
 * `./name` while a zip stores `name`, and 7z treats a name it cannot find as a
 * warning rather than a failure — so both spellings are given at once and
 * whichever the archive holds is the one read. The normalized form alone would
 * silently read nothing from a `.`-rooted tar.
 */
function entrySelectors(where: string): string[] {
  return where.startsWith('./') ? [where] : [where, `./${where}`]
}

/**
 * The bytes of one entry. A plain archive reads the entry straight out; one that
 * is a compressed tar is read by piping the tar out of the wrapper and the entry
 * out of the tar, so neither the tar nor the wrapper is ever written to disk.
 */
export async function readArchiveEntry(
  archive: string,
  inner: string,
  maxBytes: number
): Promise<Buffer> {
  const abs = path.resolve(archive)
  const where = normalizeInner(inner)
  const view = await loadView(abs)
  const names = entrySelectors(where)

  if (view.innerTar) {
    return run7zPipe(
      [
        ['x', '-so', '-p-', '--', abs, view.innerTar],
        ['x', '-so', '-si', '-ttar', '--', ...names]
      ],
      maxBytes
    )
  }

  return run7z(['x', '-so', '-p-', '--', abs, ...names], maxBytes)
}

/**
 * The total size of everything at or below a directory inside an archive. Unlike
 * a real folder this is not a walk: the listing already carries every entry's
 * stored size, so the answer is a sum over what was already read.
 */
export async function archiveDirSize(archive: string, inner: string): Promise<number> {
  const abs = path.resolve(archive)
  const where = normalizeInner(inner)
  const view = await loadView(abs)

  const prefix = where === '' ? '' : `${where}/`
  let bytes = 0
  for (const entry of view.entries) {
    if (entry.isDir) continue
    if (where !== '' && !entry.path.startsWith(prefix)) continue
    bytes += entry.size
  }
  return bytes
}
