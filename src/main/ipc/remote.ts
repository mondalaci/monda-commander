import { ipcMain, webContents } from 'electron'
import { targetRegistry } from '../relay/registry'
import type { Target } from '@shared/target'

/**
 * The renderer's door to the targets and their relays. One generic request
 * channel rather than one handler per operation: the relay's protocol is the
 * operation table, so adding an operation means teaching the relay and the
 * target API wrapper, not wiring another `ipcMain.handle`.
 *
 * Events are broadcast to every window with the target's id attached, so a pane
 * or a shell filters for the connection it belongs to.
 */

export function registerRemoteHandlers(): void {
  targetRegistry.setEventSink((targetId, event) => {
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue
      contents.send('remote:event', { targetId, ...event })
    }
  })

  ipcMain.handle('targets:list', () => targetRegistry.list())

  ipcMain.handle('targets:add', (event, input: { user: string; host: string; port?: number; relayPath?: string }) =>
    targetRegistry.add(input, (phase) => {
      if (!event.sender.isDestroyed()) event.sender.send('targets:progress', phase)
    })
  )

  ipcMain.handle('targets:remove', (_event, id: string) => targetRegistry.remove(id))

  ipcMain.handle(
    'remote:request',
    async (
      _event,
      targetId: string,
      op: string,
      args: Record<string, unknown>,
      blob?: Uint8Array
    ) => {
      try {
        const client = await targetRegistry.client(targetId)
        if (!client) {
          return {
            ok: false,
            error: { code: 'ELOCAL', message: 'The local target runs in main and has no relay' }
          }
        }
        const response = await client.request(op, args, blob ? Buffer.from(blob) : undefined)
        return {
          ok: response.ok,
          ...(response.data !== undefined ? { data: response.data } : {}),
          ...(response.error ? { error: response.error } : {}),
          ...(response.blob ? { blob: new Uint8Array(response.blob) } : {})
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not reach the target'
        return { ok: false, error: { code: 'ECONNECT', message } }
      }
    }
  )
}

export type RemoteTarget = Target
