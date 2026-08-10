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

> **Demo:** a recording is not in the repository yet. It needs a quiet screen and
> a real voice, and a staged one would misrepresent how this behaves. Until then,
> the [How it works](#how-it-works) section describes the behaviour precisely and
> `bench/track-accuracy.js` reports measured numbers you can reproduce.

---

## Features

- **Follows your speech**, word by word, rather than scrolling on a timer
- **Transcription runs on your Mac** — no API key, no account, no sign-up
- **No network access at all**, blocked at the session and by the app's CSP
- **No telemetry**, no analytics, no runtime dependencies whatsoever
- **Hides from screen recordings** on a keystroke, with an indicator so you always
  know whether it is hidden
- **Tolerant of real reading** — contractions, numbers read aloud, mispronounced
  proper nouns, repeated lines, paragraph breaks
- **Works without the microphone too** — constant-speed auto-scroll, arrow keys,
  click any line to jump

## Download

Grab the `.dmg` from [Releases](https://github.com/TheDatawiz-dot/teleprompt-notch/releases),
open it, and drag the app to Applications.

**Requires macOS 26 (Tahoe) or later.** The on-device speech API this is built on
does not exist before that.

### First launch: Gatekeeper

The app is **not signed or notarised** — that needs a paid Apple Developer
account. macOS will therefore refuse to open it on the first attempt.

1. Right-click (or Control-click) the app → **Open**
2. Confirm **Open** in the dialog

You only do this once. If you would rather not run unsigned software, build it
yourself — see [Development](#development).

### Permissions

The app asks for **the microphone**, once, the first time you press Listen. That
is the only permission it requests. It does not ask for Screen Recording, Full
Disk Access, Accessibility, or speech-recognition permission.

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

## Privacy

The claim is that no audio leaves your Mac and the app makes no network requests.
That is enforced rather than promised:

| Guarantee | How it is enforced |
|---|---|
| No network requests | Every request not loading the app's own files is refused at the Electron session; a CSP sets `connect-src 'none'` |
| Cannot gain networking later | Zero runtime dependencies, asserted by a test that fails the build |
| No network permission | The hardened-runtime entitlements deliberately omit `network.client` |
| Recognition never goes to a server | The helper requires on-device recognition and refuses to start rather than fall back |
| No telemetry | Asserted by a test that greps shipped source |
| Audio is never stored | It goes from the microphone to the local helper over a pipe, and nowhere else |

Your script is saved locally, so it is still there next launch — in
`~/Library/Application Support/`, written owner-only.

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

See **[bench/README.md](bench/README.md)** for what those numbers mean and how to
add your own recordings.

## License

MIT
