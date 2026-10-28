/**
 * How a change to what the hide mode covers is shown: the rows that leave are
 * squeezed out where they stood while everything below them closes the gap by
 * sliding up, and the rows that come back slide down into the room they open.
 *
 * The listing is windowed and every row is placed by index — `index *
 * ROW_HEIGHT` is the whole of a row's geometry — so how far a surviving row has
 * to travel is known without measuring anything: it is the difference between
 * the index it had and the index it now has. That is what this module is handed.
 * It animates the live rows with a transform, the layout already being the new
 * one, so nothing else in the pane moves; that is also why the rows the mode has
 * just covered, and which have already left the document, have to arrive as
 * copies taken while they were still there — otherwise there would be nothing
 * left to animate.
 *
 * It lives apart from the pane because it is the one place that treats rows as
 * elements rather than as entries. The arrays it reads are assembled in
 * FilePanel, which is where the rows rendered a moment ago are still known and
 * the old DOM is still standing to be copied from.
 */

/** Long enough to read as the rows closing the gap, short enough not to wait. */
const SLIDE_MS = 190
/** The row on its way out is done fading a little before the others arrive. */
const FADE_MS = 170

export interface HideScene {
  /** The listing's scroller, which the copies of the rows are appended to. */
  list: HTMLElement
  /** The row's height in pixels — the unit every travel is a multiple of. */
  rowHeight: number
  /** The pane's row paths, in order, as they were before the change. */
  before: readonly string[]
  /** The same, as they are now. */
  after: readonly string[]
  /**
   * Copies of the rows that were on screen before the change and that the mode
   * now covers. Each is the row as it stood, with the index it stood at.
   */
  leaving: readonly { el: HTMLElement; index: number }[]
}

function glide(el: HTMLElement, from: number, duration: number): void {
  el.animate(
    [{ transform: `translateY(${from}px)` }, { transform: 'translateY(0)' }],
    { duration, easing: 'ease-out', fill: 'none' }
  )
}

export function playHideAnimation({ list, rowHeight, before, after, leaving }: HideScene): void {
  const wasAt = new Map<string, number>()
  before.forEach((path, index) => wasAt.set(path, index))
  const isAt = new Map<string, number>()
  after.forEach((path, index) => isAt.set(path, index))

  for (const el of list.querySelectorAll<HTMLElement>('li[data-path]:not(.hide-ghost)')) {
    const path = el.dataset.path
    if (path === undefined) continue
    const to = isAt.get(path)
    if (to === undefined) continue

    const from = wasAt.get(path)
    if (from === undefined) {
      // Newly uncovered: it descends into the room the rows below are opening.
      el.animate(
        [
          { transform: `translateY(${-rowHeight}px)`, opacity: 0 },
          { transform: 'translateY(0)', opacity: 1 }
        ],
        { duration: SLIDE_MS, easing: 'ease-out', fill: 'none' }
      )
      continue
    }

    if (from !== to) glide(el, (from - to) * rowHeight, SLIDE_MS)
  }

  for (const { el, index } of leaving) {
    el.classList.add('hide-ghost')
    el.style.top = `${index * rowHeight}px`
    list.appendChild(el)
    el.animate(
      [
        { opacity: 1, transform: 'scaleY(1)' },
        { opacity: 0, transform: 'scaleY(0.45)' }
      ],
      // Held at the end until the element is taken out, or the last frame it is
      // in the document for would be the row back at full strength.
      { duration: FADE_MS, easing: 'ease-out', fill: 'forwards' }
    )
      .finished.finally(() => el.remove())
      .catch(() => {})
  }
}
