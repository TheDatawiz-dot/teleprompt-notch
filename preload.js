const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('notch', {
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),

  startListening: () => ipcRenderer.invoke('listening:start'),
  stopListening: () => ipcRenderer.invoke('listening:stop'),
  micPcm: (arrayBuffer) => ipcRenderer.send('mic:pcm', arrayBuffer),

  setScript: (text) => ipcRenderer.invoke('script:set', text),
  step: (delta) => ipcRenderer.invoke('script:step', delta),
  jump: (lineIndex) => ipcRenderer.invoke('script:jump', lineIndex),

  getProtection: () => ipcRenderer.invoke('protection:get'),
  setProtection: (active) => ipcRenderer.invoke('protection:set', active),

  hideWindow: () => ipcRenderer.send('window:hide'),
  showWindow: () => ipcRenderer.send('window:show'),

  on: (channel, cb) => {
    const allowed = [
      'script:loaded', 'scroll:to', 'stt:interim', 'stt:final', 'stt:status',
      'vad:state', 'listening:state', 'protection:state', 'font:step', 'status'
    ];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, data) => cb(data));
  }
});
