<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { parseModel } from '@renderer/lib/model'
import { injectTargetApi } from '@renderer/lib/targetContext'

/**
 * Every 3D tile of a thumbnail wall, drawn by one renderer.
 *
 * A wall can show a dozen models at once, and one WebGL context per tile would
 * exhaust what the browser allows in a single screenful — the limit `ModelViewer`
 * is built around, and why that one gives its context back on unmount. So the
 * wall keeps exactly one context: a transparent canvas laid over the tiles, into
 * which each model is rendered through a scissor box the size and place of its
 * own tile. That is what lets *all* of them turn at once rather than only the one
 * under the pointer.
 *
 * The canvas covers the grid's whole area but only ever paints inside a tile's
 * box, and it is `pointer-events-none`, so everywhere else the tiles keep their
 * own clicks, hover and tooltips. The models are fetched and parsed here, one
 * file at a time, because three.js is this component's alone to keep out of the
 * grid's chunk (the grid imports it lazily, exactly as `FilePanel` does Monaco).
 */
const props = defineProps<{
  /** The scrolling element the tiles live in, which the canvas overlays. */
  viewport: HTMLElement | null
  /** The model tiles on screen, by the key the grid knows each one as. */
  cells: { key: string; path: string }[]
}>()

const emit = defineEmits<{
  (event: 'status', key: string, status: 'ready' | 'error'): void
}>()

const api = injectTargetApi()
const canvas = ref<HTMLCanvasElement | null>(null)

interface Model {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  pivot: THREE.Group
}

/**
 * The models loaded so far, by the same content key the grid names a tile by.
 * The map keeps insertion order, which is the eviction order — a wall stepped
 * through for a long time does not grow without bound.
 */
const models = new Map<string, Model>()

/** The fails: a model that would not read or parse, so the tile shows its icon. */
const failed = new Set<string>()

/** The files being read or parsed right now, so the queue never asks twice. */
const loading = new Set<string>()

let renderer: THREE.WebGLRenderer | null = null
let unavailable = false
let disposed = false
let frame = 0
let lastDraw = 0
/** Keeps the drawing buffer in step with the canvas's CSS box, before paint. */
let canvasObserver: ResizeObserver | null = null

/** The most models kept in the shared context before the oldest is let go. */
const MAX_MODELS = 32

/** How many files are read at once, so a wall does not open thirty parses. */
const LOAD_LIMIT = 3

/** How fast a tile turns, in radians a second. */
const TURN_SPEED = 0.55

// --- Loading ---------------------------------------------------------------

function makeScene(): THREE.Scene {
  const scene = new THREE.Scene()
  // The same sky-and-two-keys lighting the footer viewer uses, so a model looks
  // the same whichever surface it is on.
  scene.add(new THREE.HemisphereLight(0xffffff, 0x3a4249, 1.6))
  const key = new THREE.DirectionalLight(0xffffff, 2.1)
  key.position.set(1, 1.4, 0.8)
  scene.add(key)
  const fill = new THREE.DirectionalLight(0xffffff, 0.7)
  fill.position.set(-1, -0.6, -1)
  scene.add(fill)
  return scene
}

/**
 * A parsed model as a drawable: its own scene and camera, and a pivot it turns
 * about. The model is centred on its bounding box and the camera pulled back to
 * frame it along a three-quarter direction, exactly as the enlarged viewer does,
 * so a tile reads as the same object seen from the same angle.
 */
function buildModel(object: THREE.Object3D): Model {
  const scene = makeScene()
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000)

  const box = new THREE.Box3().setFromObject(object)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  object.position.sub(center)

  const radius = Math.max(size.length() * 0.5, 1e-4)
  const distance = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.15
  camera.position.copy(new THREE.Vector3(1, 0.72, 1).normalize().multiplyScalar(distance))
  camera.near = Math.max(radius / 100, distance / 1000)
  camera.far = distance * 10 + radius * 2
  camera.lookAt(0, 0, 0)

  const pivot = new THREE.Group()
  pivot.add(object)
  // A random start, so a wall of models does not turn in lockstep like a chorus.
  pivot.rotation.y = Math.random() * Math.PI * 2
  scene.add(pivot)

  return { scene, camera, pivot }
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (mesh.geometry) mesh.geometry.dispose()
    const material = mesh.material
    if (Array.isArray(material)) material.forEach((entry) => entry.dispose())
    else if (material) material.dispose()
  })
}

function disposeModel(model: Model): void {
  disposeObject(model.pivot)
}

/**
 * Let the oldest models go once there are more than the cap — but never one that
 * is on screen, whose tile would go blank: a screenful of models is allowed to
 * exceed the cap rather than lose the ones being looked at.
 */
function evict(): void {
  if (models.size <= MAX_MODELS) return
  const visible = new Set(props.cells.map((cell) => cell.key))
  for (const key of [...models.keys()]) {
    if (models.size <= MAX_MODELS) break
    if (visible.has(key)) continue
    const model = models.get(key)
    models.delete(key)
    if (model) disposeModel(model)
  }
}

async function load(key: string, path: string): Promise<void> {
  if (unavailable) {
    emit('status', key, 'error')
    return
  }
  try {
    const result = await api.fs.readModel(path)
    if (disposed) return
    if (!result.ok) {
      failed.add(key)
      emit('status', key, 'error')
      return
    }
    const object = await parseModel(result.data.format, result.data.bytes)
    // The context can go away while a parse is in flight — a factory failure, a
    // lost context — and a model with nothing to draw into is a blank tile, so
    // the tile is told to keep its icon instead.
    if (disposed || unavailable) {
      disposeObject(object)
      return
    }
    models.set(key, buildModel(object))
    emit('status', key, 'ready')
    evict()
  } catch {
    failed.add(key)
    if (!disposed) emit('status', key, 'error')
  }
}

/** The work still wanted, and a small pump so a wall does not open thirty reads. */
let wanted: { key: string; path: string }[] = []
let running = 0

function pump(queue: { key: string; path: string }[]): void {
  wanted = queue
  run()
}

function run(): void {
  while (running < LOAD_LIMIT && wanted.length > 0) {
    const next = wanted.shift()!
    if (models.has(next.key) || failed.has(next.key) || loading.has(next.key)) continue
    loading.add(next.key)
    running += 1
    void load(next.key, next.path).finally(() => {
      loading.delete(next.key)
      running -= 1
      run()
    })
  }
}

/**
 * Read the files the wall is asking for, a few at a time. The queue is rebuilt
 * from what is on screen rather than appended to, so a fast scroll past a folder
 * of models does not queue a parse for every one it passed.
 *
 * The watch is immediate and its callback runs *before* the declarations below
 * it in a plain setup would be reached — which is why `wanted` and `running` sit
 * above it rather than beside the pump: reading them from the callback while
 * they are still in their temporal dead zone throws, and a thrown immediate
 * watch is a wall that silently never loads a model.
 */
watch(
  () => props.cells,
  (cells) => {
    if (unavailable) {
      for (const cell of cells) emit('status', cell.key, 'error')
      return
    }
    const queue: { key: string; path: string }[] = []
    const seen = new Set<string>()
    for (const cell of cells) {
      if (models.has(cell.key) || failed.has(cell.key) || loading.has(cell.key) || seen.has(cell.key)) {
        continue
      }
      seen.add(cell.key)
      queue.push(cell)
    }
    pump(queue)
  },
  { immediate: true }
)

// --- Drawing ---------------------------------------------------------------

let lastW = 0
let lastH = 0
let lastDpr = 0

function resize(el: HTMLCanvasElement): void {
  const rendererRef = renderer
  if (!rendererRef) return
  const w = Math.max(1, el.clientWidth)
  const h = Math.max(1, el.clientHeight)
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  if (w === lastW && h === lastH && dpr === lastDpr) return
  lastW = w
  lastH = h
  lastDpr = dpr
  rendererRef.setPixelRatio(dpr)
  rendererRef.setSize(w, h, false)
}

function draw(dt: number): void {
  const el = canvas.value
  const viewport = props.viewport
  const rendererRef = renderer
  if (!rendererRef || !el || !viewport) return

  const width = el.clientWidth
  const height = el.clientHeight
  if (width <= 0 || height <= 0) return
  resize(el)

  // A tile that scrolled away leaves no trace: the frame starts blank, and each
  // model is then painted into its own box through the scissor.
  rendererRef.setScissorTest(false)
  rendererRef.clear()
  rendererRef.setScissorTest(true)

  const canvasRect = el.getBoundingClientRect()
  for (const element of viewport.querySelectorAll<HTMLElement>('[data-model-key]')) {
    const attr = element.dataset['modelKey']
    const key = attr ? decodeURIComponent(attr) : null
    const model = key ? models.get(key) : undefined
    if (!model) continue

    const box = element.getBoundingClientRect()
    if (box.width < 1 || box.height < 1) continue
    const x = box.left - canvasRect.left
    const y = box.top - canvasRect.top
    if (x + box.width <= 0 || y + box.height <= 0 || x >= width || y >= height) continue

    model.pivot.rotation.y += dt * TURN_SPEED
    const aspect = box.width / box.height
    if (model.camera.aspect !== aspect) {
      model.camera.aspect = aspect
      model.camera.updateProjectionMatrix()
    }

    // WebGL's viewport origin is the bottom-left, the canvas's is the top-left.
    const bottom = height - (y + box.height)
    rendererRef.setViewport(x, bottom, box.width, box.height)
    rendererRef.setScissor(x, bottom, box.width, box.height)
    rendererRef.render(model.scene, model.camera)
  }
}

/**
 * A wall is watched, not ambient like the footer's one 64px thumbnail, so it is
 * drawn every frame the compositor offers rather than throttled — the turn is
 * advanced by the elapsed time either way, so this buys smoothness, not speed.
 */
function tick(now: number): void {
  frame = requestAnimationFrame(tick)
  const elapsed = lastDraw === 0 ? 0 : Math.min((now - lastDraw) / 1000, 0.1)
  lastDraw = now
  draw(elapsed)
}

onMounted(() => {
  const el = canvas.value
  if (!el) return
  try {
    renderer = new THREE.WebGLRenderer({ canvas: el, antialias: true, alpha: true })
  } catch {
    // No WebGL to draw with: every tile keeps its type icon rather than spinning.
    unavailable = true
    for (const cell of props.cells) emit('status', cell.key, 'error')
    return
  }
  renderer.setClearColor(0x000000, 0)
  // The canvas fills its wrapper by CSS, so its drawing buffer has to be kept the
  // same size in step with layout — not only on the next 40fps tick, or the frame
  // is a stretched bitmap whenever the box changes (the footer's strip animating
  // is the common case, and a stretch there is a model that trembles with it).
  // A ResizeObserver runs before paint, so the buffer is right for the frame that
  // shows it.
  //
  // Resizing a WebGL buffer blanks it, and the next 40fps tick is a frame or two
  // away — long enough to see as a flicker through the strip's animation — so the
  // frame is drawn again right here, still before the paint.
  canvasObserver = new ResizeObserver(() => {
    const current = canvas.value
    if (!current) return
    resize(current)
    draw(0)
  })
  canvasObserver.observe(el)
  frame = requestAnimationFrame(tick)
})

onBeforeUnmount(() => {
  disposed = true
  cancelAnimationFrame(frame)
  canvasObserver?.disconnect()
  canvasObserver = null
  for (const model of models.values()) disposeModel(model)
  models.clear()
  renderer?.dispose()
  // Give the one context back rather than leaving it to the next folder's wall.
  renderer?.forceContextLoss()
  renderer = null
})
</script>

<template>
  <canvas
    ref="canvas"
    class="pointer-events-none absolute inset-0 h-full w-full"
    aria-hidden="true"
  />
</template>
