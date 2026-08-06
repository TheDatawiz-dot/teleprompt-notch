const { app, BrowserWindow, ipcMain, globalShortcut, screen } = require('electron');
const path = require('path');
const store = require('./src/store');
const { AdaptiveVAD } = require('./src/vad');
const { createStreamingSTT } = require('./src/stt-streaming');
const { createScriptTracker } = require('./src/script-tracker');

let win = null;
let tracker = createScriptTracker('');
let streamingSTT = null;
let listening = false;
const vad = new AdaptiveVAD({
  onsetThreshold: 220,
  offsetThreshold: 130,
  silenceFrames: 18,
  onSpeechStart: () => send('vad:state', { speaking: true }),
  onSpeechEnd: (dur) => send('vad:state', { speaking: false, durationMs: dur })
});

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = 460, H = 300;
  const settings = store.getSettings();

  let startX = Math.round(workArea.x + (workArea.width - W) / 2);
  let startY = workArea.y + 6;
  if (settings.windowX !== null && settings.windowY !== null) {
    startX = Math.max(workArea.x, Math.min(settings.windowX, workArea.x + workArea.width - 100));
    startY = Math.max(workArea.y, Math.min(settings.windowY, workArea.y + workArea.height - 40));
  }

  win = new BrowserWindow({
    width: W,
    height: H,
    x: startX,
    y: startY,
    minWidth: 320,
    minHeight: 160,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    title: 'NotchPrompt',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (process.platform === 'darwin' && typeof win.setHiddenInMissionControl === 'function') {
    win.setHiddenInMissionControl(true);
  }
  win.setContentProtection(!!settings.contentProtection && !process.env.NOTCHPROMPT_NO_PROTECT);

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  let moveSaveTimer = null;
  win.on('moved', () => {
    clearTimeout(moveSaveTimer);
    moveSaveTimer = setTimeout(() => {
      if (win && !win.isDestroyed()) {
        const [x, y] = win.getPosition();
        store.setSettings({ windowX: x, windowY: y });
      }
    }, 500);
  });

  win.webContents.on('did-finish-load', () => {
    win.showInactive();
    const s = store.getSettings();
    send('script:loaded', { text: s.lastScript || '' });
    send('protection:state', { active: !!s.contentProtection });
    if (failedShortcuts.length) {
      send('status', {
        message: `Another app already holds ${failedShortcuts.join(', ')} — those shortcuts are inactive.`
      });
    }
  });
}

// -------- listening (mic -> VAD -> streaming STT -> script tracker) --------
function startListening() {
  if (listening) return { active: true, streaming: !!streamingSTT };
  const settings = store.getSettings();
  const keys = settings.apiKeys || {};
  listening = true;

  if (keys.deepgram || keys.openai) {
    const result = createStreamingSTT(settings, 'you', {
      onTranscript: (_channel, text) => {
        send('stt:final', { text });
        const at = tracker.feedTranscript(text);
        if (at) send('scroll:to', at);
      },
      onInterim: (_channel, text) => {
        send('stt:interim', { text });
        const at = tracker.feedProvisional(text);
        if (at) send('scroll:to', at);
      },
      onError: (err) => {
        send('status', { message: `Transcription (${err.provider}) error: ${err.message}. Switching to manual scroll.` });
        stopListening();
      },
      onStatusChange: (_channel, status) => send('stt:status', { status })
    });
    if (result.type === 'streaming' && result.instance) {
      streamingSTT = result.instance;
      streamingSTT.connect();
    }
  } else {
    send('status', { message: 'No Deepgram/OpenAI key set — using manual scroll instead of voice tracking.' });
  }

  send('listening:state', { active: true, streaming: !!streamingSTT });
  return { active: true, streaming: !!streamingSTT };
}

function stopListening() {
  listening = false;
  if (streamingSTT) { streamingSTT.disconnect(); streamingSTT = null; }
  vad.reset();
  send('listening:state', { active: false, streaming: false });
  return { active: false, streaming: false };
}

// -------- IPC --------
// The renderer needs to show whether a key is configured, never the key itself,
// so credentials stay in the main process rather than crossing into a window
// that also renders arbitrary pasted text.
function safeSettings() {
  const { apiKeys, ...rest } = store.getSettings();
  return { ...rest, keys: store.keyPresence(), keychain: store.encryptionAvailable() };
}

ipcMain.handle('settings:get', () => safeSettings());
ipcMain.handle('settings:set', (_e, patch) => { store.setSettings(patch); return safeSettings(); });

ipcMain.handle('listening:start', () => startListening());
ipcMain.handle('listening:stop', () => stopListening());
ipcMain.on('mic:pcm', (_e, arrayBuffer) => {
  if (!listening) return;
  // VAD drives the mic indicator only. The audio itself is streamed
  // unconditionally: Deepgram and OpenAI both run their own endpointing, and
  // withholding the quiet parts makes their segmentation worse, not cheaper.
  vad.processChunk(Buffer.from(arrayBuffer));
  if (streamingSTT) streamingSTT.sendAudio(arrayBuffer);
});

ipcMain.handle('script:set', (_e, text) => {
  tracker = createScriptTracker(text || '');
  store.setSettings({ lastScript: text || '' });
  // The layout comes from the tracker's own tokens so the words drawn on screen
  // are exactly the words the matcher indexes — the highlight cannot drift.
  return {
    layout: tracker.layout,
    totalLines: tracker.totalLines,
    totalWords: tracker.totalWords,
    ...tracker.position()
  };
});
ipcMain.handle('script:step', (_e, delta) => tracker.step(delta));
ipcMain.handle('script:jump', (_e, lineIndex) => tracker.setCursorToLine(lineIndex));

ipcMain.handle('protection:get', () => ({ active: !!store.getSettings().contentProtection }));
ipcMain.handle('protection:set', (_e, active) => {
  if (win && !win.isDestroyed()) win.setContentProtection(!!active);
  store.setSettings({ contentProtection: !!active });
  send('protection:state', { active: !!active });
  return { active: !!active };
});

ipcMain.on('window:hide', () => { if (win) win.hide(); });
ipcMain.on('window:show', () => { if (win) win.showInactive(); });

// globalShortcut.register returns false when another application already owns
// the combination. Ignoring that leaves a key that silently does nothing and no
// way to tell a taken shortcut from a broken feature, so failures are collected
// and reported to the window once it loads.
const failedShortcuts = [];

function registerShortcuts() {
  const bind = (accelerator, handler) => {
    try {
      if (!globalShortcut.register(accelerator, handler)) failedShortcuts.push(accelerator);
    } catch {
      failedShortcuts.push(accelerator);
    }
  };

  bind('CommandOrControl+Shift+N', () => {
    if (!win) return;
    if (win.isVisible()) win.hide(); else win.showInactive();
  });
  bind('CommandOrControl+Shift+L', () => {
    if (listening) stopListening(); else startListening();
  });
  bind('CommandOrControl+Shift+P', () => {
    const active = !store.getSettings().contentProtection;
    if (win && !win.isDestroyed()) win.setContentProtection(active);
    store.setSettings({ contentProtection: active });
    send('protection:state', { active });
  });
  bind('CommandOrControl+Shift+Up', () => send('font:step', { delta: 2 }));
  bind('CommandOrControl+Shift+Down', () => send('font:step', { delta: -2 }));
}

app.whenReady().then(() => {
  createWindow();
  registerShortcuts();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
