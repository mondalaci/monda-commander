<script setup lang="ts">
import { computed } from 'vue'
import { formatSize } from '@renderer/lib/format'
import type { DiskUsage } from '@shared/types'

const props = defineProps<{
  usage: DiskUsage | null
  /** Whether this is the focused pane, which sets the ordinary fill's hue. */
  active: boolean
}>()

/**
 * A size for a title bar, where a fourth character is the difference between
 * the path fitting and not: `4T` rather than `4.0 TB`, `2.1T` rather than
 * `2.10 TB`. Whole units lose their decimal so the common round disk reads
 * cleanly.
 */
function compact(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0'
  const units = ['B', 'K', 'M', 'G', 'T', 'P']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const text = value.toFixed(value >= 100 ? 0 : 1).replace(/\.0$/, '')
  return `${text}${units[unit]}`
}

/**
 * The ordinary fill takes the pane's own state rather than the runnable green:
 * the accent blue on the focused pane, the inactive selection grey on the other
 * — the same pair the cursor band is drawn in (`bg-accent` /
 * `bg-selection-inactive`), so the chip reads as part of the title it sits in.
 * The warning and full hues stay the app's traffic light (archive gold, danger
 * red). Read as theme tokens, so the two travel with the palette.
 */
const FILL_OK_ACTIVE = 'var(--color-accent)'
const FILL_OK_INACTIVE = 'var(--color-selection-inactive)'
const FILL_WARN = '#e2b93d'
const FILL_FULL = '#f14c4c'

const total = computed(() => props.usage?.total ?? 0)
const used = computed(() => props.usage?.used ?? 0)
const free = computed(() => props.usage?.free ?? 0)

/** How full the filesystem is, as a whole percent. */
const percent = computed(() =>
  total.value > 0 ? Math.min(100, Math.max(0, Math.round((used.value / total.value) * 100))) : 0
)

/** The same, unrounded, so a nearly-empty disk still draws a sliver. */
const fraction = computed(() =>
  total.value > 0 ? Math.min(1, Math.max(0, used.value / total.value)) : 0
)

const usedLabel = computed(() => compact(used.value))
const totalLabel = computed(() => compact(total.value))
const fillWidth = computed(() => `${fraction.value * 100}%`)

/**
 * The fill's hue walks the pane's own blue/grey → gold → red as the disk fills,
 * so a full disk reads with the same red the rest of the interface reserves for
 * something that wants attention.
 */
const fill = computed(() => {
  if (percent.value >= 90) return FILL_FULL
  if (percent.value >= 75) return FILL_WARN
  return props.active ? FILL_OK_ACTIVE : FILL_OK_INACTIVE
})

/** The label is white, on a dark track, whichever fill it crosses. */
const textColor = '#ffffff'

/** A dark shadow, to hold the white label where it rides over a bright fill. */
const textShadow = '0 1px 2px rgba(0, 0, 0, 0.75)'

/**
 * The empty track is dark, so the white label reads across the empty stretch and
 * the fill — and the boundary between them — alike.
 */
const track = 'rgba(0, 0, 0, 0.45)'

const fullTitle = computed(() => {
  const parts = [
    `${formatSize(used.value)} of ${formatSize(total.value)} used (${percent.value}%)`,
    `${formatSize(free.value)} free`
  ]
  if (props.usage?.mount) parts.push(`mounted at ${props.usage.mount}`)
  return parts.join(' · ')
})
</script>

<template>
  <!-- The reading rides inside the bar, so it costs no width of its own, and the
       bar sits on the passive pane background. The label is white, against a
       dark track. -->
  <span
    v-if="usage"
    class="flex shrink-0 items-center overflow-hidden rounded-[2px] border border-border"
    :style="{ background: 'var(--color-surface)' }"
    :title="fullTitle"
    aria-hidden="true"
  >
    <span
      class="relative flex h-4 items-center justify-center overflow-hidden rounded-[2px] px-1.5 text-2xs leading-none whitespace-nowrap"
      :style="{ background: track }"
    >
      <span
        class="absolute inset-y-0 left-0 transition-[width] duration-300"
        :style="{ width: fillWidth, backgroundColor: fill }"
      ></span>

      <span class="relative z-10" :style="{ color: textColor, textShadow }">
        {{ usedLabel }} / {{ totalLabel }}
      </span>
    </span>
  </span>
</template>
