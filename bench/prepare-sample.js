// Turns a recording into a corpus sample the benchmark can read.
//
//   node bench/prepare-sample.js ~/Desktop/A-normal.m4a A-normal
//
// Converts the audio to the headerless 16 kHz mono PCM the helper expects, and
// copies the matching script beside it with any bracketed stage directions
// stripped — those tell the reader what to do and are not meant to be spoken, so
// the benchmark must not expect them in the transcript.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const [input, nameArg] = process.argv.slice(2);
const CORPUS = path.join(__dirname, 'corpus');
const SCRIPTS = path.join(CORPUS, 'scripts');

if (!input) {
  console.error(`
Usage: node bench/prepare-sample.js <recording> [name]

  <recording>  any audio file macOS can read (.m4a, .wav, .aiff, .mp3)
  [name]       corpus sample name; defaults to the recording's filename

The name should match a script in bench/corpus/scripts/ so the script can be
paired automatically — for example "A-normal", or "A-normal-cafe" which still
resolves to A-normal.txt.

Available scripts:
${fs.existsSync(SCRIPTS) ? fs.readdirSync(SCRIPTS).filter((f) => f.endsWith('.txt')).map((f) => '  ' + f.replace(/\.txt$/, '')).join('\n') : '  (none)'}
`);
  process.exit(1);
}

if (!fs.existsSync(input)) {
  console.error(`No such file: ${input}`);
  process.exit(1);
}

const name = (nameArg || path.basename(input).replace(/\.[^.]+$/, '')).replace(/[^\w.-]/g, '-');
fs.mkdirSync(CORPUS, { recursive: true });

// Find the script this recording corresponds to: exact match first, then the
// longest script name that prefixes it, so "A-normal-cafe" finds "A-normal".
function findScript() {
  if (!fs.existsSync(SCRIPTS)) return null;
  const available = fs.readdirSync(SCRIPTS).filter((f) => f.endsWith('.txt')).map((f) => f.replace(/\.txt$/, ''));
  if (available.includes(name)) return name;
  const matches = available.filter((s) => name.startsWith(s)).sort((a, b) => b.length - a.length);
  return matches[0] || null;
}

// Stage directions are instructions to the reader, not words to be spoken.
function stripDirections(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*\(/.test(line))
    .join('\n')
    .replace(/\([^)]*\)/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n';
}

const wav = path.join(require('os').tmpdir(), `notchprompt-${name}-${Date.now()}.wav`);
const pcmOut = path.join(CORPUS, `${name}.pcm`);
const txtOut = path.join(CORPUS, `${name}.txt`);

try {
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', input, wav], { stdio: 'pipe' });
} catch (err) {
  console.error(`Could not convert ${input}.`);
  console.error((err.stderr || '').toString().trim() || err.message);
  process.exit(1);
}

// A canonical WAV header is 44 bytes, but afconvert may emit extra chunks, so
// the data chunk is located rather than assumed.
const wavBuffer = fs.readFileSync(wav);
let dataOffset = wavBuffer.indexOf(Buffer.from('data', 'ascii'), 12);
dataOffset = dataOffset === -1 ? 44 : dataOffset + 8;
fs.writeFileSync(pcmOut, wavBuffer.subarray(dataOffset));
fs.unlinkSync(wav);

const seconds = (fs.statSync(pcmOut).size / 2 / 16000);

const script = findScript();
if (script) {
  fs.writeFileSync(txtOut, stripDirections(fs.readFileSync(path.join(SCRIPTS, `${script}.txt`), 'utf8')));
  console.log(`\n  audio   ${path.relative(process.cwd(), pcmOut)}  (${seconds.toFixed(1)}s)`);
  console.log(`  script  ${path.relative(process.cwd(), txtOut)}  (from ${script}.txt)`);
  console.log(`\nMeasure it:\n  node bench/track-accuracy.js bench/corpus/\n`);
} else {
  console.log(`\n  audio   ${path.relative(process.cwd(), pcmOut)}  (${seconds.toFixed(1)}s)`);
  console.log(`\n  No script named "${name}" in bench/corpus/scripts/.`);
  console.log(`  Write the text you read to: ${path.relative(process.cwd(), txtOut)}`);
  console.log(`  then run: node bench/track-accuracy.js bench/corpus/\n`);
}
