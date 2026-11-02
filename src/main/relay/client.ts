import { spawn, type ChildProcess } from 'node:child_process'
import type { Target } from '@shared/target'

/**
 * A connection to one relay, speaking the length-prefixed protocol in
 * `relay/protocol.go`. The relay is launched by the registry with a command
 * line chosen for the target's kind; this class only owns the pipe, the frame
 * codec and the request table.
 *
 * Frames: a 9-byte header (u32 length, u8 type, u32 id) followed by the payload.
 * Control frames are JSON; blobs are raw bytes. See docs/design.md, "One
 * protocol, three transports".
 */

const FRAME_REQUEST = 0
const FRAME_RESPONSE = 1
const FRAME_BLOB = 2
const FRAME_EVENT = 3

const MAX_FRAME = 64 * 1024 * 1024

/** Operations whose answer carries a BLOB after its JSON response. */
const BLOB_RESPONSE_OPS = new Set(['fs:read', 'fs:readImage'])
/** Operations whose request carries a BLOB after its JSON frame. */
const BLOB_REQUEST_OPS = new Set(['fs:write'])

export interface RelayResponse {
  ok: boolean
  data?: unknown
  error?: { code: string; message: string }
  blob?: Buffer
}

interface Pending {
  expectBlob: boolean
  meta?: unknown
  resolve: (response: RelayResponse) => void
}

export type RelayEventHandler = (event: Record<string, unknown>) => void

export class RelayClient {
  readonly target: Target
  private readonly process: ChildProcess
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Map<string, Set<RelayEventHandler>>()
  private nextId = 1
  private buffer: Buffer = Buffer.alloc(0)
  private closed = false
  private writeQueue: Promise<void> = Promise.resolve()

  /** Called once when the connection ends, so the registry can forget it. */
  onClose: (() => void) | null = null

  constructor(target: Target, command: string, args: string[]) {
    this.target = target
    this.process = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    this.process.stdout?.on('data', (chunk: Buffer) => this.onData(chunk))
    this.process.stderr?.on('data', () => {
      // The relay's diagnostics are not protocol bytes; dropping them keeps the
      // frame stream clean. A debugging build can pipe them to a log instead.
    })
    // A process that exits for any reason — a bad host, a missing binary, an
    // ssh that refused — must fail the requests in flight *and* every request
    // after it, instead of leaving a pane waiting on an answer that cannot come.
    this.process.on('exit', () => this.die('The relay connection ended'))
    this.process.on('error', (error) => this.die(error.message))
  }

  onEvent(type: string, handler: RelayEventHandler): () => void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(handler)
    return () => set?.delete(handler)
  }

  request(op: string, args: Record<string, unknown>, blob?: Buffer): Promise<RelayResponse> {
    if (this.closed) {
      return Promise.resolve({ ok: false, error: { code: 'ECLOSED', message: 'relay is closed' } })
    }
    const id = this.nextId++
    const expectBlob = BLOB_RESPONSE_OPS.has(op)
    const promise = new Promise<RelayResponse>((resolve) => {
      this.pending.set(id, { expectBlob, resolve })
    })

    const send = async (): Promise<void> => {
      await this.writeFrame(FRAME_REQUEST, id, Buffer.from(JSON.stringify({ op, ...args })))
      if (BLOB_REQUEST_OPS.has(op)) {
        await this.writeFrame(FRAME_BLOB, id, blob ?? Buffer.alloc(0))
      }
    }
    this.writeQueue = this.writeQueue.then(send, send)
    return promise
  }

  close(): void {
    this.process.kill()
    this.die('relay closed')
  }

  private die(message: string): void {
    if (this.closed) return
    this.closed = true
    this.failAll(message)
    this.onClose?.()
  }

  private failAll(message: string): void {
    for (const [, pending] of this.pending) {
      pending.resolve({ ok: false, error: { code: 'ECLOSED', message } })
    }
    this.pending.clear()
  }

  private async writeFrame(type: number, id: number, payload: Buffer): Promise<void> {
    if (payload.length > MAX_FRAME) {
      throw new Error(`frame too large: ${payload.length}`)
    }
    const header = Buffer.alloc(9)
    header.writeUInt32BE(payload.length, 0)
    header[4] = type
    header.writeUInt32BE(id, 5)
    this.process.stdin?.write(header)
    this.process.stdin?.write(payload)
  }

  /**
   * Frames are length-prefixed, so a read can deliver a fragment of a frame or
   * several at once. The buffer holds the tail until the rest arrives.
   */
  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 9) {
      const length = this.buffer.readUInt32BE(0)
      if (length > MAX_FRAME) {
        this.failAll('frame too large from relay')
        this.close()
        return
      }
      if (this.buffer.length < 9 + length) return
      const type = this.buffer[4]!
      const id = this.buffer.readUInt32BE(5)
      const payload = this.buffer.subarray(9, 9 + length)
      this.buffer = this.buffer.subarray(9 + length)
      this.handleFrame(type, id, payload)
    }
  }

  private handleFrame(type: number, id: number, payload: Buffer): void {
    if (type === FRAME_EVENT) {
      try {
        const event = JSON.parse(payload.toString('utf8')) as Record<string, unknown>
        const eventType = typeof event.type === 'string' ? event.type : ''
        for (const handler of this.listeners.get(eventType) ?? []) handler(event)
      } catch {
        // A malformed event is dropped rather than taking the connection down.
      }
      return
    }

    const pending = this.pending.get(id)
    if (!pending) return

    if (type === FRAME_BLOB) {
      this.pending.delete(id)
      pending.resolve({ ok: true, data: pending.meta, blob: Buffer.from(payload) })
      return
    }

    if (type !== FRAME_RESPONSE) return

    let response: RelayResponse
    try {
      response = JSON.parse(payload.toString('utf8')) as RelayResponse
    } catch {
      this.pending.delete(id)
      pending.resolve({ ok: false, error: { code: 'EPROTO', message: 'invalid response' } })
      return
    }

    if (response.ok && pending.expectBlob) {
      // The BLOB for this id follows; keep the request open until it arrives.
      pending.meta = response.data
      return
    }

    this.pending.delete(id)
    pending.resolve(response)
  }
}
