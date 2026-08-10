# Licensing and provenance

Teleprompt Notch is **MIT** (see [`LICENSE`](../LICENSE)). This file exists
because that was not always cleanly true, and a public repository should be able
to show its work.

## What happened

The project began by studying [Cue](https://github.com/Blueturboguy07/cue), an
Electron overlay app, to understand how it captured audio and hid its window from
screen recordings. Two files were copied from it during the first build:

- `src/vad.js` — energy-based voice activity detection
- `renderer/audio-worklet-processor.js` — Float32 → Int16 audio conversion

**Cue is GPL-3.0-or-later, and is written by other people** — its commit history
lists eight contributors, none of whom are the author of this project. Shipping
their code under an MIT licence would have been a real licence violation, not a
technicality, and it was caught before the repository was made public.

## What was done about it

Both files were **rewritten as independent implementations** rather than
relabelled. Same problems, solved again:

**`src/vad.js`** — still energy against an adaptive noise floor with hysteresis,
because that is simply how energy-based VAD works. Restructured as a single state
with two run-length counters instead of a three-state machine, and stripped of an
audio ring buffer that nothing in this codebase had called since the streaming STT
providers were removed. 142 lines to 65.

**`renderer/audio-worklet-processor.js`** — still converts microphone samples off
the main thread. Converts per sample into a pre-sized `Int16Array` rather than
buffering `Float32` and converting the batch at flush time, and clamps before
conversion, which the original did not.

Both were verified working against real speech through the actual app before the
change was committed, not merely compiled.

## Current state

Measured overlap with Cue across every file that shares a filename:

| File | Non-trivial lines in common | What they are |
|---|---|---|
| `main.js` | 42 | Electron boilerplate: `app.whenReady()`, `contextIsolation: true`, `frame: false`, BrowserWindow option keys |
| `preload.js` | 6 | `contextBridge` / `ipcRenderer` usage |
| `renderer/renderer.js` | 18 | DOM idioms and `getUserMedia` options |
| `src/store.js` | 10 | `JSON.parse` / `writeFileSync` around a settings object |
| `src/vad.js` | 4 | Loop scaffolding |
| `renderer/audio-worklet-processor.js` | 3 | `registerProcessor`, class declaration |

These are the canonical ways to call the relevant APIs — the shapes Electron's own
documentation uses. They are API usage, not copied expression, and there is no
practical alternative phrasing for `contextIsolation: true`.

Reproduce the comparison with the two shell blocks in this repository's history,
or by diffing against a Cue checkout directly.

## Third-party code shipped

**None.** The application has zero runtime dependencies — asserted by a test that
fails the build if `dependencies` in `package.json` is ever non-empty.

The only third-party code involved at runtime is **Electron itself** (MIT) and the
macOS system frameworks the Swift helper links against (`Speech`, `AVFoundation`),
which are used through their public APIs under Apple's normal terms.

Build-time tooling (`electron-builder` and its tree) is MIT/ISC/BSD/Apache-2.0 and
is not distributed in the app bundle.

## Assets

No icons, fonts, images, sounds or other assets are vendored. The app uses the
system font stack and Electron's default icon. Nothing here requires attribution.

## If you reuse this

MIT: do what you like, keep the copyright notice. The parts most likely to be
worth taking are `src/script-tracker.js` (the matcher) and
`native/Transcriber.swift` (a minimal `SpeechAnalyzer` wrapper that talks
newline-delimited JSON over a pipe) — both are self-contained.

If you want the *approach* rather than the code, [the engineering
notes](engineering-notes.md) explain why it is built this way, including the parts
that did not work.
