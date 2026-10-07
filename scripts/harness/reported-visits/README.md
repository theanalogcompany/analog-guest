# Reported visits harness

Checks two things about a visit a guest told us about: when it is stamped
(`resolveOccurredAt` in `lib/agent/extract-reported-order.ts`) and which ones the guest may
take back (`selectRetractableVisits` and `retractedInConversation` in
`lib/agent/retract-reported-visit.ts`).

**Run by hand. Not in CI, not an npm script, not a test suite.** Run it when you change
`resolveOccurredAt`, `reportsTodaysScanVisit`, `lib/agent/retract-reported-visit.ts` or the
venue-local time helpers in `lib/guests/commitment-expiry.ts`.

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
- **Can:** that only a guest-reported visit, from this conversation, on a day with no scan on
  file, is offered for retraction, and that unreadable scans offer nothing.
- **Cannot:** show a retraction being written. `retractReportedVisits` talks to the database
  and is not run here; nor is the model's decision to check or to accept a correction.
- **Cannot:** say what the extractor model returns for a given message. Whether "my latte was
  cold" comes back as today's date is the model's call; the manual UAT on a real thread is
  what shows the two together.

Expected instants are UTC literals worked out by hand, not computed with the helpers under
check.
