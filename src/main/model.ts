import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ipcMain } from 'electron'
import { isArchivePath } from '@shared/archive'
import { isCadModelName, isModelName, meshFormatFor } from '@shared/model'
import type { ModelData, Result } from '@shared/types'

/**
 * A 3D model preview, read here and parsed in the renderer.
 *
 * A mesh format (STL, 3MF, OBJ, PLY, glTF) is the file's own triangles, so its
 * bytes go over as they stand and the renderer does the parsing with three.js —
 * no system dependency. A CAD document (STEP, IGES, FreeCAD's `.fcstd`) is a
 * boundary representation no mesh loader can open, so this converts it to STL
 * through FreeCAD first, exactly as a PDF page is rasterized through poppler:
 * one external tool, probed once, behind an `MC_` env var.
 */

/**
 * Where FreeCAD's command-line binary is looked for. Beside `PATH`, an explicit
 * path can be given, for a machine that keeps it somewhere the app's environment
 * does not — as `MC_FFMPEG` does for transcoding and `MC_PDFTOCAIRO` for a PDF
 * page. On Linux that binary is `freecadcmd`; a FreeCAD *AppImage* ships it
 * *inside* itself rather than on `PATH`, so there a one-line wrapper
 * (`exec .../FreeCAD.AppImage freecadcmd "$@"`) named `freecadcmd` on `PATH`, or
 * pointed at by this variable, is what it resolves to.
 */
const FREECAD = process.env['MC_FREECAD'] ?? 'freecadcmd'

/** How long a conversion may run. A big assembly meshed for a preview is seconds. */
const CONVERT_TIMEOUT_MS = 120_000

/** How long the one probe may take. FreeCAD's cold start is slow, hence generous. */
const PROBE_TIMEOUT_MS = 60_000

/**
 * The largest mesh read whole. The bytes travel the bridge and are parsed in the
 * renderer, so past this a model is refused rather than copied across.
 */
const MODEL_READ_MAX_BYTES = 256 * 1024 * 1024

/**
 * How much converted CAD geometry a session keeps. A conversion is a FreeCAD
 * process per file, so stepping back onto one already converted is a lookup; the
 * budget bounds a document of many large shapes.
 */
const CONVERT_CACHE_MAX_BYTES = 128 * 1024 * 1024

const children = new Set<ChildProcess>()

/** Stop every conversion still running, so none outlives the window. */
export function killAllModelConversions(): void {
  for (const child of children) child.kill('SIGKILL')
  children.clear()
  conversions.clear()
}

/**
 * Run FreeCAD once and hand back its standard output, or null when it could not
 * be run, failed, or timed out. FreeCAD prints a banner and its own chatter to
 * standard output too, so a caller that needs an answer greps for a marker.
 */
function runFreecad(args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(FREECAD, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    children.add(child)

    const chunks: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))

    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    const done = (value: string | null): void => {
      clearTimeout(timer)
      children.delete(child)
      resolve(value)
    }

    child.once('error', () => done(null))
    child.once('close', (code) => done(code === 0 ? Buffer.concat(chunks).toString('utf8') : null))
  })
}

/**
 * Whether FreeCAD is there to convert with. Asked once and remembered: the answer
 * decides whether the CAD documents are previewable at all, and a missing binary
 * is not going to appear mid-session. A mesh format needs no answer.
 */
let available: Promise<boolean> | null = null

export function freecadAvailable(): Promise<boolean> {
  if (available !== null) return available
  available = runFreecad(['-c', 'print("mc-model-probe")'], PROBE_TIMEOUT_MS).then(
    (printed) => printed !== null && printed.includes('mc-model-probe')
  )
  return available
}

/**
 * The script one conversion runs. A STEP or IGES file is not a FreeCAD project,
 * so it goes in through the Import module rather than `openDocument` — which
 * reads only `.fcstd`. Either way the document is recomputed and the shapes that
 * are nobody's input are exported as one STL: a PartDesign Body rather than the
 * features inside it, a boolean's result rather than its operands. A document of
 * only nested shapes falls back to every shape with one.
 */
function convertScript(input: string, output: string): string {
  return [
    'import os',
    'import FreeCAD',
    'import Mesh',
    `src = ${JSON.stringify(input)}`,
    `out = ${JSON.stringify(output)}`,
    'ext = os.path.splitext(src)[1].lower()',
    'if ext in (".step", ".stp", ".iges", ".igs"):',
    '    doc = FreeCAD.newDocument("mc-model")',
    '    import Import',
    '    Import.insert(src, doc.Name)',
    'else:',
    '    doc = FreeCAD.openDocument(src)',
    'doc.recompute()',
    'def usable(o):',
    '    return hasattr(o, "Shape") and not o.Shape.isNull()',
    'objs = [o for o in doc.Objects if usable(o) and not o.InList]',
    'if not objs:',
    '    objs = [o for o in doc.Objects if usable(o)]',
    'if not objs:',
    '    raise SystemExit("mc-model: no shape to export")',
    'Mesh.export(objs, out)',
    ''
  ].join('\n')
}

/** Convert a CAD document to an STL in a scratch directory, read and cleaned up. */
async function convertToStl(target: string): Promise<Buffer | null> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-model-'))
  const script = path.join(dir, 'convert.py')
  const output = path.join(dir, 'model.stl')

  try {
    await fs.writeFile(script, convertScript(target, output), 'utf8')
    if ((await runFreecad([script], CONVERT_TIMEOUT_MS)) === null) return null
    const bytes = await fs.readFile(output)
    return bytes.length > 0 ? bytes : null
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Converted meshes this session keeps, by the identity of the document. */
const conversions = new Map<string, { bytes: Uint8Array; size: number }>()

function readConversion(key: string): Uint8Array | null {
  const hit = conversions.get(key)
  if (!hit) return null
  // Re-insert so the map's order stays least-recently-used first.
  conversions.delete(key)
  conversions.set(key, hit)
  return hit.bytes
}

function writeConversion(key: string, bytes: Uint8Array): void {
  conversions.delete(key)
  conversions.set(key, { bytes, size: bytes.byteLength })

  let total = 0
  for (const entry of conversions.values()) total += entry.size
  while (total > CONVERT_CACHE_MAX_BYTES && conversions.size > 1) {
    const oldest = conversions.keys().next()
    if (oldest.done) break
    total -= conversions.get(oldest.value)?.size ?? 0
    conversions.delete(oldest.value)
  }
}

function fail(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message } }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown model error'
}

export function registerModelHandlers(): void {
  ipcMain.handle('fs:can-render-model', () => freecadAvailable())

  ipcMain.handle(
    'fs:read-model',
    async (_event, target: string): Promise<Result<ModelData>> => {
      if (typeof target !== 'string' || target.length === 0) {
        return fail('EINVAL', 'No model to read')
      }
      // An entry inside an archive has no real path to read or hand to FreeCAD.
      if (isArchivePath(target)) {
        return fail('ENOTSUP', 'Reading a model inside an archive is not supported')
      }

      const resolved = path.resolve(target)
      if (!isModelName(resolved)) return fail('EINVAL', 'Not a model file')

      let stats
      try {
        stats = await fs.stat(resolved)
      } catch {
        return fail('ENOENT', 'The model file could not be found')
      }
      if (!stats.isFile()) return fail('EINVAL', 'Not a regular file')

      // A mesh is the file's own triangles: it goes over as it stands.
      const mesh = meshFormatFor(resolved)
      if (mesh !== null) {
        if (stats.size > MODEL_READ_MAX_BYTES) {
          return fail('EFBIG', 'The model is too large to preview')
        }
        try {
          const bytes = await fs.readFile(resolved)
          return { ok: true, data: { format: mesh, bytes: new Uint8Array(bytes) } }
        } catch (error) {
          return fail('EREAD', messageOf(error))
        }
      }

      // A CAD document is a boundary representation: it is meshed through
      // FreeCAD first, and only where FreeCAD is there to do it.
      if (!isCadModelName(resolved)) return fail('EINVAL', 'Not a model file')
      if (!(await freecadAvailable())) {
        return fail('ENOTSUP', 'No CAD converter available')
      }

      const key = `${resolved}\u0000${stats.mtimeMs}:${stats.size}`
      const cached = readConversion(key)
      if (cached !== null) return { ok: true, data: { format: 'stl', bytes: cached } }

      try {
        const stl = await convertToStl(resolved)
        if (stl === null) {
          return fail('ERENDER', `Could not convert "${path.basename(resolved)}" to a mesh`)
        }
        const bytes = new Uint8Array(stl)
        writeConversion(key, bytes)
        return { ok: true, data: { format: 'stl', bytes } }
      } catch (error) {
        return fail('ERENDER', messageOf(error))
      }
    }
  )
}
