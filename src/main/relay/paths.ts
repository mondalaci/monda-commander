import * as path from 'node:path'
import { app } from 'electron'

/**
 * The protocol version the app and the relay must agree on. A remote relay whose
 * `--version` answers anything else is replaced before the connection opens (see
 * deploy.ts), so a stale relay from an earlier build is never talked to with a
 * newer protocol.
 */
export const RELAY_VERSION = 2

/**
 * The relay binary's location. Root needs an absolute path (pkexec does not do a
 * shell's PATH lookup), so the packaged resources directory is its home; a dev
 * run falls back to the repo's `resources/`, and `MONDA_RELAY` overrides both.
 */
export function relayBinaryPath(): string {
  if (process.env.MONDA_RELAY) return process.env.MONDA_RELAY
  if (app.isPackaged) return path.join(process.resourcesPath, 'monda-relay')
  return path.join(app.getAppPath(), 'resources', 'monda-relay')
}
