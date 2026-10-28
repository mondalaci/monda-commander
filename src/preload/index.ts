import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { McApi } from '@shared/api'
import type {
  CopyOutcome,
  DeleteOutcome,
  DirListing,
  DirSize,
  DirSizeProgress,
  FileContent,
  FsChangeEvent,
  GitChangeEvent,
  GitStatus,
  ImagePreview,
  PixelSize,
  MoveOutcome,
  PtyDataEvent,
  PtyExitEvent,
  PtySpawnOptions,
  Result
} from '@shared/types'

const api: McApi = {
  fs: {
    home: () => ipcRenderer.invoke('fs:home'),
    list: (dir: string): Promise<Result<DirListing>> => ipcRenderer.invoke('fs:list', dir),
    dirSize: (target: string): Promise<Result<DirSize>> =>
      ipcRenderer.invoke('fs:dir-size', target),
    cancelDirSize: () => ipcRenderer.send('fs:dir-size-cancel'),
    onDirSizeProgress: (handler: (event: DirSizeProgress) => void) => {
      const listener = (_event: IpcRendererEvent, payload: DirSizeProgress) => handler(payload)
      ipcRenderer.on('fs:dir-size-progress', listener)
      return () => ipcRenderer.off('fs:dir-size-progress', listener)
    },
    read: (target: string): Promise<Result<FileContent>> => ipcRenderer.invoke('fs:read', target),
    readImage: (target: string): Promise<Result<ImagePreview>> =>
      ipcRenderer.invoke('fs:read-image', target),
    imageSize: (target: string): Promise<PixelSize | null> =>
      ipcRenderer.invoke('fs:image-size', target),
    canTranscode: (): Promise<boolean> => ipcRenderer.invoke('fs:can-transcode'),
    videoCodec: (target: string): Promise<string | null> =>
      ipcRenderer.invoke('fs:video-codec', target),
    videoDuration: (target: string): Promise<number | null> =>
      ipcRenderer.invoke('fs:video-duration', target),
    write: (target: string, text: string): Promise<Result<string>> =>
      ipcRenderer.invoke('fs:write', target, text),
    open: (target: string) => ipcRenderer.invoke('fs:open', target),
    reveal: (target: string) => ipcRenderer.invoke('fs:reveal', target),
    rename: (source: string, target: string): Promise<Result<string>> =>
      ipcRenderer.invoke('fs:rename', source, target),
    mkdir: (dir: string, name: string): Promise<Result<string>> =>
      ipcRenderer.invoke('fs:mkdir', dir, name),
    copy: (
      sources: string[],
      destination: string,
      baseDir: string
    ): Promise<Result<CopyOutcome>> =>
      ipcRenderer.invoke('fs:copy', sources, destination, baseDir),
    move: (
      sources: string[],
      destination: string,
      baseDir: string
    ): Promise<Result<MoveOutcome>> =>
      ipcRenderer.invoke('fs:move', sources, destination, baseDir),
    remove: (targets: string[]): Promise<Result<DeleteOutcome>> =>
      ipcRenderer.invoke('fs:delete', targets),
    hideAdd: (dir: string, name: string): Promise<Result<string>> =>
      ipcRenderer.invoke('fs:hide-add', dir, name),
    watch: (dir: string): Promise<void> => ipcRenderer.invoke('fs:watch', dir),
    unwatch: (dir: string): Promise<void> => ipcRenderer.invoke('fs:unwatch', dir),
    onChanged: (handler: (event: FsChangeEvent) => void) => {
      const listener = (_event: IpcRendererEvent, payload: FsChangeEvent) => handler(payload)
      ipcRenderer.on('fs:changed', listener)
      return () => ipcRenderer.off('fs:changed', listener)
    }
  },
  pty: {
    create: (id: string, options: PtySpawnOptions) =>
      ipcRenderer.invoke('pty:create', id, options),
    write: (id: string, data: string) => ipcRenderer.send('pty:write', id, data),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id: string) => ipcRenderer.send('pty:kill', id),
    state: (id: string) => ipcRenderer.invoke('pty:state', id),
    onData: (handler: (event: PtyDataEvent) => void) => {
      const listener = (_event: IpcRendererEvent, payload: PtyDataEvent) => handler(payload)
      ipcRenderer.on('pty:data', listener)
      return () => ipcRenderer.off('pty:data', listener)
    },
    onExit: (handler: (event: PtyExitEvent) => void) => {
      const listener = (_event: IpcRendererEvent, payload: PtyExitEvent) => handler(payload)
      ipcRenderer.on('pty:exit', listener)
      return () => ipcRenderer.off('pty:exit', listener)
    }
  },
  win: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    onMaximizedChange: (handler: (maximized: boolean) => void) => {
      const listener = (_event: IpcRendererEvent, maximized: boolean) => handler(maximized)
      ipcRenderer.on('window:maximized-change', listener)
      return () => ipcRenderer.off('window:maximized-change', listener)
    }
  },
  hide: {
    get: (): Promise<boolean> => ipcRenderer.invoke('hide:get'),
    set: (enabled: boolean): Promise<void> => ipcRenderer.invoke('hide:set', enabled)
  },
  git: {
    status: (dir: string): Promise<Result<GitStatus>> => ipcRenderer.invoke('git:status', dir),
    watch: (root: string): Promise<void> => ipcRenderer.invoke('git:watch', root),
    unwatch: (root: string): Promise<void> => ipcRenderer.invoke('git:unwatch', root),
    onChanged: (handler: (event: GitChangeEvent) => void) => {
      const listener = (_event: IpcRendererEvent, payload: GitChangeEvent) => handler(payload)
      ipcRenderer.on('git:changed', listener)
      return () => ipcRenderer.off('git:changed', listener)
    }
  }
}

contextBridge.exposeInMainWorld('mc', api)
