# Scan greeting harness

Behavioural checks for the two runners that greet a guest who scanned the counter code and
said nothing: the Instagram webhook's fast path (`runScanGreetingFastPath`) and the cron
behind it (`processDueScanGreetings`). Both live in `lib/agent/instagram-scan-greeting.ts`.

**Run by hand. Not in CI, not an npm script, not a test suite.** Run it when you change
`lib/agent/scan-arrival.ts`, `lib/agent/scan-arrival-store.ts` or
`lib/agent/instagram-scan-greeting.ts`.

## Run it

From the repo root, with an **empty environment**:

```bash
env -i PATH="$PATH" HOME="$HOME" npx tsx scripts/harness/scan-greeting/harness.ts
```

It prints one `ok` or `FAIL` line per check and exits non-zero if any failed. The log lines
above the summary (`Missing env var`, `followup start`) are expected: see below.

The empty environment is not optional. `handleFollowup` is not stubbed, and the harness
exits with code 2 if it finds database, model or Instagram credentials, because with them a
"greeting" would be a real model call against the real database.

## What it can and cannot show

It runs the real per-row path against an in-memory store that models migration 064's
partial unique index, with the sleep and the clock injected.

- **Can:** the timing boundaries, every suppression reached through the fast path, that the
  clock is read after the sleep, and what happens when the two runners overlap on one row
  or one guest-day.
- **Cannot:** observe a send. With no credentials `handleFollowup` fails at context build, so
  a greeting is observed through the **claim** that precedes it. A check that says "claims
  once" means exactly that.
- **Cannot:** say anything about Meta's real delivery timing or how long a greeting turn
  takes. That is the manual UAT: scan into an existing thread, say nothing, and expect the
  greeting within about 20 to 45 seconds.

## Mutation pass

```bash
python3 scripts/harness/scan-greeting/mutate.py
```

Breaks the source one way at a time (the claim's two filters, the 23505 branch, the resolve
predicates, the post-sleep clock read, the wake margin and so on), re-runs the harness, and
restores each file from a byte copy. Every mutant should print `KILLED`. `SURVIVED` means the
harness does not check that behaviour; `INVALID` means the anchor text moved and the mutant
needs updating, which is not evidence either way.

It takes a few minutes and edits source files in place while it runs, so do not run it
alongside a build or a commit.
