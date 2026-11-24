import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { registerFsHandlers } from './ipc/fs'
import { registerRemoteHandlers } from './ipc/remote'
import { targetRegistry } from './relay/registry'
import { closeAllGitWatchers, registerGitHandlers } from './ipc/git'
import { registerHideHandlers } from './ipc/hide'
import { registerQuickCdHandlers } from './ipc/quickCd'
import { killAllSessions, registerPtyHandlers } from './ipc/pty'
import { closeAllWatchers, registerWatchHandlers } from './ipc/watch'
import { registerWindowHandlers } from './ipc/window'
import { restoreWindowState, trackWindowState } from './windowState'
import {
  killAllPdfRenders,
  registerPdfHandlers
} from './pdf'
import {
  killAllModelConversions,
  registerModelHandlers
} from './model'
import { registerPdfViewHandlers } from './pdfView'
import {
  killAllTranscodes,
  registerMediaHandlers,
  registerMediaProtocol,
  registerMediaScheme
} from './media'
import { killAllThumbnails, registerThumbnailHandlers } from './thumbnail'

// The hardware video decoder hands its frames to the compositor as DMA-BUFs,
// and a Linux session that cannot import those (a VM, a driver without a working
// GBM path) loses the GPU process to it: the decode fails and the rendering of
// the whole window goes with it. A footer preview is a 64px thumbnail the user
// is pointing at, never a viewing session, so decoding it in software is the
// safer trade — a preview must not be able to take the window down with it. The
// DMA-BUF path is Linux's, so the switch is only asked for there.
if (process.platform === 'linux') app.commandLine.appendSwitch('disable-accelerated-video-decode')

const APP_BACKGROUND = '#1e1e1e'
const APP_ICON = join(import.meta.dirname, '..', '..', 'resources', 'icon.png')

function resolvePreload(): string {
  const candidates = ['index.mjs', 'index.js'].map((file) =>
    join(import.meta.dirname, '..', 'preload', file)
  )
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[1]!
}

/**
 * macOS draws one menu bar for the whole app, and it is also what makes the
 * standard text-editing keys work at all: with no Edit menu, `Cmd+C`/`Cmd+V`
 * do nothing in an input or in Monaco. So the app sets its own rather than
 * leaving Electron's default, which carries a `View>Reload` on `Cmd+R` and a
 * `File>Close` on `Cmd+W` — both of which are the app's own keys (`Ctrl+R`
 * re-lists a pane, `Ctrl+W` closes a workspace, and on macOS those chords are
 * `Cmd`). Those two are left out for exactly that reason, and the wall's tile
 * zoom keeps `Cmd+=`/`Cmd+-`/`Cmd+0` by leaving out the View zoom roles too.
 *
 * Only macOS needs this; elsewhere Electron's default menu is what the app has
 * always run under, and setting one would change nothing it wants.
 *
 * Two standard accelerators do still shadow an app chord, and both are left to
 * the menu deliberately: `Edit>Copy`/`Cut` own `Cmd+C`/`Cmd+X` (so the panes'
 * copy-name and transfer-cancel are unavailable on macOS), and the app menu's
 * Hide owns `Cmd+H` (the video seek). Both are noted in docs/porting.md.
 */
function installApplicationMenu(): void {
  if (process.platform !== 'darwin') return
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * Windows groups taskbar buttons and notifications by AppUserModelID, which has
 * to be the same id electron-builder installs the app under (`appId`) or the
 * app appears as a nameless second entry beside its own shortcut.
 */
function installWindowsIdentity(): void {
  if (process.platform === 'win32') app.setAppUserModelId('com.monda.commander')
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
    // Frameless everywhere, but macOS keeps its traffic lights: `hiddenInset`
    // leaves them in the inset title bar the app draws under (TitleBar.vue hides
    // its own buttons and pads a gutter for them), where a plain `frame: false`
    // would leave the window with no controls at all.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 12, y: 10 } }
      : { frame: false }),
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
registerQuickCdHandlers()
registerGitHandlers()
registerPtyHandlers()
registerWatchHandlers()
registerWindowHandlers()
registerRemoteHandlers()
registerPdfHandlers()
registerPdfViewHandlers()
registerModelHandlers()
registerThumbnailHandlers()

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
    installApplicationMenu()
    installWindowsIdentity()
    void targetRegistry.init()
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
    killAllPdfRenders()
    killAllModelConversions()
    killAllThumbnails()
    // Remote shells are deliberately not ended here. They live in the host's
    // relay daemon and are meant to outlive the app — quitting drops the channel
    // and the shell keeps running, to be reattached on the next launch.
    targetRegistry.closeAll()
  })
}
