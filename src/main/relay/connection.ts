import { RelayClient } from './client'
import type { RelayProgress } from '@shared/api'
import type { Target } from '@shared/target'

/**
 * One target's connection to its relay, kept up rather than rebuilt. The relay
 * behind a remote target is a daemon that outlives the ssh channel (see
 * `relay/server.go` and docs/design.md, "The connection is long-lived; the
 * protocol is its guest"), so when the channel drops this does not fail the
 * session — it re-dials, re-attaches every shell at the offset it last saw, and
 * tells the app the connection is back so the panes can re-list.
 *
 * Everything a workspace does goes through `request`; the reconnect and the
 * replay are invisible above it. The only visible seam is the state change,
 * which the renderer paints as its connecting bar.
 */

export type ConnectionState = 'connecting' | 'reconnecting' | 'connected'

export interface ConnectionCallbacks {
  /** A relay event, already stripped of the reconnect bookkeeping. */
  onEvent: (event: Record<string, unknown>) => void
  /** The connection came up, dropped, or is being re-established. */
  onState: (state: ConnectionState, message?: string) => void
}

export interface RelayAnswer {
  ok: boolean
  data?: unknown
  error?: { code: string; message: string }
  blob?: Buffer
}

/**
 * How long to wait before each reconnect attempt. A dropped link is often back
 * within a second, so the early tries are quick; a host that is really gone
 * settles to one try every ten seconds rather than a tight loop.
 */
const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 5000, 10000]

export class TargetConnection {
  readonly target: Target
  private client: RelayClient | null = null
  private connecting: Promise<RelayClient> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private attempt = 0
  private everConnected = false
  private reconnectAnnounced = false
  /** Requests that arrived mid-outage and are waiting for the link to return. */
  private waiters: Array<{
    resolve: (client: RelayClient) => void
    reject: (error: Error) => void
  }> = []
  /** Which shells to re-attach, and the offset each output resumes from. */
  private readonly ptyOrder: string[] = []
  private readonly ptyOffsets = new Map<string, number>()
  /**
   * Shells the app asked for that the daemon never confirmed — a first connect
   * that failed outright, or a drop between the request and its answer. The
   * renderer believes these are up, so they are created on the next reconnect
   * rather than left as a shell the app can type into but nobody hears.
   */
  private readonly pendingCreates = new Map<string, Record<string, unknown>>()

  constructor(
    target: Target,
    private readonly launch: (onProgress?: (progress: RelayProgress) => void) => Promise<RelayClient>,
    private readonly callbacks: ConnectionCallbacks
  ) {
    this.target = target
  }

  /**
   * The live client, launching or re-dialling as needed. A request made while a
   * retry is already scheduled waits for it rather than starting another, so a
   * burst of keystrokes into a dropped terminal does not become a burst of ssh
   * attempts.
   */
  async ensureClient(onProgress?: (progress: RelayProgress) => void): Promise<RelayClient> {
    if (this.stopped) throw new Error('The connection is closed')
    if (this.client) return this.client
    if (this.connecting) return this.connecting
    if (this.reconnectTimer !== null) {
      return new Promise<RelayClient>((resolve, reject) => this.waiters.push({ resolve, reject }))
    }

    const pending = this.launch(onProgress).then(
      (client) => {
        this.adopt(client, this.everConnected)
        return client
      },
      (error: unknown) => {
        this.connecting = null
        this.scheduleReconnect()
        throw error
      }
    )
    this.connecting = pending
    return pending
  }

  /** Ask the relay behind the target, reconnecting first if that is what it takes. */
  async request(
    op: string,
    args: Record<string, unknown>,
    blob?: Buffer
  ): Promise<RelayAnswer> {
    const id = typeof args.id === 'string' ? args.id : null
    if (op === 'pty:kill' && id) this.forgetPty(id)

    let response: RelayAnswer
    try {
      const client = await this.ensureClient()
      response = await client.request(op, args, blob)
    } catch (error) {
      // A create that could not even be sent is remembered: the renderer will
      // believe the shell started, so it has to exist after the reconnect.
      if (op === 'pty:create' && id) this.pendingCreates.set(id, args)
      throw error
    }

    if (op === 'pty:create' && id) {
      if (response.ok) {
        // A create attaches a session that already exists — this host's shell —
        // and replays it so a fresh terminal is whole; only a brand-new session
        // answers with no bytes. The replay is forwarded as ordinary output, and
        // the blob is not handed back to the renderer, which has no use for it.
        this.replayPty(id, response, typeof args.view === 'string' ? args.view : undefined)
        this.confirmPty(id, response)
        return { ok: true, data: response.data }
      }
      this.pendingCreates.set(id, args)
    }
    return response
  }

  /** Forward a create's or an attach's replayed bytes as ordinary pty output. */
  private replayPty(id: string, response: RelayAnswer, view?: string): void {
    if (response.blob && response.blob.length > 0) {
      this.callbacks.onEvent({
        type: 'pty:data',
        id,
        data: response.blob.toString('utf8'),
        ...(view ? { view } : {})
      })
    }
  }

  /**
   * Hand over a client that was already launched and verified — the target
   * picker reaches a host before it is added, and its connection should not be
   * dialled a second time.
   */
  seed(client: RelayClient): void {
    if (this.client) {
      client.close()
      return
    }
    this.adopt(client, false)
  }

  close(): void {
    this.stopped = true
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.client?.close()
    this.client = null
    for (const waiter of this.waiters) waiter.reject(new Error('The connection is closed'))
    this.waiters = []
  }

  /**
   * A fresh client is wired the same way every time: events forwarded, output
   * offsets remembered, and — when this is a reconnection rather than the first
   * connect — every shell re-attached and replayed before the app is told the
   * connection is back.
   */
  private adopt(client: RelayClient, reattach: boolean): void {
    this.client = client
    this.connecting = null
    this.attempt = 0
    this.reconnectAnnounced = false

    client.onEvent('fs:changed', (event) => this.callbacks.onEvent(event))
    client.onEvent('git:changed', (event) => this.callbacks.onEvent(event))
    client.onEvent('pty:data', (event) => this.notePtyData(event))
    client.onEvent('pty:exit', (event) => {
      if (typeof event.id === 'string') this.forgetPty(event.id)
      this.callbacks.onEvent(event)
    })
    client.onClose = () => this.onClientClosed(client)

    // A process that died before it was adopted — a bad host, an ssh that was
    // refused — fires its close before this handler is attached, so the state is
    // checked rather than waited for.
    if (client.isClosed) {
      this.onClientClosed(client)
      return
    }

    const waiters = this.waiters
    this.waiters = []
    for (const waiter of waiters) waiter.resolve(client)

    this.everConnected = true
    if (reattach) {
      void this.reattachAll().finally(() => this.callbacks.onState('connected'))
    } else {
      this.callbacks.onState('connected')
    }
  }

  private onClientClosed(client: RelayClient): void {
    if (this.client !== client) return
    this.client = null
    this.connecting = null
    if (this.stopped) return
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.client || this.reconnectTimer !== null) return
    if (!this.reconnectAnnounced) {
      this.reconnectAnnounced = true
      this.callbacks.onState('reconnecting')
    }
    const delay = RECONNECT_BACKOFF_MS[Math.min(this.attempt, RECONNECT_BACKOFF_MS.length - 1)]
    this.attempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.ensureClient().catch(() => {
        // A failed attempt schedules the next; nothing to surface here.
      })
    }, delay)
  }

  /**
   * Re-attach the shells this connection knows about, each from the offset its
   * output was last seen at, so the gap in a terminal is filled rather than left
   * blank. A create that never reached the daemon is made first. A session the
   * daemon no longer has ended while we were away, and is reported as an exit.
   */
  private async reattachAll(): Promise<void> {
    for (const [id, args] of [...this.pendingCreates]) {
      const client = this.client
      if (!client) return
      try {
        const response = await client.request('pty:create', args)
        if (this.client !== client) return
        if (response.ok) {
          this.replayPty(id, response, typeof args.view === 'string' ? args.view : undefined)
          this.confirmPty(id, response)
        }
      } catch {
        return
      }
    }

    for (const id of [...this.ptyOrder]) {
      const client = this.client
      if (!client) return
      const since = this.ptyOffsets.get(id) ?? 0
      let response: RelayAnswer
      try {
        response = await client.request('pty:attach', { id, since })
      } catch {
        return
      }
      // A drop during the re-attach means the next adopt will try again.
      if (this.client !== client) return

      if (!response.ok) {
        this.forgetPty(id)
        this.callbacks.onEvent({ type: 'pty:exit', id, exitCode: 0 })
        continue
      }

      const meta = (response.data ?? {}) as {
        offset?: number
        lost?: boolean
        exited?: boolean
        exitCode?: number
        signal?: number
      }
      if (response.blob && response.blob.length > 0) {
        this.replayPty(id, response)
      } else if (meta.lost) {
        // The ring could not reach back this far, so a stretch of output is
        // genuinely gone; say so rather than pretend the screen is whole.
        this.callbacks.onEvent({
          type: 'pty:data',
          id,
          data: '\r\n\x1b[33m[reconnected — earlier output was lost]\x1b[0m\r\n'
        })
      }
      if (typeof meta.offset === 'number') this.ptyOffsets.set(id, meta.offset)
      if (meta.exited) {
        this.forgetPty(id)
        this.callbacks.onEvent({
          type: 'pty:exit',
          id,
          exitCode: meta.exitCode ?? 0,
          signal: meta.signal
        })
      }
    }
  }

  private notePtyData(event: Record<string, unknown>): void {
    const id = event.id
    const offset = event.offset
    if (typeof id === 'string' && typeof offset === 'number') {
      this.ptyOffsets.set(id, offset)
    }
    this.callbacks.onEvent(event)
  }

  /** A create the daemon confirmed: remember it, and the offset its replay ended at. */
  private confirmPty(id: string, response?: RelayAnswer): void {
    this.pendingCreates.delete(id)
    if (!this.ptyOrder.includes(id)) this.ptyOrder.push(id)
    const meta = (response?.data ?? {}) as { offset?: number }
    if (typeof meta.offset === 'number') this.ptyOffsets.set(id, meta.offset)
    else if (!this.ptyOffsets.has(id)) this.ptyOffsets.set(id, 0)
  }

  private forgetPty(id: string): void {
    this.pendingCreates.delete(id)
    this.ptyOffsets.delete(id)
    const at = this.ptyOrder.indexOf(id)
    if (at >= 0) this.ptyOrder.splice(at, 1)
  }
}
