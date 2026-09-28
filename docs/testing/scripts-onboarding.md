<!-- GENERATED FILE - do not edit by hand. Run `npm run test-map` to regenerate. -->
<!-- Source: scripts/lib/test-map.ts. Enforced by scripts/lib/test-map.test.ts. -->

# Tests in `scripts/onboarding`

25 test files, 349 `it`/`test` declaration sites.

The `source` column says where the summary came from. `header` is the file's own leading
comment, written by someone who read the assertions. `names` is derived from `describe`
names and inherits whatever those names get wrong. Neither is evidence that a behaviour is
covered: use this to pick a file to read, then read the assertion.

| file | cases | source | what it covers |
| --- | --- | --- | --- |
| `scripts/onboarding/concurrency.test.ts` | 5 | names | mapWithConcurrency |
| `scripts/onboarding/cost-tracker.test.ts` | 7 | names | cost-tracker |
| `scripts/onboarding/evaluate-approval-decision.test.ts` | 2 | header | TAC-347 Stage 2. Structural invariant test for the decision-only approval boundary — see the human-authorized constraint: "The harness calls applyApprovalPolicyStage for its return value and nothing… |
| `scripts/onboarding/extract-test-scenarios.test.ts` | 17 | names | normalizeName; parseFixtureCategoryOrder; validateUniversalCategories; assignSampleIds |
| `scripts/onboarding/extract-venue-spec-args.test.ts` | 13 | names | parseArgs; shouldRefuseOverwrite (TAC-346 overwrite guard) |
| `scripts/onboarding/extract.test.ts` | 39 | names | venue-spec-example.md fixture (TAC-342 regression canary); venue-spec-example.md fixture (TAC-331 regression canary); buildExtractionSystemPrompt (TAC-331); buildExtractionSystemPrompt (TAC-343 Phase… |
| `scripts/onboarding/generate-scenarios-pure.test.ts` | 20 | names | buildCoverableRows; buildVenueContentDigest; validateTopicMapping; parseMissingInformationItems; computeUncoveredRowIds |
| `scripts/onboarding/grade-routing.test.ts` | 5 | names | gradeRouting |
| `scripts/onboarding/grade-voice-deterministic.test.ts` | 28 | names | gradeVoiceDeterministic |
| `scripts/onboarding/ingest-response-review.test.ts` | 26 | names | classifyRow; rulePayloadFromComment; normalizeForCompare; tagsForRow; parseReviewSheet; buildPhase5Subsection; appendPhase5Section |
| `scripts/onboarding/load-venue-context.test.ts` | 5 | names | assertVenueGuard |
| `scripts/onboarding/merge-scenario-sheet-pure.test.ts` | 23 | names | computeRowHash; stampFreshRows; mergeScenarioRows; dedupeRowsBySampleId; deleted rows never resurrected (tombstones + similarity filter); filterRunnableScenarios (excluded rows skipped by the runner)… |
| `scripts/onboarding/merge-scenario-sheet-serialize.test.ts` | 8 | names | scenarioRowToValues / valuesToScenarioRow round-trip; buildMergedMetaEntries |
| `scripts/onboarding/owner-review-selection.test.ts` | 21 | names | isExcludedFromOwnerReview; classifyOwnerReviewSituation; pickDiverseForOwnerReview; selectOwnerReviewCandidates; selectOwnerReviewFinal |
| `scripts/onboarding/owner-review-sheet.test.ts` | 7 | names | buildOwnerReviewRows; rowsToCsv + parseReviewSheet round trip |
| `scripts/onboarding/parse-venue-spec.test.ts` | 10 | names | parseVenueSpec — knowledge_corpus (TAC-242); parseVenueSpec — staff[].notes routing (TAC-343 Phase 0); parseVenueSpec — Needs confirmation section (TAC-346) |
| `scripts/onboarding/preflight-clean-state.test.ts` | 3 | header | TAC-394: the harness's clean-state preflight reads a guest's pending drafts through loadPendingRowsBySlot. A guest can hold one pending card per slot, so every card is reported rather than whichever… |
| `scripts/onboarding/preflight.test.ts` | 4 | names | diffGuardrailState |
| `scripts/onboarding/run-sheet.test.ts` | 10 | names | buildRunRows; formatRetrievedChunks |
| `scripts/onboarding/run-test-scenarios.test.ts` | 1 | names | run-test-scenarios: the synthetic inbound is an SMS message (TAC-495) |
| `scripts/onboarding/sanitize-scenario-text.test.ts` | 10 | names | stripLongDashes; sanitizeScenarioText; sanitizeScenarios; containsLongDash |
| `scripts/onboarding/scorecard.test.ts` | 20 | names | pass predicates; computeTopicPassRates; buildReviewList; sampleForVoiceRead; sampleForGraderSpotCheck |
| `scripts/onboarding/seed-supabase.test.ts` | 9 | header | eslint-disable @typescript-eslint/no-unused-vars |
| `scripts/onboarding/tab-retention.test.ts` | 8 | names | buildTimestampedTabName; selectTabsToDelete |
| `scripts/onboarding/verify.test.ts` | 48 | names | VerifyResultSchema; formatNeedsConfirmationSection; buildVerifySystemPrompt; buildVerifySystemPrompt — sourceQuote must come from source materials, never the draft; buildVerifySystemPrompt — voice qu… |
