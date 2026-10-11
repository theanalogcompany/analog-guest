# Inbound attachments harness

Checks what each webhook turns a guest's attachment into (TAC-582): the kind, the status the
row is written with, that `mediaUrls` is exactly what it was before attachment rows existed,
and which links the re-host step refuses to fetch.

It also holds the wording and the first-contact rule:

- every line the model reads for an attachment, and every `previewLabel` the operator reads,
  character for character against what was approved on 2026-10-11;
- **photo first, then text, is still first contact** (owner ruling 4), with a control beside
  it that puts the photo where text goes and shows first contact ending;
- a message Meta flags `is_unsupported` is kept as a row, not dropped.

**Run by hand. Not in CI, not an npm script, not a test suite.** Run it when you change
`lib/messaging/attachments/`, `lib/agent/media-history.ts`,
`lib/ai/prompts/attachment-lines.ts`, the history renderers in `lib/ai/prompts/serializers.ts`,
or the attachment handling in `lib/messaging/instagram/parse-events.ts`.

## Run it

From the repo root, on Node 24:

```bash
env -i PATH="$PATH" HOME="$HOME" npx tsx scripts/harness/inbound-attachments/harness.ts
```

`env -i` because it must pass with no credential in the process: that is what shows nothing
in it reaches a database or a model.

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

- **Whether a reply describes media it was only told about.** That is a model's behaviour and
  needs generations; it is the check pre-registered on TAC-582, not something this can see.
- The queries. `loadMediaHistory` and the thread and conversations filters are PostgREST
  strings; they were run against production read-only during the build and are not re-run
  here.

- The download and the upload. `rehostAttachment` talks to someone else's CDN and to Storage;
  that path is proved by running `npm run rehost-pending-attachments` against real rows.
- The rows themselves. `insertMessageAttachments` is one insert; what this checks is the
  input it is given.
- Signed URLs and the wire shape. Those are checked with `curl` against the Contract on
  TAC-582.
