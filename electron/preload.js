'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getVersion:    ()      => ipcRenderer.invoke('get-version'),
  openExternal:  (url)   => ipcRenderer.invoke('open-external', url),
  platform:      process.platform,
  isElectron:    true,
});
