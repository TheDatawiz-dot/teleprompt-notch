const test = require('node:test');
const assert = require('node:assert');
const { createScriptTracker, tokenizeScript, tokenizeSpoken, alignSubsequence, normalizeWord, withinEditDistance, phoneticKey } = require('../src/script-tracker');

const SCRIPT = [
  'Welcome to the show today.',
  'We are going to talk about the future of AI.',
  'First, let us cover the basics of how it works.',
  'Then we will dive into some real world examples.',
  'Finally, I will answer your questions.'
].join('\n');

// A script that repeats its own structure. This shape is what broke the first
// implementation: plain LCS tunnelled through the repeated words and jumped to
// the last stanza on the first sentence.
const REPETITIVE = [
  'Hello everyone and welcome back.',
  'Today we are covering three main topics.',
  'The first topic is speed.',
  'The second topic is accuracy.',
  'The third topic is cost.'
].join('\n');

test('normalizeWord strips punctuation and case but keeps apostrophes', () => {
  assert.equal(normalizeWord('Hello,'), 'hello');
  assert.equal(normalizeWord("don't"), "don't");
  assert.equal(normalizeWord('—'), '');
});

test('tokenizeScript keeps line attribution and drops punctuation-only tokens', () => {
  const { lines, words } = tokenizeScript('One two\n\n— three');
  assert.equal(lines.length, 3);
  assert.deepEqual(words.map((w) => w.norm), ['one', 'two', 'three']);
  assert.deepEqual(words.map((w) => w.lineIndex), [0, 0, 2]);
});

test('reading the script straight through advances line by line', () => {
  const t = createScriptTracker(SCRIPT);
  assert.equal(t.currentLine, 0);
  t.feedTranscript('welcome to the show today');
  assert.equal(t.currentLine, 1);
  t.feedTranscript('we are going to talk about the future of AI');
  assert.equal(t.currentLine, 2);
  t.feedTranscript('first let us cover the basics of how it works');
  assert.equal(t.currentLine, 3);
});

test('a repeated sentence template does not make the cursor overshoot', () => {
  // Regression: the LCS version jumped straight to line 4 on the second chunk.
  const t = createScriptTracker(REPETITIVE);
  t.feedTranscript('hello everyone and welcome back today we are');
  assert.equal(t.currentLine, 1);
  t.feedTranscript('covering three main topics the the first topic');
  assert.equal(t.currentLine, 2, 'must not tunnel ahead to a later "topic" line');
  t.feedTranscript('is speed the second');
  assert.equal(t.currentLine, 3);
  t.feedTranscript('topic is accuracy');
  assert.equal(t.currentLine, 4);
});

test('the cursor never moves backward when the reader re-reads a passed line', () => {
  const t = createScriptTracker(REPETITIVE);
  t.feedTranscript('hello everyone and welcome back');
  t.feedTranscript('today we are covering three main topics');
  t.feedTranscript('the first topic is speed');
  const before = t.currentLine;
  const moved = t.feedTranscript('today we are covering three main topics');
  assert.equal(moved, null, 'a backward match reports no movement');
  assert.equal(t.currentLine, before);
});

test('an unrelated utterance does not move the cursor', () => {
  const t = createScriptTracker(SCRIPT);
  assert.equal(t.feedTranscript('sorry can you hear me okay'), null);
  assert.equal(t.currentLine, 0);
});

test('a single matching word is too weak to move the cursor', () => {
  const t = createScriptTracker(SCRIPT);
  assert.equal(t.feedTranscript('welcome'), null);
});

test('provisional interims track continuously without polluting history', () => {
  const t = createScriptTracker(SCRIPT);
  // Deepgram-shaped cumulative interims, redundantly repeated.
  for (let i = 0; i < 20; i++) t.feedProvisional('welcome to the');
  assert.equal(t.currentLine, 0, '20 drafts of one phrase must not drag the cursor onward');

  // The matching final still lands correctly, and the next line follows.
  t.feedTranscript('welcome to the show today');
  assert.equal(t.currentLine, 1);
  t.feedTranscript('we are going to talk about the future of AI');
  assert.equal(t.currentLine, 2);
});

test('provisional text advances the word cursor mid-line', () => {
  const t = createScriptTracker(SCRIPT);
  const first = t.feedProvisional('welcome to');
  assert.ok(first, 'interim should report a position');
  const second = t.feedProvisional('welcome to the show');
  assert.ok(second.wordIndex > first.wordIndex, 'word cursor tracks within a line');
});

test('manual stepping crosses the blank lines between paragraphs', () => {
  // Regression: stepping onto a wordless line left the cursor pinned, so the
  // next step recomputed the same target and navigation deadlocked at line 0.
  const t = createScriptTracker('First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph.');
  assert.equal(t.step(1).lineIndex, 2);
  assert.equal(t.step(1).lineIndex, 4);
  assert.equal(t.step(-1).lineIndex, 2);
});

test('stepping past either end clamps instead of throwing', () => {
  const t = createScriptTracker(SCRIPT);
  assert.equal(t.step(-5).lineIndex, 0);
  assert.equal(t.step(99).lineIndex, 4);
  assert.equal(t.step(99).lineIndex, 4);
});

test('jumping to a blank line snaps to the next line that has words', () => {
  const t = createScriptTracker('Alpha line.\n\nBravo line.');
  assert.equal(t.setCursorToLine(1).lineIndex, 2);
});

test('an empty script is inert rather than fatal', () => {
  const t = createScriptTracker('');
  assert.equal(t.totalWords, 0);
  assert.equal(t.feedTranscript('anything at all'), null);
  assert.deepEqual(t.step(1), { lineIndex: 0, wordIndex: 0 });
  assert.deepEqual(t.setCursorToLine(3), { lineIndex: 0, wordIndex: 0 });
});

test('createScriptTracker tolerates no argument', () => {
  const t = createScriptTracker();
  assert.equal(t.totalWords, 0);
  assert.equal(t.feedProvisional('hello'), null);
});

test('layout exposes every indexed word exactly once, in order', () => {
  const t = createScriptTracker(SCRIPT);
  const flat = t.layout.flat();
  assert.equal(flat.length, t.totalWords);
  flat.forEach((w, i) => assert.equal(w.index, i, 'layout indices are dense and ordered'));
});

test('layout has an entry per source line, including blank ones', () => {
  const t = createScriptTracker('One\n\nTwo');
  assert.equal(t.layout.length, 3);
  assert.deepEqual(t.layout[1], [], 'the blank line renders as an empty line');
});

test('reset returns to the start of the script', () => {
  const t = createScriptTracker(SCRIPT);
  t.feedTranscript('welcome to the show today');
  t.feedTranscript('we are going to talk about the future of AI');
  assert.notEqual(t.currentLine, 0);
  assert.deepEqual(t.reset(), { lineIndex: 0, wordIndex: 0 });
});

test('alignSubsequence prefers a dense nearby match over a distant sparse one', () => {
  // "alpha beta" sits adjacent at 0..1; a lone "beta" also appears far later.
  const script = ['alpha', 'beta', 'x', 'x', 'x', 'x', 'x', 'beta'];
  const { lastIndex } = alignSubsequence(script, ['alpha', 'beta']);
  assert.equal(lastIndex, 1, 'gap penalty must beat the far-away repeat');
});

test('alignSubsequence handles empty input', () => {
  assert.deepEqual(alignSubsequence([], ['a']), { score: 0, lastIndex: -1 });
  assert.deepEqual(alignSubsequence(['a'], []), { score: 0, lastIndex: -1 });
});

test('a long script stays responsive', () => {
  const long = Array.from({ length: 4000 }, (_, i) => `Line ${i} with several ordinary words in it.`).join('\n');
  const t = createScriptTracker(long);
  const started = Date.now();
  for (let i = 0; i < 200; i++) t.feedProvisional('with several ordinary words');
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `200 updates took ${elapsed}ms — matching should be windowed, not whole-script`);
});

// ---- tolerance for the ways a recogniser and a script legitimately disagree ----

test('a contraction matches its written-out form, and the reverse', () => {
  const t = createScriptTracker('Let us cover the basics.\nWe are going to begin.');
  // Script says "Let us"; the recogniser wrote "Let's".
  assert.ok(t.feedTranscript("let's cover the basics"), 'contraction should match the expansion');
  assert.equal(t.currentLine, 1);

  const t2 = createScriptTracker("Let's cover the basics.\nWe are going to begin.");
  // Script says "Let's"; the recogniser wrote it out.
  assert.ok(t2.feedTranscript('let us cover the basics'), 'expansion should match the contraction');
  assert.equal(t2.currentLine, 1);
});

test('digits in the script match spoken number words', () => {
  const t = createScriptTracker('We raised 5 million dollars.\nThat is the headline.');
  assert.ok(t.feedTranscript('we raised five million dollars'));
  assert.equal(t.currentLine, 1);
});

test('number words in the script match transcribed digits', () => {
  const t = createScriptTracker('There are twenty people here.\nNext line.');
  assert.ok(t.feedTranscript('there are 20 people here'));
  assert.equal(t.currentLine, 1);
});

test('ordinals match their spoken form', () => {
  const t = createScriptTracker('The 1st thing to know.\nThe second thing.');
  assert.ok(t.feedTranscript('the first thing to know'));
  assert.equal(t.currentLine, 1);
});

test('a near-miss on a long word still counts', () => {
  // British/American spelling is the everyday case; the reader said the word.
  const t = createScriptTracker('We recognise the difference.\nOn to the next point.');
  assert.ok(t.feedTranscript('we recognize the difference'));
  assert.equal(t.currentLine, 1);
});

test('short lookalike words are not fuzzy-matched into each other', () => {
  // "cat"/"cap"/"car" differ by one letter but are plainly different words.
  const t = createScriptTracker('The cat sat down.');
  assert.equal(t.feedTranscript('the cap sad down'), null,
    'one-letter differences on short words must not carry a match');
});

test('withinEditDistance respects its limit', () => {
  assert.ok(withinEditDistance('recognise', 'recognize', 1));
  assert.ok(!withinEditDistance('kitten', 'sitting', 1));
  assert.ok(withinEditDistance('kitten', 'kitten', 0));
  assert.ok(!withinEditDistance('short', 'muchlongerword', 1));
});

test('tokenizeSpoken expands contractions into separate tokens', () => {
  assert.equal(tokenizeSpoken("let's go").length, 3);   // let + us + go
  assert.equal(tokenizeSpoken('let us go').length, 3);
});

test('vocabulary offers the script\'s distinctive words, longest first', () => {
  const t = createScriptTracker('We deployed Kubernetes to the staging cluster today.');
  const vocab = t.vocabulary();
  assert.ok(vocab.includes('Kubernetes'), 'distinctive words are included');
  assert.ok(!vocab.includes('to'), 'short filler words are not worth biasing');
  assert.ok(vocab[0].length >= vocab[vocab.length - 1].length, 'longest first');
});

test('vocabulary strips punctuation and de-duplicates', () => {
  const t = createScriptTracker('"Kubernetes," again: Kubernetes!');
  const vocab = t.vocabulary();
  assert.deepEqual(vocab.filter((w) => w.toLowerCase() === 'kubernetes'), ['Kubernetes']);
});

test('vocabulary is capped', () => {
  const many = Array.from({ length: 1000 }, (_, i) => `distinctword${i}`).join(' ');
  assert.ok(createScriptTracker(many).vocabulary(50).length <= 50);
});

// ---- phonetic fallback: the reader said the word, the recogniser misspelt it ----

test('a misheard proper noun still tracks, via its sound', () => {
  // Exactly what the on-device recogniser produced for this sentence.
  const t = createScriptTracker('We deployed Kubernetes with Grafana dashboards.\nThen we shipped it.');
  assert.ok(t.feedTranscript('we deployed Cubanets with Grafana dashboards'),
    '"Cubanets" is what was heard; the reader said Kubernetes');
  assert.equal(t.currentLine, 1);
});

test('an invented name survives being spelled differently', () => {
  const t = createScriptTracker('Our engineer Zylphra Kandrix presents.\nNext slide.');
  assert.ok(t.feedTranscript('our engineer Zilfra Kendricks presents'));
  assert.equal(t.currentLine, 1);
});

test('phonetic matching does not fuse plainly different words', () => {
  const t = createScriptTracker('The first topic is speed.');
  // "third"/"cost" are nothing like "first"/"speed" — no match should be found.
  assert.equal(t.feedTranscript('the third topic is cost') === null, false,
    'the shared words "the topic is" legitimately match');
  const t2 = createScriptTracker('Alpha bravo charlie.');
  assert.equal(t2.feedTranscript('delta echo foxtrot'), null);
});

test('phoneticKey ignores spelling that does not change the sound', () => {
  assert.equal(phoneticKey('Zylphra'), phoneticKey('Zilfra'));
  assert.equal(phoneticKey('recognise'), phoneticKey('recognize'));
  assert.equal(phoneticKey('Grafana'), phoneticKey('Graphana'));
});

test('phoneticKey keeps genuinely different words apart', () => {
  assert.notEqual(phoneticKey('speed'), phoneticKey('speak'));
  assert.notEqual(phoneticKey('first'), phoneticKey('third'));
  assert.notEqual(phoneticKey('welcome'), phoneticKey('output'));
});

test('phoneticKey handles empty and punctuation-only input', () => {
  assert.equal(phoneticKey(''), '');
  assert.equal(phoneticKey('—'), '');
});
