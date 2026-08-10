(function () {
  const VM = window.NotchPromptViewModel;

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
    pendingStatus = null; // a real message outranks a queued live transcript
    statusLine.textContent = message || '';
    clearTimeout(statusTimer);
    if (message && ms) statusTimer = setTimeout(() => { statusLine.textContent = ''; }, ms);
  }

  // The running transcript is glanceable feedback, not information the reader
  // needs every revision of. It arrives as often as the recogniser changes its
  // mind, so it is written to the DOM once a frame like everything else.
  let pendingStatus = null;
  let statusFrameQueued = false;

  function showLiveStatus(message) {
    pendingStatus = message;
    if (statusFrameQueued) return;
    statusFrameQueued = true;
    requestAnimationFrame(() => {
      statusFrameQueued = false;
      if (pendingStatus === null) return;
      clearTimeout(statusTimer);
      statusLine.textContent = pendingStatus;
      pendingStatus = null;
    });
  }

  function applyFontSize() {
    scriptScroll.style.fontSize = fontSize + 'px';
  }

  // One span per word, built from the tracker's own token layout, so the word
  // highlighted on screen is by construction the word the matcher matched.
  function renderLines() {
    scriptScroll.innerHTML = '';
    // Rebuilt from scratch, so the incremental paint state and its node caches
    // start over with it.
    wordNodes = [];
    lineNodes = [];
    wordLineIndex = [];
    pacer.reset();
    paintedWord = -1;
    paintedLine = -1;
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
          span.textContent = w.raw;
          wordNodes[w.index] = span;
          wordLineIndex[w.index] = i;
          div.appendChild(span);
          div.appendChild(document.createTextNode(' '));
        });
      }
      lineNodes[i] = div;
      div.addEventListener('click', () => notch.jump(i).then(applyPosition));
      scriptScroll.appendChild(div);
    });
    paint();
  }

  // Interim results arrive several times a second. Re-deriving every word's
  // classes each time is O(script length) per update, which on a long script
  // means tens of thousands of DOM writes a second for a highlight that moved
  // by one word. Only the span that gained the cursor, the ones it passed, and
  // the line that changed are touched.
  let paintedWord = -1;
  let paintedLine = -1;
  let wordNodes = [];
  let lineNodes = [];
  let wordLineIndex = [];   // word index -> line index, for aiming the scroll ahead

  function paint() {
    if (paintedLine !== currentLine) {
      if (lineNodes[paintedLine]) lineNodes[paintedLine].classList.remove('current');
      if (lineNodes[currentLine]) lineNodes[currentLine].classList.add('current');
      paintedLine = currentLine;
    }
    if (paintedWord === currentWord) return;

    const change = VM.diffPaint(paintedWord, currentWord, wordNodes.length);
    if (change.clearAt !== null && wordNodes[change.clearAt]) {
      wordNodes[change.clearAt].classList.remove('at');
    }
    change.addSpoken.forEach((i) => { if (wordNodes[i]) wordNodes[i].classList.add('spoken'); });
    change.removeSpoken.forEach((i) => { if (wordNodes[i]) wordNodes[i].classList.remove('spoken'); });
    if (change.setAt !== null && wordNodes[change.setAt]) {
      wordNodes[change.setAt].classList.add('at');
      wordNodes[change.setAt].classList.remove('spoken');
    }
    paintedWord = currentWord;
  }

  // ---- motion ----
  //
  // Position updates arrive far faster than the screen refreshes: the recogniser
  // revises its guess every few characters, so twenty-odd updates a second is
  // normal. Acting on each one as it lands repeats the same work several times
  // between frames and shows none of it.
  //
  // Two rules keep the motion smooth. Painting is coalesced into a single
  // animation frame, so the display is brought up to date once per frame and
  // always to the newest position. And scrolling eases toward a moving target
  // instead of being re-commanded: scrollIntoView begins a fresh animation on
  // every call, so a line change part-way through one abandoned the run in
  // progress and started over — which is exactly what reads as stutter.
  let frameQueued = false;
  let scrollTarget = null;
  let scrollAnimating = false;

  // Recognition is about eight tenths of a second behind the speaker — measured,
  // and inherent to transcribing audio rather than anything this app can tune
  // away. Chasing it with the scroll is what feels like lag: by the time a word
  // is confirmed the reader is already two words past it, so the text they need
  // is always arriving late.
  //
  // So the highlight and the scroll are decoupled. The highlight stays honest,
  // marking the last word actually recognised. The scroll aims slightly ahead of
  // it, at where the reader has probably got to, and sits that point above the
  // middle of the window so the line being read has its continuation in view
  // rather than the text already spoken.
  const pacer = VM.createPacer();

  function applyPosition(at) {
    if (!at) return;
    currentLine = at.lineIndex;
    currentWord = at.wordIndex;
    pacer.record(performance.now(), at.wordIndex);
    if (frameQueued) return;
    frameQueued = true;
    requestAnimationFrame(() => {
      frameQueued = false;
      paint();
      aimScroll();
    });
  }

  function aimScroll() {
    const lead = VM.leadWords(pacer.pace());
    const node = lineNodes[VM.lineOfWord(wordLineIndex, currentWord + lead, currentLine)]
      || lineNodes[currentLine];
    if (!node) return;
    scrollTarget = VM.scrollTargetFor({
      lineTop: node.offsetTop,
      lineHeight: node.offsetHeight,
      viewportHeight: scriptScroll.clientHeight,
      contentHeight: scriptScroll.scrollHeight
    });
    if (scrollAnimating) return; // the running loop picks up the new target
    scrollAnimating = true;
    requestAnimationFrame(function stepScroll() {
      const next = VM.easeStep(scriptScroll.scrollTop, scrollTarget);
      scriptScroll.scrollTop = next.value;
      if (next.done) { scrollAnimating = false; return; }
      requestAnimationFrame(stepScroll);
    });
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
    // No transcriber, or no microphone: either way nothing will ever be heard,
    // so don't leave the button reading "Stop" as though it were working.
    if (!r.transcribing || !(await startMic())) {
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
  const keyProtection = document.getElementById('key-protection');
  const keyOpacity = document.getElementById('key-opacity');

  function applyOpacity(v) {
    shell.style.setProperty('--shell-alpha', String(v));
  }

  document.getElementById('btn-settings').addEventListener('click', async () => {
    const s = await notch.settingsGet();
    keyProtection.checked = !!s.contentProtection;
    keyOpacity.value = String(s.opacity);
    document.getElementById('voice-note').textContent = s.voiceTracking
      ? 'Voice tracking runs on this Mac — no account, no API key, and no audio leaves the device. Manual scrolling: ↑/↓ or Auto.'
      : (s.voiceTrackingNote || '');
    settingsPanel.classList.remove('hidden');
  });
  document.getElementById('btn-settings-close').addEventListener('click', () => settingsPanel.classList.add('hidden'));
  document.getElementById('btn-settings-save').addEventListener('click', async () => {
    const opacity = Number(keyOpacity.value);
    await notch.settingsSet({ opacity });
    await notch.setProtection(keyProtection.checked);
    applyOpacity(opacity);
    settingsPanel.classList.add('hidden');
    showStatus('Settings saved.', 2500);
  });
  keyOpacity.addEventListener('input', () => applyOpacity(Number(keyOpacity.value)));

  document.getElementById('btn-hide').addEventListener('click', () => notch.hideWindow());

  // ---- main-process events ----
  notch.on('script:loaded', ({ text }) => { if (text) scriptInput.value = text; });
  notch.on('scroll:to', applyPosition);
  notch.on('stt:interim', ({ text }) => showLiveStatus('hearing: ' + text));
  notch.on('stt:final', ({ text }) => showLiveStatus('heard: ' + text));
  notch.on('status', ({ message }) => showStatus(message, 6000));
  notch.on('listening:state', ({ active, transcribing }) => {
    const on = active && transcribing;
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
