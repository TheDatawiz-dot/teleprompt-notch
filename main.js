const { app, BrowserWindow, ipcMain, globalShortcut, screen, session } = require('electron');
const path = require('path');
const store = require('./src/store');
const { AdaptiveVAD } = require('./src/vad');
const { createLocalSTT, isAvailable: sttAvailable, unavailableReason } = require('./src/stt-local');
const { createScriptTracker } = require('./src/script-tracker');
const networkGuard = require('./src/network-guard');
const { placeWindow } = require('./src/window-position');

let win = null;
let tracker = createScriptTracker('');
let stt = null;
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
  const W = 460, H = 300;
  const settings = store.getSettings();

  const placement = placeWindow({
    saved: { x: settings.windowX, y: settings.windowY },
    size: { width: W, height: H },
    displays: screen.getAllDisplays(),
    primary: screen.getPrimaryDisplay()
  });
  const startX = placement.x;
  const startY = placement.y;
  console.log('[notchprompt] window placed at', startX + ',' + startY, '(' + placement.reason + ')');

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
    send('protection:state', {
      active: !!s.contentProtection && !process.env.NOTCHPROMPT_NO_PROTECT
    });
    if (failedShortcuts.length) {
      send('status', {
        message: `Another app already holds ${failedShortcuts.join(', ')} — those shortcuts are inactive.`
      });
    }
  });
}

// -------- listening (mic -> VAD -> on-device STT -> script tracker) --------
function startListening() {
  if (listening) return { active: true, transcribing: !!stt };

  const blocked = unavailableReason();
  if (blocked) {
    send('status', { message: blocked });
    return { active: false, transcribing: false };
  }

  // The recogniser returns a best guess plus runners-up. When the best guess
  // does not line up with the script, a runner-up often does — "AI" heard as
  // "A I", say — so the alternatives get a turn before the position is left
  // where it was. The first one that moves the cursor wins.
  const trackAgainst = (feed, text, alternatives) => {
    const at = feed(text);
    if (at) return at;
    for (const alt of alternatives) {
      const viaAlt = feed(alt);
      if (viaAlt) return viaAlt;
    }
    return null;
  };

  stt = createLocalSTT({
    onReady: () => send('status', { message: 'Listening — on-device, nothing leaves this Mac.' }),
    onNotice: (message) => send('status', { message }),
    onTranscript: (text, alternatives) => {
      send('stt:final', { text });
      const at = trackAgainst(tracker.feedTranscript, text, alternatives);
      if (at) send('scroll:to', at);
    },
    onInterim: (text, alternatives) => {
      send('stt:interim', { text });
      const at = trackAgainst(tracker.feedProvisional, text, alternatives);
      if (at) send('scroll:to', at);
    },
    onError: (message) => {
      send('status', { message: message + ' Manual scrolling still works.' });
      stopListening();
    },
    onExit: () => stopListening()
  });

  if (!stt.start()) { stt = null; return { active: false, transcribing: false }; }

  listening = true;
  send('listening:state', { active: true, transcribing: true });
  return { active: true, transcribing: true };
}

function stopListening() {
  listening = false;
  if (stt) { stt.stop(); stt = null; }
  vad.reset();
  send('listening:state', { active: false, transcribing: false });
  return { active: false, transcribing: false };
}

// -------- IPC --------
ipcMain.handle('settings:get', () => ({
  ...store.getSettings(),
  voiceTracking: sttAvailable(),
  voiceTrackingNote: unavailableReason()
}));
ipcMain.handle('settings:set', (_e, patch) => store.setSettings(patch));

ipcMain.handle('listening:start', () => startListening());
ipcMain.handle('listening:stop', () => stopListening());
ipcMain.on('mic:pcm', (_e, arrayBuffer) => {
  if (!listening) return;
  // VAD drives the mic indicator only. The audio itself is forwarded
  // unconditionally: the Speech framework does its own endpointing, and
  // withholding the quiet parts makes its segmentation worse, not better.
  vad.processChunk(Buffer.from(arrayBuffer));
  if (stt) stt.sendAudio(arrayBuffer);
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

// One place decides what the window actually does, so the indicator and the
// window can never disagree. The development override wins over the stored
// preference every time: it exists so the window shows up in a screen
// recording, and a preference saved from the settings panel silently turning
// capture-hiding back on makes it useless.
function applyProtection(active) {
  const effective = !!active && !process.env.NOTCHPROMPT_NO_PROTECT;
  if (win && !win.isDestroyed()) win.setContentProtection(effective);
  send('protection:state', { active: effective });
  return effective;
}

ipcMain.handle('protection:get', () => ({
  active: !!store.getSettings().contentProtection && !process.env.NOTCHPROMPT_NO_PROTECT
}));
ipcMain.handle('protection:set', (_e, active) => {
  store.setSettings({ contentProtection: !!active });
  return { active: applyProtection(active) };
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
    store.setSettings({ contentProtection: active });
    applyProtection(active);
  });
  bind('CommandOrControl+Shift+Up', () => send('font:step', { delta: 2 }));
  bind('CommandOrControl+Shift+Down', () => send('font:step', { delta: -2 }));
}

app.whenReady().then(() => {
  // Refuse outbound requests before any window exists. The app transcribes
  // locally and has nothing to send; this makes that a property of the running
  // program rather than a claim about the source.
  networkGuard.install(session.defaultSession, (url) => {
    console.warn('[notchprompt] blocked a network request:', url);
  });

  // Logged once at startup so a user whose voice tracking silently does nothing
  // can find out why from Console.app without needing the source.
  const reason = unavailableReason();
  console.log('[notchprompt]', app.getVersion(), '| packaged:', app.isPackaged,
    '| voice tracking:', reason ? 'UNAVAILABLE — ' + reason : 'available');

  createWindow();
  registerShortcuts();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // The helper is a separate process holding the microphone stream. Quitting
  // without stopping it can leave it running with the app gone.
  if (stt) { stt.stop(); stt = null; }
});
app.on('window-all-closed', () => app.quit());
