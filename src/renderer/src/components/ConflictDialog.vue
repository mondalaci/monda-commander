<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { formatRelativeDate, formatSize } from '@renderer/lib/format'
import type { TransferTask } from '@renderer/composables/useTransfers'
import type { ConflictChoice } from '@shared/types'

const props = defineProps<{ task: TransferTask }>()
const emit = defineEmits<{ (event: 'choose', choice: ConflictChoice): void }>()

const skipButton = ref<HTMLButtonElement | null>(null)
const footer = ref<HTMLElement | null>(null)

// The safe answer holds the focus, so a stray Enter does not replace a file.
onMounted(() => skipButton.value?.focus())

// Left/Right (and Up/Down) move between the buttons, wrapping, so the answer is
// reachable without the pointer — as the transfer dialogs work.
function moveFocus(delta: number): void {
  const buttons = Array.from(footer.value?.querySelectorAll<HTMLButtonElement>('button') ?? [])
  if (buttons.length === 0) return
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const from = current < 0 ? 0 : current
  buttons[(from + delta + buttons.length) % buttons.length]?.focus()
}

function focusEnd(last: boolean): void {
  const buttons = Array.from(footer.value?.querySelectorAll<HTMLButtonElement>('button') ?? [])
  buttons[last ? buttons.length - 1 : 0]?.focus()
}

function onKey(event: KeyboardEvent): void {
  switch (event.key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      event.preventDefault()
      moveFocus(-1)
      break
    case 'ArrowRight':
    case 'ArrowDown':
      event.preventDefault()
      moveFocus(1)
      break
    case 'Home':
      event.preventDefault()
      focusEnd(false)
      break
    case 'End':
      event.preventDefault()
      focusEnd(true)
      break
  }
}

const conflict = computed(() => props.task.conflict)
const isDirectory = computed(() => conflict.value?.kind === 'directory')

const title = computed(() => (isDirectory.value ? 'Folder exists' : 'File exists'))
const primaryLabel = computed(() => (isDirectory.value ? 'Merge' : 'Overwrite'))
const allLabel = computed(() => (isDirectory.value ? 'Merge all' : 'Overwrite all'))

/** A side's size and age, whichever of the two a folder has. */
function sideMeta(size: number | null, mtime: number | null): string {
  const parts: string[] = []
  if (size !== null) parts.push(formatSize(size))
  if (mtime !== null) parts.push(formatRelativeDate(mtime))
  return parts.join(' · ')
}
</script>

<template>
  <div v-if="conflict" class="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-6">
    <div
      class="flex w-full max-w-lg flex-col overflow-hidden rounded-md border border-border bg-surface shadow-xl"
      role="alertdialog"
      aria-modal="true"
      @keydown="onKey"
    >
      <div class="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
        <svg
          viewBox="0 0 24 24"
          class="h-4 w-4 shrink-0 text-danger"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M12 9v4M12 17h.01" />
          <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
        </svg>
        <span class="min-w-0 flex-1 truncate text-ui-lg text-fg-bright">{{ title }}</span>
      </div>

      <div class="flex flex-col gap-3 px-4 py-3">
        <div class="grid grid-cols-[4rem_1fr_auto] items-baseline gap-x-3 gap-y-2">
          <span class="text-ui-sm text-fg-dim">New</span>
          <span class="min-w-0 truncate font-mono text-ui" :title="conflict.source">
            {{ conflict.source }}
          </span>
          <span class="shrink-0 tabular-nums text-ui-sm text-fg-dim">
            {{ sideMeta(conflict.sourceSize, conflict.sourceMtime) }}
          </span>

          <span class="text-ui-sm text-fg-dim">Existing</span>
          <span class="min-w-0 truncate font-mono text-ui" :title="conflict.target">
            {{ conflict.target }}
          </span>
          <span class="shrink-0 tabular-nums text-ui-sm text-fg-dim">
            {{ sideMeta(conflict.targetSize, conflict.targetMtime) }}
          </span>
        </div>
        <p class="text-ui-sm text-fg-dim">
          {{ isDirectory ? 'The folder will be merged into.' : 'The existing file will be replaced.' }}
          Nothing is written until you choose.
        </p>
      </div>

      <div ref="footer" class="flex flex-wrap justify-end gap-2 border-t border-border-subtle px-4 py-3">
        <button
          type="button"
          class="rounded border border-border bg-surface px-3 py-1 text-ui text-fg hover:bg-hover focus:border-accent-strong focus:bg-accent-strong focus:text-white"
          @click="emit('choose', 'cancel')"
        >
          Cancel
        </button>
        <button
          type="button"
          class="rounded border border-border bg-surface px-3 py-1 text-ui text-fg hover:bg-hover focus:border-accent-strong focus:bg-accent-strong focus:text-white"
          @click="emit('choose', 'skipAll')"
        >
          Skip all
        </button>
        <button
          ref="skipButton"
          type="button"
          class="rounded border border-border bg-surface px-3 py-1 text-ui text-fg hover:bg-hover focus:border-accent-strong focus:bg-accent-strong focus:text-white"
          @click="emit('choose', 'skip')"
        >
          Skip
        </button>
        <button
          type="button"
          class="rounded border border-danger/60 bg-danger/10 px-3 py-1 text-ui text-danger hover:bg-danger/20 focus:border-danger focus:bg-danger focus:text-white"
          @click="emit('choose', 'overwriteAll')"
        >
          {{ allLabel }}
        </button>
        <button
          type="button"
          class="rounded border border-danger bg-danger/15 px-3 py-1 text-ui text-danger hover:bg-danger/25 focus:border-danger focus:bg-danger focus:text-white"
          @click="emit('choose', 'overwrite')"
        >
          {{ primaryLabel }}
        </button>
      </div>
    </div>
  </div>
</template>
