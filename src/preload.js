'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  probe: p => ipcRenderer.invoke('probe', p),
  pathForFile: f => webUtils.getPathForFile(f),
  encoders: () => ipcRenderer.invoke('encoders'),
  saveDialog: defaultPath => ipcRenderer.invoke('save-dialog', defaultPath),
  exportStart: plan => ipcRenderer.invoke('export-start', plan),
  exportCancel: () => ipcRenderer.invoke('export-cancel'),
  onExportProgress: cb => ipcRenderer.on('export-progress', (_e, p) => cb(p)),
  showInFolder: p => ipcRenderer.invoke('show-in-folder', p),
  setDirty: d => ipcRenderer.send('set-dirty', d),
});
