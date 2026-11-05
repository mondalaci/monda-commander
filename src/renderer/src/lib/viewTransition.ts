/**
 * A mode switch as a *morph*, where the browser can make one.
 *
 * The detail listing and the wall are two different layouts for the same rows, so
 * the honest way to show a switch is each entry travelling from the box it had to
 * the box it now has. That is exactly what the View Transitions API is for: give
 * an entry a `view-transition-name` in both layouts, run the state change inside
 * `startViewTransition`, and the browser snapshots the page before and after and
 * animates every named element from one box to the other — moving and resizing it,
 * while everything unnamed cross-fades.
 *
 * The name has to be unique in the document, so it is assigned per entry by the
 * pane that draws it (`entryName` in `FilePanel.vue`) rather than derived from the
 * path, and prefixed with the pane's side so two panes showing one folder cannot
 * collide.
 *
 * The callback is where the change happens. Vue's update is asynchronous, so it
 * awaits a tick itself *inside* the callback — the API waits for the callback's
 * promise before it takes the "after" snapshot.
 */

import { ref, watch } from 'vue'

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void | Promise<void>) => { finished: Promise<void> }
}

/**
 * Whether the browser is flying a mode morph right now.
 *
 * The panes' content is not even on screen for the length of it — a view
 * transition shows snapshots — so a thumbnail decoded or a model parsed into a
 * fresh WebGL context during those frames is work spent on something nobody can
 * see, on the same main thread the flight needs to stay smooth. The grid and the
 * model wall hold themselves back while this is true, and start once it is not.
 */
export const morphing = ref(false)

/** Whether the browser can morph a switch rather than only cross-fading it. */
export function canMorphView(): boolean {
  return typeof (document as ViewTransitionDocument).startViewTransition === 'function'
}

/**
 * Resolve once no morph is flying — at once when none is. For work that cannot be
 * made cheap, only postponed: a mesh parsed on the main thread, a tile decoded, a
 * context given back. Those are held until the flight has landed rather than
 * sharing its frames.
 */
export function whenNotMorphing(): Promise<void> {
  if (!morphing.value) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const stop = watch(
      morphing,
      (on) => {
        if (on) return
        stop()
        resolve()
      },
      // Synchronous, because this promise is what unblocks work that would
      // otherwise sit behind the frame the flag is cleared in.
      { flush: 'sync' }
    )
  })
}

/**
 * Run a view change as a morph where there is one to run, and plainly where there
 * is not — an older engine simply switches, as it did before.
 */
export function withViewTransition(update: () => void | Promise<void>): void {
  const doc = document as ViewTransitionDocument
  if (typeof doc.startViewTransition !== 'function') {
    void update()
    return
  }

  morphing.value = true
  try {
    const transition = doc.startViewTransition(update)
    // The flight is over when the *animation* is, not when the DOM changed: the
    // flag is what keeps the panes' expensive work back until nothing is moving.
    // A transition the browser skips settles here at once, which is right too.
    transition.finished.then(
      () => {
        morphing.value = false
      },
      () => {
        morphing.value = false
      }
    )
  } catch {
    // A transition that could not start must not leave the panes holding back.
    morphing.value = false
    void update()
  }
}
