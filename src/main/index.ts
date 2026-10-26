import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { registerFsHandlers } from './ipc/fs'
import { closeAllGitWatchers, registerGitHandlers } from './ipc/git'
import { registerHideHandlers } from './ipc/hide'
import { killAllSessions, registerPtyHandlers } from './ipc/pty'
import { closeAllWatchers, registerWatchHandlers } from './ipc/watch'
import { registerWindowHandlers } from './ipc/window'
import { restoreWindowState, trackWindowState } from './windowState'
import {
  killAllTranscodes,
  registerMediaHandlers,
  registerMediaProtocol,
  registerMediaScheme
} from './media'

// The hardware video decoder hands its frames to the compositor as DMA-BUFs,
// and a Linux session that cannot import those (a VM, a driver without a working
// GBM path) loses the GPU process to it: the decode fails and the rendering of
// the whole window goes with it. A footer preview is a 64px thumbnail the user
// is pointing at, never a viewing session, so decoding it in software is the
// safer trade — a preview must not be able to take the window down with it.
app.commandLine.appendSwitch('disable-accelerated-video-decode')

const APP_BACKGROUND = '#1e1e1e'
const APP_ICON = join(import.meta.dirname, '..', '..', 'resources', 'icon.png')

function resolvePreload(): string {
  const candidates = ['index.mjs', 'index.js'].map((file) =>
    join(import.meta.dirname, '..', 'preload', file)
  )
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[1]!
}

function createWindow(): BrowserWindow {
  const restored = restoreWindowState()
  const window = new BrowserWindow({
    width: restored.width,
    height: restored.height,
    ...(restored.x === null || restored.y === null ? {} : { x: restored.x, y: restored.y }),
    minWidth: 720,
    minHeight: 420,
    show: false,
    title: 'Monda Commander',
    backgroundColor: APP_BACKGROUND,
    icon: APP_ICON,
    frame: false,
    webPreferences: {
      preload: resolvePreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  // Maximized before the window is shown, so it comes up the way it was left
  // rather than flashing its restored size first. The title bar asks
  // `window:is-maximized` on mount, so it needs no notification for this one.
  if (restored.maximized) window.maximize()

  trackWindowState(window)

  window.once('ready-to-show', () => window.show())

  const notifyMaximized = (maximized: boolean) => {
    if (window.webContents.isDestroyed()) return
    window.webContents.send('window:maximized-change', maximized)
  }
  window.on('maximize', () => notifyMaximized(true))
  window.on('unmaximize', () => notifyMaximized(false))

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void window.loadURL(devUrl)
  } else {
    void window.loadFile(join(import.meta.dirname, '..', 'renderer', 'index.html'))
  }

  return window
}

// The media scheme has to be declared before the app is ready; its protocol
// handler is installed once it is. Everything else is a plain IPC handler and
// can go now.
registerMediaScheme()
registerMediaHandlers()
registerFsHandlers()
registerHideHandlers()
registerGitHandlers()
registerPtyHandlers()
registerWatchHandlers()
registerWindowHandlers()

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows()
    if (!existing) return
    if (existing.isMinimized()) existing.restore()
    existing.focus()
  })

  void app.whenReady().then(() => {
    registerMediaProtocol()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    killAllSessions()
    closeAllWatchers()
    closeAllGitWatchers()
    killAllTranscodes()
  })
}
