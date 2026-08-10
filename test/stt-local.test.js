const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { createLocalSTT } = require('../src/stt-local');

// A stand-in for the Swift helper. The real one needs macOS 26, a microphone and
// a speech model; what matters here is the contract between the two processes —
// newline-delimited JSON on stdout, diagnostics on stderr, an exit code — and
// that is reproducible without any of that.
function fakeHelper() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), {
    writable: true,
    written: [],
    write(chunk) { this.written.push(chunk); return true; },
    end() { this.ended = true; }
  });
  child.killed = false;
  child.kill = () => { child.killed = true; };
  // Convenience: push text through stdout as the helper would.
  child.say = (text) => child.stdout.emit('data', Buffer.from(text, 'utf8'));
  return child;
}

function harness(overrides = {}) {
  const events = { ready: [], interim: [], final: [], errors: [], notices: [], exits: [] };
  const child = fakeHelper();
  const stt = createLocalSTT({
    binary: '/fake/helper',
    spawnFn: () => child,
    onReady: (m) => events.ready.push(m),
    onInterim: (text, alts) => events.interim.push({ text, alts }),
    onTranscript: (text, alts) => events.final.push({ text, alts }),
    onError: (m) => events.errors.push(m),
    onNotice: (m) => events.notices.push(m),
    onExit: (code) => events.exits.push(code),
    ...overrides
  });
  return { stt, child, events };
}

test('a ready message starts the session', () => {
  const { stt, child, events } = harness();
  assert.equal(stt.start(), true);
  child.say('{"type":"ready","onDevice":true,"locale":"en-US"}\n');
  assert.equal(events.ready.length, 1);
  assert.equal(events.ready[0].onDevice, true);
});

test('interim and final transcripts are delivered separately', () => {
  const { stt, child, events } = harness();
  stt.start();
  child.say('{"type":"interim","text":"hello wor"}\n');
  child.say('{"type":"final","text":"hello world."}\n');
  assert.deepEqual(events.interim.map((e) => e.text), ['hello wor']);
  assert.deepEqual(events.final.map((e) => e.text), ['hello world.']);
});

test('alternatives are passed through, and default to an empty list', () => {
  const { stt, child, events } = harness();
  stt.start();
  child.say('{"type":"final","text":"AI.","alternatives":["A I.","A.I."]}\n');
  child.say('{"type":"final","text":"plain"}\n');
  assert.deepEqual(events.final[0].alts, ['A I.', 'A.I.']);
  assert.deepEqual(events.final[1].alts, [], 'absent alternatives must not be undefined');
});

test('a message split across two chunks is reassembled', () => {
  // Pipes split wherever they like; a JSON object arriving in halves is normal.
  const { stt, child, events } = harness();
  stt.start();
  child.say('{"type":"final","te');
  assert.equal(events.final.length, 0, 'nothing is emitted from half a line');
  child.say('xt":"split across chunks"}\n');
  assert.deepEqual(events.final.map((e) => e.text), ['split across chunks']);
});

test('several messages in one chunk are all handled', () => {
  const { stt, child, events } = harness();
  stt.start();
  child.say('{"type":"interim","text":"one"}\n{"type":"interim","text":"two"}\n{"type":"final","text":"three"}\n');
  assert.deepEqual(events.interim.map((e) => e.text), ['one', 'two']);
  assert.deepEqual(events.final.map((e) => e.text), ['three']);
});

test('a line held without its newline is not emitted early', () => {
  const { stt, child, events } = harness();
  stt.start();
  child.say('{"type":"final","text":"waiting"}');
  assert.equal(events.final.length, 0);
  child.say('\n');
  assert.equal(events.final.length, 1);
});

test('malformed and blank lines are ignored rather than crashing', () => {
  const { stt, child, events } = harness();
  stt.start();
  assert.doesNotThrow(() => {
    child.say('not json at all\n');
    child.say('\n');
    child.say('   \n');
    child.say('{"unclosed": \n');
    child.say('{"type":"unknown-kind","text":"?"}\n');
    child.say('{"type":"final","text":"still working"}\n');
  });
  assert.deepEqual(events.final.map((e) => e.text), ['still working'],
    'a garbled line must not desynchronise the stream');
  assert.equal(events.errors.length, 0);
});

test('an error message from the helper is surfaced', () => {
  const { stt, child, events } = harness();
  stt.start();
  child.say('{"type":"error","message":"On-device speech recognition is unavailable."}\n');
  assert.deepEqual(events.errors, ['On-device speech recognition is unavailable.']);
});

test('a notice is surfaced separately from an error', () => {
  const { stt, child, events } = harness();
  stt.start();
  child.say('{"type":"notice","message":"downloading the on-device speech model"}\n');
  assert.deepEqual(events.notices, ['downloading the on-device speech model']);
  assert.equal(events.errors.length, 0, 'a progress notice is not a failure');
});

test('a helper that dies with a diagnostic reports rather than failing silently', () => {
  const { stt, child, events } = harness();
  stt.start();
  child.stderr.emit('data', Buffer.from('dyld: Symbol not found: _SpeechAnalyzer\n'));
  child.emit('exit', 1);
  assert.equal(events.errors.length, 1, 'the user is told something went wrong');
  assert.deepEqual(events.exits, [1], 'and the app unwinds its listening state');
});

test('a helper that exits cleanly is not reported as an error', () => {
  const { stt, child, events } = harness();
  stt.start();
  child.emit('exit', 0);
  assert.equal(events.errors.length, 0);
  assert.deepEqual(events.exits, [0]);
});

test('a spawn failure is reported with its cause', () => {
  const { stt, child, events } = harness();
  stt.start();
  child.emit('error', new Error('spawn ENOENT'));
  assert.equal(events.errors.length, 1);
  assert.match(events.errors[0], /spawn ENOENT/);
});

test('stopping deliberately does not report an error on exit', () => {
  const { stt, child, events } = harness();
  stt.start();
  stt.stop();
  child.emit('exit', 0);
  assert.equal(events.errors.length, 0, 'a requested shutdown is not a fault');
  assert.equal(events.exits.length, 0, 'and does not re-enter the stop path');
});

test('stop closes stdin so the helper can flush and exit on its own', () => {
  const { stt, child } = harness();
  stt.start();
  stt.stop();
  assert.equal(child.stdin.ended, true);
});

test('audio is forwarded to the helper while running, and not after stopping', () => {
  const { stt, child } = harness();
  stt.start();
  stt.sendAudio(new Uint8Array([1, 2, 3, 4]).buffer);
  assert.equal(child.stdin.written.length, 1);
  stt.stop();
  stt.sendAudio(new Uint8Array([5, 6]).buffer);
  assert.equal(child.stdin.written.length, 1, 'no writes to a closed helper');
});

test('sending audio before starting is a no-op, not a crash', () => {
  const { stt } = harness();
  assert.doesNotThrow(() => stt.sendAudio(new Uint8Array([1, 2]).buffer));
});

test('starting twice does not spawn a second helper', () => {
  let spawns = 0;
  const child = fakeHelper();
  const stt = createLocalSTT({
    binary: '/fake/helper',
    spawnFn: () => { spawns++; return child; },
    onReady() {}, onInterim() {}, onTranscript() {},
    onError() {}, onExit() {}
  });
  stt.start();
  stt.start();
  assert.equal(spawns, 1);
});

test('running reflects the lifecycle', () => {
  const { stt, child } = harness();
  assert.equal(stt.running, false);
  stt.start();
  assert.equal(stt.running, true);
  child.emit('exit', 0);
  assert.equal(stt.running, false);
});

test('stopping when never started is harmless', () => {
  const { stt } = harness();
  assert.doesNotThrow(() => stt.stop());
});

