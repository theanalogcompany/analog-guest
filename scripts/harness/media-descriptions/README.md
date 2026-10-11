# Media descriptions harness

Checks every decision around describing a guest's photo, video or story (TAC-584), with the
model call and the ffmpeg call replaced by stand-ins:

- **what is described and from where**: a photo from our own bucket, a story from a transient
  download that is never stored, and never a Giphy sticker, a voice note, a share or the
  venue's own story;
- **what a failure writes**: nothing when it may not repeat (the model call, a missing
  ffmpeg, a copy still running), a settled "skipped" row when it always will (a type nothing
  can read, a dead story link);
- **the naming rule and the visit rule**, one function each in
  `lib/schemas/attachment-description.ts`;
- **what reaches a prompt**: a description with its brackets, quotes and line breaks removed.

**Run by hand. Not in CI, not an npm script, not a test suite.** Run it when you change
`lib/messaging/attachments/describe.ts`, `frames.ts`, `lib/schemas/attachment-description.ts`,
or anything else a section header in `harness.ts` names.

## Run it

From the repo root, on Node 24:

```bash
env -i PATH="$PATH" HOME="$HOME" npx tsx scripts/harness/media-descriptions/harness.ts
```

`env -i` because it must pass with no credential in the process: that is what shows nothing
in it reaches a database, a model or the network.

It prints one `PASS` or `FAIL` line per check and exits non-zero if any failed.

## What it does not cover

- **Whether the model describes a picture correctly, names the right drink, or leaves people
  out.** That needs real images and real calls: `scripts/measurement/media-describe.ts`, the
  check pre-registered on TAC-584.
- **Whether ffmpeg runs in a deployment.** The pure half of `frames.ts` is checked here (where
  frames are taken, what passes through untouched). That the binary is present and starts is
  the `/admin/health` row, which runs it.
- **Whether Meta's story link can be fetched.** The download goes through the same guards
  re-host uses, and `scripts/harness/inbound-attachments/` checks those; no real story link
  has been fetched by anything in this repo.
