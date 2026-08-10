# Changelog

## v0.2.0

First release with a downloadable app. Previously the only way to run this was to
clone the repository and have a Swift toolchain installed.

**Requires macOS 26 or later, Apple Silicon.** The app is unsigned; see the
[README](README.md#first-launch-gatekeeper) for the one-time Gatekeeper step.

### Distribution

- Produces a `.dmg` and a `.zip` via `npm run dist`
- The Swift speech helper is packaged into `Contents/Resources` and verified to
  execute from inside the bundle
- `npm run verify:artifact` inspects the built `.app` — helper present,
  executable, native architecture, no leaked `node_modules`, no developer paths,
  and signature state reported honestly
- The packaged app was launched from outside the repository with a stripped
  environment to confirm it does not depend on the source tree, npm, or Xcode

### Testing

- 37 tests to 122
- Renderer display logic extracted to `renderer/view-model.js` as pure functions
  and covered: cursor movement in both directions, paint diffing, reading-pace
  estimation, scroll targeting, easing convergence, retargeting mid-animation
- Settings persistence covered: corrupt files, non-object contents, unwritable
  locations, upgrades, unicode round-trips
- Speech helper lifecycle covered: line framing across chunks, malformed output,
  crash with diagnostics, clean exit, spawn failure, double start
- Window placement covered across displays, docking and undocking
- Privacy guarantees asserted against the source tree

### Fixed

- Settings file containing a string or array had its keys spread onto the
  settings object, producing settings named `"0"`, `"1"`, `"2"`
- A window position remembered on an external display was clamped against the
  built-in display when undocked, leaving the window off screen apart from its
  top-left corner
- A window left overlapping the dock was treated as belonging to a disconnected
  display, discarding the user's chosen position
- Removed an unused Swift constant and an unused exported helper

### Privacy

- Outbound requests are refused at the Electron session unless the app is loading
  its own files
- The renderer carries a CSP with `connect-src 'none'`
- The hardened-runtime entitlements deliberately omit `network.client`
- Tests fail the build if a networking API, a telemetry library, a remote URL, or
  any runtime dependency appears in shipped source

### Removed

- **Contextual biasing.** Measured three times on three vocabularies, including
  an invented personal name, and the transcript was byte-identical with and
  without it every time — including via the explicit `setContext` path. It
  carried a temporary file, argv plumbing and cleanup for a benefit that could
  not be demonstrated. The phonetic fallback already recovers those words, which
  is covered by a test using the exact transcript the recogniser produced.

### Benchmarking

- `bench/track-accuracy.js` grades the matcher against the transcript and reports
  time aligned, behind and ahead, false forward jumps, backward jumps, stalls,
  paragraph stalls, template confusions, divergence and recovery times —
  deliberately not reduced to a single score
- `bench/lead-sweep.js` compares scroll-lead values against measured recognition
  latency
- `bench/prepare-sample.js` converts a recording into a corpus sample
- `bench/corpus/scripts/` contains seven scripts chosen to stress specific
  weaknesses: normal prose, fast speech, pauses, repeated structure, numbers,
  names, and self-correction

### Documentation

- README rewritten around the product; download and privacy near the top
- `docs/engineering-notes.md` — why substring matching and LCS failed, why
  Smith-Waterman, the latency investigation, and the experiments that disproved
  their own hypotheses
- `docs/human-test.md` — a ten-minute protocol for the question benchmarks cannot
  answer
- `docs/demo.md` — shot list for a real demo recording
- `docs/licensing.md` — provenance, and how a GPL conflict was found and resolved

### Continuous integration

- GitHub Actions runs the tests, an import and dependency check, and an unsigned
  package build on every push
- The Swift job reports rather than fails when the runner's SDK predates
  `SpeechAnalyzer`

### Known limitations

- Unsigned; Gatekeeper warns on first launch
- No human has yet validated that the scrolling feels comfortable to read from.
  `leadSeconds` remains a reasoned default, not a tested one
- All accuracy figures are from synthesised speech; no real recordings are bundled
- Apple Silicon only, macOS 26+, English only as configured

## v0.1.0

Initial working version. Voice-tracked scrolling, on-device transcription via
`SpeechAnalyzer`, content protection, and the matcher. Source only — no packaged
build.
