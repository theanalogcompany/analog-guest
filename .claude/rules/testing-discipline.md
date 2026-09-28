---
paths:
  - "**/*.test.ts"
---

# Testing discipline

Loads when you touch a test file. These are the failures this repo has actually paid for,
in rough order of how much they cost.

## Ask what would fail if the claim were untrue

The expensive defects here are almost never wrong code. They are a **claim nothing
enforces** - a test name, a comment, a printed PASS, a schema default - and the claim is
what stops anyone looking.

Three instances landed in two days once: a PII test that planted its own value and checked
for one it never inserted, so it could only pass, and it passed while reporting on a leak it
could not reach; a measurement printing `PASS` for ceilings it never evaluated; a comment
asserting DST-safety above code that dropped a day at the transition.

**The check is mechanical: name the input that would make this claim false, then confirm the
test fails on it.** If no such input exists, the claim proves nothing whatever it says.
Delete it, or make it able to fail.

Specimens, all real: a test named `returns false for unknown triggers (future-add safety)`
whose assertion encoded the **opposite** and passed for two months while pushes were
silently dropped. A comment promising a `tsc` error that `tsc` could not produce
(`readonly T[]` is not exhaustiveness-checked). A test comparing a derivation against a
literal that could never differ from it. A comment claiming a total switch above a ternary
chain with a silent default - the reviewer added a sixth union member and the new state
mapped to null, fired nothing, and sent.

## Arrange for something to disagree

Careful reading catches none of the above. What works every time is a **second source that
can contradict the first**: a control arm that can fail, a per-file reconciliation against a
total, a mutant, an independent tool.

Four in one session, each producing a perfectly plausible number: two runs of byte-identical
code giving 4/5 and 1/5 on the same metric; a whole new line entering a prompt block with
5,701 tests green because every assertion was a substring; two assertions that could be
inverted and still pass; a per-file test count read as 459 when the truth was 231.

A number nobody can contradict is not evidence, however carefully it was read.

## Mutation testing

Change the code so the behaviour is wrong, run the test, confirm it fails. Then restore.

**A mutant is only evidence if the file compiled and the intended line changed.**

- A syntax error makes the file collect **zero** tests, which prints nothing failing and is
  indistinguishable from a real survivor. Check for `Tests N passed`, not the absence of
  failures. A "survivor" from a file that ran zero tests is no more evidence than a kill
  from one.
- `perl -0pi -e 's/.../.../'` without `/g` replaces the **first** match, which may not be
  your line. Assert the anchor matches **exactly once** before writing, and diff the file
  after.
- A crashed vitest worker (`Worker exited unexpectedly`) still prints a summary line. Treat a
  crash or a skip as **invalid**, never as evidence either way - it reported SURVIVED on the
  two mutants a recursion bound exists for, twice.
- **Restore from a file copy, not `git checkout --`.** That restores to HEAD, so mutating
  against an **uncommitted** fix silently destroys it. It happened twice in one sitting, and
  the only signal was tests written for the fix starting to fail. Commit the fix first.

**Your own mutation pass verifies the mutants you already thought of.** That is a real
guarantee and a narrow one. The survivors are usually a different question - not "what does
the code compute" but "can the fixture reach the code", or "is the caller wired in at all".
Nine hand-run mutants all died and a review then found a blocker and four majors, every one
of the second kind: a guard with the wrong *shape* for its auth path, a fixture that answered
identically with and without the field, a double that discarded the filters it existed to
pin, a module with no test file whose header claimed the invariant was asserted in the tests,
and a new enum value falling through a switch **in a file the diff never touched**.

Two cheap habits close most of the gap: ask what the **fixture** cannot express (one
category, one channel, one flag state, one delivery status guards only that one), and get a
second reader whose first question is "can this test fail at all" - the question its author
already answered wrongly in the same keystroke that wrote the fixture.

## Fixture traps

- **A mocked behaviour flag must match production.** `shouldRetrieveKnowledge: () => false`
  against a predicate that returns `true` for every case in the file made the entire
  knowledge-retrieval branch unreachable, in three files, and correcting it broke nothing -
  which is the tell that it had no coverage rather than conflicting coverage. Sweep with
  `grep -rn ": () => \(true\|false\)," --include='*.test.ts' .`
- **Give a mock a return value that differs from the expected one.** A mock resolving `[]`
  under an assertion of `[]` cannot distinguish "the path ran and found nothing" from "the
  path was skipped".
- **A required field forces a value, never the right one.** Make new context fields required
  so every construction site has to decide - an optional one lets twenty sites default
  silently to the wrong thing, which is usually the defect under test.
- **A partially-cast fixture reads `undefined` at runtime.** `venue` cast partially means
  `brandPersona` and `venueInfo` are absent the moment source dereferences them. Backfill the
  fixture; do not make the source defensive against a state its own type forbids.
- **A mock's recorded argument is a live reference.** Asserting on `mock.calls[0][0]` after an
  orchestrator mutated that object describes the end state, not what the callee saw. Snapshot
  inside the mock.
- **`vi.restoreAllMocks()` does not clear call history** on a `vi.fn()` from a module factory.
- **A bare `vi.fn()` resolves `undefined`**, which `Promise.allSettled` reports as fulfilled.
- **`waitUntil` mocked as `(p) => p` leaks across tests.** A chain started in one test is
  still running in the next and consumes shared mock state. The signature is a test that
  passes in isolation and fails in the file. Drain in `afterEach`.

## Assertion shape

- **`toEqual`, not `toMatchObject`, when the subject is which fields move.** A partial match
  passes while a field silently goes missing - which was the original bug's exact shape. Then
  mutation-check both directions: drop each field, and add one that must not move.
- **Pin a ruled sentence as one contiguous literal.** A sentence can be reversed while every
  asserted fragment survives; three mutants did exactly that and passed 36 of 36.
- **A test name is not evidence of what the test checks.** Rename it to what it asserts.
- **Reverse a test rather than deleting it** when behaviour deliberately changes. A deleted
  test leaves no record it was ever the other way.
- **Assert an absence as deliberately as a presence** - a retired token, a banned import, a
  quoted example that must not exist.
- **A source-level guard catches only the spellings it was written against.** Write down the
  equivalent code it must reject and run that as a mutant in the same change. One matched
  snake_case only and a camelCase mutant walked past it; one matched `x.filter(` and a filter
  chained onto the producing call passed.
- **Guard the guard.** A test that scans files must assert it found a non-empty set, or it
  passes vacuously. Per root, not combined - a single count stays green when one root
  resolves to nothing.
- **A binding test should DERIVE what it reads**, not name a file. One pinned to the
  migration that defined an RPC stayed green after a later migration redefined it, leaving
  the live function unchecked.
- **Totality over a closed set is a `satisfies Record<K, V>` map**, not an array and not a
  ternary chain. `readonly K[]` checks each element is a `K` and cannot check the list is
  complete. Verify by adding a member and watching `tsc` fail.

## Running the suite

- **The suite refuses to run on the wrong Node major** (`.nvmrc`, currently 24), before any
  test collects. There is no escape hatch and none should be added - the sibling repo lost
  three days to a test that hung on CI's Node and passed locally. Fix the Node, never the
  guard. `npx tsc --noEmit` is unaffected.
- **`testTimeout` is 15 s** and must not be raised to silence a hang: a couple of tests use a
  timeout as the **signal** that a `sleep` was reintroduced.
- **Read `Test Files N failed` and the per-file count, not `Tests N passed`.** A new import
  can make one file collect zero tests while the run summary reads green.
- `.worktrees/**` and `.claude/**` are excluded in config. Note `exclude` **replaces**
  vitest's defaults, so `node_modules`/`dist` are restated there and must stay.
- **Measure a before/after in a throwaway worktree, and remove it before measuring the
  after** - while it exists, a local run collects both copies and a per-file figure comes back
  exactly doubled. That has happened twice in one ticket.
- **Never carry a count or a file list across a rebase.** Re-measure. Every arithmetic
  shortcut here has been wrong so far.
- **Check `tsc`'s exit code directly, not through a pipe.** `$?` after a pipe reports the
  pipe, which has already misread a failing typecheck as clean.
