<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { sideColor } from '@renderer/lib/gitMark'
import { commitRelPath, type CommitEntry } from '@renderer/lib/commit'

const props = defineProps<{
  /** The work tree's root, shown so the scope is never in doubt. */
  root: string
  branch: string
  detached: boolean
  /** The upstream a push would reach, or null with none. */
  upstream: string | null
  entries: CommitEntry[]
  /**
   * The message the field starts with, derived from the changes — selected on
   * open, so typing replaces it wholesale. See `defaultCommitMessage`.
   */
  defaultMessage: string
  /**
   * How many of those entries are conflicted. A non-zero count is warned about:
   * the whole work tree is about to be committed, conflict markers and all.
   */
  conflicted: number
  /** A commit or push is in flight; every control is held. */
  running: boolean
  /** Why the last attempt failed, shown in place rather than as a pane notice. */
  error: string | null
}>()

const emit = defineEmits<{
  (event: 'confirm', message: string, push: boolean): void
  (event: 'cancel'): void
}>()

const messageInput = ref<HTMLTextAreaElement | null>(null)
const cancelButton = ref<HTMLButtonElement | null>(null)
const commitButton = ref<HTMLButtonElement | null>(null)

const message = ref('')

/**
 * Whether the commit will be followed by a push. Push is only on offer when
 * there is somewhere to push to — a branch with an upstream and a HEAD that is
 * on one — and it starts on when there is.
 */
const canPush = computed(() => !props.detached && props.upstream !== null)
const push = ref(false)

const subject = computed(() => message.value.trim().split('\n', 1)[0]?.trim() ?? '')
const canCommit = computed(
  () => subject.value.length > 0 && props.entries.length > 0 && !props.running
)

const actionLabel = computed(() => (push.value ? 'Commit & push' : 'Commit'))

/** The path as the list shows it: relative to the work tree, not absolute. */
function rel(path: string): string {
  return commitRelPath(props.root, path)
}

onMounted(() => {
  push.value = canPush.value
  // The generated message is the field's starting value and is *selected*, so
  // typing replaces it whole while an arrow or a click can keep it and edit
  // around it.
  message.value = props.defaultMessage
  // The message is the field to fill in, so it starts focused and ready to type.
  void nextTick(() => {
    messageInput.value?.focus()
    messageInput.value?.select()
  })
})

/**
 * The one button the dialog has: stage everything and commit it, pushing after
 * when asked. A conflict is not refused — committing a merge is legitimate —
 * but it is the user's to accept, which the warning above the buttons is for.
 */
function submit(): void {
  if (!canCommit.value) return
  emit('confirm', message.value.trim(), push.value)
}

/** A press on the backdrop itself cancels, unless a write is in flight. */
function onBackdrop(): void {
  if (!props.running) emit('cancel')
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    if (!props.running) emit('cancel')
    return
  }

  if (event.key === 'Enter') {
    const inMessage = document.activeElement === messageInput.value
    // The two functions are exchanged from a plain textarea: Enter starts a line
    // and Shift+Enter commits (Ctrl/Cmd+Enter commits from anywhere). Composing a
    // message is the common case and firing it off is deliberate, so the plain key
    // composes and the chord fires. Enter on a focused button is left to the
    // button, so Enter on Cancel still cancels.
    const commits =
      event.ctrlKey || event.metaKey || (event.shiftKey && inMessage && !event.altKey)
    if (commits) {
      event.preventDefault()
      submit()
      return
    }

    // A bare Enter in the message is the newline. When the whole prefilled message
    // is still selected — nothing typed over it — the line lands *after* it rather
    // than replacing it, so asking for a body line does not wipe the starting
    // message. Any other Enter is the textarea's own.
    const el = messageInput.value
    if (
      inMessage &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      el !== null &&
      message.value.length > 0 &&
      el.selectionStart === 0 &&
      el.selectionEnd === message.value.length
    ) {
      event.preventDefault()
      const end = message.value.length
      message.value = `${message.value}\n`
      void nextTick(() => el.setSelectionRange(end + 1, end + 1))
      return
    }

    return
  }

  // Arrow keys move between the buttons only once a button has the focus; in
  // the message they belong to the text cursor.
  if (document.activeElement === messageInput.value) return

  switch (event.key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      event.preventDefault()
      cancelButton.value?.focus()
      break
    case 'ArrowRight':
    case 'ArrowDown':
      event.preventDefault()
      commitButton.value?.focus()
      break
  }
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
    @mousedown.self="onBackdrop"
  >
    <div
      class="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-md border border-border bg-surface shadow-xl"
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
          <line x1="6" y1="3" x2="6" y2="15" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" y="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
        <span class="min-w-0 flex-1 truncate text-ui-lg text-fg-bright">Commit changes</span>
        <span class="shrink-0 font-mono text-ui-sm text-fg-dim">{{ branch }}</span>
      </div>

      <div class="flex min-h-0 flex-col gap-2 px-4 py-3">
        <p class="truncate font-mono text-ui-sm text-fg-dim" :title="root">{{ root }}</p>

        <!-- The scope, said plainly: this stages and commits the whole work
             tree, not the directory the pane happens to be showing. -->
        <p class="text-ui-sm text-fg-dim">
          <template v-if="entries.length === 0">Nothing to commit — the work tree is clean.</template>
          <template v-else>
            {{ entries.length === 1 ? '1 changed entry' : `${entries.length} changed entries` }} —
            all of them will be staged and committed.
          </template>
        </p>

        <ul
          v-if="entries.length > 0"
          class="max-h-52 shrink-0 overflow-y-auto rounded border border-border bg-bg-alt py-1 font-mono text-ui-sm"
        >
          <li
            v-for="entry in entries"
            :key="entry.path"
            class="flex items-baseline gap-2 px-2 py-0.5"
            :title="entry.label"
          >
            <span class="w-3 shrink-0 text-center" :style="{ color: sideColor(entry.letter) }">{{
              entry.letter
            }}</span>
            <span class="min-w-0 flex-1 truncate text-fg">{{ rel(entry.path) }}{{ entry.directory ? '/' : '' }}</span>
          </li>
        </ul>

        <!-- A merge mid-flight is worth a word: `add -A` stages the conflict
             markers too, so committing here is a decision, not an accident. -->
        <p v-if="conflicted > 0" class="text-ui-sm text-danger">
          {{ conflicted === 1 ? '1 path is conflicted' : `${conflicted} paths are conflicted` }} —
          committing will record the conflict markers as they stand.
        </p>

        <p class="pt-1 text-ui-sm text-fg-dim">Message</p>
        <textarea
          ref="messageInput"
          v-model="message"
          rows="5"
          class="w-full resize-none rounded border border-border bg-bg-alt px-2 py-1 font-mono text-ui text-fg outline-none focus:border-accent-strong"
          spellcheck="false"
          placeholder="Commit message"
        />
        <p class="text-ui-sm text-fg-dim">
          The first line is the subject. Enter starts a new line; Shift+Enter commits.
        </p>

        <label
          v-if="canPush"
          class="flex cursor-pointer items-center gap-2 pt-1 text-ui-sm text-fg"
        >
          <input
            v-model="push"
            type="checkbox"
            class="h-3.5 w-3.5 accent-[var(--color-accent-strong)]"
            :disabled="running"
          />
          <span>Push to <span class="font-mono">{{ upstream }}</span> after committing</span>
        </label>
        <p v-else-if="detached" class="pt-1 text-ui-sm text-fg-dim">
          HEAD is detached, so there is no branch to push.
        </p>
        <p v-else class="pt-1 text-ui-sm text-fg-dim">
          The branch has no upstream, so there is nothing to push to yet.
        </p>

        <p v-if="error" class="text-ui-sm whitespace-pre-wrap text-danger">{{ error }}</p>
      </div>

      <div class="flex items-center justify-end gap-2 border-t border-border-subtle px-4 py-3">
        <span v-if="running" class="mr-auto text-ui-sm text-fg-dim">
          {{ push ? 'Committing and pushing…' : 'Committing…' }}
        </span>
        <button
          ref="cancelButton"
          type="button"
          class="rounded border border-border bg-surface px-3 py-1 text-ui text-fg hover:bg-hover focus:border-accent-strong focus:bg-accent-strong focus:text-white disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="running"
          @click="$emit('cancel')"
        >
          Cancel
        </button>
        <button
          ref="commitButton"
          type="button"
          class="rounded border border-accent-strong bg-accent-strong/15 px-3 py-1 text-ui text-accent-strong hover:bg-accent-strong/25 focus:border-accent-strong focus:bg-accent-strong focus:text-white focus:outline-2 focus:outline-accent-strong disabled:cursor-not-allowed disabled:border-border disabled:bg-transparent disabled:text-fg-dim disabled:hover:bg-transparent"
          :disabled="!canCommit"
          @click="submit"
        >
          {{ actionLabel }}
        </button>
      </div>
    </div>
  </div>
</template>
