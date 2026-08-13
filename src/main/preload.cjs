const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('atomica', {
  getState: () => ipcRenderer.invoke('get-state'),
  requestDataset: () => ipcRenderer.invoke('request-dataset'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  removeFolder: (i) => ipcRenderer.invoke('remove-folder', i),
  rescan: () => ipcRenderer.invoke('rescan'),
  setParams: (p) => ipcRenderer.invoke('set-params', p),
  computeLayout: (p) => ipcRenderer.invoke('compute-layout', p),
  setEmbeddings: (b) => ipcRenderer.invoke('set-embeddings', b),
  readAudio: (p) => ipcRenderer.invoke('read-audio', p),
  decodeAudio: (p) => ipcRenderer.invoke('decode-audio', p),
  startDrag: (p) => ipcRenderer.send('start-drag', p),
  reveal: (p) => ipcRenderer.send('reveal', p),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, d) => cb(d)),
  onDataset: (cb) => ipcRenderer.on('dataset', (_e, d) => cb(d)),
  onPositions: (cb) => ipcRenderer.on('positions', (_e, d) => cb(d)),
  onNotice: (cb) => ipcRenderer.on('notice', (_e, d) => cb(d)),
});
