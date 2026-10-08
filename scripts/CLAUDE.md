# scripts - CLI entry points, the onboarding pipeline, measurement harnesses

Loads only when you work in this directory.

Layout: `scripts/*.ts` are thin orchestrators (read args, set up clients, call helpers, log).
`scripts/onboarding/` holds one helper module per pipeline step. `scripts/lib/` holds pure
`.mjs` helpers used inside GitHub Actions steps. `scripts/measurement/` holds harnesses. `scripts/harness/` holds
hand-run behavioural harnesses that make no model calls (each has its own README).

Add a script with a `package.json` entry of the form
`"<name>": "tsx --env-file=.env.local scripts/<file>.ts"`.

## Module split

Importing a module that constructs a Voyage or Supabase client at the top level runs that
init on import. When pure helpers must be importable without it, split: `<name>-pure.ts`
with no `@/*` imports and `<name>.ts` with the DB-touching code, re-exporting from `-pure` so
the CLI keeps one import.

A `main()` guard via `import.meta.url === file://${process.argv[1]}` is **not** a safe fix -
that comparison silently never matches on a path containing characters `import.meta.url`
percent-encodes, such as a space or a curly apostrophe. Split the args parser out instead.

## Phase 5 onboarding pipeline

Five numbered files per venue in Drive. The numbering is meaningful and **04-09 are
reserved** - scripts find their input by prefix, so an ambiguous match trips the existence
guard.

| file | what |
| --- | --- |
| `04-{slug}-menu` (gsheet) | menu CSV, owner-editable |
| `05-{slug}-transcript` | onboarding interview |
| `06-{slug}-venue-spec-draft.md` | the venue's voice brain, extracted |
| `07-{slug}-test-scenarios.json` | venue-tailored scenarios |
| `08-{slug}-response-review` (gsheet) | owner review, read back by `ingest-response-review` |

Idempotent at every step, with one exception: `extract-venue-spec` hard-refuses if a `06-`
file exists (`--force` to override, `--dry-run` is exempt).

**Verification failure aborts the whole run** - one retry, then nothing is written to Drive
or disk and the process exits 1. Every `06-` file in Drive has passed verification.

`## Needs confirmation` is appended by the extraction's own verification pass, before a human
has looked at the draft. It replaced a model-authored self-attested checklist that ticked "at
least 5 voice_corpus entries" against a padded corpus - a green signal nobody had confirmed.

**Re-seeding is not how voice training works.** Phase 5 updates are surgical via
`ingest-response-review`. `seed-venue --force` rewrites config stores only, never the `venues`
row or any guest table, and refuses outright if the venue has any guests or messages.

**Run `run-test-scenarios` during the venue's open hours.** The prompt carries an open/closed
line, so a run after close injects "CLOSED right now" into every scenario, including the pool
that becomes the sheet an owner signs off. Results are not comparable run-to-run unless both
runs fell in the same state.

## Extraction places content by MOOD, not just by topic

Owners speak in advice. Recording that faithfully into `venue_info` renders it into every
prompt turn as if it were a structured fact, indistinguishable from one by the time the model
reads it.

- Opinionated recommendations go to `knowledge_corpus` (retrieval-gated, surfaces only when
  the guest asks), never `venue_info`.
- Content that legitimately stays in `venue_info` must read as **description of the venue**,
  never as an instruction to the assistant. An imperative there beats a universal rule that
  invites judgement - measured.
- A fixture's own `e.g.` placeholder is copy the model will echo. One leaked vocabulary into
  every extraction.
- Extraction rules never name "Needs confirmation" as a destination. Omitted content is just
  omitted; the verification pass finds it independently, so the two cannot silently disagree
  about what was dropped and why.

## Deriving a venue's voice profile

`npm run derive-voice-profile -- --venue <slug>` measures how a venue's team texts from the
Instagram history import and prints the numbers (decision 0010). Read-only; `--examples`
also prints candidate replies for a person to approve line by line. Nothing is stored by the
script: the profile and the approved examples are applied by hand, to every venue that
shares the voice. What counts as a reply and what is dropped as canned:
`scripts/lib/voice-profile.ts`. It also counts how often the team left a pure close
unanswered, with the same two functions the inbound turn decides with.

## Measurement harness convention

A harness answers a question about live behaviour via many expensive model calls. **Its
default shape destroys its own evidence** - this cost two result sets in one hour. Import
`createRunLog` from `scripts/measurement/run-log.ts` rather than reimplementing:

1. **Timestamped output by default.** Never a fixed filename.
2. **Checkpoint after each unit.** The expensive half is the model calls; losing them to a
   late throw in the cheap half is the specific failure.
3. **Never overwrite without an explicit flag.**
4. **Record the arm and the code state in the file** - prompt version, git SHA, the constant
   under test. A file that does not say which arm produced it is barely better than one that
   was overwritten.

Then, on whatever reports the run:

5. **A failed unit is not a result.** An errored call produces no verdict, so a harness
   counting positives scores it like a negative and a wholly broken run reports clean. Make
   a failure **disqualify** its cell whatever the count reads, and print failures per unit.
6. **A crashed or skipped run is not a result either.** A dead worker can still print a
   summary line that reads as zero failures. Check for a crash or skip **before** reading any
   count.
7. **Check a free-text detector for asymmetry between arms.** A phrase list systematically
   under-counts whichever arm is not echoing a script, and the error always flatters the
   scripted control. Read bodies before believing a rate; prefer a pattern with an optional
   slot over an exact-phrase list; re-score earlier runs after fixing a detector and say
   whether the numbers moved.
8. **Pre-register ceilings and evaluate them in code.** A bar answers "did it work"; a
   ceiling answers "did it break something while working". A ceiling breach fails the arm
   whatever its rate - and the harness must print that itself, because one ticket tallied a
   ceiling and never evaluated it while printing PASS.
9. **State up front when an arm cannot differ from its control**, verify it by string
   comparison, and void the run rather than reading the rate delta.
10. **A variable you hold fixed is an instrument too - check its distribution before
   trusting a run.** TAC-554 seeded `resolveDispatchBubbles`' coin from the scenario id so
   both arms saw the same flip. Bare FNV-1a over eighteen near-identical short ids clustered
   into two tight bands (0.52-0.58 and 0.065-0.085, nothing between), so the "fair" coin was
   effectively constant per band and could not represent the 50/50 that decided the ticket's
   own incident. A murmur3 finalizer fixed it; the tell was reading the per-unit values in
   the output rather than any number in the summary. Same family as 7, one layer out: there
   the detector flattered an arm, here the controlled variable did.

`scripts/onboarding/tab-retention.ts` is the same lesson in a different medium: a single
reused sheet tab destroyed the previous run, and a 455-scenario run was lost that way.

## GitHub Actions helpers

`scripts/lib/*.mjs` run inside workflow steps, not in this app's process - plain `.mjs`, no
`@/*`, no SDK init at module load.

`scripts/linear.mjs` is the only write path to Linear from CI. It takes comment text from a
markdown file so nothing is JSON-escaped by hand, refuses a comment without the authorship
prefix, and redacts its key from every line it prints. It imports nothing outside Node's
standard library, because the audit workflow runs it without `npm ci`.

**A script a CI session must run gets its own narrow allowlist entry, never a bare
interpreter.** A session that can run any program can read every secret in its environment.

## Drive

ADC via `gcloud auth application-default login`. Two distinct failures land on the same fix:
`insufficient authentication scopes` (never granted Drive) and `invalid_grant` /
`invalid_rapt` (expired, time-based - expect it again).

**Plain `gcloud auth application-default login` succeeds, reports a healthy login, and then
every Drive call still fails.** The default scopes do not include `drive`, and gcloud's
built-in client cannot request it at all - hence `--client-id-file` with the project-owned
Desktop client. `--scopes` is mandatory and cannot be added after the fact.

The client file is `client_secret_*.json` under the repo's **parent** directory. Locate it
with a glob; the filename embeds the client id and there is no fixed path.

**This is interactive and human-only.** It opens a browser consent flow with no scripted path
around it. Stop and hand off to the operator.

---

Root `CLAUDE.md` is the index for the whole repo, `docs/decisions/README.md` holds the
cross-cutting decisions, and `README.md` is the navigable map of both.
