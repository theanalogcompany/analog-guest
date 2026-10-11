# Instagram raw payload capture harness

**Temporary.** Delete this directory with `lib/messaging/instagram/raw-payload-log.ts`, when
the media-messages ticket has the payloads it needs.

Checks for the `INSTAGRAM_LOG_RAW_PAYLOADS` capture: that nothing is produced unless the flag
is exactly `true`, that the line is one line of JSON at full depth, that token- and
signature-shaped values are redacted, and that an attachment's `payload.url` is not.

**Run by hand. Not in CI, not an npm script, not a test suite.** Run it when you change
`lib/messaging/instagram/raw-payload-log.ts`.

## Run it

From the repo root, on Node 24:

```bash
npx tsx scripts/harness/instagram-raw-payload/harness.ts
```

It prints one `PASS` or `FAIL` line per check and exits non-zero if any failed. No model
calls, no network, no database.

## What it does not cover

The route itself. `app/api/webhooks/instagram/route.ts` calls `instagramRawPayloadLine` once,
after the signature has verified and the body has parsed, and logs the result when it is not
null. The gate lives inside that function so that both flag states are checked here; the
call site is three lines and is read, not run.
