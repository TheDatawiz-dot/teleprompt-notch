(function () {
  const editView = document.getElementById('edit-view');
  const readView = document.getElementById('read-view');
  const scriptInput = document.getElementById('script-input');
  const scriptScroll = document.getElementById('script-scroll');
  const statusLine = document.getElementById('status-line');
  const settingsPanel = document.getElementById('settings-panel');
  const dotMic = document.getElementById('dot-mic');
  const dotProtect = document.getElementById('dot-protect');
  const shell = document.getElementById('app');

  let fontSize = 28;
  let layout = [];
  let currentLine = 0;
  let currentWord = 0;
  let listening = false;
  let autoTimer = null;
  let statusTimer = null;

  function showStatus(message, ms) {
    statusLine.textContent = message || '';
    clearTimeout(statusTimer);
    if (message && ms) statusTimer = setTimeout(() => { statusLine.textContent = ''; }, ms);
  }

  function applyFontSize() {
    scriptScroll.style.fontSize = fontSize + 'px';
  }

  // One span per word, built from the tracker's own token layout, so the word
  // highlighted on screen is by construction the word the matcher matched.
  function renderLines() {
    scriptScroll.innerHTML = '';
    layout.forEach((words, i) => {
      const div = document.createElement('div');
      div.className = 'line';
      div.dataset.line = String(i);
      if (!words.length) {
        div.classList.add('blank');
      } else {
        words.forEach((w) => {
          const span = document.createElement('span');
          span.className = 'word';
          span.dataset.index = String(w.index);
          span.textContent = w.raw;
          div.appendChild(span);
          div.appendChild(document.createTextNode(' '));
        });
      }
      div.addEventListener('click', () => notch.jump(i).then(applyPosition));
      scriptScroll.appendChild(div);
    });
    paint();
  }

  function paint() {
    scriptScroll.querySelectorAll('.line').forEach((n) => {
      n.classList.toggle('current', Number(n.dataset.line) === currentLine);
    });
    scriptScroll.querySelectorAll('.word').forEach((n) => {
      const i = Number(n.dataset.index);
      n.classList.toggle('spoken', i < currentWord);
      n.classList.toggle('at', i === currentWord);
    });
  }

  // Interim transcripts arrive several times a second. Repainting the highlight
  // that often is cheap, but re-issuing a smooth scrollIntoView is not — it
  // restarts the animation on every update and reads as jitter. So scrolling is
  // commanded only when the line actually changes.
  function applyPosition(at) {
    if (!at) return;
    const lineChanged = at.lineIndex !== currentLine;
    currentLine = at.lineIndex;
    currentWord = at.wordIndex;
    paint();
    if (lineChanged) {
      const target = scriptScroll.querySelector('.line[data-line="' + at.lineIndex + '"]');
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // ---- edit <-> read ----
  async function enterReadMode() {
    const text = scriptInput.value;
    const r = await notch.setScript(text);
    if (!r.totalWords) {
      showStatus('Nothing to read — paste a script first.', 4000);
      return;
    }
    layout = r.layout;
    currentLine = r.lineIndex;
    currentWord = r.wordIndex;
    renderLines();
    applyFontSize();
    editView.classList.add('hidden');
    readView.classList.remove('hidden');
    scriptScroll.focus();
  }
  function enterEditMode() {
    if (listening) toggleListening();
    stopAuto();
    readView.classList.add('hidden');
    editView.classList.remove('hidden');
  }
  document.getElementById('btn-start-reading').addEventListener('click', enterReadMode);
  document.getElementById('btn-back-edit').addEventListener('click', enterEditMode);

  // ---- manual / auto-speed fallback scrolling ----
  document.getElementById('btn-font-up').addEventListener('click', () => setFontSize(fontSize + 2));
  document.getElementById('btn-font-down').addEventListener('click', () => setFontSize(fontSize - 2));
  function setFontSize(v) {
    fontSize = Math.max(14, Math.min(64, v));
    applyFontSize();
    notch.settingsSet({ fontSize });
  }

  function stopAuto() {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    document.getElementById('btn-auto').textContent = 'Auto ▸';
  }
  document.getElementById('btn-auto').addEventListener('click', () => {
    if (autoTimer) { stopAuto(); return; }
    document.getElementById('btn-auto').textContent = 'Auto ■';
    autoTimer = setInterval(() => notch.step(1).then(applyPosition), 1400);
  });

  document.addEventListener('keydown', (e) => {
    if (!settingsPanel.classList.contains('hidden')) return;
    if (readView.classList.contains('hidden')) return;
    if (e.key === 'ArrowDown') { notch.step(1).then(applyPosition); e.preventDefault(); }
    if (e.key === 'ArrowUp') { notch.step(-1).then(applyPosition); e.preventDefault(); }
    if (e.key === 'Escape') { enterEditMode(); e.preventDefault(); }
  });

  // ---- listening (mic capture) ----
  let audioCtx = null, micStream = null, micWorklet = null;
  async function startMic() {
    if (micStream) return true;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: 16000 }
      });
      audioCtx = new AudioContext({ sampleRate: 16000 });
      await audioCtx.audioWorklet.addModule('audio-worklet-processor.js');
      const source = audioCtx.createMediaStreamSource(micStream);
      micWorklet = new AudioWorkletNode(audioCtx, 'notchprompt-audio-processor');
      micWorklet.port.onmessage = (e) => notch.micPcm(e.data);
      source.connect(micWorklet);
      return true;
    } catch (err) {
      showStatus('Microphone capture failed: ' + (err && err.message ? err.message : String(err)), 6000);
      stopMic();
      return false;
    }
  }
  function stopMic() {
    if (micWorklet) { micWorklet.disconnect(); micWorklet = null; }
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  }

  function setListenButton(on) {
    document.getElementById('btn-listen').textContent = on ? 'Stop 🎙' : 'Listen 🎙';
  }

  async function toggleListening() {
    if (listening) {
      await notch.stopListening();
      stopMic();
      listening = false;
      setListenButton(false);
      return;
    }
    const r = await notch.startListening();
    // No provider, or no microphone: either way nothing will ever be heard, so
    // don't leave the button reading "Stop" as though it were working.
    if (!r.streaming || !(await startMic())) {
      await notch.stopListening();
      setListenButton(false);
      return;
    }
    listening = true;
    setListenButton(true);
    dotMic.className = 'dot on';
  }
  document.getElementById('btn-listen').addEventListener('click', toggleListening);

  // ---- settings ----
  const keyDeepgram = document.getElementById('key-deepgram');
  const keyOpenai = document.getElementById('key-openai');
  const keyProtection = document.getElementById('key-protection');
  const keyOpacity = document.getElementById('key-opacity');

  function applyOpacity(v) {
    shell.style.setProperty('--shell-alpha', String(v));
  }

  document.getElementById('btn-settings').addEventListener('click', async () => {
    const s = await notch.settingsGet();
    keyDeepgram.value = '';
    keyOpenai.value = '';
    // Only presence crosses the bridge — the key itself never leaves the main process.
    keyDeepgram.placeholder = s.keys.deepgram ? '•••• saved' : 'paste to set';
    keyOpenai.placeholder = s.keys.openai ? '•••• saved' : 'paste to set';
    keyProtection.checked = !!s.contentProtection;
    keyOpacity.value = String(s.opacity);
    document.getElementById('keychain-note').textContent = s.keychain
      ? 'Keys are encrypted in your login Keychain.'
      : 'No OS keychain available — keys are stored unencrypted on this machine.';
    settingsPanel.classList.remove('hidden');
  });
  document.getElementById('btn-settings-close').addEventListener('click', () => settingsPanel.classList.add('hidden'));
  document.getElementById('btn-settings-save').addEventListener('click', async () => {
    const patch = { apiKeys: {}, opacity: Number(keyOpacity.value) };
    if (keyDeepgram.value) patch.apiKeys.deepgram = keyDeepgram.value;
    if (keyOpenai.value) patch.apiKeys.openai = keyOpenai.value;
    await notch.settingsSet(patch);
    await notch.setProtection(keyProtection.checked);
    keyDeepgram.value = '';
    keyOpenai.value = '';
    applyOpacity(patch.opacity);
    settingsPanel.classList.add('hidden');
    showStatus('Settings saved.', 2500);
  });
  keyOpacity.addEventListener('input', () => applyOpacity(Number(keyOpacity.value)));

  document.getElementById('btn-hide').addEventListener('click', () => notch.hideWindow());

  // ---- main-process events ----
  notch.on('script:loaded', ({ text }) => { if (text) scriptInput.value = text; });
  notch.on('scroll:to', applyPosition);
  notch.on('stt:interim', ({ text }) => showStatus('hearing: ' + text));
  notch.on('stt:final', ({ text }) => showStatus('heard: ' + text, 2500));
  notch.on('status', ({ message }) => showStatus(message, 6000));
  notch.on('listening:state', ({ active, streaming }) => {
    const on = active && streaming;
    dotMic.className = 'dot' + (on ? ' on' : '');
    if (!on && listening) { stopMic(); listening = false; setListenButton(false); }
  });
  notch.on('vad:state', ({ speaking }) => {
    if (listening) dotMic.className = 'dot ' + (speaking ? 'speaking' : 'on');
  });
  notch.on('protection:state', ({ active }) => {
    dotProtect.className = 'dot' + (active ? ' on' : '');
    keyProtection.checked = !!active;
  });
  notch.on('font:step', ({ delta }) => setFontSize(fontSize + delta));

  // ---- init ----
  (async () => {
    const s = await notch.settingsGet();
    fontSize = s.fontSize || 28;
    applyFontSize();
    applyOpacity(s.opacity);
    dotProtect.className = 'dot' + (s.contentProtection ? ' on' : '');
  })();
})();
