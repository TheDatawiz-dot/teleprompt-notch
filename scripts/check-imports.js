// Catches the class of mistake where a module references something that is not
// there: a deleted file still required, a package removed from dependencies, a
// typo in a path. Cheap to run and it fails the build instead of the app.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const failures = [];
const notes = [];

// Modules that must load standalone, outside Electron.
const PLAIN = ['src/script-tracker.js', 'src/vad.js', 'src/stt-local.js',
  'src/store.js', 'src/network-guard.js', 'renderer/view-model.js'];

for (const rel of PLAIN) {
  try {
    require(path.join(ROOT, rel));
    notes.push(`  loads   ${rel}`);
  } catch (err) {
    failures.push(`  BROKEN  ${rel} — ${err.message}`);
  }
}

// Electron-dependent files cannot be required here, so they are parsed instead.
const ELECTRON_ONLY = ['main.js', 'preload.js', 'renderer/renderer.js',
  'renderer/audio-worklet-processor.js'];
for (const rel of ELECTRON_ONLY) {
  try {
    execFileSync(process.execPath, ['--check', path.join(ROOT, rel)], { stdio: 'pipe' });
    notes.push(`  parses  ${rel}`);
  } catch (err) {
    failures.push(`  BROKEN  ${rel} — ${(err.stderr || '').toString().split('\n')[0]}`);
  }
}

// Anything required from our own source must actually exist on disk.
const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter((f) => f.endsWith('.js'));
for (const rel of tracked) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  for (const m of text.matchAll(/require\((['"])(\.[^'"]+)\1\)/g)) {
    const target = path.resolve(path.dirname(path.join(ROOT, rel)), m[2]);
    const exists = fs.existsSync(target) || fs.existsSync(target + '.js');
    if (!exists) failures.push(`  MISSING ${rel} requires ${m[2]}, which does not exist`);
  }
}

// A runtime dependency would ship with the app; the project deliberately has none.
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const runtimeDeps = Object.keys(pkg.dependencies || {});
if (runtimeDeps.length) {
  failures.push(`  DEPS    unexpected runtime dependencies: ${runtimeDeps.join(', ')}`);
} else {
  notes.push('  deps    no runtime dependencies');
}

console.log(notes.join('\n'));
if (failures.length) {
  console.error('\n' + failures.join('\n') + `\n\n${failures.length} import problem(s).\n`);
  process.exit(1);
}
console.log('\nAll imports resolve.\n');
