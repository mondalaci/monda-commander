<script setup lang="ts">
/**
 * The column editor's "insert a column here" control. One of these sits in every
 * gap of the header — before each column and after the last — so a column can be
 * put anywhere, not only at the end. It is presented rather than built here: the
 * pane owns what an add does, and whether there is still a type left to add.
 */
defineProps<{
  /** True once every column type is already shown, so there is nothing to add. */
  disabled: boolean
}>()

defineEmits<{ (event: 'add'): void }>()
</script>

<template>
  <button
    type="button"
    class="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-transparent text-fg-dim transition-colors hover:border-border hover:bg-hover hover:text-fg disabled:cursor-default disabled:opacity-25 disabled:hover:border-transparent disabled:hover:bg-transparent"
    :disabled="disabled"
    :title="disabled ? 'Every column is already shown' : 'Add a column here'"
    aria-label="Add a column here"
    @click.stop="$emit('add')"
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
</template>
