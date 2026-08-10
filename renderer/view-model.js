// The decisions behind what the reading view shows, with no DOM in sight.
//
// Everything here is a pure function of position, timing and geometry. The
// renderer supplies measurements and applies the results; this file decides
// what should happen. That split exists because the display logic is where the
// awkward bugs live — a highlight that walks the wrong way, a scroll that
// fights itself, a pace estimate that runs away during a pause — and none of
// that is testable while it is interleaved with element lookups.
//
// Loaded as a plain script by the renderer (there is no bundler) and required
// directly by the tests, hence the small dual-export dance at the bottom.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NotchPromptViewModel = factory();
}(typeof self !== 'undefined' ? self : globalThis, function () {

  // Tuning for how far ahead of the confirmed position the scroll aims.
  //
  // NOT human-validated. No person has yet read from this app and reported
  // whether the motion feels right, and that is the only test that settles these
  // numbers. Treat them as defaults chosen to fail safe.
  //
  // What is measured: recognition reports a word a median of ~0.8s after it is
  // spoken, on this machine. `bench/lead-sweep.js` models a steady reader against
  // that latency and finds leadSeconds ≈ 1.0–1.2 minimises the distance between
  // the aimed position and where the reader actually is; at 0.6 the scroll sits
  // about 0.6 words behind them.
  //
  // 0.6 is kept anyway, deliberately. The model optimises average distance and
  // is indifferent to which side of the reader the error falls on, whereas a
  // reader is not: text arriving slightly late is a much smaller problem than the
  // page scrolling past the line being read. If it feels sluggish, raising this
  // toward 1.0 is the first thing to try — and the sweep says that is defensible.
  const DEFAULTS = {
    leadSeconds: 0.6,   // how far ahead of the confirmed word to aim
    maxLeadWords: 6,    // never lead further than this, however fast the pace
    anchor: 0.4,        // read line sits this fraction down the viewport
    maxPace: 6,         // words/sec above this is a jump, not reading
    minPaceSamples: 3,  // fewer samples than this is not yet a pace
    minPaceSeconds: 0.4,// shorter window than this is too noisy to divide by
    paceHistory: 12,    // samples kept for the pace estimate
    ease: 0.16,         // fraction of the remaining distance covered per frame
    settleWithin: 0.5   // closer than this to target counts as arrived
  };

  // Tracks how fast the reader is getting through words, from confirmed
  // positions over time. Deliberately conservative: it reports no pace at all
  // rather than a wrong one, because an inflated pace leads the scroll past
  // where the reader is, which is worse than not leading.
  function createPacer(options) {
    const cfg = Object.assign({}, DEFAULTS, options || {});
    let samples = [];

    return {
      record(timeMs, wordIndex) {
        samples.push({ t: timeMs, word: wordIndex });
        if (samples.length > cfg.paceHistory) samples.shift();
      },
      // Words per second, or 0 when there is not enough evidence.
      pace() {
        if (samples.length < cfg.minPaceSamples) return 0;
        const first = samples[0];
        const last = samples[samples.length - 1];
        const seconds = (last.t - first.t) / 1000;
        if (seconds < cfg.minPaceSeconds) return 0;
        const words = last.word - first.word;
        if (words <= 0) return 0; // stalled or moved backward: no forward pace
        return Math.min(words / seconds, cfg.maxPace);
      },
      reset() { samples = []; },
      get size() { return samples.length; }
    };
  }

  // How many words ahead of the confirmed position to aim the scroll.
  function leadWords(pace, options) {
    const cfg = Object.assign({}, DEFAULTS, options || {});
    if (!(pace > 0)) return 0;
    return Math.min(Math.round(pace * cfg.leadSeconds), cfg.maxLeadWords);
  }

  // Where scrollTop should end up to put `line` at the anchor point. Clamped to
  // the scrollable range so the top and bottom of a script cannot be scrolled
  // past — without the clamp the last line pins itself mid-viewport and the
  // remaining text is pushed out of sight.
  function scrollTargetFor(geometry, options) {
    const cfg = Object.assign({}, DEFAULTS, options || {});
    const { lineTop, lineHeight, viewportHeight, contentHeight } = geometry;
    const anchored = lineTop - viewportHeight * cfg.anchor + lineHeight / 2;
    const limit = Math.max(0, contentHeight - viewportHeight);
    return Math.max(0, Math.min(anchored, limit));
  }

  // One frame of easing toward the target. Returns the next scroll position and
  // whether the animation is finished, so the caller owns no easing state.
  function easeStep(current, target, options) {
    const cfg = Object.assign({}, DEFAULTS, options || {});
    const remaining = target - current;
    if (Math.abs(remaining) < cfg.settleWithin) return { value: target, done: true };
    return { value: current + remaining * cfg.ease, done: false };
  }

  // Which words changed state between two cursor positions, so the renderer can
  // touch only those elements. Re-deriving every word's class on every update is
  // O(script) per frame, which on a long script is tens of thousands of DOM
  // writes to move a highlight one word.
  //
  // Walking the gap is what makes a jump (click, arrow key, recognition
  // correction) correct in both directions: forward marks the words passed over
  // as read, backward un-marks them.
  function diffPaint(prev, next, wordCount) {
    const clampIndex = (i) => Math.max(-1, Math.min(i, wordCount - 1));
    const from = clampIndex(prev);
    const to = clampIndex(next);
    const result = { clearAt: from >= 0 && from !== to ? from : null, setAt: to >= 0 ? to : null, addSpoken: [], removeSpoken: [] };

    if (to > from) {
      for (let i = Math.max(0, from); i < to; i++) result.addSpoken.push(i);
    } else if (to < from) {
      for (let i = Math.max(0, to); i <= from; i++) result.removeSpoken.push(i);
    }
    return result;
  }

  // Maps a word index to the line containing it, tolerating out-of-range input
  // so a lead that runs past the end of the script lands on the last line
  // instead of returning undefined.
  function lineOfWord(wordLineIndex, index, fallbackLine) {
    if (!wordLineIndex || !wordLineIndex.length) return fallbackLine || 0;
    const clamped = Math.max(0, Math.min(index, wordLineIndex.length - 1));
    const line = wordLineIndex[clamped];
    return line === undefined ? (fallbackLine || 0) : line;
  }

  return { DEFAULTS, createPacer, leadWords, scrollTargetFor, easeStep, diffPaint, lineOfWord };
}));
