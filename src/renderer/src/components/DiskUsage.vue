<script setup lang="ts">
import { computed } from 'vue'
import { formatSize } from '@renderer/lib/format'
import type { DiskUsage } from '@shared/types'

const props = defineProps<{
  usage: DiskUsage | null
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
 * The app's own occupancy fills, as hex rather than theme tokens, so their
 * brightness can be read in code and the label drawn against them rather than
 * guessed at: runnable green, archive gold, danger red.
 */
const FILL_OK = '#98c379'
const FILL_WARN = '#e2b93d'
const FILL_FULL = '#f14c4c'

function channel(hex: string, index: number): number {
  const value = parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance of a `#rrggbb` colour: 0 (black) to 1 (white). */
function luminance(hex: string): number {
  return 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2)
}

/**
 * The luminance at which black and white text contrast a background equally:
 * below it white wins, above it black does.
 */
const CONTRAST_PIVOT = 0.179

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
 * The fill's hue walks green → gold → red as the disk fills — the app's own
 * traffic light, runnable → archive → danger — so a full disk reads with the
 * same red the rest of the interface reserves for something that wants
 * attention.
 */
const fill = computed(() => {
  if (percent.value >= 90) return FILL_FULL
  if (percent.value >= 75) return FILL_WARN
  return FILL_OK
})

/** Whether the fill is a dark colour, which is what turns the label light. */
const fillIsDark = computed(() => luminance(fill.value) <= CONTRAST_PIVOT)

/** The label's colour, chosen against the fill it is written on. */
const textColor = computed(() => (fillIsDark.value ? '#ffffff' : '#141414'))

/** A shadow of the opposite polarity, to lift the label where a fill ends on it. */
const textShadow = computed(() =>
  fillIsDark.value ? '0 1px 1px rgba(0, 0, 0, 0.55)' : '0 1px 1px rgba(255, 255, 255, 0.5)'
)

/**
 * The empty track takes the label's polarity too, so the same label reads on the
 * empty stretch as on the fill and across the boundary between them.
 */
const track = computed(() => (fillIsDark.value ? 'rgba(0, 0, 0, 0.45)' : 'rgba(255, 255, 255, 0.5)'))

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
       bar sits on the passive pane background. The label's colour is read from
       the fill rather than fixed. -->
  <span
    v-if="usage"
    class="flex shrink-0 items-center overflow-hidden rounded-[2px]"
    :style="{ background: 'var(--color-surface)' }"
    :title="fullTitle"
    aria-hidden="true"
  >
    <span
      class="relative flex h-4 w-[4.5rem] items-center justify-center overflow-hidden rounded-[2px] text-2xs leading-none"
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
