// Compares lead values against the latency they exist to compensate for.
//
// READ THIS BEFORE QUOTING ANY NUMBER BELOW.
//
// This is a model, not a user study. It simulates a reader moving through a
// script at a steady pace, delays recognition by the latency measured on this
// machine, and asks how far the scroll's aimed position ends up from where the
// reader actually is. That is a real question with a real answer, and it is the
// question the lead parameter was introduced to address.
//
// It is not the question that decides the setting. "Does the page move in a way
// that is comfortable to read from" depends on eye movement, line length, font
// size and personal preference, and no simulation here can answer it. The values
// in renderer/view-model.js remain unvalidated by a human until a human reads
// from the app and says so.
//
//   node bench/lead-sweep.js
//   node bench/lead-sweep.js --latency 0.8 --pace 2.6

const VM = require('../renderer/view-model');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
}

// Measured on this machine with bench/latency (see docs/engineering-notes.md):
// a word is reported a median of ~0.8s after it is spoken.
const LATENCY = arg('latency', 0.8);
// Comfortable read-aloud pace is roughly 130-170 words per minute.
const PACE = arg('pace', 2.6);
const DURATION = 40;      // seconds of simulated reading
const TICK = 0.05;        // simulation resolution

function simulate(leadSeconds) {
  const pacer = VM.createPacer();
  let lastConfirmed = -1;
  const errors = [];
  let overshoots = 0;
  let aimHistory = [];

  for (let t = 0; t < DURATION; t += TICK) {
    const trueWord = t * PACE;                       // where the reader is now
    const heardWord = Math.floor((t - LATENCY) * PACE); // what recognition can know
    if (heardWord > lastConfirmed && heardWord >= 0) {
      lastConfirmed = heardWord;
      pacer.record(t * 1000, heardWord);
    }
    if (lastConfirmed < 0) continue;

    const lead = VM.leadWords(pacer.pace(), { leadSeconds, maxLeadWords: 12 });
    const aimed = lastConfirmed + lead;
    errors.push(aimed - trueWord);
    if (aimed - trueWord > 1) overshoots++;
    aimHistory.push(aimed);
  }

  const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
  const absMean = errors.reduce((a, b) => a + Math.abs(b), 0) / errors.length;
  // How jumpy the aim is: mean absolute change between consecutive frames.
  let jitter = 0;
  for (let i = 1; i < aimHistory.length; i++) jitter += Math.abs(aimHistory[i] - aimHistory[i - 1]);
  jitter /= Math.max(1, aimHistory.length - 1);

  return {
    leadSeconds,
    signedError: mean,        // negative = behind the reader
    absError: absMean,        // how far off, either way
    overshootShare: overshoots / errors.length,
    jitter
  };
}

console.log(`
Lead sweep — A MODEL, NOT A USER STUDY.
  recognition latency : ${LATENCY.toFixed(2)}s (measured)
  reading pace        : ${PACE.toFixed(2)} words/sec (assumed)

"behind" is the reader waiting for text to arrive. "ahead" risks scrolling past
them. Neither extreme is what a person wants, and the balance point between them
is a matter of feel that this cannot measure.
`);

console.log(['lead(s)', ' signed', '  |err|', 'overshoot', ' jitter'].join('  '));
console.log('-'.repeat(48));

const results = [];
for (const lead of [0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.2]) {
  const r = simulate(lead);
  results.push(r);
  const marker = lead === VM.DEFAULTS.leadSeconds ? '  <- current default' : '';
  console.log([
    r.leadSeconds.toFixed(2).padStart(7),
    (r.signedError >= 0 ? '+' : '') + r.signedError.toFixed(2).padStart(6),
    r.absError.toFixed(2).padStart(7),
    (r.overshootShare * 100).toFixed(0).padStart(8) + '%',
    r.jitter.toFixed(2).padStart(7)
  ].join('  ') + marker);
}

const best = results.reduce((a, b) => (b.absError < a.absError ? b : a));
console.log('-'.repeat(48));
console.log(`
Smallest average distance from the reader: lead = ${best.leadSeconds.toFixed(2)}s
(|err| ${best.absError.toFixed(2)} words, overshooting ${(best.overshootShare * 100).toFixed(0)}% of the time)

That is the value this model prefers, which is not the same as the value a reader
prefers. A setting that minimises average distance can still feel wrong if it
spends time ahead of the reader. Treat this as a starting point and a guard
against obviously bad values, not as a verdict.

To change the default, edit DEFAULTS in renderer/view-model.js.
`);
