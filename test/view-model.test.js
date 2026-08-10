const test = require('node:test');
const assert = require('node:assert');
const VM = require('../renderer/view-model');

// ---- paint diffing: which words change state as the cursor moves ----
//
// This is the logic behind the highlight. Its failure modes are subtle and
// visual: words left marked as read after the cursor moves back, a stale
// highlight on two words at once, an off-by-one at the ends of the script.

test('moving forward marks the words passed over as read', () => {
  const d = VM.diffPaint(2, 5, 20);
  assert.deepEqual(d.addSpoken, [2, 3, 4]);
  assert.deepEqual(d.removeSpoken, []);
  assert.equal(d.clearAt, 2, 'the old cursor loses its highlight');
  assert.equal(d.setAt, 5, 'the new cursor gains it');
});

test('moving backward un-marks the words returned to', () => {
  const d = VM.diffPaint(5, 2, 20);
  assert.deepEqual(d.addSpoken, []);
  assert.deepEqual(d.removeSpoken, [2, 3, 4, 5],
    'everything between the two positions stops being read text');
  assert.equal(d.setAt, 2);
});

test('the first update from the initial state does not touch word -1', () => {
  const d = VM.diffPaint(-1, 0, 20);
  assert.equal(d.clearAt, null, 'there is no previous word to clear');
  assert.deepEqual(d.addSpoken, [], 'nothing has been read yet');
  assert.equal(d.setAt, 0);
});

test('a position at the very end of the script is in range', () => {
  const d = VM.diffPaint(8, 9, 10);
  assert.equal(d.setAt, 9);
  assert.deepEqual(d.addSpoken, [8]);
});

test('a position past the end is clamped rather than pointing at nothing', () => {
  const d = VM.diffPaint(5, 999, 10);
  assert.equal(d.setAt, 9, 'clamped to the last word');
  assert.ok(d.addSpoken.every((i) => i < 10), 'never marks a word that does not exist');
});

test('no movement produces no work', () => {
  const d = VM.diffPaint(4, 4, 20);
  assert.equal(d.clearAt, null);
  assert.deepEqual(d.addSpoken, []);
  assert.deepEqual(d.removeSpoken, []);
});

test('an empty script produces no paint work', () => {
  const d = VM.diffPaint(-1, 0, 0);
  assert.equal(d.setAt, null);
  assert.deepEqual(d.addSpoken, []);
});

test('walking the whole script marks every word exactly once', () => {
  // Simulates the incremental repaint keeping up with a full read-through: the
  // union of every step must equal the whole script, with nothing repeated.
  const total = 50;
  const marked = new Set();
  let prev = -1;
  for (let next = 0; next < total; next++) {
    VM.diffPaint(prev, next, total).addSpoken.forEach((i) => {
      assert.ok(!marked.has(i), `word ${i} marked twice`);
      marked.add(i);
    });
    prev = next;
  }
  assert.equal(marked.size, total - 1, 'every word before the cursor is read text');
});

// ---- pace estimation ----

test('pace reports nothing until there is enough evidence', () => {
  const p = VM.createPacer();
  assert.equal(p.pace(), 0, 'no samples');
  p.record(0, 0);
  p.record(100, 1);
  assert.equal(p.pace(), 0, 'two samples is not a pace');
});

test('pace reports words per second over the sample window', () => {
  const p = VM.createPacer();
  p.record(0, 0);
  p.record(500, 1);
  p.record(1000, 2);
  p.record(2000, 4); // 4 words in 2s
  assert.equal(p.pace(), 2);
});

test('a reader who has stopped has no forward pace', () => {
  // Interims keep arriving during a pause, all reporting the same position.
  const p = VM.createPacer();
  p.record(0, 10);
  p.record(1000, 10);
  p.record(2000, 10);
  assert.equal(p.pace(), 0, 'a stalled cursor must not keep the lead running');
});

test('a backward correction does not produce a negative pace', () => {
  const p = VM.createPacer();
  p.record(0, 10);
  p.record(1000, 9);
  p.record(2000, 8);
  assert.equal(p.pace(), 0);
});

test('an implausibly fast jump is capped, not trusted', () => {
  const p = VM.createPacer();
  p.record(0, 0);
  p.record(100, 100);
  p.record(200, 400); // 400 words in 0.2s — a jump, not speech
  assert.ok(p.pace() <= VM.DEFAULTS.maxPace);
});

test('a burst of updates in a few milliseconds is too noisy to divide by', () => {
  const p = VM.createPacer();
  for (let i = 0; i < 10; i++) p.record(i, i); // 10 updates within 10ms
  assert.equal(p.pace(), 0, 'a 10ms window would imply a nonsensical pace');
});

test('pace history is bounded, so long sessions do not grow memory', () => {
  const p = VM.createPacer();
  for (let i = 0; i < 500; i++) p.record(i * 100, i);
  assert.ok(p.size <= VM.DEFAULTS.paceHistory);
});

test('reset clears the pace, so switching scripts does not inherit a speed', () => {
  const p = VM.createPacer();
  p.record(0, 0); p.record(1000, 3); p.record(2000, 6);
  assert.ok(p.pace() > 0);
  p.reset();
  assert.equal(p.pace(), 0);
  assert.equal(p.size, 0);
});

// ---- lead ----

test('no pace means no lead: the scroll shows the confirmed position', () => {
  assert.equal(VM.leadWords(0), 0);
});

test('lead grows with pace but never past the cap', () => {
  const slow = VM.leadWords(2);
  const fast = VM.leadWords(100);
  assert.ok(slow > 0);
  assert.ok(fast >= slow);
  assert.equal(fast, VM.DEFAULTS.maxLeadWords);
});

test('lead is configurable, so it can be swept without editing code', () => {
  assert.equal(VM.leadWords(3, { leadSeconds: 0 }), 0);
  assert.ok(VM.leadWords(3, { leadSeconds: 2, maxLeadWords: 99 }) > VM.leadWords(3));
});

// ---- scroll targeting ----

test('the read line is placed at the anchor, not the middle', () => {
  const target = VM.scrollTargetFor({
    lineTop: 1000, lineHeight: 40, viewportHeight: 300, contentHeight: 5000
  });
  // anchor 0.4 of a 300px viewport puts the line 120px down; its centre is +20.
  assert.equal(target, 1000 - 120 + 20);
  // Placing the line higher in the viewport means scrolling further, so the
  // anchored target must exceed what dead-centring would give.
  const centred = 1000 - 150 + 20;
  assert.ok(target > centred,
    'anchoring above centre leaves the upcoming text in view, not the read text');
});

test('scrolling cannot go above the top of the script', () => {
  const target = VM.scrollTargetFor({
    lineTop: 0, lineHeight: 40, viewportHeight: 300, contentHeight: 5000
  });
  assert.equal(target, 0, 'the first line must not scroll off the top');
});

test('scrolling cannot go past the end of the script', () => {
  const target = VM.scrollTargetFor({
    lineTop: 4900, lineHeight: 40, viewportHeight: 300, contentHeight: 5000
  });
  assert.equal(target, 4700, 'clamped to the last scrollable pixel');
});

test('a script shorter than the window does not scroll at all', () => {
  const target = VM.scrollTargetFor({
    lineTop: 20, lineHeight: 40, viewportHeight: 300, contentHeight: 120
  });
  assert.equal(target, 0);
});

// ---- easing ----

test('easing converges on the target and reports when it is done', () => {
  let pos = 0;
  const target = 500;
  let frames = 0;
  for (;;) {
    const step = VM.easeStep(pos, target);
    pos = step.value;
    frames++;
    if (step.done) break;
    assert.ok(frames < 500, 'easing must terminate');
  }
  assert.equal(pos, target, 'lands exactly on target rather than near it');
  assert.ok(frames > 3, 'and gets there gradually, not in one jump');
});

test('easing moves toward a target above the current position too', () => {
  const step = VM.easeStep(500, 0);
  assert.ok(step.value < 500);
  assert.equal(step.done, false);
});

test('easing that is already there does no work', () => {
  const step = VM.easeStep(300, 300);
  assert.deepEqual(step, { value: 300, done: true });
});

test('retargeting mid-animation still converges (the moving-target case)', () => {
  // The scroll target is replaced while easing is in flight — the case that used
  // to restart scrollIntoView and read as stutter.
  let pos = 0;
  let target = 400;
  for (let frame = 0; frame < 200; frame++) {
    if (frame === 5) target = 900;   // reader sped up
    if (frame === 20) target = 650;  // recognition corrected backward
    const step = VM.easeStep(pos, target);
    pos = step.value;
    if (step.done && frame > 25) break;
  }
  assert.ok(Math.abs(pos - 650) < 1, `settled at ${pos}, expected ~650`);
});

// ---- word -> line mapping ----

test('word to line mapping handles blank lines between paragraphs', () => {
  // "One two" on line 0, line 1 blank, "three" on line 2.
  const map = [0, 0, 2];
  assert.equal(VM.lineOfWord(map, 0), 0);
  assert.equal(VM.lineOfWord(map, 2), 2);
});

test('a lead running past the last word lands on the last line', () => {
  const map = [0, 0, 2];
  assert.equal(VM.lineOfWord(map, 99), 2, 'clamped, never undefined');
});

test('word to line mapping on an empty script falls back safely', () => {
  assert.equal(VM.lineOfWord([], 5, 3), 3);
  assert.equal(VM.lineOfWord(undefined, 5, 0), 0);
});
