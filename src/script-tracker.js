// Matches live transcribed speech against a pasted script to find where the
// reader currently is, so the UI can follow along. This is the one piece with
// no equivalent in Cue — everything else here is audio plumbing, this is the
// actual "teleprompter" part.

function normalizeWord(w) {
  return w.toLowerCase().replace(/[^a-z0-9']/g, '');
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

// Local alignment (Smith-Waterman) between a short forward-looking `script`
// slice and the last few spoken words (`probe`), both already normalized.
// Plain longest-common-subsequence is *not* safe here: scripts routinely
// repeat structure ("The first topic is speed... The second topic is
// accuracy...") and unrestricted LCS will happily "tunnel" through an
// unrelated repeated word far ahead and report a match there. A gap penalty
// makes a jump only pay off when the words around it actually line up, so a
// short match right after a big empty gap loses to a denser match found
// earlier. Windows are tiny (tens of words) so O(n*m) DP is fine.
const MATCH_SCORE = 3;
const GAP_PENALTY = 1;

function alignSubsequence(script, probe) {
  const n = script.length, m = probe.length;
  if (!n || !m) return { score: 0, lastIndex: -1 };
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  let best = 0, bestI = -1;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const diag = script[i - 1] === probe[j - 1] ? dp[i - 1][j - 1] + MATCH_SCORE : 0;
      const up = dp[i - 1][j] - GAP_PENALTY;   // script word with no spoken counterpart yet
      const left = dp[i][j - 1] - GAP_PENALTY; // spoken word with no script counterpart (filler/misheard)
      const v = Math.max(0, diag, up, left);
      dp[i][j] = v;
      if (v > best) { best = v; bestI = i - 1; }
    }
  }
  return { score: best, lastIndex: bestI };
}

const WINDOW_AHEAD = 24;   // how far past the cursor we search for a match
const TOLERANCE_BACK = 4;  // how far behind the cursor a match is still trusted (false starts / re-reads)
const PROBE_WORDS = 8;     // most-recently-spoken words used to locate the cursor
const MIN_SCORE = 5;       // roughly two consecutive matched words before a jump is trusted

function createScriptTracker(scriptText) {
  const { lines, words } = tokenizeScript(scriptText || '');
  const norms = words.map((w) => w.norm);

  // Manual navigation steps between lines that actually contain words. Moving
  // by raw line number deadlocks on the blank lines between paragraphs: the
  // target line has no word to anchor to, the cursor stays put, and the next
  // step recomputes the same unreachable target forever.
  const wordLines = [];
  const firstWordOfLine = new Map();
  words.forEach((w, i) => {
    if (!firstWordOfLine.has(w.lineIndex)) {
      firstWordOfLine.set(w.lineIndex, i);
      wordLines.push(w.lineIndex);
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
    if (!words.length) return { lineIndex: 0, wordIndex: 0 };
    const i = Math.min(cursor, words.length - 1);
    return { lineIndex: words[i].lineIndex, wordIndex: i };
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
    if (!words.length) return null;
    const spoken = (text.match(/\S+/g) || []).map(normalizeWord).filter(Boolean);
    if (!spoken.length) return null;

    const probe = committedTail.concat(spoken).slice(-PROBE_WORDS);
    if (commit) committedTail = probe;

    const from = Math.max(0, cursor - TOLERANCE_BACK);
    const to = Math.min(norms.length, cursor + WINDOW_AHEAD);
    const { score, lastIndex } = alignSubsequence(norms.slice(from, to), probe);
    if (score < MIN_SCORE || lastIndex === -1) return null;

    const newCursor = from + lastIndex + 1; // just past the last matched word
    if (newCursor <= cursor) return null;   // never jump backward
    cursor = Math.min(newCursor, words.length - 1);
    return position();
  }

  const feedTranscript = (text) => advance(text, true);
  const feedProvisional = (text) => advance(text, false);

  // Snaps to the first word at or after `lineIndex`, so clicking a blank line
  // lands on the next real line instead of doing nothing.
  function setCursorToLine(lineIndex) {
    if (!words.length) return position();
    let target = wordLines.find((l) => l >= lineIndex);
    if (target === undefined) target = wordLines[wordLines.length - 1];
    cursor = firstWordOfLine.get(target);
    committedTail = [];
    return position();
  }

  function step(deltaLines) {
    if (!words.length) return position();
    const current = position().lineIndex;
    let at = wordLines.indexOf(current);
    if (at === -1) at = 0;
    const next = Math.max(0, Math.min(wordLines.length - 1, at + deltaLines));
    cursor = firstWordOfLine.get(wordLines[next]);
    committedTail = [];
    return position();
  }

  function reset() {
    cursor = 0;
    committedTail = [];
    return position();
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
    get currentLine() { return position().lineIndex; }
  };
}

module.exports = { createScriptTracker, normalizeWord, tokenizeScript, alignSubsequence };
