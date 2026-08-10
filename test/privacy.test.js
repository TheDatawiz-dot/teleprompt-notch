const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const guard = require('../src/network-guard');

const ROOT = path.join(__dirname, '..');

// ---- the guard itself ----

test('remote requests are refused', () => {
  for (const url of [
    'https://example.com/x', 'http://example.com/x', 'ws://example.com',
    'wss://example.com', 'ftp://example.com/f', '//example.com/protocol-relative'
  ]) {
    assert.equal(guard.shouldBlock(url), true, `${url} must be blocked`);
  }
});

test('the app loading its own files is allowed', () => {
  for (const url of [
    'file:///Applications/Teleprompt%20Notch.app/Contents/Resources/app.asar/renderer/index.html',
    'data:text/html,ok', 'blob:null/abc', 'devtools://devtools/bundled/x.js'
  ]) {
    assert.equal(guard.shouldBlock(url), false, `${url} must be allowed`);
  }
});

test('a scheme is matched case-insensitively', () => {
  assert.equal(guard.shouldBlock('FILE:///x'), false);
  assert.equal(guard.shouldBlock('HTTPS://example.com'), true);
});

test('a URL that merely mentions file: is still blocked', () => {
  // The check is on the scheme, not on the string containing it.
  assert.equal(guard.shouldBlock('https://evil.example/?next=file:///etc/passwd'), true);
});

test('empty and malformed input is blocked rather than allowed by accident', () => {
  for (const url of ['', null, undefined, 0, {}]) {
    assert.equal(guard.shouldBlock(url), true);
  }
});

test('install refuses a blocked request and reports it', () => {
  const calls = [];
  let handler = null;
  const fakeSession = { webRequest: { onBeforeRequest: (fn) => { handler = fn; } } };
  assert.equal(guard.install(fakeSession, (url) => calls.push(url)), true);

  let result = null;
  handler({ url: 'https://tracker.example/collect' }, (r) => { result = r; });
  assert.deepEqual(result, { cancel: true });
  assert.deepEqual(calls, ['https://tracker.example/collect']);

  handler({ url: 'file:///app/renderer/index.html' }, (r) => { result = r; });
  assert.deepEqual(result, {}, 'local loads proceed');
});

test('install tolerates a session without webRequest', () => {
  assert.equal(guard.install(null), false);
  assert.equal(guard.install({}), false);
});

// ---- the repository as a whole ----
// These assert the privacy property against the source, so a future change that
// quietly introduces networking fails the build rather than the promise.

function sourceFiles() {
  return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.(js|swift|html)$/.test(f))
    .filter((f) => !f.startsWith('test/'));
}

test('no networking APIs appear anywhere in shipped source', () => {
  const banned = /\b(fetch\s*\(|XMLHttpRequest|new WebSocket|require\(['"](https?|net|dgram|tls)['"]\)|URLSession|NSURLConnection)/;
  const offenders = sourceFiles().filter((f) => banned.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  assert.deepEqual(offenders, [], 'networking API found in shipped source');
});

test('no analytics or telemetry libraries are referenced', () => {
  const banned = /\b(analytics|telemetry|sentry|posthog|mixpanel|amplitude|bugsnag|datadog|gtag)\b/i;
  const offenders = sourceFiles().filter((f) => banned.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  assert.deepEqual(offenders, []);
});

test('no remote URLs are embedded in shipped source', () => {
  const offenders = [];
  for (const f of sourceFiles()) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const line of text.split('\n')) {
      // Documentation links inside comments are fine; a live URL in code is not.
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('<!--')) continue;
      const match = line.match(/https?:\/\/[^\s'")]+/);
      if (match && !/DTDs\/PropertyList|www\.apple\.com\/DTDs/.test(match[0])) {
        offenders.push(`${f}: ${match[0]}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('the app has no runtime dependencies at all', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies || {}, {},
    'a runtime dependency is a supply chain that could add networking');
});

test('the renderer declares a restrictive content security policy', () => {
  const html = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /connect-src 'none'/, 'the page must not be able to connect anywhere');
});

test('the build does not request the network entitlement', () => {
  const plist = fs.readFileSync(path.join(ROOT, 'build/entitlements.mac.plist'), 'utf8');
  assert.ok(!/network\.client/.test(plist),
    'requesting outgoing-network would undermine the privacy claim');
});
