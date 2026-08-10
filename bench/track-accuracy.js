// Measures how well the matcher follows a reader, and — when it does not — says
// which of several distinct things went wrong.
//
// What this measures. Ground truth is the transcript, not the audio: for each
// thing the recogniser reported, an unwindowed search over the whole script
// finds the best position that text could correspond to, and the live tracker's
// incremental answer is compared against it. So this grades the matcher — given
// what was heard, did it land in the right place — and says nothing about
// recognition quality, and nothing about whether reading from it feels good.
//
// Deliberately not reduced to one score. "91% aligned" and "2 false forward
// jumps" are different facts with different fixes, and averaging them together
// destroys the only information worth having.
//
//   node bench/track-accuracy.js                  # bundled synthetic cases
//   node bench/track-accuracy.js bench/corpus/    # your own recordings
//   node bench/track-accuracy.js bench/corpus/ --lead 1.0
//
// See bench/corpus/README.md to record a corpus.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const {
  createScriptTracker, tokenizeScript, tokenizeSpoken, alignSubsequence, normalizeWord
} = require('../src/script-tracker');

const HELPER = path.join(__dirname, '..', 'native', 'build', 'notchprompt-transcriber');

// A cursor within this many words of the transcript-implied position is doing
// its job; the display is showing the right part of the script.
const ALIGNED_WORDS = 2;
// Beyond this, the reader has probably noticed.
const DIVERGED_WORDS = 3;

// ---------------------------------------------------------------- oracle ----

// Where the transcript-so-far best lands, searched over the whole script rather
// than a window around the cursor. Deliberately the expensive, non-incremental
// answer: it is what the live tracker is graded against.
function makeOracle(scriptText) {
  const { words } = tokenizeScript(scriptText);
  const tokens = [];
  words.forEach((w, wordIndex) => {
    tokenizeSpoken(w.raw).forEach((forms) => tokens.push({ forms, wordIndex }));
  });
  const forms = tokens.map((t) => t.forms);
  return function oracle(spokenText) {
    const probe = tokenizeSpoken(spokenText).slice(-8);
    if (!probe.length || !forms.length) return null;
    const { score, lastIndex } = alignSubsequence(forms, probe);
    if (score <= 0 || lastIndex < 0) return null;
    return tokens[Math.min(lastIndex, tokens.length - 1)].wordIndex;
  };
}

// Lines whose opening words repeat elsewhere in the script — "The first topic
// is…", "The second topic is…". These are where the matcher is most likely to
// land on the wrong copy, so confusions among them are counted separately.
function templateLines(scriptText) {
  const lines = scriptText.split('\n');
  const openings = new Map();
  lines.forEach((line, i) => {
    const norm = (line.match(/\S+/g) || []).map(normalizeWord).filter(Boolean);
    if (norm.length < 3) return;
    const key = norm.slice(0, 2).join(' ');
    if (!openings.has(key)) openings.set(key, []);
    openings.get(key).push(i);
  });
  const repeated = new Set();
  for (const group of openings.values()) {
    if (group.length > 1) group.forEach((i) => repeated.add(i));
  }
  return repeated;
}

function lineOfWord(scriptText) {
  const { words } = tokenizeScript(scriptText);
  return (wordIndex) => {
    const w = words[Math.max(0, Math.min(wordIndex, words.length - 1))];
    return w ? w.lineIndex : 0;
  };
}

// Word indices that immediately follow a blank line, so a stall there can be
// attributed to paragraph handling rather than to matching in general.
function paragraphEntryWords(scriptText) {
  const { lines, words } = tokenizeScript(scriptText);
  const blankAfter = new Set();
  lines.forEach((line, i) => { if (!line.trim()) blankAfter.add(i); });
  const entries = new Set();
  let seenLine = -1;
  words.forEach((w, index) => {
    if (w.lineIndex !== seenLine) {
      seenLine = w.lineIndex;
      if (blankAfter.has(w.lineIndex - 1)) entries.add(index);
    }
  });
  return entries;
}

// -------------------------------------------------------------- evaluate ----

// `updates` is [{ text, final, t }] with `t` in seconds from the start of audio.
function evaluate(scriptText, updates, audioSeconds) {
  const tracker = createScriptTracker(scriptText);
  const oracle = makeOracle(scriptText);
  const templates = templateLines(scriptText);
  const lineOf = lineOfWord(scriptText);
  const paragraphEntries = paragraphEntryWords(scriptText);

  let spoken = '';
  let previousWord = 0;

  // Divergence sampled over time, then integrated on a fixed grid below.
  //
  // Attributing time per update does not work: several updates routinely carry
  // the same timestamp, so the interval between them is zero and whatever the
  // display was doing during them counts for nothing. That produced the absurd
  // reading of 100% aligned alongside four false forward jumps.
  const timeline = [];
  const divergences = [];
  let signedWorst = 0;
  let falseForward = 0;
  let backwardJumps = 0;
  let stalls = 0;
  let paragraphStalls = 0;
  let templateConfusions = 0;
  const recoveries = [];
  let divergingSince = null;
  let stalledSince = null;

  for (const u of updates) {
    spoken = (spoken + ' ' + u.text).trim().split(/\s+/).slice(-60).join(' ');
    const at = u.final ? tracker.feedTranscript(u.text) : tracker.feedProvisional(u.text);
    const cursor = at ? at.wordIndex : tracker.position().wordIndex;

    if (at && at.wordIndex < previousWord) backwardJumps++;

    const truth = oracle(spoken);
    if (truth === null) {
      timeline.push({ t: u.t, divergence: null });
    } else {
      const divergence = cursor - truth; // + ahead of the reader, - behind
      timeline.push({ t: u.t, divergence });
      divergences.push(Math.abs(divergence));
      if (Math.abs(divergence) > Math.abs(signedWorst)) signedWorst = divergence;

      if (divergence > DIVERGED_WORDS) {
        falseForward++;
        // Landing on a different repetition of a repeated opening is a distinct
        // failure from simply running ahead.
        if (templates.has(lineOf(cursor)) && lineOf(cursor) !== lineOf(truth)) templateConfusions++;
      }

      if (Math.abs(divergence) > DIVERGED_WORDS) {
        if (divergingSince === null) divergingSince = u.t;
      } else if (divergingSince !== null) {
        recoveries.push(u.t - divergingSince);
        divergingSince = null;
      }

      // A stall is the display standing still while the reader moves on.
      const readerMoved = truth - previousWord > DIVERGED_WORDS;
      if (!at && readerMoved) {
        if (stalledSince === null) stalledSince = u.t;
      } else if (stalledSince !== null) {
        if (u.t - stalledSince > 1.0) {
          stalls++;
          if (paragraphEntries.has(truth) || paragraphEntries.has(cursor + 1)) paragraphStalls++;
        }
        stalledSince = null;
      }
    }

    previousWord = cursor;
  }

  // Integrate the timeline on a fixed grid across the whole recording, so each
  // moment of the reading counts once regardless of how many updates landed in
  // it. Anything before the first result is unscored rather than assumed good.
  // Turning the timeline into shares.
  //
  // Two earlier attempts got this wrong and are worth recording. Taking the
  // interval between consecutive updates gives zero weight to everything in a
  // group sharing a timestamp, which reported 100% aligned alongside four false
  // forward jumps. Sampling on a fixed grid instead hid brief excursions between
  // sample points and reported the same impossible thing.
  //
  // Each update now receives an equal share of the interval its timestamp group
  // occupies, so a divergence lasting one update out of five still accounts for a
  // fifth of that interval. Scoring begins at the first recognition result:
  // before that there is nothing to compare against, and counting startup
  // latency as a failure would bury the real numbers.
  const firstScored = timeline.findIndex((p) => p.divergence !== null);
  const startAt = firstScored >= 0 ? timeline[firstScored].t : 0;
  const endAt = audioSeconds || (timeline.length ? timeline[timeline.length - 1].t : 0);
  const time = { aligned: 0, ahead: 0, behind: 0, unknown: 0 };

  const scored = firstScored >= 0 ? timeline.slice(firstScored) : [];
  for (let i = 0; i < scored.length;) {
    // All updates carrying this timestamp.
    let j = i;
    while (j + 1 < scored.length && scored[j + 1].t === scored[i].t) j++;
    const nextT = j + 1 < scored.length ? scored[j + 1].t : endAt;
    const interval = Math.max(0, nextT - scored[i].t);
    const each = interval / (j - i + 1);
    for (let k = i; k <= j; k++) {
      const d = scored[k].divergence;
      if (d === null) time.unknown += each;
      else if (Math.abs(d) <= ALIGNED_WORDS) time.aligned += each;
      else if (d > 0) time.ahead += each;
      else time.behind += each;
    }
    i = j + 1;
  }

  // A short clip can have every result arrive after the audio finished, leaving
  // no interval to divide up. Rather than report nothing, fall back to counting
  // each update equally — less precise, but it still says what happened.
  let totalTime = time.aligned + time.ahead + time.behind + time.unknown;
  if (totalTime === 0 && scored.length) {
    const each = 1 / scored.length;
    for (const p of scored) {
      const d = p.divergence;
      if (d === null) time.unknown += each;
      else if (Math.abs(d) <= ALIGNED_WORDS) time.aligned += each;
      else if (d > 0) time.ahead += each;
      else time.behind += each;
    }
    totalTime = 1;
  }
  const share = (v) => (totalTime > 0 ? v / totalTime : NaN);
  const sorted = recoveries.slice().sort((a, b) => a - b);

  return {
    totalWords: tracker.totalWords,
    finalWord: tracker.position().wordIndex,
    reachedEnd: tracker.position().wordIndex >= Math.floor(tracker.totalWords * 0.7),
    updates: updates.length,
    duration: totalTime,
    leadInSeconds: startAt,
    alignedShare: share(time.aligned),
    aheadShare: share(time.ahead),
    behindShare: share(time.behind),
    unknownShare: share(time.unknown),
    meanDivergence: divergences.length ? divergences.reduce((a, b) => a + b, 0) / divergences.length : NaN,
    worstDivergence: signedWorst,
    falseForward,
    backwardJumps,
    stalls,
    paragraphStalls,
    templateConfusions,
    medianRecovery: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
    worstRecovery: sorted.length ? sorted[sorted.length - 1] : null
  };
}

// ------------------------------------------------------------- transcribe ----

function transcribe(pcmPath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(HELPER)) {
      return reject(new Error('speech helper not built — run: npm run build:native'));
    }
    const child = spawn(HELPER, ['en-US']);
    const updates = [];
    let buf = '';
    let audioSeconds = 0;

    child.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        // Timestamped against audio played so far, so metrics are in the
        // reader's time rather than in wall-clock or update count.
        if (m.type === 'interim') updates.push({ text: m.text, final: false, t: audioSeconds });
        if (m.type === 'final') updates.push({ text: m.text, final: true, t: audioSeconds });
      }
    });
    child.on('error', reject);

    const pcm = fs.readFileSync(pcmPath);
    let off = 0;
    const CHUNK = 3200; // 100ms of 16kHz mono Int16
    const timer = setInterval(() => {
      if (off >= pcm.length) {
        clearInterval(timer);
        setTimeout(() => { try { child.stdin.end(); } catch {} }, 400);
        return;
      }
      child.stdin.write(pcm.subarray(off, off + CHUNK));
      off += CHUNK;
      audioSeconds = off / 2 / 16000;
    }, 100);
    child.stdin.on('error', () => {});
    child.on('exit', () => resolve({ updates, audioSeconds: pcm.length / 2 / 16000 }));
  });
}

// --------------------------------------------------------------- corpora ----

// Generated on any Mac so the harness runs without a corpus. Synthetic: one TTS
// voice, even pace, clean audio, no accent. Good for catching regressions,
// worthless as a claim about real speech.
const SYNTHETIC = [
  { name: 'normal prose',
    script: 'Welcome to the show today.\nWe are going to talk about the future of AI.\nFirst let us cover the basics.',
    speak: 'Welcome to the show today. We are going to talk about the future of A I. First let us cover the basics.' },
  { name: 'repeated structure',
    script: 'The first topic is speed.\nThe second topic is accuracy.\nThe third topic is cost.',
    speak: 'The first topic is speed. The second topic is accuracy. The third topic is cost.' },
  { name: 'names and jargon',
    script: 'Our Kubernetes cluster runs Grafana and Postgres.\nAnirudh manages the Terraform modules.',
    speak: 'Our Kubernetes cluster runs Grafana and Postgres. Anirudh manages the Terraform modules.' },
  { name: 'numbers and ordinals',
    script: 'We raised 5 million dollars.\nThat is the 1st milestone of 3.',
    speak: 'We raised five million dollars. That is the first milestone of three.' },
  { name: 'contractions',
    script: 'Let us begin with what we are building.\nIt is not finished yet.',
    speak: "Let's begin with what we're building. It's not finished yet." },
  { name: 'paragraph breaks',
    script: 'First paragraph here.\n\nSecond paragraph follows.\n\nThird and last.',
    speak: 'First paragraph here. Second paragraph follows. Third and last.' }
];

function synthesise(text, outPcm) {
  const aiff = outPcm.replace(/\.pcm$/, '.aiff');
  const wav = outPcm.replace(/\.pcm$/, '.wav');
  execFileSync('say', ['-r', '170', '-o', aiff, text]);
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav]);
  fs.writeFileSync(outPcm, fs.readFileSync(wav).subarray(44));
}

// ----------------------------------------------------------------- output ----

const pct = (v) => (Number.isNaN(v) ? '  n/a' : (v * 100).toFixed(1).padStart(5) + '%');
const secs = (v) => (v === null ? '  n/a' : v.toFixed(1) + 's');

function report(name, r) {
  const signed = (r.worstDivergence >= 0 ? '+' : '') + r.worstDivergence;
  console.log(`\n${name}  (${r.duration.toFixed(0)}s, ${r.totalWords} words, ${r.updates} updates)`);
  console.log('  Overall');
  console.log(`    aligned          ${pct(r.alignedShare)}     within ${ALIGNED_WORDS} words of where the words say you are`);
  console.log(`    behind           ${pct(r.behindShare)}     display trailing the reader`);
  console.log(`    ahead            ${pct(r.aheadShare)}     display in front of the reader`);
  if (r.unknownShare > 0.01) {
    console.log(`    unscored         ${pct(r.unknownShare)}     nothing recognised yet to compare against`);
  }
  console.log('  Faults');
  console.log(`    false forward jumps  ${String(r.falseForward).padStart(3)}   cursor ran ahead of the evidence`);
  console.log(`    backward jumps       ${String(r.backwardJumps).padStart(3)}   must always be zero`);
  console.log(`    stalls               ${String(r.stalls).padStart(3)}   speech advanced, display did not`);
  console.log(`    paragraph stalls     ${String(r.paragraphStalls).padStart(3)}   stalled at a blank-line boundary`);
  console.log(`    template confusions  ${String(r.templateConfusions).padStart(3)}   landed on the wrong repetition`);
  console.log('  Divergence');
  console.log(`    mean             ${Number.isNaN(r.meanDivergence) ? ' n/a' : r.meanDivergence.toFixed(1)} words`);
  console.log(`    worst            ${signed} words   (+ ahead, - behind)`);
  console.log('  Recovery');
  console.log(`    median           ${secs(r.medianRecovery)}`);
  console.log(`    worst            ${secs(r.worstRecovery)}`);
  console.log(`  Reached end of script: ${r.reachedEnd ? 'yes' : 'NO'} (word ${r.finalWord} of ${r.totalWords})`);
  console.log(`  Scoring began ${r.leadInSeconds.toFixed(1)}s in, once recognition produced its first result.`);
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const corpus = args[0];
  const cases = [];

  if (corpus) {
    if (!fs.existsSync(corpus)) { console.error(`No such directory: ${corpus}`); process.exit(1); }
    for (const f of fs.readdirSync(corpus).filter((f) => f.endsWith('.pcm')).sort()) {
      const scriptFile = path.join(corpus, f.replace(/\.pcm$/, '.txt'));
      if (!fs.existsSync(scriptFile)) {
        console.error(`skipping ${f}: no matching .txt`);
        continue;
      }
      cases.push({ name: f.replace(/\.pcm$/, ''), pcm: path.join(corpus, f), script: fs.readFileSync(scriptFile, 'utf8') });
    }
    if (!cases.length) {
      console.error(`\nNo samples in ${corpus}.\nRecord one: see bench/corpus/README.md\n`);
      process.exit(1);
    }
    console.log(`\n=== REAL RECORDINGS — ${cases.length} sample(s) from ${corpus} ===`);
  } else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notchprompt-bench-'));
    for (const c of SYNTHETIC) {
      const pcm = path.join(tmp, c.name.replace(/\W+/g, '-') + '.pcm');
      synthesise(c.speak, pcm);
      cases.push({ name: c.name, pcm, script: c.script });
    }
    console.log('\n=== SYNTHETIC SPEECH (macOS `say`) ===');
    console.log('One voice, even pace, clean audio, no accent — the easiest possible');
    console.log('input. These numbers catch regressions. They are NOT evidence about');
    console.log('real speech. To measure that, record yourself: bench/corpus/README.md');
  }

  const results = [];
  for (const c of cases) {
    const { updates, audioSeconds } = await transcribe(c.pcm);
    const r = evaluate(c.script, updates, audioSeconds);
    results.push({ name: c.name, r });
    report(c.name, r);
  }

  console.log('\n' + '='.repeat(66));
  console.log('Summary');
  console.log('  case                        aligned   behind    ahead unscored  faults');
  for (const { name, r } of results) {
    const faults = r.falseForward + r.backwardJumps + r.stalls;
    console.log(`  ${name.padEnd(26)} ${pct(r.alignedShare)}  ${pct(r.behindShare)}  ${pct(r.aheadShare)}  ${pct(r.unknownShare)}  ${String(faults).padStart(6)}`);
  }

  const anyBackward = results.some(({ r }) => r.backwardJumps > 0);
  const allFinished = results.every(({ r }) => r.reachedEnd);
  console.log('');
  console.log(anyBackward ? '  FAIL  the cursor moved backward' : '  OK    the cursor never moved backward');
  console.log(allFinished ? '  OK    every case tracked to the end' : '  FAIL  a case did not reach the end');
  console.log('');
  console.log('  Reminder: none of this measures whether reading from it feels good.');
  console.log('  That is docs/human-test.md, and it is still unanswered.');
  console.log('');
  process.exitCode = anyBackward || !allFinished ? 1 : 0;
}

if (require.main === module) main().catch((err) => { console.error('\n' + err.message + '\n'); process.exit(1); });
module.exports = { evaluate, makeOracle, templateLines, paragraphEntryWords };
