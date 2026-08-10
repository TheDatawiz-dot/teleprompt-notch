# Teleprompt Notch

**A private, on-device macOS teleprompter that follows your voice.**

![platform: macOS 26+](https://img.shields.io/badge/platform-macOS%2026%2B-black)
![transcription: on-device](https://img.shields.io/badge/transcription-on--device-brightgreen)
![no API key](https://img.shields.io/badge/API%20key-none-blue)
![no network](https://img.shields.io/badge/network-blocked-informational)
![license: MIT](https://img.shields.io/badge/license-MIT-lightgrey)

Paste a script, start reading out loud, and the text keeps pace with you. Slow
down, speed up, stumble over a sentence — it stays with you. No preset scroll
speed to guess at.

It sits in a small window just under the menu bar, stays on top of whatever else
you are doing, and can hide itself from screen recordings.

> **Demo:** not recorded yet. It needs a quiet screen and a real voice, and a
> staged one would misrepresent how this behaves. The shot list is written up in
> [docs/demo.md](docs/demo.md).

## Download

**[Download the latest .dmg →](https://github.com/TheDatawiz-dot/teleprompt-notch/releases/latest)**

Open it, drag the app to Applications, done. No terminal, no account, no API key.

**Requires macOS 26 (Tahoe) or later, on Apple Silicon.** The on-device speech API
this is built on does not exist before macOS 26, and the build is `arm64` only —
no Intel Mac can run macOS 26 anyway.

<details>
<summary><b>First launch: macOS will say the developer cannot be verified</b></summary>

The app is **not signed or notarised** — that needs a paid Apple Developer
account. So the first launch takes one extra step:

1. **Right-click** (or Control-click) the app → **Open**
2. Click **Open** in the dialog

Once only. After that it opens normally. If you would rather not run unsigned
software, build it yourself — see [Development](#development).
</details>

### Permissions

It asks for **the microphone**, once, the first time you press Listen. That is the
only permission it requests — no Screen Recording, no Accessibility, no Full Disk
Access, and no speech-recognition permission.

## Privacy

Your voice never leaves your Mac, and the app makes no network requests at all.
Enforced, not just promised:

| Guarantee | How |
|---|---|
| No network requests | Refused at the Electron session unless the app is loading its own files; CSP sets `connect-src 'none'` |
| Cannot acquire networking later | Zero runtime dependencies, asserted by a test that fails the build |
| No network permission | The hardened-runtime entitlements omit `network.client` |
| Recognition never reaches a server | The helper requires on-device recognition and refuses to start rather than fall back |
| No telemetry or analytics | Asserted by a test that greps shipped source |
| Audio is never written to disk | Microphone → local helper over a pipe, and nowhere else |

Your script is saved locally so it is there next launch, in
`~/Library/Application Support/`, written owner-only.

## Features

- **Follows your speech** word by word, instead of scrolling on a timer
- **Transcription on your Mac** — no API key, no account, no sign-up
- **Stays on top** of whatever else you are doing
- **Hides from screen recordings** on a keystroke, with an indicator so you always
  know whether it is hidden
- **Tolerant of real reading** — contractions, numbers read aloud, mispronounced
  proper nouns, repeated lines, paragraph breaks
- **Works without the microphone too** — constant-speed auto-scroll, arrow keys,
  or click any line to jump

## How it works

You read; the app listens and matches.

1. The microphone is captured in the app and converted to 16 kHz mono audio.
2. A small Swift helper transcribes it locally using macOS's `SpeechAnalyzer`.
3. Each transcript update is aligned against your script to find your position.
4. The current word is highlighted and the view scrolls to keep upcoming text in
   view.

The matching is the interesting part, because a transcript never matches a script
exactly. It handles:

- **Repeated structure.** "The first topic is speed… the second topic is
  accuracy…" — naive matching latches onto the wrong repetition and skips ahead.
  Local alignment with a gap penalty means a match only wins if the words around
  it line up too.
- **Words spelled differently than they sound.** Your script says *Kubernetes*;
  the transcript says *Cubanets*. Matching falls back to what words *sound* like.
- **The same thing written two ways.** `let's`/`let us`, `5`/`five`,
  `1st`/`first`, `recognise`/`recognize`.
- **Re-reading and stumbles.** Repeat a line and the position holds rather than
  jumping backwards.

Recognition is inherently about **0.8 seconds behind** you — measured, and not
something any app can tune away. So the highlight marks the last word actually
recognised, while the scroll aims slightly *ahead* of it at your measured reading
pace. That way the text you are about to read is what fills the window, instead of
the text you just finished.

Full detail, including the approaches that failed: **[docs/engineering-notes.md](docs/engineering-notes.md)**.

## Shortcuts

| Keys | Action |
|---|---|
| `⌘⇧N` | show / hide the window |
| `⌘⇧L` | start / stop listening |
| `⌘⇧P` | toggle hiding from screen capture |
| `⌘⇧↑` / `⌘⇧↓` | font size |
| `↑` / `↓` | step one line (while reading) |
| `Esc` | back to the editor |

If another app already owns one of these, the app says so on launch rather than
leaving you with a key that quietly does nothing.


## Limitations

Honest ones.

- **macOS 26+ only.** `SpeechAnalyzer` does not exist before it. This excludes
  every Intel Mac. It is the project's biggest constraint.
- **Unsigned.** Gatekeeper will warn on first launch. Needs a paid Apple
  Developer account to fix.
- **No human has validated the feel.** The tracking is measured; whether the
  motion is comfortable to read from is not, and the scroll-lead values are
  reasoned defaults rather than tested ones. See `bench/README.md`.
- **Accuracy numbers are from synthesised speech.** The bundled benchmark uses
  macOS `say`: one voice, even pace, clean audio. Real speech is harder. The
  harness accepts real recordings; none are included.
- **It matches words, not meaning.** Paraphrase heavily and it loses you. Built
  for reading prepared text, not improvising.
- **Apple Silicon build only.** Intel Macs cannot run macOS 26 anyway.
- **One script at a time.** No library, no playlists.
- **English only** as configured, though the underlying API supports more.

## Development

```bash
git clone https://github.com/TheDatawiz-dot/teleprompt-notch.git
cd teleprompt-notch
npm install        # also compiles the Swift speech helper
npm start
```

Needs the Xcode Command Line Tools for the helper. Without them `npm install`
still succeeds — it skips the helper with a message, and the app runs with manual
scrolling only.

```bash
npm start                      # run in development
NOTCHPROMPT_NO_PROTECT=1 npm start   # make the window visible to screen recording
npm run build:native           # rebuild just the Swift helper
npm run dist                   # produce .dmg and .zip in dist/
npm run verify:artifact        # inspect the built .app
```

### Layout

```
main.js                     Electron main: window, shortcuts, IPC, audio routing
preload.js                  The IPC surface exposed to the page (allowlisted)
src/script-tracker.js       The matcher: alignment, phonetics, normalisation
src/stt-local.js            Drives the Swift helper, parses its output
src/window-position.js      Where the window opens, across displays
src/network-guard.js        Refuses outbound requests
src/store.js                Settings persistence
src/vad.js                  Energy-based speech detection (drives the mic dot)
renderer/view-model.js      Display decisions as pure functions
renderer/renderer.js        DOM binding for the above
native/Transcriber.swift    On-device transcription via SpeechAnalyzer
bench/                      Accuracy and lead-tuning harnesses
```

## Testing

```bash
npm test        # 122 tests; also runs the import/dependency check
```

Covers the matcher, the display logic, settings persistence, the helper process
lifecycle, window placement across displays, and the privacy guarantees.

Much of the suite is regressions for bugs that actually happened — LCS tunnelling
through repeated sentence structure, navigation deadlocking on blank lines,
interim transcripts poisoning the match history, a settings file injecting keys, a
window stranded off screen after undocking.

Benchmarks are separate and not run in CI, since one needs real-time audio and the
other is a model:

```bash
node bench/track-accuracy.js   # matcher accuracy against the transcript
node bench/lead-sweep.js       # scroll-lead values vs measured latency
```

See **[bench/README.md](bench/README.md)** for what those numbers mean, and
**[bench/corpus/README.md](bench/corpus/README.md)** to record your own samples.

### The measurement that is still missing

Everything above measures whether the cursor lands on the right word. None of it
measures whether reading from this feels good, which is the question that decides
whether the product is any use. [`docs/human-test.md`](docs/human-test.md) is a
ten-minute protocol for answering it, and it is currently unanswered.

## Documentation

| | |
|---|---|
| [Engineering notes](docs/engineering-notes.md) | How the matcher works, and the experiments that disproved their own hypotheses |
| [Human test protocol](docs/human-test.md) | Ten minutes to answer what benchmarks cannot |
| [Benchmarks](bench/README.md) | What the numbers mean |
| [Recording a corpus](bench/corpus/README.md) | Turning your voice into measurable data |
| [Demo shot list](docs/demo.md) | How to record the demo |
| [Licensing and provenance](docs/licensing.md) | Including a GPL conflict found and resolved |
| [Changelog](CHANGELOG.md) | What changed in v0.2.0 |

## License

MIT
