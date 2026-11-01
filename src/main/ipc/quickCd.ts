import { ipcMain } from 'electron'
import { readQuickCd, writeQuickCd } from '../quickCd'

export function registerQuickCdHandlers(): void {
  ipcMain.handle('quickcd:get', () => readQuickCd())

  ipcMain.handle('quickcd:set', (_event, directories: string[]) => {
    writeQuickCd(directories)
  })
}
