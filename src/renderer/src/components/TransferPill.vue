<script setup lang="ts">
import { computed } from 'vue'
import { transferPhrase, transferTooltip, type TransferTask } from '@renderer/composables/useTransfers'
import { TRANSFER_PILLS_LABEL } from '@shared/transfer'

const props = defineProps<{ task: TransferTask }>()
const emit = defineEmits<{ (event: 'restore'): void }>()

const isMove = computed(() => props.task.mode === 'move')
const isDelete = computed(() => props.task.mode === 'delete')

const percent = computed(() => {
  const { copied, total } = props.task
  return total > 0 ? Math.min(100, Math.floor((copied / total) * 100)) : 0
})

const indeterminate = computed(() => props.task.status === 'running' && props.task.total === 0)

/** The hover text, with the keyboard door named so a pill is reachable without a pointer. */
const title = computed(
  () => `${transferTooltip(props.task)}\n${TRANSFER_PILLS_LABEL} — move between tasks`
)
</script>

<template>
  <button
    type="button"
    data-transfer-pill
    class="flex h-5 items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2 text-2xs text-fg-dim transition-colors hover:border-accent-strong hover:text-fg"
    :style="{ 'view-transition-name': `transfer-${task.id}` }"
    :title="title"
    @click="emit('restore')"
  >
    <svg
      viewBox="0 0 24 24"
      class="h-3 w-3 shrink-0"
      :class="isDelete ? 'text-danger' : ''"
      fill="none"
      stroke="currentColor"
      stroke-width="1.9"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <template v-if="isDelete">
        <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v5M14 11v5" />
      </template>
      <template v-else-if="isMove">
        <path d="M13 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8" />
        <path d="M15 7l5 5-5 5M20 12H9" />
      </template>
      <template v-else>
        <rect x="9" y="9" width="11" height="11" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </template>
    </svg>

    <span class="max-w-24 truncate">
      {{
        task.status === 'running' && !task.stopRequested
          ? task.total > 0
            ? `${percent}%`
            : '…'
          : transferPhrase(task)
      }}
    </span>

    <span class="relative h-1 w-10 shrink-0 overflow-hidden rounded-full bg-bg">
      <span
        v-if="indeterminate"
        class="transfer-bar-running absolute inset-y-0 w-1/2 rounded-full bg-accent-strong"
      ></span>
      <span
        v-else
        class="absolute inset-y-0 left-0 rounded-full"
        :class="task.status === 'done' ? 'bg-runnable' : 'bg-accent-strong'"
        :style="{ width: `${percent}%` }"
      ></span>
    </span>
  </button>
</template>
