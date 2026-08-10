# Engineering notes

How the interesting parts of Teleprompt Notch work, and why several obvious
approaches were tried and abandoned. The failed experiments are kept here
deliberately: they are the part with information in them.

Every number below was measured on the machine noted with it. Nothing here is
estimated or rounded up to sound better.

---

## The problem

The user pastes a script. They read it aloud. The app has to know which word they
are on, from a transcript that arrives late, incomplete, and sometimes wrong.

That is harder than it sounds, and the reasons are worth walking through.

## Why substring matching fails

The first instinct is to search for the transcript inside the script. It fails
immediately, for reasons that are not edge cases but the normal condition:

- The recogniser writes `let's` where the script says `let us`, `5` where the
  script says `five`, `Cubanets` where the script says `Kubernetes`. An exact
  substring is almost never present.
- Interim results are revised. The text you searched for a moment ago no longer
  exists.
- Readers stumble, repeat themselves, and skip words. The spoken sequence is not
  a contiguous slice of the written one.

## Why longest common subsequence fails

LCS handles insertions and deletions, which fixes the stumbles. It was the second
implementation, and it broke on something scripts do constantly: repeat their own
structure.

```
The first topic is speed.
The second topic is accuracy.
The third topic is cost.
```

Reading the first line, LCS matches `the`, `topic`, `is` — and is perfectly happy
to collect those matches from the *third* line, because subsequence matching does
not care how far apart the matched elements are. The cursor jumped several lines
ahead on the first sentence.

The fix is not a threshold. It is that distance has to cost something.

## Smith-Waterman with a gap penalty

Local alignment scores a match and *subtracts* for each unmatched token skipped
on either side. A cluster of matches close together beats the same number of
matches spread across the script, which is exactly the property LCS lacked.

```js
const diag = similarity(script[i-1], probe[j-1]) > 0 ? dp[i-1][j-1] + gain : 0;
const up   = dp[i-1][j] - GAP_PENALTY;   // a script word not yet spoken
const left = dp[i][j-1] - GAP_PENALTY;   // a spoken word not in the script
dp[i][j] = Math.max(0, diag, up, left);
```

Three details matter as much as the algorithm:

- **The window.** Alignment runs over ~24 tokens ahead of the cursor and 4
  behind, not the whole script. This bounds the cost, and more importantly bounds
  the damage: a spurious match 200 words away is not merely unlikely, it is
  unreachable.
- **The 4-token tolerance backward.** Enough to re-match a false start, not
  enough to let the cursor walk backward through a repeated phrase.
- **Never moving backward.** `if (newCursor <= cursor) return null`. A reader who
  repeats a line they already delivered should not drag the display back with
  them.

Confirmed by test: the repeated-topics script now advances one line at a time.

## Making words match when the spelling does not

Three layers, in order of how much they are trusted.

**Exact, after normalisation.** Lowercased, punctuation stripped. Numbers and
ordinals carry both forms, so `5`/`five` and `1st`/`first` are one token. This
is worth full score.

**Contractions, by expanding both sides.** `let's` becomes two tokens, `let` and
`us`, so it matches a script that spells it out — and the reverse. Only
unambiguous expansions are listed: `he's` could be *he is* or *he has*, and
guessing wrong is worse than not guessing. Because one written word can now be
two spoken tokens, matching runs over a token list that maps back to display
words rather than over the words themselves.

**Phonetics, at a discount.** This is the layer that matters most in practice,
and it came from reading actual failures:

| script | recogniser wrote | phonetic key |
|---|---|---|
| Kubernetes | Cubanets | `KBRNTS` / `KBNTS` |
| Postgres | postcards | `PSTKRS` / `PSTKRTS` |
| Zylphra Kandrix | Zilfra Kendricks | identical |
| recognise | recognize | identical |

Every one is far apart as spelling and nearly identical as sound. A
Metaphone-style key recovers them.

### What that risks, and what it was measured against

Phonetic keys are lossy, so they can fuse words that merely sound alike. Guards:
a key must be at least 3 characters to match exactly and 4 to match within an
edit distance of 1, and a phonetic hit scores *below* the threshold needed to
move the cursor — so it takes two pieces of evidence, never one.

Measured across 200,000 random pairs drawn from the 174,000-word system
dictionary: **0.057%** would match phonetically.

**That number is measured on the wrong distribution, and should not be trusted
too far.** Random dictionary pairs are not recogniser errors. Real errors are
phonetically adjacent by construction — they are exactly the population most
likely to collide. The true false-positive rate under real use is higher and
currently unmeasured. `bench/track-accuracy.js` is where that would be measured
against real recordings.

## Interim transcripts

The recogniser revises its guess continuously. Using only finalised text makes
the display lurch forward at every pause; using interim text naively is worse.

The first version folded every interim into the match history, so twenty drafts
of the same phrase stacked into the probe and dragged the cursor forward through
text nobody had said. Interim results now move the cursor but are **not**
committed to history; the matching final confirms the position. Since the cursor
only ever moves forward, a provisional guess that turns out to be premature costs
nothing.

## The latency investigation

Scrolling felt laggy. Three plausible causes were measured, and all three were
wrong.

| Hypothesis | Measurement | Verdict |
|---|---|---|
| The matcher is too slow | 0.028 ms per update, 0.6% of one core | Not the cause |
| Too many updates per second | ~2 position updates/sec | Not the cause |
| The audio buffer is too large | 256 ms → 64 ms changed latency by 0.05 s | Not the cause |

The actual cause: **a word is reported a median of 0.77 s after it is spoken**
(28 samples, audio fed at real-time pace, macOS 26.6, M-series). That is
transcription latency. Nothing in this app can tune it away.

Two real rendering faults turned up alongside it, both since fixed:

- Smooth scrolling was declared twice — CSS `scroll-behavior: smooth` *and*
  `scrollIntoView({behavior:'smooth'})`. Every line change abandoned the
  animation in flight and began another. Restarting an animation mid-flight is
  precisely what reads as stutter. There is now one eased loop that retargets
  without restarting.
- Painting ran synchronously on each message, repeating work several times
  between frames and displaying none of it. It is coalesced into one animation
  frame.

### Leading instead of chasing

Given ~0.8 s of irreducible delay, centring the *confirmed* word means
permanently showing the reader where they have already been.

So the highlight and the scroll were separated. The highlight stays honest — it
marks the last word actually recognised. The scroll aims slightly ahead of it, by
the reader's measured pace, and anchors that point above the middle of the window
so the text still to be read is what fills the view.

`bench/lead-sweep.js` models this. Against 0.8 s latency and a 2.6 words/sec
reader, `leadSeconds ≈ 1.0–1.2` minimises the distance between the aimed position
and the reader; at the current 0.6 the scroll sits ~0.6 words behind them.

**The default stays at 0.6 anyway.** The model optimises average distance and is
indifferent to which side of the reader the error falls on. A reader is not: text
arriving slightly late is a far smaller problem than the page scrolling past the
line they are reading. And no human has yet read from this app and reported how it
feels, which is the only test that settles it.

## Bugs worth recording

| Bug | Symptom | Cause |
|---|---|---|
| LCS tunnelling | Repeated sentence templates jumped several lines ahead | Subsequence matching ignores distance |
| Blank-line deadlock | Arrow keys and auto-scroll froze permanently at any paragraph break | Stepping to a wordless line left the cursor pinned, so the next step recomputed the same unreachable target forever |
| Interim poisoning | Repeated drafts of one phrase dragged the cursor forward | Interim text was committed to match history |
| Phantom imports | Would have crashed with `MODULE_NOT_FOUND` | Dead code inherited with a copied file required packages this project does not depend on |
| Settings key injection | A settings file containing a string got `"0"`, `"1"`, `"2"` as settings | Spreading a non-object's keys |
| Stranded window | Undocking left the window hanging past the screen edge, visible by its corner | A position remembered on an external display was clamped against the built-in one |
| Full repaint per update | Tens of thousands of DOM writes per second on a long script | Every word's classes re-derived on each update instead of the ones that changed |

The blank-line deadlock is the one worth dwelling on: it made the app's manual
fallback completely unusable on any script with paragraphs, and it survived
because nothing tested navigation. It is why the renderer logic was extracted
into `renderer/view-model.js` and covered.

## The window position mystery

The window appeared at different coordinates across screenshots, which looked
like nondeterminism. It was not.

Electron reports the development display as `1470×956` logical at scale 2. The
centred position for a 460 pt window is `(1470-460)/2 = 505`, which is exactly
what the app used every time. Meanwhile `system_profiler` reports the panel's
native `2560×1664` — a different number for the same screen — and screenshots are
normalised to a fixed image width, so identical windows landed on different
pixels.

Deterministic all along. The tests in `test/window-position.test.js` record this
so it is not re-investigated.

## The notch

There is nothing to detect, which is the honest finding.

macOS already excludes the menu bar from a display's `workArea`, and on a notched
Mac the menu bar *is* the strip the camera housing occupies. Opening just below
`workArea.y` therefore sits directly under the notch on machines that have one and
directly under the menu bar on machines that do not, with no special casing.

Electron does not expose `NSScreen.safeAreaInsets`, and reaching for it through
the Swift helper would buy nothing here: the window is far wider than the notch,
so it never competes with it for space.

## Speech recognition: the API that could not work

The first implementation used `SFSpeechRecognizer`, the obvious choice. It failed
with a flat "permission denied" and **no prompt** — the Speech Recognition pane in
System Settings stayed empty, because an app only appears there once it has
successfully requested access.

Four fixes were tried and all failed identically:

1. Embedding an `Info.plist` with `NSSpeechRecognitionUsageDescription` into the
   helper binary
2. Removing the helper's `CFBundleIdentifier` so attribution would fall to the parent
3. Adding the usage description to the host app's `Info.plist`
4. Moving the helper inside the app bundle

Root cause: a spawned command-line helper is not an app bundle macOS can display
a prompt for, so the request is refused before it can register, and the user is
never given the chance to allow it.

`SpeechAnalyzer` (macOS 26) has no such gate. It is on-device by construction and
needs no speech-recognition permission — only the microphone. It also removes a
second problem: `SFSpeechRecognizer` treats on-device recognition as *opt-in*, so
leaving it unset streams audio to Apple's servers. For an app whose premise is not
being observed, that default was unacceptable.

This is why the app requires macOS 26. It is a real cost, honestly the largest
limitation the project has, and it bought a hard privacy guarantee.

## The experiment that failed: contextual biasing

`AnalysisContext.contextualStrings` lets you hand the recogniser terms to expect.
A teleprompter knows exactly what is about to be said, so this looked like the
single biggest accuracy win available.

Measured three times, on three vocabularies, including an invented name where the
effect should have been unmistakable:

| Test | Without biasing | With biasing |
|---|---|---|
| Kubernetes / Grafana / Postgres | `Cubanets`, `postcards` | *byte-identical* |
| Invented name `Zylphra Kandrix` | `Zilfra Kendricks` | *byte-identical* |
| Longer technical sentence | `Kubernet S`, `in postcards` | *byte-identical* |

Zero effect every time, including via the explicit `setContext` path. The likely
explanation is that synthesised speech is clean enough that the model is already
confident and biasing cannot shift it; real noisy speech might behave otherwise.

**The code was removed.** It carried a temp file, argv plumbing and cleanup for an
unproven benefit, and the phonetic fallback already recovers those words — which
is verified by test using the exact transcript above. Complexity that cannot
demonstrate its value does not stay.

## Performance

Measured on macOS 26.6, M-series, with a 60-line script:

| Operation | Cost |
|---|---|
| One matcher update (alignment + phonetics) | 0.028 ms |
| 200 updates on a 4,000-line script | ~26 ms |
| Position updates during speech | ~2 per second |
| Transcript messages during speech | ~6 per second |

The matcher has never been the bottleneck. Repainting was, before it was made
incremental.

## Privacy architecture

The claim is "no audio leaves your Mac, and the app makes no network requests".
Enforced, not asserted:

- **Nothing to send it with.** Zero runtime dependencies. A test fails the build
  if `dependencies` is ever non-empty, or if `fetch`/`XMLHttpRequest`/
  `WebSocket`/`URLSession`/node's `http` appear in shipped source.
- **Blocked at the session.** `src/network-guard.js` refuses every request that is
  not the app loading its own files, and logs any attempt.
- **Blocked at the page.** A CSP with `connect-src 'none'`.
- **Not permitted by the bundle.** The hardened-runtime entitlements deliberately
  omit `network.client`.
- **On-device recognition is a hard requirement, not a preference.** The helper
  refuses to start rather than fall back to server-side recognition.

The one thing that does cross a process boundary is audio, from the renderer to
the local helper over a pipe. It is never written to disk.

## Trade-offs taken

- **macOS 26+ only.** Narrow, and the price of on-device recognition without a
  permission that a helper process cannot obtain.
- **Word matching, not meaning.** Heavy paraphrasing loses the tracker. It is
  built for reading prepared text.
- **Leading errs behind the reader.** Deliberate, per the sweep discussion above.
- **The helper is a separate process, not a native module.** No node-gyp, no
  rebuild-per-Electron-version, and a crash cannot take the app down. The cost is
  process management and a pipe protocol, both tested.
- **Unsigned.** Notarisation needs a paid Apple Developer account. Gatekeeper will
  warn. Documented rather than worked around.
