// Drives the native on-device transcriber.
//
// Speech recognition runs through the Speech framework's SpeechAnalyzer in a
// helper process: no API key, no account, and no audio leaving the machine.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// In a packaged build the helper ships inside the app bundle; in development it
// is whatever the build script just produced.
const BINARY = process.env.NOTCHPROMPT_TRANSCRIBER
  || (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'notchprompt-transcriber'))
    ? path.join(process.resourcesPath, 'notchprompt-transcriber')
    : path.join(__dirname, '..', 'native', 'build', 'notchprompt-transcriber'));

function isAvailable() {
  return process.platform === 'darwin' && fs.existsSync(BINARY);
}

// Why manual scrolling is the only option, phrased for someone who did not just
// read the build script.
function unavailableReason() {
  if (process.platform !== 'darwin') {
    return 'Voice tracking needs macOS speech recognition — use Auto or the arrow keys instead.';
  }
  if (!fs.existsSync(BINARY)) {
    return 'The speech helper is not built. Run "npm run build:native" (needs Xcode Command Line Tools).';
  }
  return null;
}

// `binary` and `spawnFn` exist so the lifecycle — line framing, crashes, exits
// before readiness — can be exercised against a stand-in helper. Production
// callers pass neither.
function createLocalSTT({ onInterim, onTranscript, onError, onReady, onNotice, onExit, binary, spawnFn }) {
  const exe = binary || BINARY;
  const launch = spawnFn || spawn;
  let child = null;
  let buffer = '';
  let stopping = false;
  let lastStderr = '';

  function handleLine(line) {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    switch (msg.type) {
      case 'ready':
        console.log(`[stt] ready — on-device: ${msg.onDevice}, locale: ${msg.locale}`);
        onReady(msg);
        break;
      case 'interim': onInterim(msg.text, msg.alternatives || []); break;
      case 'final': onTranscript(msg.text, msg.alternatives || []); break;
      case 'notice':
        console.log('[stt]', msg.message);
        if (onNotice) onNotice(msg.message);
        break;
      case 'error':
        // Also logged: the window shows one status line at a time, and a
        // simultaneous microphone failure would otherwise hide this one.
        console.log('[stt] error:', msg.message);
        onError(msg.message);
        break;
    }
  }

  function start() {
    if (child) return true;
    const reason = binary ? null : unavailableReason();
    if (reason) { onError(reason); return false; }

    const args = ['en-US'];
    stopping = false;
    lastStderr = '';
    child = launch(exe, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop();
      lines.forEach(handleLine);
    });

    // Kept for diagnosis rather than display. A helper that dies before it can
    // print a JSON error — a missing framework, an OS too old for the API —
    // says why here and nowhere else.
    child.stderr.on('data', (chunk) => {
      lastStderr = (lastStderr + chunk.toString('utf8')).slice(-2000);
    });

    child.on('error', (err) => {
      child = null;
      onError('Could not start the speech helper: ' + err.message);
    });

    child.on('exit', (code) => {
      child = null;
      if (stopping) return;
      // A non-zero exit before stop() means the helper refused to run at all.
      // If it printed a JSON error, that has already been surfaced; if it died
      // without one, stderr is the only account of why.
      if (code !== 0 && lastStderr.trim()) {
        console.log('[stt] helper exited', code, 'stderr:', lastStderr.trim());
        onError('The speech helper stopped unexpectedly. See the console for details.');
      }
      onExit(code);
    });

    // The helper exits when stdin closes; a broken pipe during teardown is
    // expected rather than an error worth reporting.
    child.stdin.on('error', () => {});
    return true;
  }

  function sendAudio(arrayBuffer) {
    if (!child || !child.stdin.writable) return;
    child.stdin.write(Buffer.from(arrayBuffer));
  }

  function stop() {
    if (!child) return;
    stopping = true;
    try { child.stdin.end(); } catch { /* already gone */ }
    const dying = child;
    child = null;
    // Give it a moment to flush a final result, then make sure it is gone.
    setTimeout(() => { if (!dying.killed) dying.kill(); }, 1200).unref();
  }

  return { start, stop, sendAudio, get running() { return !!child; } };
}

module.exports = { createLocalSTT, isAvailable, unavailableReason };
