# Recording the demo

The demo has one job: someone who has never heard of this watches for ten
seconds and thinks *"oh — it follows what you're saying."*

Not how it works. Not that it is on-device. Not the architecture. Just that.

Everything else on the page can explain itself. The demo only has to make the
idea land.

---

## Before you record

```bash
NOTCHPROMPT_NO_PROTECT=1 npm start
```

The env var matters: with capture-hiding on, the window is deliberately excluded
from screen recordings and **your demo will come out empty**. This is by design
and it will catch you out otherwise.

Then:

- **Font size up** (`⌘⇧↑` a few times). It will be viewed small, in a README, on
  a phone. Bigger than feels right in person.
- **Resize the window taller** so three or four lines are visible. One line shows
  nothing moving; ten lines makes the text too small to read.
- **Quiet room, decent mic.** Recognition errors in the demo read as "this is
  broken", even though recovering from them is a feature.
- **Tidy desktop behind it.** The window is translucent — whatever is behind it
  is in the shot.

Use a script with **short, distinct lines**. Long paragraphs wrap and the
movement becomes hard to see.

Suggested demo script — deliberately written so each line is visibly different
and the highlight is easy to follow:

```
Welcome to Teleprompt Notch.
This teleprompter listens while you read.
It follows your voice, not a timer.
Slow down, or speed up. It keeps pace.
Everything runs on your Mac.
```

---

## The shot list

Ten to twenty seconds total. One continuous take is better than cuts.

| # | Shot | Roughly | What the viewer should notice |
|---|---|---|---|
| 1 | App on screen, script visible, not yet started | 1–2 s | A small window under the menu bar, sitting over the desktop |
| 2 | Press Listen; the mic dot turns green | 1 s | It is now listening |
| 3 | Start reading aloud | 2–3 s | The highlight moves **with your voice** — the whole point |
| 4 | Keep reading through a line break | 2–3 s | The view scrolls smoothly, showing what is coming |
| 5 | **Stop mid-sentence.** Hold the pause | 2 s | The display holds. It does not run away without you |
| 6 | Resume from where you stopped | 2–3 s | It picks you up again immediately |
| 7 | Re-read a line you already read | 2 s | It does **not** jump backward or lurch |

Shots 5–7 are what separate this from a timer-based scroller. If you have to cut
for length, cut 1 and 4, never 5–7.

---

## Capturing

Built into macOS, no extra software:

```
⌘⇧5 → Record Selected Portion → drag a box around the window → Record
```

Record a little wider than the window so the rounded corners and the desktop
behind are visible — it reads as a real app rather than a screenshot of text.

**Record without audio.** The GIF will be silent, and a muted video of someone
talking is confusing. If you want a video with sound, record it separately as an
`.mp4`.

---

## Converting to a GIF

```bash
# trim to the good part, scale for a README, and keep the file small
ffmpeg -i ~/Desktop/recording.mov -ss 0 -t 15 \
  -vf "fps=12,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" \
  -loop 0 docs/demo.gif
```

- `fps=12` — smooth enough for text, half the size of 24
- `scale=720` — sharp on a README, still under a couple of megabytes
- `-ss` / `-t` — trim; dead air at the start is the most common mistake

Check the size. **Over about 5 MB and GitHub will be slow to load it** — drop to
`fps=10` or `scale=640`.

An `.mp4` is smaller and higher quality but does not autoplay in a README.
A GIF is the right trade for the top of the page.

---

## Putting it in the README

Replace the placeholder note under the title with:

```markdown
![Teleprompt Notch following a script as it is read aloud](docs/demo.gif)
```

Write real alt text. It is what a screen reader announces, and what shows if the
image fails to load.

---

## What not to do

- **Do not stage a fake.** No mocked-up scrolling, no video edited to look more
  accurate than it is. If the recognition mangles a word, leave it — recovering
  is the interesting part.
- **Do not speed it up.** The pacing *is* the product.
- **Do not add captions explaining the architecture.** That is what the README is
  for.
- **Do not record with content protection on**, or you will get a very confusing
  empty rectangle.
