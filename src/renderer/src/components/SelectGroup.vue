<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

const props = defineProps<{
  mode: 'select' | 'unselect'
  mask: string
  filesOnly: boolean
  caseSensitive: boolean
}>()

const emit = defineEmits<{
  (event: 'confirm', mask: string, filesOnly: boolean, caseSensitive: boolean): void
  (event: 'cancel'): void
}>()

const maskInput = ref<HTMLInputElement | null>(null)
const cancelButton = ref<HTMLButtonElement | null>(null)
const applyButton = ref<HTMLButtonElement | null>(null)

/** The last answer is the starting point — the two keys are one question. */
const mask = ref(props.mask)
const filesOnly = ref(props.filesOnly)
const caseSensitive = ref(props.caseSensitive)

const selecting = computed(() => props.mode === 'select')
const title = computed(() => (selecting.value ? 'Select group' : 'Unselect group'))

/**
 * An empty mask is nothing to match, so the button stays out of reach until
 * there is one. The value is deliberately not trimmed: a leading or trailing
 * space is a character of a filename, and a mask that wants one has to be able
 * to ask for it.
 */
const canApply = computed(() => mask.value.length > 0)

// The mask is the field to fill in, and it opens selected, so typing replaces
// the previous answer rather than appending to it.
onMounted(() => {
  maskInput.value?.focus()
  maskInput.value?.select()
})

function commit(): void {
  if (!canApply.value) return
  emit('confirm', mask.value, filesOnly.value, caseSensitive.value)
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    // Enter in the mask, or on a checkbox, applies; a focused button keeps its
    // native Enter/Space activation. Space remains the checkbox's own toggle.
    const active = document.activeElement
    if (active === maskInput.value || active instanceof HTMLInputElement) {
      event.preventDefault()
      commit()
    }
    return
  }

  // Arrow keys move between the buttons only while a button has focus; in the
  // mask they belong to the text cursor, and on a checkbox they would otherwise
  // look like a second way to toggle it.
  if (!(document.activeElement instanceof HTMLButtonElement)) return

  switch (event.key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      event.preventDefault()
      cancelButton.value?.focus()
      break
    case 'ArrowRight':
    case 'ArrowDown':
      event.preventDefault()
      applyButton.value?.focus()
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
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="m8 12 3 3 5-6" />
        </svg>
        <span class="min-w-0 flex-1 truncate text-ui-lg text-fg-bright">{{ title }}</span>
      </div>

      <div class="flex flex-col gap-2 px-4 py-3">
        <p class="text-ui-sm text-fg-dim">Mask</p>
        <input
          ref="maskInput"
          v-model="mask"
          type="text"
          class="w-full rounded border border-border bg-bg-alt px-2 py-1 font-mono text-ui text-fg outline-none focus:border-accent-strong"
          spellcheck="false"
          autocomplete="off"
          placeholder="*"
        />
        <p class="text-ui-sm text-fg-dim">
          <span class="font-mono">*</span> matches any characters,
          <span class="font-mono">?</span> one character, and
          <span class="font-mono">[abc]</span> a set of them.
        </p>

        <div class="flex flex-wrap items-center gap-x-5 gap-y-2 pt-1">
          <label class="flex cursor-pointer items-center gap-2 text-ui-sm text-fg">
            <input
              v-model="filesOnly"
              type="checkbox"
              class="h-3.5 w-3.5 accent-[var(--color-accent-strong)]"
            />
            <span>Files only</span>
          </label>
          <label class="flex cursor-pointer items-center gap-2 text-ui-sm text-fg">
            <input
              v-model="caseSensitive"
              type="checkbox"
              class="h-3.5 w-3.5 accent-[var(--color-accent-strong)]"
            />
            <span>Case sensitive</span>
          </label>
        </div>
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
          ref="applyButton"
          type="button"
          class="rounded border border-accent-strong bg-accent-strong/15 px-3 py-1 text-ui text-accent-strong hover:bg-accent-strong/25 focus:border-accent-strong focus:bg-accent-strong focus:text-white focus:outline-2 focus:outline-accent-strong disabled:cursor-not-allowed disabled:border-border disabled:bg-transparent disabled:text-fg-dim disabled:hover:bg-transparent"
          :disabled="!canApply"
          @click="commit"
        >
          {{ selecting ? 'Select' : 'Unselect' }}
        </button>
      </div>
    </div>
  </div>
</template>
