<!-- GENERATED FILE - do not edit by hand. Run `npm run test-map` to regenerate. -->
<!-- Source: scripts/lib/test-map.ts. Enforced by scripts/lib/test-map.test.ts. -->

# Tests in `scripts/measurement`

10 test files, 170 `it`/`test` declaration sites, 26 `.each` tables (each expands to several tests at runtime).

The `source` column says where the summary came from. `header` is the file's own leading
comment, written by someone who read the assertions. `names` is derived from `describe`
names and inherits whatever those names get wrong. Neither is evidence that a behaviour is
covered: use this to pick a file to read, then read the assertion.

| file | cases | source | what it covers |
| --- | --- | --- | --- |
| `scripts/measurement/channel-language.test.ts` | 8 +5e | names | phone claims, which are FALSE on Instagram; ordinary words are not claims; a denied claim is not a claim; Instagram idioms, true but off-copy; reporting |
| `scripts/measurement/date-language.test.ts` | 30 +6e | names | findDateLanguage |
| `scripts/measurement/first-touch-question-detector.test.ts` | 16 +6e | names | classifyFirstTouchReply (TAC-423); contractions (regression from the 2026-09-22 run); adverb slot (regression from the 2026-09-23 confirmation run); carriesApology |
| `scripts/measurement/grounding-failure-set.test.ts` | 13 | names | grounding failure set — fixture integrity; grounding failure set — the invariants that make it usable; grounding failure set — public-repo constraint |
| `scripts/measurement/guest-name-language.test.ts` | 26 | names | countNameUses; findThirdPersonVenue; consecutiveNamePairs; classifyGuestName; looksLikeDodge |
| `scripts/measurement/intention-block-move.test.ts` | 14 | names | splitPromptBlocks; moveIntentionBlockLate |
| `scripts/measurement/knowledge-context-language.test.ts` | 9 +1e | names | classifyBhadraReply (TAC-547) |
| `scripts/measurement/run-log.test.ts` | 13 +1e | names | createRunLog default path; checkpoint as you go; explicit path collision; header round-trip; directory auto-creation; real git sha default |
| `scripts/measurement/speaker-identity-language.test.ts` | 22 +7e | names | namedSelfIntro — the ticket; bareNameAsk — defect 2; whatToCallYouReason — R37, as corrected 2026-09-26; questionCount — the ceiling input; sentencesOf |
| `scripts/measurement/take-and-specifics-language.test.ts` | 19 | names | countSpecificHits; findPersonalTake; repeatedPhrases; repeatedPhrases — small-run floor |
