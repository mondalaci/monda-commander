<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { parseModel } from '@renderer/lib/model'
import type { ModelFormat } from '@shared/types'

/**
 * A 3D model drawn in a canvas — the panes' one way of showing a mesh, used both
 * as the footer thumbnail and as the display. It parses the bytes main read (or
 * converted), centres the model, frames the camera on it, and lights it; a mesh
 * with no material of its own gets the viewer's neutral one (`lib/model.ts`).
 *
 * Both turn on their own, so a still frame reads as a solid rather than as a
 * silhouette. The display also hands the pointer to orbit controls, which take
 * the turning over the moment they are grabbed — from then on the drag turns the
 * model and the wheel zooms it. The component owns its own WebGL context and gives
 * it back on unmount, so stepping the cursor across a folder of models does not
 * exhaust the browser's contexts.
 */
const props = defineProps<{
  format: ModelFormat
  bytes: Uint8Array
  /** Whether the model can be turned with the pointer. A thumbnail is not. */
  interactive?: boolean
}>()

const emit = defineEmits<{ ready: []; error: [] }>()

const canvas = ref<HTMLCanvasElement | null>(null)

let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let controls: OrbitControls | null = null
/** The model's holder, which the thumbnail turns about its own centre. */
let pivot: THREE.Group | null = null
let observer: ResizeObserver | null = null
let frame = 0
/** When the last frame was drawn, for the thumbnail's own modest rate. */
let lastDraw = 0
/** When the last frame ran, for the elapsed time the controls advance by. */
let lastTick = 0
let disposed = false
let announced = false

/** The bounding-sphere radius and camera distance, kept for the controls' limits. */
let radius = 1
let distance = 3

function render(): void {
  if (renderer && scene && camera) renderer.render(scene, camera)
}

/**
 * Centre the model on its own bounding box and pull the camera back to frame it,
 * along a three-quarter direction so the shape reads in depth rather than flat.
 */
function fit(object: THREE.Object3D): void {
  const cam = camera
  if (!cam) return

  const box = new THREE.Box3().setFromObject(object)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  // The model's centre moves to the pivot's origin, so a rotation turns it in
  // place rather than swinging it around the file's own origin.
  object.position.sub(center)

  radius = Math.max(size.length() * 0.5, 1e-4)
  distance = (radius / Math.sin((cam.fov * Math.PI) / 360)) * 1.15

  cam.position.copy(new THREE.Vector3(1, 0.72, 1).normalize().multiplyScalar(distance))
  cam.near = Math.max(radius / 100, distance / 1000)
  cam.far = distance * 10 + radius * 2
  cam.lookAt(0, 0, 0)
  cam.updateProjectionMatrix()
}

function resize(): void {
  const el = canvas.value
  if (!el || !renderer || !camera) return

  const width = Math.max(1, el.clientWidth)
  const height = Math.max(1, el.clientHeight)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setSize(width, height, false)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
  render()

  // The display is revealed off this element's box, so it is announced only once
  // it has one: a hidden box (the footer before its strip is tall) measures zero,
  // and the ResizeObserver calls this again when it is shown.
  if (!announced && el.clientWidth > 0 && el.clientHeight > 0) {
    announced = true
    emit('ready')
  }
}

/**
 * How often the *thumbnail* is redrawn — ~40fps. It is ambient: a slow turn in a
 * 64px box reads the same a few frames apart as it does at the monitor's rate,
 * and a full-rate redraw of a box the pointer is merely resting on is GPU spent
 * for nothing. The display is not throttled: it is being watched and handled, so
 * it is drawn every frame the compositor offers.
 */
const FRAME_MS = 1000 / 40

/**
 * How fast an enlarged model turns on its own, before it is handled. OrbitControls
 * reads the speed as `60 / speed` seconds per orbit (the default 2 is half a
 * minute round), so 5 is a turn every ~12 seconds — near the thumbnail's pace, and
 * frame-rate independent because the loop hands `update` the elapsed time.
 */
const AUTO_ROTATE_SPEED = 5

function tick(now: number): void {
  frame = requestAnimationFrame(tick)

  if (controls) {
    // The display is watched and handled, so it is drawn at the rate the
    // compositor offers — the monitor's own, not a cap of ours — but only when
    // the camera actually moved: a drag, the damping settling, the slow turn.
    // The elapsed time is capped so a frame the window was away for does not
    // spin the model round in one step.
    const elapsed = lastTick === 0 ? 0 : Math.min((now - lastTick) / 1000, 0.1)
    lastTick = now
    if (controls.update(elapsed)) render()
    return
  }

  if (!pivot) return

  // The thumbnail's own rate, and the turn measured from the last *draw* rather
  // than the last frame, so the slow turn is the same however often it is drawn.
  const sinceDraw = Math.min(now - lastDraw, 100)
  if (sinceDraw < FRAME_MS) return
  lastDraw = now
  pivot.rotation.y += (sinceDraw / 1000) * 0.55
  render()
}

async function setup(): Promise<void> {
  const el = canvas.value
  if (!el) return

  try {
    renderer = new THREE.WebGLRenderer({ canvas: el, antialias: true, alpha: true })
  } catch {
    emit('error')
    return
  }
  renderer.setClearColor(0x000000, 0)

  scene = new THREE.Scene()
  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000)

  // A cool sky over a dark ground and two directional lights: enough to read a
  // surface's curvature from the shading alone, which is what a bare mesh is.
  scene.add(new THREE.HemisphereLight(0xffffff, 0x3a4249, 1.6))
  const key = new THREE.DirectionalLight(0xffffff, 2.1)
  key.position.set(1, 1.4, 0.8)
  scene.add(key)
  const fill = new THREE.DirectionalLight(0xffffff, 0.7)
  fill.position.set(-1, -0.6, -1)
  scene.add(fill)

  let object: THREE.Object3D
  try {
    object = await parseModel(props.format, props.bytes)
  } catch {
    if (!disposed) emit('error')
    return
  }
  if (disposed || !scene) return

  fit(object)
  pivot = new THREE.Group()
  pivot.add(object)
  scene.add(pivot)

  if (props.interactive) {
    controls = new OrbitControls(camera, el)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.rotateSpeed = 0.9
    controls.zoomSpeed = 0.9
    // Panning is off on purpose: the display's right button is its own gesture —
    // a quick right-click leaves the mode — so the model turns with the left
    // button and zooms with the wheel rather than competing for the right one.
    controls.enablePan = false
    controls.minDistance = radius * 0.35
    controls.maxDistance = distance * 6
    controls.target.set(0, 0, 0)

    // An enlarged model turns on its own too, so it reads as a solid the way the
    // thumbnail does rather than as a still, and hands the turning over the
    // moment the pointer takes it — from then on the drag and the wheel own it.
    controls.autoRotate = true
    controls.autoRotateSpeed = AUTO_ROTATE_SPEED
    controls.addEventListener('start', () => {
      if (controls) controls.autoRotate = false
    })

    controls.update()
  }

  observer = new ResizeObserver(resize)
  observer.observe(el)
  resize()
  frame = requestAnimationFrame(tick)
}

onMounted(() => {
  void setup()
})

onBeforeUnmount(() => {
  disposed = true
  cancelAnimationFrame(frame)
  observer?.disconnect()
  observer = null
  controls?.dispose()
  controls = null

  pivot?.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (mesh.geometry) mesh.geometry.dispose()
    const material = mesh.material
    if (Array.isArray(material)) material.forEach((entry) => entry.dispose())
    else if (material) material.dispose()
  })

  renderer?.dispose()
  // Give the context back rather than waiting for the next mount to push the
  // browser's context limit over: a folder of models is stepped through quickly.
  renderer?.forceContextLoss()
  renderer = null
  scene = null
  camera = null
  pivot = null
})
</script>

<template>
  <canvas ref="canvas" class="block h-full w-full" />
</template>
