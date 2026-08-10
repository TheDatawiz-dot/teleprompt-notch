# Recording a corpus

Everything the accuracy benchmark needs from you, and nothing else. Recordings
stay on your machine — `bench/corpus/` is gitignored apart from this file and the
scripts.

## The short version

```bash
# 1. record yourself reading one of the scripts (⌘R starts, ⌘. stops)
open -a "QuickTime Player"        # File > New Audio Recording, save as A-normal.m4a

# 2. convert it and pair it with its script, in one step
node bench/prepare-sample.js ~/Desktop/A-normal.m4a A-normal

# 3. measure
node bench/track-accuracy.js bench/corpus/
```

That is the whole loop. `prepare-sample.js` handles the audio format and copies
the matching script for you.

## 1. How to record

Any recorder that produces a file macOS can read works — QuickTime Player is
already installed and is enough:

**File → New Audio Recording → record → save.**

Use the microphone you would actually use in real life. If you would present
with AirPods, record with AirPods. A benchmark run on a perfect studio mic tells
you nothing about your Tuesday.

Do **not** re-record to get a clean take. Stumbles, filler words and mistakes are
the data. A polished read measures nothing that matters.

## 2. What to read

Seven scripts in `scripts/`, each chosen to stress a different weakness. Record
as many as you have patience for — even two is a real improvement on zero.

| # | File | What it stresses | Length |
|---|---|---|---|
| A | `A-normal.txt` | The baseline: ordinary prose at a natural pace | ~2 min |
| B | `B-fast.txt` | Whether tracking keeps up when you rush | ~45 s |
| C | `C-pauses.txt` | Pauses and paragraph breaks — does it drift or hold? | ~1 min |
| D | `D-repetition.txt` | Repeated sentence structure, the known weak case | ~1 min |
| E | `E-numbers.txt` | Digits, percentages, decimals, dates, ordinals, years | ~45 s |
| F | `F-names.txt` | People, places and technical terms the model has not seen | ~45 s |
| G | `G-self-correction.txt` | Saying the wrong thing, correcting, and recovering | ~1 min |

**Start with A and D.** A is the case that has to work; D is the case most likely
to break.

Scripts B, C and G contain bracketed stage directions telling you what to do.
Do not read those aloud — `prepare-sample.js` strips them from the script copy so
the benchmark does not expect them.

## 3. Conditions worth varying

Once the basics are recorded, the interesting runs are the awkward ones:

- **Background noise** — a café, a fan, a room with an echo
- **Distance** — laptop mic at arm's length rather than a headset
- **Your natural register**, not your presenting voice
- **Tired** — genuinely different from a fresh read

Name these so you can tell them apart later: `A-normal-cafe`, `A-normal-laptop-mic`.

## 4. Where recordings go

`prepare-sample.js` puts them in the right place. If you prefer to do it by hand,
the benchmark wants a matched pair:

```
bench/corpus/A-normal.pcm    16 kHz mono signed 16-bit little-endian, headerless
bench/corpus/A-normal.txt    the script you read
```

Manual conversion:

```bash
afconvert -f WAVE -d LEI16@16000 -c 1 input.m4a output.wav
tail -c +45 output.wav > bench/corpus/A-normal.pcm   # strip the 44-byte header
cp bench/corpus/scripts/A-normal.txt bench/corpus/A-normal.txt
```

## 5. Running the benchmark

```bash
npm run build:native                     # once, if you have not already
node bench/track-accuracy.js bench/corpus/
```

With no argument it runs the bundled synthetic cases instead, and says so.
Anything measured on `say` output is a regression check, not evidence about real
speech.

## 6. Reading the output

```
Overall
  aligned            91.4%     within 2 words of where the words say you are
  behind              5.5%     display trailing you
  ahead               3.1%     display in front of you

Faults
  false forward jumps    2     cursor ran ahead of the evidence
  backward jumps         0     must always be zero
  stalls                 1     speech advanced, display did not
  paragraph stalls       0     stalled at a blank-line boundary
  template confusions    0     landed on the wrong repetition of a phrase

Divergence
  mean                 1.1 words
  worst               +8 words  (+ = ahead, - = behind)

Recovery
  median               1.2 s    to get back on track after diverging
  worst                3.4 s
```

What each one means, and what to do about it:

- **aligned** — the headline. Above 90% on normal prose is working; below 80%
  means something is wrong, and the fault counts say what.
- **behind vs ahead** — these are not equivalent. Behind is the safe failure:
  text arrives a little late. Ahead means the display has run past you, which is
  the one that makes you lose your place. A high *ahead* number matters far more
  than the same *behind* number.
- **false forward jumps** — the display skipped to text you had not reached. On a
  repetition script this usually means the matcher latched onto the wrong copy of
  a phrase.
- **backward jumps** — should be structurally impossible. Anything but 0 is a bug;
  please open an issue with the recording.
- **stalls / paragraph stalls** — the display stopped while you kept talking.
  Paragraph stalls specifically point at blank-line handling.
- **template confusions** — landed on a different repetition than the words
  justify. Expect these on script D; they should be rare elsewhere.
- **worst divergence** — a single large number with an otherwise good *aligned*
  score usually means one bad moment, not a systemic problem. The recovery times
  tell you how long that moment lasted.

Exit code is non-zero if the cursor ever moved backward or a case failed to reach
the end of its script.

## 7. And then the part no benchmark can do

None of the above tells you whether reading from it feels good. After recording,
spend five minutes actually using the app and fill in
[`docs/human-test.md`](../../docs/human-test.md). That is the measurement that
decides whether the scroll tuning is right, and it is the one still missing.
