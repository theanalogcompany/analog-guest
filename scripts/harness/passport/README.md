# Passport check

Behavioural checks for passport stamps (TAC-586): which stamp a purchase gets, where it lands
on the page, and whether it draws the same twice. No database, no network, no model.

Run it when you change anything under `lib/passport/`, `lib/passport/assets/`, or the
`sharp` / `@resvg/resvg-js` versions.

## Run it

From the repo root, on Node 24:

```bash
npm run passport-check
```

It prints one `ok` or `FAIL` line per check and exits non-zero if any failed. Renders are
written to `$TMPDIR/passport-check/`.

`npm run passport-check -- --write-goldens` re-records `golden/*.png`. Do that only when a
change to how stamps look is intended, and look at the new images before keeping them.

## What it checks

- **(a) The decision.** Every branch of `decideStamp`. It also prints what a Square line
  item with a variation (`"Oat Milk Cortado"` / `"Large"`) prints as and matches as.
- **(b) The layout.** The same seed always places the same way. No slot is used twice across
  60 guests × 13 stamps. Every tilt is within ±8°. Pages roll over at 6 and 12.
- **(c) The renders.**
  - Each kind and one 6-stamp spread are rendered twice and must match **exactly**. This is
    the acceptance criterion: a stored stamp re-draws pixel-identically.
  - Each is also compared with its golden, with a small tolerance (max channel delta ≤ 2 on
    ≤ 0.1% of pixels), because the goldens were recorded on macOS and a Linux libvips may
    round differently.
  - **The control arm:** the same stamp with a different seed must *fail* its golden. If it
    passes, the comparison proves nothing.
  - It also checks that the bundled fonts' cap heights are the ones the layout was measured
    against, that resvg draws Oswald 600 and 500 differently, and that no font has ★ (which
    is why the star is drawn as a polygon).
- **(d) The reference.** The twelve stamps of Figma `167:1632` ("Passport / pages 01–02 · 6
  per page") are re-drawn into templates A and B with no jitter, and written beside
  `reference-167-1632.png`. **Judged by eye; nothing can fail it.** It is the only check the
  measured slot positions in `lib/passport/templates.ts` have.

## What it cannot show

- Anything that needs the database or Instagram: the claim, the upload, the send, the retry,
  the echo check, `sent_at`. Those are covered by reading the code and by the device UAT on
  the ticket.
- That the renderer runs on Vercel. The `/admin/health` "Passport renderer" row renders
  twice on the deployed function and says so.
