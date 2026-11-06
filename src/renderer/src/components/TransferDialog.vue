<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { formatSize } from '@renderer/lib/format'
import { transferPhrase, type TransferTask } from '@renderer/composables/useTransfers'
import { TRANSFER_BACKGROUND_LABEL, TRANSFER_CANCEL_LABEL } from '@shared/transfer'

const props = defineProps<{ task: TransferTask }>()

const emit = defineEmits<{
  (event: 'background'): void
  (event: 'stop'): void
  (event: 'dismiss'): void
}>()

const card = ref<HTMLElement | null>(null)

// The dialog holds the keyboard while it is up, so the app's own keys do not
// leak past it to the panes. Focus lands on the card rather than a button, so a
// stray Enter does not fire Background or Cancel unbidden.
onMounted(() => card.value?.focus())

const isMove = computed(() => props.task.mode === 'move')
const phrase = computed(() => transferPhrase(props.task))

/** A stop that has been asked for but not yet confirmed by main. */
const cancelling = computed(() => props.task.status === 'running' && props.task.stopRequested)

/** The line under the title: the entry being written, or the state it ended in. */
const detail = computed(() => {
  const task = props.task
  if (task.status === 'error') return task.error ?? 'The transfer failed'
  if (task.status === 'done' || task.status === 'cancelled') {
    return task.resolvedDestination ?? task.destination
  }
  if (task.total === 0 && task.copied === 0 && task.totalFiles === 0) return 'Measuring…'
  return task.current ?? 'Preparing…'
})

const fraction = computed(() => {
  const { copied, total } = props.task
  return total > 0 ? Math.min(1, copied / total) : 0
})

/** Unknown total — the transfer is still being weighed, or one that never says. */
const indeterminate = computed(() => props.task.status === 'running' && props.task.total === 0)

const percent = computed(() => Math.floor(fraction.value * 100))

/**
 * The current file's own bar, the one an orthodox copy dialog sets beside the
 * whole job's (`File` / `Total`, as mc and Double Commander draw it): a single
 * slow file shows it filling while the total barely moves. It is only drawn when
 * there is more than one file to tell apart — a lone file's two bars would be
 * the same bar twice.
 */
const showFileBar = computed(() => props.task.totalFiles > 1)

const fileFraction = computed(() => {
  const { fileCopied, fileTotal } = props.task
  return fileTotal > 0 ? Math.min(1, fileCopied / fileTotal) : 0
})

const fileIndeterminate = computed(() => props.task.status === 'running' && props.task.fileTotal === 0)

const filePercent = computed(() => Math.floor(fileFraction.value * 100))

/**
 * The whole job in one line, under the bars: how many of the files are done and
 * how many bytes of the whole — so a transfer of many small files reads as
 * progress rather than as whatever single file happens to be in flight.
 */
const summary = computed(() => {
  const task = props.task
  const parts: string[] = []
  if (task.totalFiles > 1) parts.push(`${task.files} of ${task.totalFiles} files`)
  if (task.total > 0) parts.push(`${formatSize(task.copied)} of ${formatSize(task.total)}`)
  else if (task.copied > 0) parts.push(formatSize(task.copied))
  return parts.join(' · ')
})
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
    @mousedown.self="task.status === 'running' ? $emit('background') : $emit('dismiss')"
  >
    <div
      ref="card"
      tabindex="-1"
      class="flex w-full max-w-md flex-col overflow-hidden rounded-md border border-border bg-surface shadow-xl outline-none"
      :style="{ 'view-transition-name': `transfer-${task.id}` }"
      role="dialog"
      aria-modal="true"
    >
      <div class="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
        <svg
          viewBox="0 0 24 24"
          class="h-4 w-4 shrink-0 text-accent-strong"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <template v-if="isMove">
            <path d="M13 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8" />
            <path d="M15 7l5 5-5 5M20 12H9" />
          </template>
          <template v-else>
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </template>
        </svg>
        <span class="min-w-0 flex-1 truncate text-ui-lg text-fg-bright" :title="phrase">
          {{ phrase }}
        </span>
        <svg
          v-if="task.status === 'done'"
          viewBox="0 0 24 24"
          class="h-4 w-4 shrink-0 text-runnable"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M5 13l4 4L19 7" />
        </svg>
      </div>

      <div class="flex flex-col gap-3 px-4 py-3">
        <div
          class="min-w-0 truncate text-ui-sm"
          :class="task.status === 'error' ? 'text-danger' : 'text-fg-dim'"
          :title="detail"
        >
          {{ detail }}
        </div>

        <!-- The two bars an orthodox copy dialog draws: the file in flight and
             the whole job. The `File` row is left out when there is only one
             file, where it would be the `Total` bar twice. -->
        <div class="grid grid-cols-[2.75rem_1fr_2.5rem] items-center gap-x-3 gap-y-2">
          <template v-if="showFileBar">
            <span class="text-ui-sm text-fg-dim">File</span>
            <div class="h-1.5 overflow-hidden rounded-full bg-bg-alt">
              <div
                v-if="fileIndeterminate"
                class="transfer-bar-running h-full w-1/3 rounded-full bg-accent-strong"
              ></div>
              <div
                v-else
                class="h-full rounded-full transition-[width] duration-150 ease-out"
                :class="task.status === 'error' ? 'bg-danger' : 'bg-accent-strong'"
                :style="{ width: `${fileFraction * 100}%` }"
              ></div>
            </div>
            <span class="text-right tabular-nums text-ui-sm text-fg-dim">
              {{ fileIndeterminate ? '' : `${filePercent}%` }}
            </span>
          </template>

          <span class="text-ui-sm text-fg-dim">Total</span>
          <div class="h-1.5 overflow-hidden rounded-full bg-bg-alt">
            <div
              v-if="indeterminate"
              class="transfer-bar-running h-full w-1/3 rounded-full bg-accent-strong"
            ></div>
            <div
              v-else
              class="h-full rounded-full transition-[width] duration-150 ease-out"
              :class="task.status === 'error' ? 'bg-danger' : 'bg-accent-strong'"
              :style="{ width: `${fraction * 100}%` }"
            ></div>
          </div>
          <span class="text-right tabular-nums text-ui-sm text-fg-bright">
            {{ indeterminate ? '' : `${percent}%` }}
          </span>
        </div>

        <div v-if="summary" class="tabular-nums text-ui-sm text-fg-dim">{{ summary }}</div>
      </div>

      <div
        v-if="task.status === 'running' || task.status === 'error'"
        class="flex justify-end gap-2 border-t border-border-subtle px-4 py-3"
      >
        <template v-if="task.status === 'running'">
          <button
            v-if="task.cancellable"
            type="button"
            :disabled="cancelling"
            class="flex items-center rounded border border-border bg-surface px-3 py-1 text-ui text-fg hover:bg-hover focus:border-accent-strong focus:bg-accent-strong focus:text-white disabled:cursor-default disabled:opacity-50"
            @click="$emit('stop')"
          >
            {{ cancelling ? 'Cancelling…' : 'Cancel' }}
            <span
              v-if="!cancelling"
              class="ml-1.5 rounded border border-border px-1 text-2xs leading-4 opacity-70"
            >
              {{ TRANSFER_CANCEL_LABEL }}
            </span>
          </button>
          <button
            type="button"
            class="flex items-center rounded border border-accent-strong bg-accent-strong/15 px-3 py-1 text-ui text-accent-strong hover:bg-accent-strong/25 focus:border-accent-strong focus:bg-accent-strong focus:text-white"
            @click="$emit('background')"
          >
            Background
            <span
              class="ml-1.5 rounded border border-accent-strong/40 px-1 text-2xs leading-4 opacity-70"
            >
              {{ TRANSFER_BACKGROUND_LABEL }}
            </span>
          </button>
        </template>
        <button
          v-else
          type="button"
          class="rounded border border-border bg-surface px-3 py-1 text-ui text-fg hover:bg-hover focus:border-accent-strong focus:bg-accent-strong focus:text-white"
          @click="$emit('dismiss')"
        >
          Close
        </button>
      </div>
    </div>
  </div>
</template>
