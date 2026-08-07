# NotchPrompt

**A teleprompter that lives under the MacBook notch and follows your voice.**

Paste a script, start reading out loud, and the text tracks where you actually
are — not on a timer you have to guess at ahead of time. Slow down, speed up,
stumble over a sentence, and it stays with you.

```bash
npm install
npm start
```

---

## Why voice-tracked instead of timed?

Every free teleprompter scrolls at a constant speed you set in advance. That is
fine until you pause for a thought, get a word wrong, or simply read faster than
you rehearsed — and then you spend the rest of the take fighting the scroll
instead of talking.

NotchPrompt listens to your microphone, transcribes it, and aligns what you said
against the script to find your position. The text follows you.

It also handles the messy parts of real reading:

- **Repeated structure.** Scripts say things like *"The first topic is speed…
  The second topic is accuracy…"*. Naive matching latches onto the wrong
  repetition and skips ahead several lines. NotchPrompt uses local alignment with
  a gap penalty, so a match only wins if the words *around* it line up too.
- **Re-reading.** If you repeat a line you already delivered, the cursor holds
  position instead of jumping backwards.
- **Filler and misheard words.** "Um", "sorry", and transcription errors cost a
  small penalty rather than breaking the match.
- **Words the recogniser spells its own way.** Your script says *Kubernetes*;
  the transcript says *Cubanets*. Matching falls back to what the words *sound*
  like, so a mangled proper noun still tracks. Measured on a dictionary of
  174,000 words, unrelated pairs collide this way 0.06% of the time, and one
  weak match alone is never enough to move the cursor.
- **The same thing written two ways.** "let's" and "let us", "5" and "five",
  "1st" and "first", "recognise" and "recognize" all count as matches.
- **Continuous tracking.** It follows in-flight (interim) transcripts, not just
  finalized ones, so the script moves while you speak instead of lurching
  forward every time you pause for breath.

## Hidden from screen recordings

The window can exclude itself from screen shares and recordings
(`setContentProtection`), so it does not appear in your own screen capture or in
a call you are sharing. A dot in the title bar always shows whether that is
currently on, so you are never guessing about the state.

NotchPrompt does **not** disguise its process name — it reports itself as
NotchPrompt everywhere macOS shows it. Hiding a window from a *recording* is a
framing choice; lying about what software is running is a different thing, and
this app does not do it.

## Transcription is built in

There is no API key, no account, and no sign-up. Recognition runs on this Mac
through the Speech framework's `SpeechAnalyzer`, in a small Swift helper the
app spawns (`native/Transcriber.swift`). Your audio is never sent anywhere —
not to Apple, not to us. The app makes no network requests at all.

The helper deliberately uses `SpeechAnalyzer` rather than the older
`SFSpeechRecognizer`. Two reasons, both learned the hard way:

- `SFSpeechRecognizer` is gated behind the **Speech Recognition** privacy
  permission, and a spawned command-line helper cannot obtain it — macOS has no
  app bundle to show a prompt for, so the request is denied outright and the
  user is never asked. It never even appears in System Settings to be allowed.
- Its on-device mode is opt-in. Left unset it streams audio to Apple's servers,
  which is what System Settings warns about, and the wrong default for this app.

`SpeechAnalyzer` is on-device by construction and needs no such permission. The
only permission NotchPrompt asks for is the **microphone**.

If it is unavailable — non-macOS, macOS below 26, or the helper was not built —
the app says so and manual scrolling carries on working:

| Mode | How it moves |
|---|---|
| Voice tracking | follows your speech |
| `Auto` | constant speed, start/stop |
| `↑` / `↓` | one line at a time |
| Click a line | jump there |

## Shortcuts

| Keys | Action |
|---|---|
| `⌘⇧N` | show / hide the window |
| `⌘⇧L` | start / stop listening |
| `⌘⇧P` | toggle hiding from screen capture |
| `⌘⇧↑` / `⌘⇧↓` | font size |
| `↑` / `↓` | step one line (while reading) |
| `Esc` | back to the editor |

If another app already owns one of these, NotchPrompt says so on launch instead
of leaving you with a key that quietly does nothing.

## Development

```bash
npm test              # 20 tests over the alignment and navigation logic
npm run build:native  # rebuild just the Swift helper
```

The tracker is the part worth testing, and the suite is mostly regressions for
bugs that actually happened: LCS tunnelling through repeated sentence templates,
interim transcripts poisoning the match history, and manual navigation
deadlocking on the blank line between paragraphs. The phonetic tests use the
actual output the on-device recogniser produced, not invented examples.

The script's vocabulary is also handed to the recogniser as context. On
synthesised speech this changed no output at all — the model is already
confident there — so it is kept as the documented hint it is rather than
advertised as an improvement; the phonetic fallback is what does the work.

To see the window in your own screen recordings while working on it:

```bash
NOTCHPROMPT_NO_PROTECT=1 npm start
```

## Limitations

- **macOS-only for voice.** "Under the notch" is a Mac idea to begin with. The
  window runs elsewhere and anchors top-center, but transcription, content
  protection, and Mission Control hiding are macOS-only.
- **Voice tracking needs macOS 26 or later.** `SpeechAnalyzer` was introduced in
  macOS 26; on anything older the app runs, says voice tracking is unavailable,
  and leaves you the manual modes.
- **The Swift helper needs the Xcode Command Line Tools to build.** `npm install`
  compiles it; without a toolchain the build is skipped with a message rather
  than failing the install.
- **Tracking is only as good as the transcription.** Heavy accents, background
  noise, or a bad mic degrade it. The manual modes are always there as a floor.
- **It matches words, not meaning.** Paraphrase the script heavily and it will
  lose you; it is built for reading prepared text, not improvising.
- **One script at a time.** No playlists, no multi-take management.

## License

MIT
