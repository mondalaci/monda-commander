<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

const emit = defineEmits<{
  (event: 'confirm', name: string): void
  (event: 'cancel'): void
}>()

const nameInput = ref<HTMLInputElement | null>(null)
const cancelButton = ref<HTMLButtonElement | null>(null)
const createButton = ref<HTMLButtonElement | null>(null)

const name = ref('')

/**
 * An empty name is nothing to make, so Create stays out of reach until there is
 * one. Spaces alone are no name either, which is what the trimmed test is for:
 * the name is what the user typed, and main trims it the same way.
 */
const canCreate = computed(() => name.value.trim().length > 0)

// The name is the field to fill in, so it starts focused: the dialog opens
// ready to type, exactly like the transfer dialog's destination.
onMounted(() => nameInput.value?.focus())

function commit(): void {
  const value = name.value.trim()
  if (!value) return
  emit('confirm', value)
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    // Enter in the field creates; a focused button keeps its native Enter/Space
    // activation.
    if (document.activeElement === nameInput.value) {
      event.preventDefault()
      commit()
    }
    return
  }

  // Arrow keys move between the buttons only while a button has focus; in the
  // name input they belong to the text cursor.
  if (document.activeElement === nameInput.value) return

  switch (event.key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      event.preventDefault()
      cancelButton.value?.focus()
      break
    case 'ArrowRight':
    case 'ArrowDown':
      event.preventDefault()
      createButton.value?.focus()
      break
  }
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
    @mousedown.self="$emit('cancel')"
  >
    <div
      class="flex w-full max-w-md flex-col overflow-hidden rounded-md border border-border bg-surface shadow-xl"
      role="dialog"
      aria-modal="true"
      @keydown="onKey"
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
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
          <path d="M12 11v6M9 14h6" />
        </svg>
        <span class="min-w-0 flex-1 truncate text-ui-lg text-fg-bright">Create directory</span>
      </div>

      <div class="flex flex-col gap-2 px-4 py-3">
        <p class="text-ui-sm text-fg-dim">Name</p>
        <input
          ref="nameInput"
          v-model="name"
          type="text"
          class="w-full rounded border border-border bg-bg-alt px-2 py-1 font-mono text-ui text-fg outline-none focus:border-accent-strong"
          spellcheck="false"
          autocomplete="off"
          placeholder="New folder"
        />
        <p class="text-ui-sm text-fg-dim">
          A name alone makes a folder here; a path makes one where it points.
        </p>
      </div>

      <div class="flex justify-end gap-2 border-t border-border-subtle px-4 py-3">
        <button
          ref="cancelButton"
          type="button"
          class="rounded border border-border bg-surface px-3 py-1 text-ui text-fg hover:bg-hover focus:border-accent-strong focus:bg-accent-strong focus:text-white"
          @click="$emit('cancel')"
        >
          Cancel
        </button>
        <button
          ref="createButton"
          type="button"
          class="rounded border border-accent-strong bg-accent-strong/15 px-3 py-1 text-ui text-accent-strong hover:bg-accent-strong/25 focus:border-accent-strong focus:bg-accent-strong focus:text-white focus:outline-2 focus:outline-accent-strong disabled:cursor-not-allowed disabled:border-border disabled:bg-transparent disabled:text-fg-dim disabled:hover:bg-transparent"
          :disabled="!canCreate"
          @click="commit"
        >
          Create
        </button>
      </div>
    </div>
  </div>
</template>
