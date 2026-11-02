import { inject, type ComputedRef } from 'vue'
import type { TargetApi } from './targetApi'

/**
 * The active workspace's target API, provided by `App.vue` and injected by the
 * components that touch the filesystem directly — the viewer's save, a preview's
 * read, the hide gesture. A pane's own listing and its shell go through the API
 * the workspace handed them; these are the few places a component calls the
 * bridge itself.
 *
 * The provider is a computed over the active workspace, and the panes are keyed
 * by workspace id, so a tab switch remounts the components with the right target
 * rather than leaving one bound to the previous host.
 */
export const targetApiKey: unique symbol = Symbol('targetApi')

export function injectTargetApi(): TargetApi {
  const api = inject<ComputedRef<TargetApi> | null>(targetApiKey, null)
  if (api) return api.value
  // A component mounted outside the app (a test, a story) still needs an API; a
  // local one keeps it working without pretending to be a remote host.
  const user = window.mc.targets.localUser
  const target = { id: 'local', kind: 'local' as const, user, host: 'localhost' }
  return {
    target,
    fs: window.mc.fs,
    pty: window.mc.pty,
    git: window.mc.git,
    onProgress: () => () => {}
  }
}
