# Human test

The benchmark can tell you the cursor landed on the right word. It cannot tell
you whether reading from this is pleasant. Those are different questions, and the
second one decides whether the product is any good.

Fill this in after actually reading from the app for a few minutes. Copy it, keep
your answers locally or paste them into an issue — whatever is useful. It is not
collected, uploaded, or read by the app.

**Time needed: about 10 minutes.**

---

## Setup

1. Open the app.
2. Paste a script you would genuinely read aloud — two minutes of your own
   writing is far better than the sample text.
3. Press **Start reading**, then **Listen** (or `⌘⇧L`).
4. Read it as you would for real. Do not perform for the test. Stumble if you
   stumble.

Do this **twice**: once straight through, once where you deliberately pause
mid-sentence, repeat a line, and correct yourself.

---

## Session details

```
Date:
Script length (roughly):
Microphone (built-in / headset / AirPods / other):
Room (quiet / some noise / noisy):
leadSeconds value if you changed it (default 0.6):
```

---

## The questions

Answer 1–5 where a scale is given. **3 is neutral.**

**1. Did the text feel ahead of you?**
`1 = never   3 = occasionally   5 = constantly ahead`

> Answer:

**2. Did the text feel behind you?**
`1 = never   3 = occasionally   5 = constantly behind`

> Answer:

*(1 and 2 are the two questions that decide the scroll tuning. If 2 is high, the
lead value should go up. If 1 is high, it should come down. If both are low, it
is right.)*

**3. Did it jump unexpectedly?**
`1 = never   5 = repeatedly`

> Answer:
> Where, if you can remember:

**4. Did you ever lose your place?**
`1 = never   5 = often`

> Answer:
> What were you reading when it happened:

**5. Did you have to consciously follow the scrolling?**
`1 = not at all   5 = constantly managing it`

> Answer:

**6. Did it feel natural enough to read without thinking about it?**
`1 = not at all   5 = completely natural`

> Answer:

*(6 is the real target. Everything else is diagnosis.)*

**7. How distracting were recognition errors?**
`1 = did not notice   5 = ruined it`

> Answer:
> Which words did it get wrong:

**8. How distracting was latency?**
`1 = did not notice   5 = ruined it`

> Answer:

**9. Would you actually use this?**
`Yes / No / Only if _____`

> Answer:

**10. What was the worst moment?**
Be specific. One concrete bad moment is worth more than nine scores.

> Answer:

---

## Optional: comparing lead values

If question 2 (behind) scored 4 or 5, the scroll is trailing you and it is worth
trying a larger lead.

Edit `leadSeconds` in `renderer/view-model.js`:

```js
const DEFAULTS = {
  leadSeconds: 0.6,   // try 1.0
```

Then `npm start` and read the same script again.

`bench/lead-sweep.js` models 1.0–1.2 as minimising the distance to the reader.
The default is 0.6 anyway, because that model does not care which side of you the
error falls on and you do: text arriving slightly late is a much smaller problem
than the page scrolling past the line you are on.

**Your answer to questions 1, 2 and 6 is the evidence that settles this.** Until
someone fills this in, the value is a guess with a rationale, and the README says
so.

---

## What happens with your answers

- **2 high, 1 low** → raise `leadSeconds` toward 1.0
- **1 high** → lower it, or reduce `maxLeadWords`
- **3 or 4 high** → a matching problem, not a scrolling one. Record that script
  into `bench/corpus/` and run `track-accuracy.js`; the fault counts will say
  whether it was a false forward jump or a template confusion
- **5 high but 1 and 2 low** → the tracking is fine and something else is
  distracting: font size, line length, window height, the status line
- **6 scored 4 or 5** → it works. Say so in the README, with the date and who
  tested it
