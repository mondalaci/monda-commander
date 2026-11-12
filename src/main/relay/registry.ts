import { existsSync, promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { app } from 'electron'
import { RelayClient } from './client'
import { TargetConnection } from './connection'
import { ensureRemoteRelay } from './deploy'
import { relayBinaryPath } from './paths'
import type { RelayProgress } from '@shared/api'
import { LOCAL_TARGET_ID, ROOT_TARGET_ID, type Target } from '@shared/target'

/**
 * The targets a workspace can run on, and the connections behind the non-local
 * ones. Local runs in main and needs no relay; root and ssh run the same Go
 * relay, launched differently. See docs/design.md, "One protocol, three
 * transports".
 *
 * A non-local target is a `TargetConnection`: it owns the relay behind the
 * target, keeps it up across a dropped channel, and re-attaches the shells when
 * it comes back. A connection is created on first use and kept for the app's
 * life.
 */

export type RelayEventSink = (targetId: string, event: Record<string, unknown>) => void

export class TargetRegistry {
  private readonly targets = new Map<string, Target>()
  private readonly connections = new Map<string, TargetConnection>()
  private sink: RelayEventSink | null = null
  private writeQueue: Promise<void> = Promise.resolve()

  async init(): Promise<void> {
    const user = os.userInfo().username
    this.targets.set(LOCAL_TARGET_ID, {
      id: LOCAL_TARGET_ID,
      kind: 'local',
      user,
      host: 'localhost'
    })
    this.targets.set(ROOT_TARGET_ID, {
      id: ROOT_TARGET_ID,
      kind: 'root',
      user: 'root',
      host: 'localhost'
    })

    const saved = await this.readSaved()
    for (const target of saved) this.targets.set(target.id, target)
  }

  setEventSink(sink: RelayEventSink): void {
    this.sink = sink
  }

  list(): Target[] {
    // Local first, then root, then saved remotes in the order they were added.
    const order: Target[] = []
    const local = this.targets.get(LOCAL_TARGET_ID)
    const root = this.targets.get(ROOT_TARGET_ID)
    if (local) order.push(local)
    if (root) order.push(root)
    for (const [id, target] of this.targets) {
      if (id === LOCAL_TARGET_ID || id === ROOT_TARGET_ID) continue
      order.push(target)
    }
    return order
  }

  get(id: string): Target | undefined {
    return this.targets.get(id)
  }

  async add(
    input: { user: string; host: string; port?: number; relayPath?: string },
    onProgress?: (progress: RelayProgress) => void
  ): Promise<Target> {
    const user = input.user.trim()
    const host = input.host.trim()
    if (!user || !host) throw new Error('A remote target needs a user and a host')
    const port = input.port && input.port > 0 ? input.port : undefined
    const id = `ssh-${user}-${host}${port ? `-${port}` : ''}`.replaceAll(/[^a-zA-Z0-9@._-]/g, '_')
    const existing = this.targets.get(id)
    if (existing) return existing

    const target: Target = {
      id,
      kind: 'ssh',
      user,
      host,
      ...(port ? { port } : {}),
      ...(input.relayPath?.trim() ? { relayPath: input.relayPath.trim() } : {})
    }

    // Reach it before it is remembered: install the relay if it is not there, and
    // wait for a `hello` so a host that answers ssh but not the protocol is a
    // failure too. A target that cannot be reached is never saved, and the reason
    // is what the caller shows — a typo does not become a permanent entry.
    const client = await this.launch(target, onProgress)
    onProgress?.({ phase: 'Verifying…', value: 0.92 })
    const hello = await client.request('hello', {})
    if (!hello.ok) {
      client.close()
      throw new Error(hello.error?.message ?? 'The relay did not answer')
    }

    // The connection adopts the client that was just verified rather than
    // dialling the host a second time.
    this.connectionFor(target).seed(client)
    this.targets.set(id, target)
    await this.persist()
    return target
  }

  async remove(id: string): Promise<void> {
    const target = this.targets.get(id)
    if (!target || target.kind === 'local' || target.kind === 'root') return
    this.connections.get(id)?.close()
    this.connections.delete(id)
    this.targets.delete(id)
    await this.persist()
  }

  /**
   * Ask a target's relay something, reconnecting first if the channel has
   * dropped. Local is refused here because it has no relay — its operations go
   * through main's own bridge — so the caller reports that rather than a dead
   * pipe. Routing every request through the connection is what lets it track the
   * ptys it must re-attach and the offsets their output resumes from.
   */
  async request(
    id: string,
    op: string,
    args: Record<string, unknown>,
    blob?: Buffer
  ): Promise<{
    ok: boolean
    data?: unknown
    error?: { code: string; message: string }
    blob?: Buffer
  }> {
    const target = this.targets.get(id)
    if (!target) throw new Error(`Unknown target ${id}`)
    if (target.kind === 'local') {
      return {
        ok: false,
        error: { code: 'ELOCAL', message: 'The local target runs in main and has no relay' }
      }
    }
    return this.connectionFor(target).request(op, args, blob)
  }

  closeAll(): void {
    for (const connection of this.connections.values()) connection.close()
    this.connections.clear()
  }

  /** The connection for a target, created once and kept for the app's life. */
  private connectionFor(target: Target): TargetConnection {
    const existing = this.connections.get(target.id)
    if (existing) return existing
    const connection = new TargetConnection(
      target,
      (onProgress) => this.launch(target, onProgress),
      {
        onEvent: (event) => this.forward(target.id, event),
        onState: (state, message) =>
          this.forward(target.id, {
            type: 'target:status',
            state,
            ...(message ? { message } : {})
          })
      }
    )
    this.connections.set(target.id, connection)
    return connection
  }

  /**
   * Launch — and, for a remote, install — the relay behind a target. A failure
   * here is thrown rather than hidden: the connection re-dials with a backoff,
   * and the caller's first attempt is turned into the error the pane shows, so
   * an unreachable host is a message and not an empty panel.
   */
  private async launch(
    target: Target,
    onProgress?: (progress: RelayProgress) => void
  ): Promise<RelayClient> {
    const report =
      onProgress ??
      ((progress: RelayProgress) =>
        this.forward(target.id, {
          type: 'target:progress',
          phase: progress.phase,
          value: progress.value
        }))

    if (target.kind === 'ssh') {
      await ensureRemoteRelay(target, report)
    } else if (!existsSync(relayBinaryPath())) {
      throw new Error('The relay binary is missing — run `npm run build:relay`')
    }

    report({ phase: 'Starting relay…', value: 0.8 })
    const { command, args } = this.launchFor(target)
    return new RelayClient(target, command, args)
  }

  private forward(targetId: string, event: Record<string, unknown>): void {
    this.sink?.(targetId, event)
  }

  private launchFor(target: Target): { command: string; args: string[] } {
    if (target.kind === 'root') {
      // Root stays a plain in-process relay: a persistent root daemon would be
      // an always-on privileged server, which the session-scoped launch avoids.
      return { command: 'pkexec', args: [relayBinaryPath(), '--stdio'] }
    }
    const port = target.port ? ['-p', String(target.port)] : []
    // The same path deploy.ts put the binary at: an absolute `relayPath` if one
    // was given, otherwise the per-user install the deploy wrote. Never a bare
    // `monda-relay`, which would only exist if the user installed it by hand.
    const remoteRelay =
      target.relayPath && target.relayPath.startsWith('/')
        ? target.relayPath
        : '~/.monda/monda-relay'
    // `--connect` reaches the persistent daemon on the host (starting it if it
    // is not up) rather than being the relay itself, which is what lets a
    // dropped channel be redialled without taking the sessions with it.
    return {
      command: 'ssh',
      args: [
        '-T',
        '-o',
        'ConnectTimeout=10',
        '-o',
        'ServerAliveInterval=15',
        '-o',
        'ServerAliveCountMax=3',
        ...port,
        `${target.user}@${target.host}`,
        remoteRelay,
        '--connect'
      ]
    }
  }

  private savedFile(): string {
    return path.join(app.getPath('userData'), 'targets.json')
  }

  private async readSaved(): Promise<Target[]> {
    try {
      const text = await fs.readFile(this.savedFile(), 'utf8')
      const parsed = JSON.parse(text) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed.filter((entry): entry is Target => {
        if (typeof entry !== 'object' || entry === null) return false
        const value = entry as Partial<Target>
        return (
          typeof value.id === 'string' &&
          value.kind === 'ssh' &&
          typeof value.user === 'string' &&
          typeof value.host === 'string'
        )
      })
    } catch {
      return []
    }
  }

  /** Writes are serialized so two quick adds cannot interleave and lose one. */
  private persist(): Promise<void> {
    const write = async (): Promise<void> => {
      const saved = this.list().filter((target) => target.kind === 'ssh')
      await fs.mkdir(path.dirname(this.savedFile()), { recursive: true })
      await fs.writeFile(this.savedFile(), JSON.stringify(saved, null, 2), 'utf8')
    }
    this.writeQueue = this.writeQueue.then(write, write)
    return this.writeQueue
  }
}

export const targetRegistry = new TargetRegistry()
