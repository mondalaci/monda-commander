import { ref } from 'vue'

/**
 * Whether the editor wraps its lines, as one answer for the whole app: the
 * overlay viewer and a pane's in-place editor both read it, and switching it in
 * one is the same choice the next one opens with. It starts wrapped — a long
 * line that runs off the edge is the common nuisance, and prose is written to a
 * width — and the gesture (`Alt+Z`, or the editor's own Wrap button) turns it
 * off where code reads better unwrapped.
 *
 * It is a session preference rather than a remembered one: the next launch opens
 * wrapped again, which is what "by default" means for a viewer that is used for
 * prose as often as for code.
 */
export const editorWrap = ref(true)

/** The gesture's answer: wrapped, or not. */
export function toggleEditorWrap(): void {
  editorWrap.value = !editorWrap.value
}
