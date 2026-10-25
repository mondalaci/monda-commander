<script setup lang="ts">
import { computed } from 'vue'

/**
 * The pointer's own answer to "keep holding": a small ring drawn where the right
 * button went down, filled over what is left of the hold (`duration`), so the
 * long right-press says what it is doing while it does it. A ring that fills is
 * also what tells the two gestures apart in the hand — a plain right-click marks
 * and never draws one, because the ring only appears once the hold has outlasted
 * a click (see `HOLD_HINT_MS` in FilePanel).
 *
 * It is an element rather than the cursor itself: a CSS `cursor:` image cannot
 * animate, so a progress bar cannot be the pointer. This sits under the pointer —
 * the OS cursor is composited above the page — which is where a badge belongs.
 */
const props = defineProps<{
  /** Where the button went down, in client coordinates. */
  x: number
  y: number
  /** How long the fill takes: the rest of the hold. */
  duration: number
}>()

const box = computed(() => ({ left: `${props.x}px`, top: `${props.y}px` }))

/** The fill is the animation's own length, so the ring and the timer cannot drift. */
const fill = computed(() => ({ animationDuration: `${props.duration}ms` }))
</script>

<template>
  <div
    class="pointer-events-none fixed z-[60] -translate-x-1/2 -translate-y-1/2"
    :style="box"
    aria-hidden="true"
  >
    <svg viewBox="0 0 20 20" class="h-6 w-6">
      <circle class="hold-disc" cx="10" cy="10" r="8" />
      <circle class="hold-track" cx="10" cy="10" r="8" />
      <circle
        class="hold-arc"
        cx="10"
        cy="10"
        r="8"
        transform="rotate(-90 10 10)"
        :style="fill"
      />
    </svg>
  </div>
</template>
