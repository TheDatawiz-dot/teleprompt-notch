// Matches live transcribed speech against a pasted script to find where the
// reader currently is, so the UI can follow along. This is the one piece with
// no equivalent in Cue — everything else here is audio plumbing, this is the
// actual "teleprompter" part.

function normalizeWord(w) {
  return w.toLowerCase().replace(/[^a-z0-9']/g, '');
}

// A recogniser writes "let's"; the script says "let us" — or the reverse. Both
// are the same speech, and a mismatch here stalls tracking on a word the reader
// said perfectly well. Expanding both sides to the same tokens makes them agree.
// Only unambiguous expansions are listed: "he's" could be "he is" or "he has",
// and guessing wrong would be worse than leaving it alone.
const CONTRACTIONS = {
  "i'm": ['i', 'am'], "i've": ['i', 'have'], "i'll": ['i', 'will'], "i'd": ['i', 'would'],
  "you're": ['you', 'are'], "you've": ['you', 'have'], "you'll": ['you', 'will'],
  "we're": ['we', 'are'], "we've": ['we', 'have'], "we'll": ['we', 'will'],
  "they're": ['they', 'are'], "they've": ['they', 'have'], "they'll": ['they', 'will'],
  "let's": ['let', 'us'], "that's": ['that', 'is'], "there's": ['there', 'is'],
  "here's": ['here', 'is'], "what's": ['what', 'is'], "who's": ['who', 'is'],
  "it's": ['it', 'is'], "isn't": ['is', 'not'], "aren't": ['are', 'not'],
  "wasn't": ['was', 'not'], "weren't": ['were', 'not'], "don't": ['do', 'not'],
  "doesn't": ['does', 'not'], "didn't": ['did', 'not'], "can't": ['can', 'not'],
  "couldn't": ['could', 'not'], "shouldn't": ['should', 'not'], "wouldn't": ['would', 'not'],
  "won't": ['will', 'not'], "haven't": ['have', 'not'], "hasn't": ['has', 'not'],
  "hadn't": ['had', 'not'], "cannot": ['can', 'not']
};

// Scripts write "5" and "2nd"; people say "five" and "second". Recognisers pick
// one form or the other unpredictably, so both are treated as the same token.
const NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen', 'twenty'
];
const TENS = { 30: 'thirty', 40: 'forty', 50: 'fifty', 60: 'sixty', 70: 'seventy', 80: 'eighty', 90: 'ninety', 100: 'hundred' };
const ORDINALS = {
  '1st': 'first', '2nd': 'second', '3rd': 'third', '4th': 'fourth', '5th': 'fifth',
  '6th': 'sixth', '7th': 'seventh', '8th': 'eighth', '9th': 'ninth', '10th': 'tenth'
};

const NUMBER_TO_WORD = new Map();
NUMBER_WORDS.forEach((w, n) => NUMBER_TO_WORD.set(String(n), w));
Object.entries(TENS).forEach(([n, w]) => NUMBER_TO_WORD.set(n, w));

const WORD_TO_NUMBER = new Map();
NUMBER_TO_WORD.forEach((word, digits) => WORD_TO_NUMBER.set(word, digits));

// Every spelling of one token that should count as the same token.
function formsFor(norm) {
  const forms = new Set([norm]);
  const asWord = NUMBER_TO_WORD.get(norm);
  if (asWord) forms.add(asWord);
  const asDigits = WORD_TO_NUMBER.get(norm);
  if (asDigits) forms.add(asDigits);
  if (ORDINALS[norm]) forms.add(ORDINALS[norm]);
  for (const [digits, word] of Object.entries(ORDINALS)) {
    if (word === norm) forms.add(digits);
  }
  return forms;
}

// One written word can be more than one spoken token, so matching runs over a
// flattened token list that points back at the word it came from.
function tokensForWord(norm) {
  const expanded = CONTRACTIONS[norm];
  return (expanded || [norm]).map(formsFor);
}

function tokenizeSpoken(text) {
  const tokens = [];
  (text.match(/\S+/g) || []).forEach((raw) => {
    const norm = normalizeWord(raw);
    if (norm) tokensForWord(norm).forEach((forms) => tokens.push(forms));
  });
  return tokens;
}

function tokenizeScript(text) {
  const lines = text.split('\n');
  const words = [];
  lines.forEach((line, lineIndex) => {
    (line.match(/\S+/g) || []).forEach((raw) => {
      const norm = normalizeWord(raw);
      // Punctuation-only tokens ("—", "...") normalize to empty. They carry no
      // matchable signal, so they are display-only and never enter the index.
      if (norm) words.push({ raw, norm, lineIndex });
    });
  });
  return { lines, words };
}

// Levenshtein distance, but it stops as soon as the answer exceeds `limit` —
// only near-misses matter here and the early exit keeps the inner loop cheap.
function withinEditDistance(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return false;
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let best = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < best) best = curr[j];
    }
    if (best > limit) return false;
    const swap = prev; prev = curr; curr = swap;
  }
  return prev[b.length] <= limit;
}

// A Metaphone-style phonetic key: what a word sounds like, stripped of how it
// is spelled. This is the fallback that matters most for a teleprompter. A
// recogniser that has never seen your proper nouns writes down what it heard —
// "Cubanets" for "Kubernetes", "postcards" for "Postgres", "Zilfra" for
// "Zylphra" — and every one of those is orthographically distant but
// phonetically almost identical. Comparing sounds recovers the word the reader
// actually said, which spelling-based comparison cannot.
function phoneticKey(word) {
  let s = word.toUpperCase().replace(/[^A-Z]/g, '');
  if (!s) return '';
  // Silent leading clusters: KNife, GNat, PNeumatic, WRite, X-ray.
  s = s.replace(/^(KN|GN|PN|AE|WR)/, (m) => m[1]);
  if (s[0] === 'X') s = 'S' + s.slice(1);
  s = s.replace(/^WH/, 'W');

  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i], next = s[i + 1] || '', prev = s[i - 1] || '';
    if (c === prev && c !== 'C') continue; // collapse doubles
    switch (c) {
      case 'A': case 'E': case 'I': case 'O': case 'U':
        if (i === 0) out += c; // vowels only carry information at the start
        break;
      case 'B': if (!(i === s.length - 1 && prev === 'M')) out += 'B'; break;
      case 'C':
        if (next === 'H') { out += 'X'; i++; }
        else if ('IEY'.includes(next)) out += 'S';
        else out += 'K';
        break;
      case 'D':
        if (next === 'G') { out += 'J'; i++; }
        else out += 'T';
        break;
      case 'G':
        if (next === 'H') { out += 'K'; i++; }
        else if ('IEY'.includes(next)) out += 'J';
        else out += 'K';
        break;
      case 'H': if ('AEIOU'.includes(prev) && !'AEIOU'.includes(next)) break; out += 'H'; break;
      case 'K': if (prev !== 'C') out += 'K'; break;
      case 'P': if (next === 'H') { out += 'F'; i++; } else out += 'P'; break;
      case 'Q': out += 'K'; break;
      case 'S': if (next === 'H') { out += 'X'; i++; } else out += 'S'; break;
      case 'T':
        if (next === 'H') { out += '0'; i++; }
        else if (s.slice(i, i + 3) === 'TIO' || s.slice(i, i + 3) === 'TIA') { out += 'X'; i += 2; }
        else out += 'T';
        break;
      case 'V': out += 'F'; break;
      case 'W': case 'Y': if ('AEIOU'.includes(next)) out += c; break;
      case 'X': out += 'KS'; break;
      case 'Z': out += 'S'; break;
      default: out += c;
    }
  }
  return out;
}

const MATCH_SCORE = 3;
// A near-miss still counts, at a discount. Recognisers routinely return
// "recognise" for "recognize" — treating that as a total mismatch stalls the
// scroll on a word the reader said perfectly well.
const FUZZY_SCORE = 2;
const FUZZY_MIN_LENGTH = 5; // short words differing by a letter are usually different words
// Phonetic keys are lossy, so they are only trusted when there is enough of one
// to be meaningful: identical short keys ("KT" for both cat and coat) say very
// little, and a one-character difference says less still.
const PHONETIC_MIN_EXACT = 3;
const PHONETIC_MIN_NEAR = 4;
const GAP_PENALTY = 1;

function asForms(token) {
  return token instanceof Set ? token : new Set([token]);
}

function similarity(scriptToken, spokenToken) {
  const a = asForms(scriptToken);
  const b = asForms(spokenToken);
  for (const form of a) if (b.has(form)) return MATCH_SCORE;
  for (const x of a) {
    if (x.length < FUZZY_MIN_LENGTH) continue;
    for (const y of b) {
      if (y.length < FUZZY_MIN_LENGTH) continue;
      if (withinEditDistance(x, y, 1)) return FUZZY_SCORE;
    }
  }
  for (const x of a) {
    if (x.length < 4) continue;
    const kx = phoneticKey(x);
    if (kx.length < PHONETIC_MIN_EXACT) continue;
    for (const y of b) {
      if (y.length < 4) continue;
      const ky = phoneticKey(y);
      if (ky.length < PHONETIC_MIN_EXACT) continue;
      if (kx === ky) return FUZZY_SCORE;
      if (kx.length >= PHONETIC_MIN_NEAR && ky.length >= PHONETIC_MIN_NEAR
          && withinEditDistance(kx, ky, 1)) return FUZZY_SCORE;
    }
  }
  return 0;
}

// Local alignment (Smith-Waterman) between a short forward-looking `script`
// slice and the last few spoken tokens (`probe`).
//
// Plain longest-common-subsequence is *not* safe here: scripts routinely repeat
// structure ("The first topic is speed... The second topic is accuracy...") and
// unrestricted LCS will happily "tunnel" through an unrelated repeated word far
// ahead and report a match there. A gap penalty makes a jump only pay off when
// the words around it actually line up, so a short match right after a big empty
// gap loses to a denser match found earlier. Windows are tiny (tens of tokens)
// so O(n*m) DP is fine.
function alignSubsequence(script, probe) {
  const n = script.length, m = probe.length;
  if (!n || !m) return { score: 0, lastIndex: -1 };
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  let best = 0, bestI = -1;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const gain = similarity(script[i - 1], probe[j - 1]);
      const diag = gain > 0 ? dp[i - 1][j - 1] + gain : 0;
      const up = dp[i - 1][j] - GAP_PENALTY;   // script token with no spoken counterpart yet
      const left = dp[i][j - 1] - GAP_PENALTY; // spoken token with no script counterpart (filler/misheard)
      const v = Math.max(0, diag, up, left);
      dp[i][j] = v;
      if (v > best) { best = v; bestI = i - 1; }
    }
  }
  return { score: best, lastIndex: bestI };
}

const WINDOW_AHEAD = 24;   // how far past the cursor we search for a match
const TOLERANCE_BACK = 4;  // how far behind the cursor a match is still trusted (false starts / re-reads)
const PROBE_TOKENS = 8;    // most-recently-spoken tokens used to locate the cursor
const MIN_SCORE = 5;       // roughly two solid matches before a jump is trusted

function createScriptTracker(scriptText) {
  const { lines, words } = tokenizeScript(scriptText || '');

  // Matching runs over tokens, not display words, because a contraction is one
  // word on screen and two tokens in speech. Each token remembers its word.
  const tokens = [];
  words.forEach((w, wordIndex) => {
    tokensForWord(w.norm).forEach((forms) => tokens.push({ forms, wordIndex }));
  });
  const tokenForms = tokens.map((t) => t.forms);

  // Manual navigation steps between lines that actually contain words. Moving
  // by raw line number deadlocks on the blank lines between paragraphs: the
  // target line has no word to anchor to, the cursor stays put, and the next
  // step recomputes the same unreachable target forever.
  const wordLines = [];
  const firstTokenOfLine = new Map();
  tokens.forEach((t, i) => {
    const line = words[t.wordIndex].lineIndex;
    if (!firstTokenOfLine.has(line)) {
      firstTokenOfLine.set(line, i);
      wordLines.push(line);
    }
  });

  // What the renderer draws. Handing it the tokens the tracker actually indexed
  // keeps the two from drifting: a word highlighted on screen is by
  // construction the same word the matcher is reasoning about.
  const layout = lines.map(() => []);
  words.forEach((w, index) => layout[w.lineIndex].push({ raw: w.raw, index }));

  let cursor = 0;
  let committedTail = [];

  function position() {
    if (!tokens.length) return { lineIndex: 0, wordIndex: 0 };
    const t = tokens[Math.min(cursor, tokens.length - 1)];
    return { lineIndex: words[t.wordIndex].lineIndex, wordIndex: t.wordIndex };
  }

  // Returns the new position if the cursor advanced, else null.
  //
  // `commit` distinguishes a finalized transcript from an in-flight one.
  // Interim results are revised as the provider hears more, so folding them
  // into the committed history would stack every draft of the same phrase and
  // wreck the probe. Provisional text still moves the cursor — the cursor only
  // ever moves forward, and the matching final re-confirms it — which is what
  // makes tracking follow speech continuously instead of lurching at pauses.
  function advance(text, commit) {
    if (!tokens.length) return null;
    const spoken = tokenizeSpoken(text || '');
    if (!spoken.length) return null;

    const probe = committedTail.concat(spoken).slice(-PROBE_TOKENS);
    if (commit) committedTail = probe;

    const from = Math.max(0, cursor - TOLERANCE_BACK);
    const to = Math.min(tokenForms.length, cursor + WINDOW_AHEAD);
    const { score, lastIndex } = alignSubsequence(tokenForms.slice(from, to), probe);
    if (score < MIN_SCORE || lastIndex === -1) return null;

    const newCursor = from + lastIndex + 1; // just past the last matched token
    if (newCursor <= cursor) return null;   // never jump backward
    cursor = Math.min(newCursor, tokens.length - 1);
    return position();
  }

  const feedTranscript = (text) => advance(text, true);
  const feedProvisional = (text) => advance(text, false);

  // Snaps to the first word at or after `lineIndex`, so clicking a blank line
  // lands on the next real line instead of doing nothing.
  function setCursorToLine(lineIndex) {
    if (!tokens.length) return position();
    let target = wordLines.find((l) => l >= lineIndex);
    if (target === undefined) target = wordLines[wordLines.length - 1];
    cursor = firstTokenOfLine.get(target);
    committedTail = [];
    return position();
  }

  function step(deltaLines) {
    if (!tokens.length) return position();
    const current = position().lineIndex;
    let at = wordLines.indexOf(current);
    if (at === -1) at = 0;
    const next = Math.max(0, Math.min(wordLines.length - 1, at + deltaLines));
    cursor = firstTokenOfLine.get(wordLines[next]);
    committedTail = [];
    return position();
  }

  function reset() {
    cursor = 0;
    committedTail = [];
    return position();
  }

  // Distinct script vocabulary, longest first, for biasing the recogniser
  // toward the words this particular script actually uses.
  function vocabulary(limit = 400) {
    const seen = new Set();
    const out = [];
    for (const w of words) {
      if (w.norm.length < 4 || seen.has(w.norm)) continue;
      seen.add(w.norm);
      out.push(w.raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));
    }
    return out.sort((a, b) => b.length - a.length).slice(0, limit);
  }

  return {
    lines,
    layout,
    totalLines: lines.length,
    totalWords: words.length,
    feedTranscript,
    feedProvisional,
    setCursorToLine,
    step,
    reset,
    position,
    vocabulary,
    get currentLine() { return position().lineIndex; }
  };
}

module.exports = {
  createScriptTracker,
  normalizeWord,
  tokenizeScript,
  tokenizeSpoken,
  alignSubsequence,
  withinEditDistance,
  phoneticKey
};
