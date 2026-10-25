/**
 * The pane menu's two shapes: what a pane asks for when its rows want a menu, and
 * what the app can put in one.
 *
 * An item carries its own action — a closure over the app's operations — because
 * the app is what owns those (the transfers, the delete confirmation, the viewer).
 * The menu component only draws the items and reports the pick, which keeps it a
 * view of the list rather than a second place where the operations live.
 */

/**
 * A row's request for its menu. The row is named by path rather than by index:
 * the pane re-lists on its own (a watcher on the directory, a refresh), so an
 * index taken at the press can point at a different entry by the time the app
 * looks, while the path is what the row *is*.
 */
export interface PaneMenuRequest {
  path: string
  /** Where the menu was asked for, in client coordinates. */
  x: number
  y: number
}

export type PaneMenuItem =
  | {
      kind: 'action'
      label: string
      /** The key that does the same thing without the menu, shown beside it. */
      hint?: string
      run: () => void
    }
  | { kind: 'separator' }

/** What the menu reports back: only an action is a pick. */
export type PaneMenuChoice = Extract<PaneMenuItem, { kind: 'action' }>
