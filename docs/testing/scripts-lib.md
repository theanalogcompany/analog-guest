<!-- GENERATED FILE - do not edit by hand. Run `npm run test-map` to regenerate. -->
<!-- Source: scripts/lib/test-map.ts. Enforced by scripts/lib/test-map.test.ts. -->

# Tests in `scripts/lib`

16 test files, 446 `it`/`test` declaration sites, 37 `.each` tables (each expands to several tests at runtime).

The `source` column says where the summary came from. `header` is the file's own leading
comment, written by someone who read the assertions. `names` is derived from `describe`
names and inherits whatever those names get wrong. Neither is evidence that a behaviour is
covered: use this to pick a file to read, then read the assertion.

| file | cases | source | what it covers |
| --- | --- | --- | --- |
| `scripts/lib/bash-allowlist.test.ts` | 32 +8e | names | allows; permits; permitsCommandLine; the build allowlist; what the prompts teach, the allowlist permits; .github/CLAUDE.md\ |
| `scripts/lib/build-workflow.test.ts` | 78 | names | build-ready.yml selects one ticket per run; build-ready.yml skips a ticket another session has (TAC-448); build-ready.yml refuses to start a ticket still waiting on an answer (TAC-453); build-ready.y… |
| `scripts/lib/claims.test.ts` | 49 +2e | names | the 2026-09-17 incident: TAC-396 resumed under a local session; a local claim on a resume; a [POLLING-STATE] on a resume; a start; an open PR on a resume; which comments are claims; which branches ar… |
| `scripts/lib/claude-md-budget.test.ts` | 10 +2e | names | instruction file budget; instruction file pointers |
| `scripts/lib/comment-provenance.test.ts` | 35 | names | isBotComment; commentMarker; isRulingComment; isContextChatComment; unescapeBrackets; isBookkeepingComment; a CC HUMAN-REVIEW-REQUIRED comment is never a ruling; isBookkeepingComment; auditHasQuestio… |
| `scripts/lib/denials-redaction.test.ts` | 13 +2e | names | the [DENIALS] capture block redacts every secret it holds (TAC-442) |
| `scripts/lib/insert-instagram-credential.test.ts` | 15 | names | parseInsertArgs; decideAccountClaim; describeGraphFailure |
| `scripts/lib/instagram-smoke.test.ts` | 14 +1e | names | textOfBytes; capVerdictBlocker; parseSmokeArgs; idForLog |
| `scripts/lib/linear-cli.test.ts` | 38 +3e | names | parseArgs; checkCommentBody; checkDescriptionBody; redact; comment; describe; label; state; transport failures; usage; the key never appears in output or errors; scripts/linear.mjs as a process; sour… |
| `scripts/lib/linear-prompts.test.ts` | 12 +6e | names | the Linear block of the workflow prompts; the Linear helper each prompt teaches is on its allowlist; work-ticket.md step 1 |
| `scripts/lib/pending-question.test.ts` | 24 +1e | names | newestTurn; pendingQuestionLabel; reconcile; run |
| `scripts/lib/reconcile-needs-decision.test.ts` | 28 | names | deriveNeedsDecision; auditHasOpenQuestions; reconcile; run |
| `scripts/lib/reconcile-status.test.ts` | 20 | names | deriveTargetStatus; reconcile; run |
| `scripts/lib/repo-line-owner.test.ts` | 4 +3e | names | both workflows extract the identical repo-assignment rule; %s |
| `scripts/lib/run-report.test.ts` | 41 +5e | names | lastResult; classifyEnding; readGitState; readGitState against a real repository; renderGitReport; the two notices; run |
| `scripts/lib/test-map.test.ts` | 33 +4e | names | parseHeader; parseDescribes; countCases; countEachSites; areaOf; areaSlug; escapeCell; toEntry; discovery; docs/testing is current; docs/testing integrity; the pointers into docs/testing |
