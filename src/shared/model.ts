import type { ModelFormat } from './types'

/**
 * What a pane previews as a 3D model, and how each such file is read.
 *
 * Two families share the one preview. A *mesh* format is the file's own
 * triangles, so the renderer parses it itself through three.js — no system
 * dependency at all. A *CAD* format is a boundary representation (STEP, IGES) or,
 * for `.fcstd`, FreeCAD's own document: no mesh reader can open one, so main
 * converts it to a mesh through FreeCAD first, exactly as a PDF page is
 * rasterized through poppler. The split is by extension, and both sides read it
 * from here so a row asking for a model is a row main can answer for.
 */

/** Extensions whose file *is* its mesh, mapped to the parser that reads it. */
const MESH_FORMATS: Record<string, ModelFormat> = {
  stl: 'stl',
  '3mf': '3mf',
  obj: 'obj',
  ply: 'ply',
  gltf: 'gltf',
  glb: 'gltf'
}

/**
 * Extensions that are CAD documents rather than meshes: STEP and IGES, the two
 * shapes OCCT exchanges, and FreeCAD's own `.fcstd`. None is previewable without
 * FreeCAD to convert it — the probe `fs:can-render-model` is what decides
 * whether a pane offers them at all.
 */
const CAD_EXTENSIONS = new Set(['step', 'stp', 'fcstd', 'iges', 'igs'])

function extensionOf(name: string): string | null {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot <= 0 || dot === lower.length - 1) return null
  return lower.slice(dot + 1)
}

/** The mesh format a name is, or null when it is not one the renderer parses. */
export function meshFormatFor(name: string): ModelFormat | null {
  const extension = extensionOf(name)
  return extension === null ? null : (MESH_FORMATS[extension] ?? null)
}

/** Whether a name is a CAD document main converts through FreeCAD. */
export function isCadModelName(name: string): boolean {
  const extension = extensionOf(name)
  return extension !== null && CAD_EXTENSIONS.has(extension)
}

/** Whether a name is a 3D model a pane previews — a mesh, or a CAD document. */
export function isModelName(name: string): boolean {
  return meshFormatFor(name) !== null || isCadModelName(name)
}
