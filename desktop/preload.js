// Small, safe API for the web UI (window.DJDesktop).
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('DJDesktop', {
  isDesktop: true,
  platform: process.platform,
  /** Real file-system path of a picked / dropped File (so the library can be remembered). */
  pathForFile: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch (e) { return ''; } },
  fileExists: (p) => ipcRenderer.invoke('file-exists', p),
  /** Saves a recorded mix into Music/DJ Free and returns the full path. */
  saveRecording: (bytes, name) => ipcRenderer.invoke('save-recording', bytes, name),
  showFile: (p) => ipcRenderer.invoke('show-file', p),
});
