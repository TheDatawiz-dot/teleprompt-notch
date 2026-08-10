// Measures how well the matcher follows a transcript.
//
// What this does and does not claim. Ground truth here is the transcript, not
// the audio: for each thing the recogniser reported, an unwindowed search over
// the whole script finds the best place that text could correspond to, and the
// live tracker's incremental answer is compared against it. So this measures the
// matcher — given what was heard, did it land in the right place — and says
// nothing about how good the recognition was, or how the result feels to read.
//
// Corpus provenance is printed with the results, because a number measured on
// synthesised speech is not a number measured on a person.
//
//   node bench/track-accuracy.js                 # bundled synthetic cases
//   node bench/track-accuracy.js corpus/         # a directory of real recordings
//
// See bench/README.md for how to add recordings.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  createScriptTracker, tokenizeScript, tokenizeSpoken, alignSubsequence
} = require('../src/script-tracker');

const HELPER = path.join(__dirname, '..', 'native', 'build', 'notchprompt-transcriber');

// The position the transcript-so-far best corresponds to, searched over the
// entire script rather than a window around the cursor. This is deliberately the
// expensive, non-incremental answer: it is what the live tracker is graded on.
function oraclePosition(scriptText, spokenText) {
  const { words } = tokenizeScript(scriptText);
  const scriptTokens = [];
  words.forEach((w, wordIndex) => {
    tokenizeSpoken(w.raw).forEach((forms) => scriptTokens.push({ forms, wordIndex }));
  });
  const probe = tokenizeSpoken(spokenText).slice(-8);
  if (!probe.length || !scriptTokens.length) return null;
  const { score, lastIndex } = alignSubsequence(scriptTokens.map((t) => t.forms), probe);
  if (score <= 0 || lastIndex < 0) return null;
  return scriptTokens[Math.min(lastIndex, scriptTokens.length - 1)].wordIndex;
}

function evaluate(scriptText, updates) {
  const tracker = createScriptTracker(scriptText);
  const totalWords = tracker.totalWords;

  let spokenSoFar = '';
  let previousWord = 0;
  const divergences = [];
  let backwardJumps = 0;
  let falseForward = 0;
  let stalls = 0;
  let recoveries = [];
  let diverging = null;

  for (const update of updates) {
    spokenSoFar = (spokenSoFar + ' ' + update.text).trim().split(/\s+/).slice(-60).join(' ');
    const at = update.final
      ? tracker.feedTranscript(update.text)
      : tracker.feedProvisional(update.text);
    const cursor = at ? at.wordIndex : tracker.position().wordIndex;

    if (at && at.wordIndex < previousWord) backwardJumps++;
    if (!at) stalls++;

    const oracle = oraclePosition(scriptText, spokenSoFar);
    if (oracle !== null) {
      const divergence = cursor - oracle;
      divergences.push(Math.abs(divergence));
      // Ahead of where the words justify: the failure mode that skips a line.
      if (divergence > 3) falseForward++;
      if (Math.abs(divergence) > 3) {
        if (diverging === null) diverging = divergences.length;
      } else if (diverging !== null) {
        recoveries.push(divergences.length - diverging);
        diverging = null;
      }
    }
    previousWord = cursor;
  }

  const finished = tracker.position().wordIndex >= Math.floor(totalWords * 0.7);
  const mean = divergences.length
    ? divergences.reduce((a, b) => a + b, 0) / divergences.length : NaN;
  return {
    updates: updates.length,
    totalWords,
    reachedEnd: finished,
    finalWord: tracker.position().wordIndex,
    meanDivergence: mean,
    maxDivergence: divergences.length ? Math.max(...divergences) : NaN,
    withinTwoWords: divergences.length
      ? divergences.filter((d) => d <= 2).length / divergences.length : NaN,
    falseForwardJumps: falseForward,
    backwardJumps,
    stalls,
    meanRecoveryUpdates: recoveries.length
      ? recoveries.reduce((a, b) => a + b, 0) / recoveries.length : 0
  };
}

// Feeds a PCM file through the real helper at real-time pace and collects what
// it reports. Requires the helper to be built.
function transcribe(pcmPath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(HELPER)) return reject(new Error('helper not built — run: npm run build:native'));
    const child = spawn(HELPER, ['en-US']);
    const updates = [];
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.type === 'interim') updates.push({ text: m.text, final: false });
        if (m.type === 'final') updates.push({ text: m.text, final: true });
      }
    });
    child.on('error', reject);

    const pcm = fs.readFileSync(pcmPath);
    let off = 0;
    const timer = setInterval(() => {
      if (off >= pcm.length) {
        clearInterval(timer);
        setTimeout(() => child.stdin.end(), 400);
        return;
      }
      child.stdin.write(pcm.subarray(off, off + 3200)); // 100ms of 16kHz mono
      off += 3200;
    }, 100);
    child.stdin.on('error', () => {});
    child.on('exit', () => resolve(updates));
  });
}

// The cases this repository can generate on any Mac, so the harness runs without
// a corpus. Synthetic: one TTS voice, even pace, clean audio, no accent. Useful
// for catching regressions, useless for judging real-world accuracy.
const SYNTHETIC = [
  {
    name: 'plain prose',
    script: 'Welcome to the show today.\nWe are going to talk about the future of AI.\nFirst let us cover the basics.',
    speak: 'Welcome to the show today. We are going to talk about the future of A I. First let us cover the basics.'
  },
  {
    name: 'repeated sentence structure',
    script: 'The first topic is speed.\nThe second topic is accuracy.\nThe third topic is cost.',
    speak: 'The first topic is speed. The second topic is accuracy. The third topic is cost.'
  },
  {
    name: 'proper nouns and jargon',
    script: 'Our Kubernetes cluster runs Grafana and Postgres.\nAnirudh manages the Terraform modules.',
    speak: 'Our Kubernetes cluster runs Grafana and Postgres. Anirudh manages the Terraform modules.'
  },
  {
    name: 'numbers and ordinals',
    script: 'We raised 5 million dollars.\nThat is the 1st milestone of 3.',
    speak: 'We raised five million dollars. That is the first milestone of three.'
  },
  {
    name: 'contractions',
    script: "Let us begin with what we are building.\nIt is not finished yet.",
    speak: "Let's begin with what we're building. It's not finished yet."
  },
  {
    name: 'paragraph breaks',
    script: 'First paragraph here.\n\nSecond paragraph follows.\n\nThird and last.',
    speak: 'First paragraph here. Second paragraph follows. Third and last.'
  }
];

function synthesise(text, outPcm) {
  const { execFileSync } = require('child_process');
  const aiff = outPcm.replace(/\.pcm$/, '.aiff');
  const wav = outPcm.replace(/\.pcm$/, '.wav');
  execFileSync('say', ['-r', '170', '-o', aiff, text]);
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav]);
  const data = fs.readFileSync(wav);
  fs.writeFileSync(outPcm, data.subarray(44)); // strip the WAV header
}

function row(label, r) {
  const pct = (v) => (Number.isNaN(v) ? '   n/a' : (v * 100).toFixed(0).padStart(5) + '%');
  const num = (v, d = 1) => (Number.isNaN(v) ? ' n/a' : v.toFixed(d).padStart(5));
  return [
    label.padEnd(30),
    pct(r.withinTwoWords),
    num(r.meanDivergence),
    num(r.maxDivergence, 0),
    String(r.falseForwardJumps).padStart(6),
    String(r.backwardJumps).padStart(5),
    num(r.meanRecoveryUpdates),
    r.reachedEnd ? '  yes' : '   NO'
  ].join('  ');
}

async function main() {
  const corpus = process.argv[2];
  const cases = [];

  if (corpus) {
    // Real recordings: <name>.pcm (16kHz mono Int16) beside <name>.txt
    const files = fs.readdirSync(corpus).filter((f) => f.endsWith('.pcm'));
    for (const f of files) {
      const scriptFile = path.join(corpus, f.replace(/\.pcm$/, '.txt'));
      if (!fs.existsSync(scriptFile)) {
        console.error(`skipping ${f}: no matching .txt script`);
        continue;
      }
      cases.push({ name: f.replace(/\.pcm$/, ''), pcm: path.join(corpus, f), script: fs.readFileSync(scriptFile, 'utf8') });
    }
    console.log(`\nCorpus: ${corpus} — REAL RECORDINGS (${cases.length} case(s))\n`);
  } else {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'notchprompt-bench-'));
    for (const c of SYNTHETIC) {
      const pcm = path.join(tmp, c.name.replace(/\W+/g, '-') + '.pcm');
      synthesise(c.speak, pcm);
      cases.push({ name: c.name, pcm, script: c.script });
    }
    console.log('\nCorpus: SYNTHETIC (macOS `say`, one voice, even pace, clean audio).');
    console.log('These numbers detect regressions. They do NOT represent real speech —');
    console.log('for that, record yourself and pass a corpus directory. See bench/README.md.\n');
  }

  console.log([
    'case'.padEnd(30), 'within2', ' mean', '  max', 'falseF', ' back', ' recov', ' end'
  ].join('  '));
  console.log('-'.repeat(96));

  const all = [];
  for (const c of cases) {
    const updates = await transcribe(c.pcm);
    const r = evaluate(c.script, updates);
    all.push(r);
    console.log(row(c.name, r));
  }

  console.log('-'.repeat(96));
  console.log('within2 = updates landing within 2 words of the transcript-implied position');
  console.log('falseF  = cursor more than 3 words ahead of what the words justify');
  console.log('back    = cursor moved backward (should always be 0)');
  console.log('recov   = mean updates taken to get back within 3 words after diverging');

  const anyBackward = all.some((r) => r.backwardJumps > 0);
  const allFinished = all.every((r) => r.reachedEnd);
  console.log(`\n${anyBackward ? 'FAIL: the cursor moved backward' : 'OK: the cursor never moved backward'}`);
  console.log(`${allFinished ? 'OK: every case tracked to the end' : 'FAIL: a case did not reach the end'}\n`);
  process.exitCode = anyBackward || !allFinished ? 1 : 0;
}

if (require.main === module) main().catch((err) => { console.error(err.message); process.exit(1); });
module.exports = { evaluate, oraclePosition };
