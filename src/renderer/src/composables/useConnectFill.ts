import { onBeforeUnmount, watch, type Ref } from 'vue'

/**
 * The relay-connect fill, as a pane title or the picker draws it.
 *
 * The connect reports coarse stages — contact, install, start, verify — and a
 * stage can take a while, so a fill that only moved when a stage arrived would
 * sit still for seconds and read as a hang. This eases toward the stage the relay
 * last reported but adds a floor to every step, so the fill is always inching
 * forward and progress is visible *between* stages too. It stops just short of the
 * end, because the fill is removed the moment the relay is up and never has to
 * claim completion.
 *
 * `stage` is the target the relay reported (`null` when not connecting), and `host`
 * is the element the fill is painted on. The value is written straight to the
 * element's `--connect-value` each frame rather than through a reactive ref, so a
 * frame's worth of motion never re-renders the pane around it.
 */
export function useConnectFill(stage: () => number | null, host: Ref<HTMLElement | null>): void {
  let value = 0
  let frame = 0

  function paint(): void {
    host.value?.style.setProperty('--connect-value', `${value * 100}%`)
  }

  function step(): void {
    const target = stage()
    if (target === null) return
    // Approach the stage quickly, then keep a floor: the fill never truly stops,
    // so a slow stage still looks like motion rather than a bar that gave up.
    const gap = target - value
    value = Math.min(0.97, value + Math.max(0.0005, gap * 0.02))
    paint()
    frame = requestAnimationFrame(step)
  }

  watch(
    stage,
    (target) => {
      if (target === null) {
        if (frame) cancelAnimationFrame(frame)
        frame = 0
        value = 0
        paint()
        return
      }
      if (frame === 0) {
        value = Math.max(value, 0.02)
        paint()
        frame = requestAnimationFrame(step)
      }
    },
    { immediate: true }
  )

  onBeforeUnmount(() => {
    if (frame) cancelAnimationFrame(frame)
    frame = 0
  })
}
