# Benchmarks

Two harnesses, both of which print what their numbers do and do not mean.
Neither is run in CI: one needs a built Swift helper and real-time audio, the
other is a model whose output invites interpretation rather than a pass/fail.

```bash
npm run build:native          # the accuracy harness needs the helper
node bench/track-accuracy.js  # matcher accuracy on synthetic speech
node bench/lead-sweep.js      # how lead values compare against measured latency
```

## `track-accuracy.js`

Feeds audio through the real on-device recogniser at real-time pace and grades
the matcher against the transcript.

Ground truth is deliberately the **transcript**, not the audio. For each thing
the recogniser reported, an unwindowed search over the whole script finds the
best position that text could correspond to, and the live tracker's incremental
answer is compared against it. So this measures *given what was heard, did the
matcher land in the right place* — it says nothing about recognition quality, and
nothing about how the result feels to read from.

| Column | Meaning |
|---|---|
| `within2` | share of updates landing within 2 words of the transcript-implied position |
| `mean` / `max` | average and worst distance from that position, in words |
| `falseF` | times the cursor was more than 3 words *ahead* of what the words justify — the failure that skips a line |
| `back` | times the cursor moved backward. Should always be 0 |
| `recov` | mean updates taken to get back within 3 words after diverging |
| `end` | whether tracking reached the end of the script |

Exit code is non-zero if the cursor ever moved backward or a case failed to
reach the end, so it is usable as a manual gate.

### The bundled cases are synthetic

With no argument, the harness generates its audio with macOS `say`: one voice,
even pace, clean signal, no accent, perfect enunciation. That is the easiest
input a recogniser can be given. The numbers are good for catching regressions
and worthless as a claim about real-world accuracy.

### Adding real recordings

```bash
mkdir -p bench/corpus
# record, then convert to what the helper expects: 16 kHz mono Int16 PCM
afconvert -f WAVE -d LEI16@16000 -c 1 my-take.m4a my-take.wav
tail -c +45 my-take.wav > bench/corpus/my-take.pcm   # strip the 44-byte header
# the script you were reading, as plain text
cp my-script.txt bench/corpus/my-take.txt

node bench/track-accuracy.js bench/corpus/
```

`corpus/` is gitignored — recordings of your voice are yours, and are not
something this repository should carry.

Worth covering, because each one stresses a different part of the matcher:

- normal conversational delivery
- deliberately fast, and deliberately slow
- long pauses mid-sentence
- a sentence read twice
- self-corrections ("we raised five — sorry, six million")
- filler words
- skipping a line entirely
- proper nouns and technical terms
- numbers and ordinals read aloud
- contractions where the script spells them out
- a script with repeated sentence structure
- background noise, and a poor microphone

## `lead-sweep.js`

Compares `leadSeconds` values against the latency they exist to compensate for.

This is a **model, not a user study**. It simulates a reader moving at a steady
pace, delays recognition by the measured latency, and reports how far the aimed
scroll position lands from where the reader actually is.

That is a real question. It is not the question that settles the value, because
"does this feel comfortable to read from" depends on eye movement, line length,
font size and preference. A setting that minimises average distance can still
feel wrong if it spends its time ahead of the reader.

The current default errs behind the reader on purpose: text arriving slightly
late is a smaller problem than the page scrolling past the line being read.

Options:

```bash
node bench/lead-sweep.js --latency 0.8 --pace 2.6
```

To change the default, edit `DEFAULTS` in `renderer/view-model.js`.
