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

## Works without an API key

Voice tracking needs a speech-to-text provider. Without one, the app is still a
perfectly usable teleprompter:

| Mode | Needs a key | How it moves |
|---|---|---|
| Voice tracking | yes | follows your speech |
| `Auto` | no | constant speed, start/stop |
| `↑` / `↓` | no | one line at a time |
| Click a line | no | jump there |

Add a key via ⚙. [Deepgram](https://console.deepgram.com/) is the better choice
(purpose-built streaming STT, lowest latency, free tier); an OpenAI key also
works.

### Where your key goes

Keys are encrypted with Electron's `safeStorage` — backed by your login Keychain
on macOS — so the settings file on disk holds a ciphertext blob, not a usable
credential, and is written `0600`. Keys stay in the main process and are never
handed to the window that renders your script; the UI is only ever told
*whether* a key is set.

Audio goes to whichever provider you configured, and nowhere else. There is no
server of ours in the loop, no telemetry, and no LLM call anywhere in the app —
position tracking is plain string alignment running locally.

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
npm test     # 20 tests over the alignment and navigation logic
```

The tracker is the part worth testing, and the suite is mostly regressions for
bugs that actually happened: LCS tunnelling through repeated sentence templates,
interim transcripts poisoning the match history, and manual navigation
deadlocking on the blank line between paragraphs.

To see the window in your own screen recordings while working on it:

```bash
NOTCHPROMPT_NO_PROTECT=1 npm start
```

## Limitations

- **macOS-first.** "Under the notch" is a Mac idea. It runs elsewhere and simply
  anchors top-center, but content protection and Mission Control hiding are only
  verified on macOS.
- **Tracking is only as good as the transcription.** Heavy accents, background
  noise, or a bad mic degrade it. The manual modes are always there as a floor.
- **It matches words, not meaning.** Paraphrase the script heavily and it will
  lose you; it is built for reading prepared text, not improvising.
- **One script at a time.** No playlists, no multi-take management.

## License

MIT
