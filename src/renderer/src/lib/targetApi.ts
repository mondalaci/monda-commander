import type { McGitApi, McFsApi, McPtyApi } from '@shared/api'
import type { Target, TargetApi } from '@shared/target'

export type { TargetApi } from '@shared/target'
import type {
  CopyOutcome,
  DeleteOutcome,
  DirListing,
  DirSize,
  FileContent,
  FsChangeEvent,
  GitChangeEvent,
  GitStatus,
  ImagePreview,
  MoveOutcome,
  PixelSize,
  PtySpawnOptions,
  PtyStateSnapshot,
  Result
} from '@shared/types'

/**
 * The API a workspace uses, scoped to its target. Local is main's own bridge,
 * handed through untouched; root and ssh are the same operations asked of an
 * relay over `remote:request`. The panes and the shell call the same interface
 * either way, so a workspace on a remote host needs no second code path above
 * this file — only the target that built the API differs.
 *
 * See docs/design.md, "One protocol, three transports".
 */

function toResult<T>(response: { ok: boolean; data?: unknown; error?: { code: string; message: string } }): Result<T> {
  if (response.ok) return { ok: true, data: response.data as T }
  return {
    ok: false,
    error: response.error ?? { code: 'EUNKNOWN', message: 'The relay returned no answer' }
  }
}

function toBase64(bytes: Uint8Array): string {
  // btoa takes a binary string; chunking keeps a large file from blowing the
  // argument limit on String.fromCharCode.
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function remoteFs(target: Target): McFsApi {
  const id = target.id
  const request = window.mc.remote.request

  return {
    home: async () => {
      const response = await request(id, 'fs:home', {})
      return response.ok ? String(response.data ?? '') : ''
    },
    list: async (dir) => toResult<DirListing>(await request(id, 'fs:list', { path: dir })),
    dirSize: async (path) => toResult<DirSize>(await request(id, 'fs:dirSize', { path })),
    cancelDirSize: () => {
      // A remote walk is one request; there is no in-flight walk to cancel from
      // here. The pane's own epoch still stops it waiting for the answer.
    },
    onDirSizeProgress: () => () => {
      // The relay answers a size walk in one piece rather than streaming it.
    },
    read: async (path) => {
      const response = await request(id, 'fs:read', { path })
      if (!response.ok) {
        return { ok: false, error: response.error ?? { code: 'EUNKNOWN', message: 'read failed' } }
      }
      const meta = (response.data ?? {}) as { path?: string; truncated?: boolean }
      const text = new TextDecoder().decode(response.blob ?? new Uint8Array())
      return {
        ok: true,
        data: { path: meta.path ?? path, text, truncated: Boolean(meta.truncated) } satisfies FileContent
      }
    },
    readImage: async (path) => {
      const response = await request(id, 'fs:readImage', { path })
      if (!response.ok) {
        return { ok: false, error: response.error ?? { code: 'EUNKNOWN', message: 'read failed' } }
      }
      const meta = (response.data ?? {}) as { mime?: string }
      const base64 = toBase64(response.blob ?? new Uint8Array())
      return {
        ok: true,
        data: { dataUrl: `data:${meta.mime ?? 'application/octet-stream'};base64,${base64}` } satisfies ImagePreview
      }
    },
    imageSize: async (path) => {
      const response = await request(id, 'fs:imageSize', { path })
      return response.ok ? ((response.data as PixelSize | null) ?? null) : null
    },
    canTranscode: async () => {
      const response = await request(id, 'fs:canTranscode', {})
      return response.ok ? Boolean(response.data) : false
    },
    canArchive: async () => {
      const response = await request(id, 'fs:canArchive', {})
      return response.ok ? Boolean(response.data) : false
    },
    videoCodec: async (path) => {
      const response = await request(id, 'fs:videoCodec', { path })
      return response.ok ? ((response.data as string | null) ?? null) : null
    },
    videoDuration: async (path) => {
      const response = await request(id, 'fs:videoDuration', { path })
      return response.ok ? ((response.data as number | null) ?? null) : null
    },
    write: async (path, text) => {
      const response = await request(id, 'fs:write', { path }, new TextEncoder().encode(text))
      return toResult<string>(response)
    },
    open: async (path) => {
      const response = await request(id, 'fs:open', { path })
      return response.ok ? String(response.data ?? '') : ''
    },
    reveal: async (path) => {
      const response = await request(id, 'fs:reveal', { path })
      if (!response.ok) throw new Error(response.error?.message ?? 'reveal failed')
    },
    rename: async (source, next) =>
      toResult<string>(await request(id, 'fs:rename', { source, target: next })),
    mkdir: async (dir, name) => toResult<string>(await request(id, 'fs:mkdir', { dir, name })),
    copy: async (sources, destination, baseDir) =>
      toResult<CopyOutcome>(await request(id, 'fs:copy', { sources, destination, baseDir })),
    move: async (sources, destination, baseDir) =>
      toResult<MoveOutcome>(await request(id, 'fs:move', { sources, destination, baseDir })),
    remove: async (targets) => toResult<DeleteOutcome>(await request(id, 'fs:delete', { targets })),
    hideAdd: async (dir, name) => toResult<string>(await request(id, 'fs:hideAdd', { dir, name })),
    hideRemove: async (dir, name) =>
      toResult<string>(await request(id, 'fs:hideRemove', { dir, name })),
    watch: async (dir) => {
      await request(id, 'fs:watch', { path: dir })
    },
    unwatch: async (dir) => {
      await request(id, 'fs:unwatch', { path: dir })
    },
    onChanged: (handler: (event: FsChangeEvent) => void) => {
      return window.mc.remote.onEvent((event) => {
        if (event.targetId !== id || event.type !== 'fs:changed') return
        if (typeof event.path === 'string') handler({ path: event.path })
      })
    }
  }
}

function remotePty(target: Target): McPtyApi {
  const id = target.id
  const request = window.mc.remote.request

  return {
    create: async (ptyId, options: PtySpawnOptions) => {
      await request(id, 'pty:create', {
        id: ptyId,
        path: options.cwd,
        cols: options.cols,
        rows: options.rows
      })
    },
    write: (ptyId, data) => {
      void request(id, 'pty:write', { id: ptyId, data })
    },
    resize: (ptyId, cols, rows) => {
      void request(id, 'pty:resize', { id: ptyId, cols, rows })
    },
    kill: (ptyId) => {
      void request(id, 'pty:kill', { id: ptyId })
    },
    state: async (ptyId) => {
      const response = await request(id, 'pty:state', { id: ptyId })
      if (!response.ok) return { cwd: null, idle: false } satisfies PtyStateSnapshot
      const data = (response.data ?? {}) as { cwd?: string | null; idle?: boolean }
      return { cwd: data.cwd ?? null, idle: Boolean(data.idle) } satisfies PtyStateSnapshot
    },
    onData: (handler) => {
      return window.mc.remote.onEvent((event) => {
        if (event.targetId !== id || event.type !== 'pty:data') return
        if (typeof event.id === 'string' && typeof event.data === 'string') {
          handler({ id: event.id, data: event.data })
        }
      })
    },
    onExit: (handler) => {
      return window.mc.remote.onEvent((event) => {
        if (event.targetId !== id || event.type !== 'pty:exit') return
        if (typeof event.id === 'string') {
          handler({
            id: event.id,
            exitCode: typeof event.exitCode === 'number' ? event.exitCode : 0,
            signal: typeof event.signal === 'number' ? event.signal : undefined
          })
        }
      })
    }
  }
}

function remoteGit(target: Target): McGitApi {
  const id = target.id
  const request = window.mc.remote.request

  return {
    status: async (dir) => toResult<GitStatus>(await request(id, 'git:status', { dir })),
    watch: async (root) => {
      await request(id, 'git:watch', { path: root })
    },
    unwatch: async (root) => {
      await request(id, 'git:unwatch', { path: root })
    },
    onChanged: (handler: (event: GitChangeEvent) => void) => {
      return window.mc.remote.onEvent((event) => {
        if (event.targetId !== id || event.type !== 'git:changed') return
        if (typeof event.path === 'string') handler({ root: event.path })
      })
    }
  }
}

export function createTargetApi(target: Target): TargetApi {
  if (target.kind === 'local') {
    return {
      target,
      fs: window.mc.fs,
      pty: window.mc.pty,
      git: window.mc.git,
      onProgress: () => () => {}
    }
  }
  return {
    target,
    fs: remoteFs(target),
    pty: remotePty(target),
    git: remoteGit(target),
    onProgress: remoteProgress(target)
  }
}

function remoteProgress(target: Target): (handler: (phase: string) => void) => () => void {
  const id = target.id
  return (handler) =>
    window.mc.remote.onEvent((event) => {
      if (event.targetId !== id || event.type !== 'target:progress') return
      if (typeof event.phase === 'string') handler(event.phase)
    })
}
