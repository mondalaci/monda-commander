import * as THREE from 'three'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import type { ModelFormat } from '@shared/types'

/**
 * How a mesh with no material of its own is shaded — an STL or a PLY is bare
 * geometry and carries no colour. A neutral, slightly cool grey reads as a solid
 * rather than as a colour the file chose, and the app's own gold and green stay
 * reserved for marks and runnable names.
 */
const DEFAULT_MODEL_COLOR = 0xa7b2bd

/**
 * Turn a model file's bytes into the object a viewer adds to its scene: a mesh
 * for the formats that carry bare geometry, the loader's own group for the ones
 * that carry materials and structure. The bytes are what main read (or converted)
 * — nothing here is a render, only a parse.
 */
export async function parseModel(format: ModelFormat, bytes: Uint8Array): Promise<THREE.Object3D> {
  const buffer = bufferOf(bytes)

  switch (format) {
    case 'stl':
      return meshOf(new STLLoader().parse(buffer))
    case 'ply':
      return meshOf(new PLYLoader().parse(buffer))
    case '3mf':
      return new ThreeMFLoader().parse(buffer)
    case 'obj':
      return new OBJLoader().parse(new TextDecoder().decode(buffer))
    case 'gltf': {
      const gltf = await new GLTFLoader().parseAsync(buffer, '')
      return gltf.scene
    }
  }
}

/**
 * The bytes as an `ArrayBuffer` for a loader, without copying where the view
 * already spans its whole buffer — which is how an IPC-delivered `Uint8Array`
 * arrives. A parser reads in place and none detaches what it is given, so the
 * same bytes can be handed to a second view if the component is rebuilt.
 */
function bufferOf(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer
  }
  return bytes.slice().buffer
}

/** A bare geometry as a shaded mesh, its normals computed when the file carried
 * none — a flat-shaded STL still has to be lit. */
function meshOf(geometry: THREE.BufferGeometry): THREE.Object3D {
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals()
  const material = new THREE.MeshStandardMaterial({
    color: DEFAULT_MODEL_COLOR,
    metalness: 0.1,
    roughness: 0.62
  })
  return new THREE.Mesh(geometry, material)
}
