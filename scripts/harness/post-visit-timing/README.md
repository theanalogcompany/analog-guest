# Post-visit timing harness

Behavioural checks for the rules behind the messages a visit ends in (TAC-578): which slot a
first-visit thank-you or a later-visit check-in goes out in, whether a visit's complaint reads
as put right, the three-hour one-message rule and who wins it, and the parts of the check-in
freshness check that need no model.

**Run by hand. Not in CI, not an npm script, not a test suite.** It makes no model calls and
touches no database: everything it drives is in `lib/agent/visit-messages.ts`. Run it when you
change that file.

## Run it

From the repo root, on Node 24:

```bash
env -i PATH="$PATH" HOME="$HOME" npx tsx scripts/harness/post-visit-timing/harness.ts
```

It prints one `ok` or `FAIL` line per check and exits non-zero if any failed. Its last check
runs a deliberately wrong expectation through the same comparison and requires it to be
reported, so a comparison that could not fail would fail here.

## What it does not cover

- **The once-ever guarantees themselves.** "A second thank-you claim loses" and "one sign-off
  per visit" are the two unique indexes in migration 076, enforced by Postgres. Nothing here
  can show them; the harness checks only the decisions made before a claim
  (`isFirstVisitDay`, `complaintStanding`).
- **That the close is not spent when a follow-up is armed.** That is an ordering of reads in
  `lib/agent/warm-close-timeout.ts` (the follow-up check returns before the claim), read from
  the code and not exercised.
- **The processors.** `post-visit-timeout.ts` and the pause timer are not run: they need a
  database and they send.
- **Anything a model writes or judges.** That is `npm run measure-post-visit-messages`.

## Mutations that were made to fail

Each row was seen to fail the named check: the first by breaking the code by hand, the second
by a defect in the code as first written.

| broken | check that failed |
| --- | --- |
| the margin dropped from the window in `resolvePostVisitSlot` | window edge: Meta closes four minutes after the slot starts |
| the thanks pattern as first written, whose `appreciate` arm could not match (a real defect, caught on the first run) | C3: every seeded thanks-for-visiting line is caught |

A check not in that table has not been shown able to fail by mutation.
