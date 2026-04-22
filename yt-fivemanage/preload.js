const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  // Window controls
  minimize: ()     => ipcRenderer.send('win-minimize'),
  maximize: ()     => ipcRenderer.send('win-maximize'),
  close:    ()     => ipcRenderer.send('win-close'),

  // Config
  loadConfig: ()     => ipcRenderer.invoke('load-config'),
  saveConfig: (data) => ipcRenderer.invoke('save-config', data),

  // Dialogs / shell
  openUrl:  (url)  => ipcRenderer.invoke('open-url', url),
  pickDir:  ()     => ipcRenderer.invoke('pick-dir'),
  pickFile: ()     => ipcRenderer.invoke('pick-file'),

  // yt-dlp
  ensureYtdlp: () => ipcRenderer.invoke('ensure-ytdlp'),
  download: (opts) => ipcRenderer.invoke('download', opts),

  // Upload
  upload: (opts) => ipcRenderer.invoke('upload', opts),

  // Event listeners
  onDlProgress: (cb) => ipcRenderer.on('dl-progress', (_, v) => cb(v)),
  onDlLog:      (cb) => ipcRenderer.on('dl-log',      (_, v) => cb(v)),
  onUpProgress: (cb) => ipcRenderer.on('up-progress', (_, v) => cb(v)),

  removeAllListeners: (ch) => ipcRenderer.removeAllListeners(ch),
})
