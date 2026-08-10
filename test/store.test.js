const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore, DEFAULTS } = require('../src/store');

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notchprompt-store-'));
  return path.join(dir, 'settings.json');
}

test('a missing settings file yields defaults rather than failing', () => {
  const store = createStore(tempFile());
  assert.deepEqual(store.getSettings(), DEFAULTS);
});

test('settings round-trip to disk', () => {
  const file = tempFile();
  createStore(file).setSettings({ fontSize: 42, opacity: 0.5 });

  const reopened = createStore(file).getSettings();
  assert.equal(reopened.fontSize, 42);
  assert.equal(reopened.opacity, 0.5);
});

test('a patch only changes the keys it names', () => {
  const file = tempFile();
  const store = createStore(file);
  store.setSettings({ fontSize: 40 });
  store.setSettings({ opacity: 0.7 });
  const s = store.getSettings();
  assert.equal(s.fontSize, 40, 'the earlier change survives the later one');
  assert.equal(s.opacity, 0.7);
  assert.equal(s.contentProtection, DEFAULTS.contentProtection, 'untouched keys keep their default');
});

test('corrupt JSON falls back to defaults instead of throwing', () => {
  const file = tempFile();
  fs.writeFileSync(file, '{ this is not json');
  assert.deepEqual(createStore(file).getSettings(), DEFAULTS);
});

test('a settings file containing a non-object is discarded, not spread', () => {
  // Regression: spreading a string's keys grafted "0", "1", "2"… onto settings.
  for (const junk of ['"just a string"', '[1,2,3]', '42', 'null', 'true']) {
    const file = tempFile();
    fs.writeFileSync(file, junk);
    const s = createStore(file).getSettings();
    assert.deepEqual(Object.keys(s).sort(), Object.keys(DEFAULTS).sort(),
      `settings file containing ${junk} must not introduce keys`);
  }
});

test('unknown keys in the file are preserved, not silently dropped', () => {
  // Forward compatibility: a newer build's setting should survive an older one
  // reading and rewriting the file.
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify({ futureSetting: 'keep me', fontSize: 30 }));
  const s = createStore(file).getSettings();
  assert.equal(s.futureSetting, 'keep me');
  assert.equal(s.fontSize, 30);
});

test('API keys left by an older build are erased from disk on load', () => {
  // Not merely ignored in memory: the credential must leave the filesystem.
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify({
    apiKeys: { deepgram: 'SECRET_VALUE_should_not_survive' },
    fontSize: 31
  }));

  const s = createStore(file).getSettings();
  assert.equal(s.apiKeys, undefined, 'not present in memory');
  assert.equal(s.fontSize, 31, 'unrelated settings are preserved');

  const onDisk = fs.readFileSync(file, 'utf8');
  assert.ok(!onDisk.includes('SECRET_VALUE_should_not_survive'), 'and erased from disk');
  assert.ok(!onDisk.includes('apiKeys'));
});

test('an unwritable location does not crash the app', () => {
  // The app must keep working on in-memory settings; it just will not remember.
  const store = createStore('/proc/definitely-not-writable/settings.json');
  assert.doesNotThrow(() => store.setSettings({ fontSize: 33 }));
  assert.equal(store.getSettings().fontSize, 33, 'still honoured for this session');
});

test('the settings file is written owner-only', () => {
  const file = tempFile();
  createStore(file).setSettings({ fontSize: 20 });
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
});

test('a patch of undefined or null is harmless', () => {
  const store = createStore(tempFile());
  assert.doesNotThrow(() => store.setSettings(undefined));
  assert.doesNotThrow(() => store.setSettings(null));
  assert.deepEqual(store.getSettings(), DEFAULTS);
});

test('an explicitly undefined value does not erase a setting', () => {
  const store = createStore(tempFile());
  store.setSettings({ fontSize: 44 });
  store.setSettings({ fontSize: undefined });
  assert.equal(store.getSettings().fontSize, 44);
});

test('a script with newlines and unicode survives a round-trip', () => {
  const file = tempFile();
  const script = 'Line one — ünïcode ✓\n\nLine three\ttabbed';
  createStore(file).setSettings({ lastScript: script });
  assert.equal(createStore(file).getSettings().lastScript, script);
});
