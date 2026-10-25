<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import type { PaneMenuChoice, PaneMenuItem } from '@renderer/lib/paneMenu'

/**
 * The menu a pane's row opens — the long right-press, Ctrl+right-click, or
 * Shift+F10. The app builds what is in it (the operations are the app's), so this
 * is only the drawing and the keyboard: the items come in already worded, already
 * carrying their action and the key that does the same thing without a menu.
 */
const props = defineProps<{
  /** What the menu is about, named in its header — the row's own name. */
  title: string
  items: PaneMenuItem[]
  /** Where it was asked for, in client coordinates. */
  x: number
  y: number
}>()

const emit = defineEmits<{
  (event: 'choose', choice: PaneMenuChoice): void
  (event: 'close'): void
}>()

const panel = ref<HTMLElement | null>(null)

/**
 * Where the menu ends up, which is where it was asked for until it has measured
 * itself. A menu near an edge would otherwise hang off it, and the only way to
 * know how much room it needs is to ask it: it is drawn invisible for the one
 * frame that costs, rather than being placed, painted at the wrong spot and moved.
 */
const anchor = ref({ x: props.x, y: props.y })
const placed = ref(false)
const EDGE = 6

/** The item the keyboard is on. Only a pickable one can be current. */
const active = ref(0)

/** The indices the keyboard may land on: the items that are not separators. */
const choices = computed(() =>
  props.items.flatMap((item, index) => (item.kind === 'action' ? [index] : []))
)

/**
 * Step to the next pickable item, separators skipped: the highlight is on
 * something Enter can run, and a menu whose arrows stopped on a divider would be
 * a menu you can get stuck in.
 */
function step(delta: number): void {
  const count = choices.value.length
  if (count === 0) return
  const at = choices.value.indexOf(active.value)
  const next = choices.value[(at + delta + count) % count]
  if (next !== undefined) active.value = next
}

function onKey(event: KeyboardEvent): void {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      step(1)
      break
    case 'ArrowUp':
      event.preventDefault()
      step(-1)
      break
    case 'Home':
      event.preventDefault()
      active.value = choices.value[0] ?? 0
      break
    case 'End':
      event.preventDefault()
      active.value = choices.value[choices.value.length - 1] ?? 0
      break
    case 'Enter':
      event.preventDefault()
      choose(active.value)
      break
    case 'Tab':
      // The menu is the whole of the keyboard while it is up, so Tab is not a
      // way out of it: Escape, or a click outside, is.
      event.preventDefault()
      break
  }
}

function choose(index: number): void {
  const item = props.items[index]
  if (!item || item.kind !== 'action') return
  emit('choose', item)
}

onMounted(async () => {
  active.value = choices.value[0] ?? 0
  await nextTick()

  const box = panel.value?.getBoundingClientRect()
  if (box) {
    const limit = { x: window.innerWidth - box.width - EDGE, y: window.innerHeight - box.height - EDGE }
    anchor.value = {
      x: Math.max(EDGE, Math.min(props.x, limit.x)),
      y: Math.max(EDGE, Math.min(props.y, limit.y))
    }
  }

  placed.value = true

  // The focus has to wait for the placement to reach the DOM: while the menu is
  // still `invisible` it cannot hold the keyboard, and `focus()` on a hidden
  // element is silently ignored — which leaves the arrows driving the shell's line
  // editor behind the menu. One microtask, and no paint in between, so the menu is
  // never drawn at the wrong spot on the way.
  await nextTick()
  panel.value?.focus()
})

/**
 * Whether a key that reached the app is this menu's own — the arrows and Enter it
 * moves and picks with. The menu drives itself from the keys that land on it,
 * which is what holding the focus means; this is how the app tells those from a
 * key that arrived while the focus had gone somewhere else, which it drops rather
 * than let drive the pane or the shell behind a modal menu.
 */
function ownsKey(target: EventTarget | null): boolean {
  return target instanceof Node && panel.value?.contains(target) === true
}

defineExpose({ ownsKey })
</script>

<template>
  <!-- The whole window is the menu's backdrop: a press anywhere outside it is a
       dismissal, and nothing behind it is reachable while it is up. The right
       button's own release lands here too — the hold that opened the menu may
       still be held — and is deliberately not a click on anything: a menu that
       opened under a held button must not pick the item that happens to be under
       the pointer when the button comes up. -->
  <div
    class="fixed inset-0 z-50"
    @mousedown="$emit('close')"
    @wheel.prevent="$emit('close')"
    @contextmenu.prevent
  >
    <div
      ref="panel"
      tabindex="-1"
      role="menu"
      class="absolute w-64 overflow-hidden rounded-md border border-border bg-surface py-1 text-ui shadow-xl outline-none"
      :class="placed ? '' : 'invisible'"
      :style="{ left: `${anchor.x}px`, top: `${anchor.y}px` }"
      @keydown="onKey"
      @mousedown.stop
      @contextmenu.prevent
    >
      <p
        class="truncate border-b border-border-subtle px-3 pb-1.5 pt-1 font-mono text-ui-sm text-fg-bright"
        :title="title"
      >
        {{ title }}
      </p>

      <template v-for="(item, index) in items" :key="index">
        <div v-if="item.kind === 'separator'" class="my-1 border-t border-border-subtle" />
        <button
          v-else
          type="button"
          role="menuitem"
          class="flex w-full items-center justify-between gap-3 px-3 py-1 text-left"
          :class="index === active ? 'bg-accent-strong text-white' : 'text-fg hover:bg-hover'"
          @mouseenter="active = index"
          @click="choose(index)"
        >
          <span class="truncate">{{ item.label }}</span>
          <span
            v-if="item.hint"
            class="shrink-0 text-ui-sm"
            :class="index === active ? 'text-white/80' : 'text-fg-dim'"
          >
            {{ item.hint }}
          </span>
        </button>
      </template>
    </div>
  </div>
</template>
