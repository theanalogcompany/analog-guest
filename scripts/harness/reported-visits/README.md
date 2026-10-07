# Reported visits harness

Checks when a visit a guest told us about is stamped: `resolveOccurredAt` in
`lib/agent/extract-reported-order.ts`.

**Run by hand. Not in CI, not an npm script, not a test suite.** Run it when you change
`resolveOccurredAt`, `reportsTodaysScanVisit` or the venue-local time helpers in
`lib/guests/commitment-expiry.ts`.

## Run it

From the repo root:

```bash
env -i PATH="$PATH" HOME="$HOME" npx tsx scripts/harness/reported-visits/harness.ts
```

It prints one `ok` or `FAIL` line per check and exits non-zero if any failed. It makes no
model call and no database call, so the empty environment is a habit here, not a safeguard.

## What it can and cannot show

- **Can:** that a same-day report is stamped at the message time and never later than it,
  that a past day keeps its venue-local noon, and that a malformed date or an unreadable
  timezone falls back to the message time.
- **Cannot:** say what the extractor model returns for a given message. Whether "my latte was
  cold" comes back as today's date is the model's call; the manual UAT on a real thread is
  what shows the two together.

Expected instants are UTC literals worked out by hand, not computed with the helpers under
check.
