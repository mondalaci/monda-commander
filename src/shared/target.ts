import type { McGitApi, McFsApi, McPtyApi } from './api'

/**
 * Where a workspace's files and shell live. A workspace is one connection: both
 * panes and the shell belong to the same target, so there is one filesystem in
 * play (see docs/design.md, "A workspace is a connection").
 *
 * `local` runs in main as it always has. `root` and `ssh` run through the relay
 * (see "One protocol, three transports"); the relay is launched differently —
 * pkexec plus polkit for root, ssh for a remote host — but speaks the same
 * protocol over the same frames.
 */
export type TargetKind = 'local' | 'root' | 'ssh'

export interface Target {
  id: string
  kind: TargetKind
  user: string
  host: string
  port?: number
  /** Overrides the relay's path on a remote host; defaults to PATH lookup. */
  relayPath?: string
}

/** The API a workspace uses. Shaped like `McApi`, scoped to one target. */
export interface TargetApi {
  target: Target
  fs: McFsApi
  pty: McPtyApi
  git: McGitApi
  /**
   * The stages of this target's relay coming up — contacting the host, installing
   * the relay, starting and verifying it. A no-op for a local target, which has no
   * relay to wait for. A pane subscribes for the length of its first listing, so a
   * slow remote connect is a label instead of a blank list.
   */
  onProgress(handler: (phase: string) => void): () => void
}

/** `user@host`, the way a tab names the connection it is on. */
export function targetLabel(target: Target): string {
  const port = target.port && target.port !== 22 ? `:${target.port}` : ''
  return `${target.user}@${target.host}${port}`
}

/** The default local target, filled in by main once it knows the user. */
export const LOCAL_TARGET_ID = 'local'
export const ROOT_TARGET_ID = 'root'
