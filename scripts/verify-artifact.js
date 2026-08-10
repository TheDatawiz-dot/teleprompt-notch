// Checks a packaged .app the way a stranger's Mac will see it.
//
// The failure modes here are quiet ones. A helper binary that lost its execute
// bit, or got swallowed into the asar archive where it cannot be run, produces
// an app that launches, looks correct, and simply never transcribes anything.
// Config review does not catch that; inspecting the built bundle does.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const APP = process.argv[2] || 'dist/mac-arm64/Teleprompt Notch.app';
const checks = [];
let failed = 0;

function check(name, fn) {
  try {
    const detail = fn();
    checks.push(`  PASS  ${name}${detail ? ' — ' + detail : ''}`);
  } catch (err) {
    failed++;
    checks.push(`  FAIL  ${name} — ${err.message}`);
  }
}

const contents = path.join(APP, 'Contents');
const resources = path.join(contents, 'Resources');

check('app bundle exists', () => {
  if (!fs.existsSync(APP)) throw new Error(`not found at ${APP}`);
  return APP;
});

check('Info.plist present', () => {
  const p = path.join(contents, 'Info.plist');
  if (!fs.existsSync(p)) throw new Error('missing');
  return 'ok';
});

check('declares the microphone usage string', () => {
  const out = execFileSync('/usr/libexec/PlistBuddy',
    ['-c', 'Print :NSMicrophoneUsageDescription', path.join(contents, 'Info.plist')],
    { encoding: 'utf8' }).trim();
  if (!out) throw new Error('empty');
  return out.slice(0, 40) + '…';
});

check('declares a minimum system version', () => {
  const out = execFileSync('/usr/libexec/PlistBuddy',
    ['-c', 'Print :LSMinimumSystemVersion', path.join(contents, 'Info.plist')],
    { encoding: 'utf8' }).trim();
  if (!out.startsWith('26')) throw new Error(`expected 26.x, got ${out}`);
  return out;
});

check('runs as a background app (no dock icon)', () => {
  const out = execFileSync('/usr/libexec/PlistBuddy',
    ['-c', 'Print :LSUIElement', path.join(contents, 'Info.plist')],
    { encoding: 'utf8' }).trim();
  if (out !== 'true' && out !== '1') throw new Error(`LSUIElement is ${out}`);
  return 'yes';
});

// The whole point of the extraResources rule.
check('speech helper is present in Resources', () => {
  const p = path.join(resources, 'notchprompt-transcriber');
  if (!fs.existsSync(p)) throw new Error('helper missing from the bundle');
  return `${(fs.statSync(p).size / 1024).toFixed(0)}KB`;
});

check('speech helper is executable', () => {
  const p = path.join(resources, 'notchprompt-transcriber');
  const mode = fs.statSync(p).mode;
  if (!(mode & 0o111)) throw new Error(`mode ${(mode & 0o777).toString(8)} is not executable`);
  return (mode & 0o777).toString(8);
});

check('speech helper is a native arm64 binary', () => {
  const out = execFileSync('file', [path.join(resources, 'notchprompt-transcriber')], { encoding: 'utf8' });
  if (!/Mach-O/.test(out)) throw new Error('not a Mach-O executable');
  return out.split(':').slice(1).join(':').trim().slice(0, 50);
});

check('speech helper actually runs from inside the bundle', () => {
  // Launched with no stdin, it should report readiness or a clean reason and
  // exit — what it must not do is fail to load at all.
  const p = path.join(resources, 'notchprompt-transcriber');
  let out = '';
  try {
    out = execFileSync(p, ['en-US'], { encoding: 'utf8', timeout: 25000, input: '' });
  } catch (err) {
    out = (err.stdout || '') + (err.stderr || '');
    if (/dyld|Symbol not found|image not found/i.test(out)) {
      throw new Error('dynamic linking failed: ' + out.split('\n')[0]);
    }
  }
  if (!out.trim()) throw new Error('produced no output at all');
  const kinds = out.trim().split('\n').map((l) => { try { return JSON.parse(l).type; } catch { return '?'; } });
  return 'emitted: ' + [...new Set(kinds)].join(', ');
});

check('application code is packaged', () => {
  const asar = path.join(resources, 'app.asar');
  const plain = path.join(resources, 'app');
  if (fs.existsSync(asar)) return `app.asar ${(fs.statSync(asar).size / 1024).toFixed(0)}KB`;
  if (fs.existsSync(plain)) return 'unpacked app directory';
  throw new Error('neither app.asar nor app/ found');
});

check('no node_modules leaked into the bundle', () => {
  // electron-builder should prune devDependencies; a stray node_modules means
  // electron-builder itself may have been packaged.
  const leaked = path.join(resources, 'app', 'node_modules');
  if (fs.existsSync(leaked)) {
    const n = fs.readdirSync(leaked).length;
    if (n > 0) throw new Error(`${n} packages present`);
  }
  return 'clean';
});

check('bundle does not embed developer paths', () => {
  // A hard-coded /Users/... path in shipped code means the app only works on
  // the machine that built it.
  const out = execFileSync('/bin/sh', ['-c',
    `grep -rl "/Users/" "${resources}" --include="*.js" 2>/dev/null | head -5 || true`],
    { encoding: 'utf8' }).trim();
  if (out) throw new Error('developer paths found in: ' + out.replace(/\n/g, ', '));
  return 'none';
});

check('signature state is reported honestly', () => {
  try {
    const out = execFileSync('codesign', ['-dv', APP], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return out.match(/Signature=\S+/)?.[0] || 'signed';
  } catch (err) {
    const text = (err.stderr || '').toString();
    if (/adhoc/i.test(text)) return 'ad-hoc signed (Gatekeeper will warn)';
    if (/not signed/i.test(text)) return 'UNSIGNED (Gatekeeper will warn)';
    return 'unknown: ' + text.split('\n')[0];
  }
});

console.log(`\nVerifying artifact: ${APP}\n`);
checks.forEach((line) => console.log(line));
console.log(`\n${failed === 0 ? 'All artifact checks passed.' : failed + ' check(s) FAILED.'}\n`);
process.exit(failed === 0 ? 0 : 1);
