import { existsSync, promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { app } from 'electron'
import { RelayClient } from './client'
import { ensureRemoteRelay } from './deploy'
import { relayBinaryPath } from './paths'
import type { RelayProgress } from '@shared/api'
import { LOCAL_TARGET_ID, ROOT_TARGET_ID, type Target } from '@shared/target'

/**
 * The targets a workspace can run on, and the relay connections behind the
 * non-local ones. Local runs in main and needs no relay; root and ssh run the
 * same Go relay, launched differently. See docs/design.md, "One protocol, three
 * transports".
 *
 * A client is created on first use and kept for the app's life: a root relay is
 * session-scoped by design, and an ssh master is worth keeping up rather than
 * redialling per operation. Closing the app closes every client.
 */

export type RelayEventSink = (targetId: string, event: Record<string, unknown>) => void

/**
 * How long a failed launch is remembered. A pane's setup is two calls — home,
 * then the first listing — so without this the second call would start a whole
 * new ssh attempt and the pane would sit silent through two timeouts before
 * showing one error.
 */
const LAUNCH_FAILURE_TTL_MS = 5000

export class TargetRegistry {
  private readonly targets = new Map<string, Target>()
  private readonly clients = new Map<string, RelayClient>()
  private readonly pendingClients = new Map<string, Promise<RelayClient>>()
  private readonly launchFailures = new Map<string, { message: string; at: number }>()
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

    this.clients.set(id, client)
    this.targets.set(id, target)
    await this.persist()
    return target
  }

  async remove(id: string): Promise<void> {
    const target = this.targets.get(id)
    if (!target || target.kind === 'local' || target.kind === 'root') return
    this.clients.get(id)?.close()
    this.clients.delete(id)
    this.targets.delete(id)
    await this.persist()
  }

  /**
   * The relay behind a target, launched on first use. Null for local, which has
   * no relay; throws when a non-local relay cannot be reached or installed, so
   * the caller reports why instead of handing back a dead pipe.
   */
  async client(id: string): Promise<RelayClient | null> {
    const target = this.targets.get(id)
    if (!target) throw new Error(`Unknown target ${id}`)
    if (target.kind === 'local') return null

    const existing = this.clients.get(id)
    if (existing) return existing

    // Two panes opening at once share one launch, rather than racing two relays
    // onto the same target (and two uploads onto the same remote).
    const pending = this.pendingClients.get(id)
    if (pending) return pending

    const failed = this.launchFailures.get(id)
    if (failed && Date.now() - failed.at < LAUNCH_FAILURE_TTL_MS) {
      throw new Error(failed.message)
    }

    const launched = this.launch(target, (progress) =>
      this.forward(id, { type: 'target:progress', phase: progress.phase, value: progress.value })
    ).then(
      (client) => {
        this.launchFailures.delete(id)
        return client
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        this.launchFailures.set(id, { message, at: Date.now() })
        throw error
      }
    )
    this.pendingClients.set(id, launched)
    try {
      const client = await launched
      this.clients.set(id, client)
      return client
    } finally {
      this.pendingClients.delete(id)
    }
  }

  /**
   * Launch — and, for a remote, install — the relay behind a target. A failure
   * here is thrown rather than hidden: the IPC layer turns it into the error the
   * pane shows, so an unreachable host is a message and not an empty panel.
   */
  private async launch(
    target: Target,
    onProgress?: (progress: RelayProgress) => void
  ): Promise<RelayClient> {
    if (target.kind === 'ssh') {
      await ensureRemoteRelay(target, onProgress)
    } else if (!existsSync(relayBinaryPath())) {
      throw new Error('The relay binary is missing — run `npm run build:relay`')
    }

    onProgress?.({ phase: 'Starting relay…', value: 0.8 })
    const { command, args } = this.launchFor(target)
    const client = new RelayClient(target, command, args)
    client.onEvent('fs:changed', (event) => this.forward(target.id, event))
    client.onEvent('git:changed', (event) => this.forward(target.id, event))
    client.onEvent('pty:data', (event) => this.forward(target.id, event))
    client.onEvent('pty:exit', (event) => this.forward(target.id, event))
    // A client whose process ended is forgotten, so the next request launches a
    // fresh one — and re-checks the remote relay — instead of talking to a corpse.
    client.onClose = () => {
      if (this.clients.get(target.id) === client) this.clients.delete(target.id)
    }
    return client
  }

  closeAll(): void {
    for (const client of this.clients.values()) client.close()
    this.clients.clear()
  }

  private forward(targetId: string, event: Record<string, unknown>): void {
    this.sink?.(targetId, event)
  }

  private launchFor(target: Target): { command: string; args: string[] } {
    if (target.kind === 'root') {
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
        '--stdio'
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
