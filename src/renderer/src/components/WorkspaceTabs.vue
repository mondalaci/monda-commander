<script setup lang="ts">
import { ref } from 'vue'

/**
 * The workspace tab strip, rendered inside the title bar so it costs no extra
 * vertical space. Each tab is a whole workspace — its own pair of file panes
 * and its own shell — so switching tabs is switching sessions. Clicking the
 * active tab toggles its terminal. Ctrl+T / Ctrl+W / Ctrl+PageUp /
 * Ctrl+PageDown mirror the buttons here, and Shift+Ctrl+PageUp/PageDown or a
 * drag reorders the tabs.
 */
defineProps<{ tabs: { id: string; label: string }[]; activeIndex: number }>()

const emit = defineEmits<{
  (event: 'select', index: number): void
  (event: 'close', index: number): void
  (event: 'create'): void
  (event: 'reorder', from: number, to: number): void
}>()

/**
 * HTML5 drag state. `dragIndex` is the tab being dragged; `dropIndex` is the
 * gap it would land in, in the *original* indexing, so it can be 0..length.
 * A half-tab midpoint decides whether a drop goes before or after the hovered
 * tab. The indicator is drawn at that gap.
 */
const dragIndex = ref<number | null>(null)
const dropIndex = ref<number | null>(null)

function onDragStart(event: DragEvent, index: number): void {
  dragIndex.value = index
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    // Firefox only starts a drag once some data is set.
    event.dataTransfer.setData('text/plain', String(index))
  }
}

function onDragOver(event: DragEvent, index: number): void {
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  dropIndex.value = index + (event.clientX > rect.left + rect.width / 2 ? 1 : 0)
}

function resetDrag(): void {
  dragIndex.value = null
  dropIndex.value = null
}

function onDrop(event: DragEvent): void {
  event.preventDefault()
  const from = dragIndex.value
  const gap = dropIndex.value
  resetDrag()
  if (from === null || gap === null) return
  // Removing `from` first shifts any gap at or after it down by one.
  const to = gap > from ? gap - 1 : gap
  if (to !== from) emit('reorder', from, to)
}
</script>

<template>
  <div
    class="flex min-w-0 items-center gap-1 overflow-x-auto"
    @dragover.prevent
    @drop="onDrop"
  >
    <template v-for="(tab, index) in tabs" :key="tab.id">
      <div
        v-if="dropIndex === index"
        class="h-4 w-0.5 shrink-0 rounded bg-accent-strong"
        aria-hidden="true"
      ></div>

      <div
        class="flex h-5 shrink-0 items-center rounded transition-colors"
        :class="[
          index === activeIndex
            ? 'bg-accent text-fg-bright'
            : 'text-fg-dim hover:bg-hover hover:text-fg',
          dragIndex === index ? 'opacity-50' : ''
        ]"
        draggable="true"
        @dragstart="onDragStart($event, index)"
        @dragover="onDragOver($event, index)"
        @dragend="resetDrag"
      >
        <button
          type="button"
          class="max-w-44 truncate pl-2 pr-1 text-ui-sm"
          @click="emit('select', index)"
        >
          {{ tab.label }}
        </button>

        <button
          v-if="tabs.length > 1"
          type="button"
          class="mr-1 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded hover:bg-hover hover:text-fg-bright"
          title="Close terminal (Ctrl+W)"
          @click.stop="emit('close', index)"
        >
          <svg
            viewBox="0 0 24 24"
            class="h-2.5 w-2.5"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    </template>

    <div
      v-if="dropIndex === tabs.length"
      class="h-4 w-0.5 shrink-0 rounded bg-accent-strong"
      aria-hidden="true"
    ></div>

    <button
      type="button"
      class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-dim transition-colors hover:bg-hover hover:text-fg"
      title="New terminal (Ctrl+T)"
      @click="emit('create')"
    >
      <svg
        viewBox="0 0 24 24"
        class="h-3 w-3"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <path d="M12 5v14M5 12h14" />
      </svg>
    </button>
  </div>
</template>
