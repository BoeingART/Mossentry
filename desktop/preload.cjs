const { contextBridge, ipcRenderer } = require('electron');

const preferences = ipcRenderer.sendSync('mossentry:appearance:get');
contextBridge.exposeInMainWorld('mossentryAppearance', {
  get: () => preferences,
  set: (key, value) => ipcRenderer.invoke('mossentry:appearance:set', key, value),
});
