# Inbound attachments harness

Checks what each webhook turns a guest's attachment into (TAC-582): the kind, the status the
row is written with, that `mediaUrls` is exactly what it was before attachment rows existed,
and which links the re-host step refuses to fetch.

**Run by hand. Not in CI, not an npm script, not a test suite.** Run it when you change
`lib/messaging/attachments/kind.ts`, `lib/messaging/attachments/rehost.ts`, or the attachment
handling in `lib/messaging/instagram/parse-events.ts`.

## Run it

From the repo root, on Node 24:

```bash
npx tsx scripts/harness/inbound-attachments/harness.ts
```

It prints one `PASS` or `FAIL` line per check and exits non-zero if any failed. No model
calls, no network, no database.

## Where the fixtures come from

The image, voice note, sticker/GIF and reel share are the shapes Meta sent on 2026-10-11,
read through the temporary raw-payload log (PR #369) before that log was removed. Every id
and every link signature is replaced.

**The video, story mention and story reply were never captured.** They follow Meta's
documented shapes and their check names start with `documented:`. A real delivery of one of
those is the thing that can still disagree with this file; when one arrives, replace the
fixture with its shape.

## What it does not cover

- The download and the upload. `rehostAttachment` talks to someone else's CDN and to Storage;
  that path is proved by running `npm run rehost-pending-attachments` against real rows.
- The rows themselves. `insertMessageAttachments` is one insert; what this checks is the
  input it is given.
- Signed URLs and the wire shape. Those are checked with `curl` against the Contract on
  TAC-582.
