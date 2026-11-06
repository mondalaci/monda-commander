<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
// The app mark, inlined so it stays a data: URL the renderer's CSP allows.
import logo from '@renderer/assets/monda-commander.png?inline'

const maximized = ref(false)
let unsubscribe: (() => void) | null = null

onMounted(async () => {
  maximized.value = await window.mc.win.isMaximized()
  unsubscribe = window.mc.win.onMaximizedChange((value) => {
    maximized.value = value
  })
})

onBeforeUnmount(() => {
  unsubscribe?.()
  unsubscribe = null
})

function minimize(): void {
  void window.mc.win.minimize()
}

function toggleMaximize(): void {
  void window.mc.win.toggleMaximize()
}

function close(): void {
  void window.mc.win.close()
}

function onDoubleClick(event: MouseEvent): void {
  const target = event.target
  if (target instanceof HTMLElement && target.closest('button')) return
  toggleMaximize()
}
</script>

<template>
  <header
    class="drag-region flex h-8 shrink-0 items-center border-b border-border bg-surface pr-1.5"
    @dblclick="onDoubleClick"
  >
    <div class="flex shrink-0 items-center gap-2 pl-3">
      <img :src="logo" alt="" aria-hidden="true" class="h-4 w-4 select-none" draggable="false" />
    </div>

    <div class="no-drag ml-3 flex min-w-0 items-center">
      <slot />
    </div>

    <div class="drag-region h-full min-w-2 flex-1" aria-hidden="true"></div>

    <!-- Backgrounded transfers, parked leftward of the window buttons. The slot
         is `no-drag` like the buttons, or a pill could not be clicked, and it is
         held against the buttons by the spacer above taking the slack. -->
    <div class="no-drag flex h-full shrink-0 items-center gap-1 pr-1">
      <slot name="tasks" />
    </div>

    <div class="no-drag flex h-full shrink-0 items-stretch gap-1">
      <button
        type="button"
        class="flex w-7 items-center justify-center text-fg-dim transition-colors hover:bg-hover hover:text-fg"
        title="Minimize"
        @click="minimize"
      >
        <svg
          viewBox="0 0 24 24"
          class="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M5 12h14" />
        </svg>
      </button>

      <button
        type="button"
        class="flex w-7 items-center justify-center text-fg-dim transition-colors hover:bg-hover hover:text-fg"
        :title="maximized ? 'Restore' : 'Maximize'"
        @click="toggleMaximize"
      >
        <svg
          v-if="maximized"
          viewBox="0 0 24 24"
          class="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <rect x="4.5" y="8.5" width="11" height="11" rx="1" />
          <path d="M8.5 8.5v-3a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-3" />
        </svg>
        <svg
          v-else
          viewBox="0 0 24 24"
          class="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <rect x="5" y="5" width="14" height="14" rx="1" />
        </svg>
      </button>

      <button
        type="button"
        class="flex w-7 items-center justify-center text-fg-dim transition-colors hover:bg-danger hover:text-white"
        title="Close"
        @click="close"
      >
        <svg
          viewBox="0 0 24 24"
          class="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  </header>
</template>
