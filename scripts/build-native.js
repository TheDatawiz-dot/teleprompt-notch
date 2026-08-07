// Compiles the on-device transcriber. macOS only; elsewhere this is a no-op and
// the app falls back to manual scrolling.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'native', 'Transcriber.swift');
const plist = path.join(root, 'native', 'Info.plist');
const outDir = path.join(root, 'native', 'build');
const out = path.join(outDir, 'notchprompt-transcriber');

if (process.platform !== 'darwin') {
  console.log('[notchprompt] not macOS — skipping the native transcriber build.');
  process.exit(0);
}

if (!spawnSync('xcrun', ['--find', 'swiftc']).status === 0) {
  console.log('[notchprompt] swiftc not found — install the Xcode Command Line Tools to enable voice tracking.');
  process.exit(0);
}

fs.mkdirSync(outDir, { recursive: true });

// The Info.plist is linked into the binary's __TEXT,__info_plist section. A
// command-line tool has no bundle to read a usage description from, and without
// one the speech-permission request is denied outright.
const args = [
  '-sdk', spawnSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' }).stdout.trim(),
  '-swift-version', '5',
  '-parse-as-library', // the entry point is @main, not top-level code
  '-O',
  '-o', out,
  src,
  '-framework', 'Speech',
  '-framework', 'AVFoundation',
  '-Xlinker', '-sectcreate',
  '-Xlinker', '__TEXT',
  '-Xlinker', '__info_plist',
  '-Xlinker', plist
];

const res = spawnSync('swiftc', args, { stdio: 'inherit' });
if (res.status !== 0) {
  console.log('[notchprompt] native transcriber failed to build — voice tracking will be unavailable, manual scrolling still works.');
  process.exit(0);
}

// Ad-hoc signing gives the binary a stable identity, so the speech-permission
// grant sticks to it across rebuilds instead of being asked for every launch.
spawnSync('codesign', ['--force', '--sign', '-', out], { stdio: 'inherit' });
console.log('[notchprompt] built ' + path.relative(root, out));
