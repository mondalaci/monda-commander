<script setup lang="ts">
/**
 * The insertion point a column drag would drop into. It is one white marker: a
 * line running down the header to its bottom edge, and — as the line's own
 * elongation upward — a downward triangle that reaches up over the pane title
 * above the header. The triangle is the point of the whole thing: it hangs over
 * the title, so the place the columns would part at is unmistakable, and the
 * line it grows out of is left as the insertion itself.
 *
 * It is drawn once, positioned by the pane at the gap the pointer has chosen,
 * rather than a copy per column: only the header's own box can hold a marker that
 * overshoots the header's top, and the pane already knows the gap's x.
 */
defineProps<{
  /** The gap's x, in the header's own coordinates, from its left edge. */
  x: number
}>()
</script>

<template>
  <!-- `bottom-0` puts the line's foot on the header's bottom edge and `h-8`
       (the header's 24px plus an 8px overshoot) lifts the top — and the triangle
       on it — clear above the header, over the title. Centring is by the gap's x,
       so the line straddles the boundary exactly. -->
  <span
    class="pointer-events-none absolute bottom-0 z-20 flex h-8 w-2 -translate-x-1/2 flex-col items-center"
    :style="{ left: `${x}px` }"
    aria-hidden="true"
  >
    <svg viewBox="0 0 8 8" class="h-2 w-2 shrink-0 fill-fg-bright" aria-hidden="true">
      <path d="M0 0h8L4 8z" />
    </svg>
    <span
      class="min-h-0 w-[3px] flex-1 rounded-full bg-fg-bright shadow-[0_0_0_1px_rgba(0,0,0,0.55),0_0_8px_rgba(255,255,255,0.55)]"
    />
  </span>
</template>
