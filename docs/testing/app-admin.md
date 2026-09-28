<!-- GENERATED FILE - do not edit by hand. Run `npm run test-map` to regenerate. -->
<!-- Source: scripts/lib/test-map.ts. Enforced by scripts/lib/test-map.test.ts. -->

# Tests in `app/admin`

51 test files, 474 `it`/`test` declaration sites, 2 `.each` tables (each expands to several tests at runtime).

The `source` column says where the summary came from. `header` is the file's own leading
comment, written by someone who read the assertions. `names` is derived from `describe`
names and inherits whatever those names get wrong. Neither is evidence that a behaviour is
covered: use this to pick a file to read, then read the assertion.

| file | cases | source | what it covers |
| --- | --- | --- | --- |
| `app/admin/(authed)/_lib/current-context.test.ts` | 9 | header | eslint-disable @typescript-eslint/no-unused-vars |
| `app/admin/(authed)/_lib/guest-name.test.ts` | 15 | names | guestDisplayName; guestNameWithPhone; formatGuestPhone; the Instagram handle |
| `app/admin/(authed)/_lib/knowledge-corpus.test.ts` | 17 | header | eslint-disable @typescript-eslint/no-unused-vars |
| `app/admin/(authed)/_lib/load-intention-prompts.test.ts` | 14 | names | loadIntentionPrompts |
| `app/admin/(authed)/_lib/load-venue-commitments.test.ts` | 15 | names | loadVenueCommitments |
| `app/admin/(authed)/_lib/load-venue-guests.test.ts` | 8 | names | loadVenueGuestsByActivity |
| `app/admin/(authed)/_lib/load-venue-intentions.test.ts` | 20 | names | loadVenueOpenIntentions |
| `app/admin/(authed)/_lib/mechanics.test.ts` | 10 | header | eslint-disable @typescript-eslint/no-unused-vars |
| `app/admin/(authed)/conversations/_components/build-review-payload.test.ts` | 10 | names | buildReviewPayload; canSaveReview |
| `app/admin/(authed)/conversations/api/follow-up/route.test.ts` | 21 +1e | names | POST /admin/conversations/api/follow-up |
| `app/admin/(authed)/conversations/api/review/[messageId]/route.test.ts` | 16 | header | Mock signatures mirror the supabase-js fluent builder, which passes column names + filter args we don't inspect inside the test. |
| `app/admin/(authed)/conversations/api/transactions/[transactionId]/route.test.ts` | 8 | header | Mock signatures mirror the supabase-js fluent builder, which passes column names + filter args we don't inspect inside the test. |
| `app/admin/(authed)/conversations/lib/compute-message-stats.test.ts` | 8 | names | computeMessageStats — counts; computeMessageStats — response rate |
| `app/admin/(authed)/conversations/lib/extract-recognition.test.ts` | 8 | names | extractRecognition — happy path; extractRecognition — null cases; extractRecognition — defensive parsing |
| `app/admin/(authed)/conversations/lib/order-guests-by-activity.test.ts` | 13 | names | activityIndex; orderGuestsByActivity |
| `app/admin/(authed)/conversations/lib/parse-ticket.test.ts` | 14 | names | parseTicket; buildItemsPreview; formatPosProvider |
| `app/admin/(authed)/conversations/lib/project-thread.test.ts` | 14 | names | projectThread; deriveResponseState; wasDispatched |
| `app/admin/(authed)/conversations/lib/select-trace-stages.test.ts` | 7 | names | selectTraceStages |
| `app/admin/(authed)/health/check-apns.test.ts` | 6 | names | checkApns |
| `app/admin/(authed)/health/check-langfuse.test.ts` | 9 | names | checkLangfuse — Active; checkLangfuse — Disabled; checkLangfuse — Misconfigured; checkLangfuse — Not configured |
| `app/admin/(authed)/intentions/_lib/definition-display.test.ts` | 15 | names | resolveDefinition; formatExpiryWindow; formatPromptedAt; formatArmsOn (TAC-380); formatGate (TAC-380) |
| `app/admin/(authed)/intentions/no-copied-strings.test.ts` | 4 | names | intentions surface renders definitions from the constant |
| `app/admin/(authed)/venues/_lib/commitment-display.test.ts` | 19 +1e | names | classifyKind; isEscalated; isUntimed; sortForDisplay; formatAge; formatExpiry |
| `app/admin/(authed)/venues/_lib/expiry-queue.test.ts` | 6 | names | partitionCurrentContext |
| `app/admin/(authed)/venues/_lib/mechanic-fields.test.ts` | 12 | names | parseMechanicTriggerType; findMissingMechanicFields |
| `app/admin/(authed)/venues/_lib/readiness.test.ts` | 17 | names | computeReadiness |
| `app/admin/(authed)/venues/_lib/section-grouping.test.ts` | 11 | names | groupKnowledgeByTag |
| `app/admin/(authed)/venues/_lib/unclaimed-fields.test.ts` | 10 | names | computeUnclaimedVenueInfoFields; computeUnclaimedMechanicColumns |
| `app/admin/(authed)/venues/api/knowledge/[entryId]/route.test.ts` | 9 | names | PATCH /admin/venues/api/knowledge/[entryId]; DELETE /admin/venues/api/knowledge/[entryId] |
| `app/admin/(authed)/venues/api/knowledge/[entryId]/split/route.test.ts` | 5 | names | POST /admin/venues/api/knowledge/[entryId]/split |
| `app/admin/(authed)/venues/api/knowledge/merge/route.test.ts` | 5 | names | POST /admin/venues/api/knowledge/merge |
| `app/admin/(authed)/venues/api/mechanics/[mechanicId]/route.test.ts` | 8 | names | PATCH /admin/venues/api/mechanics/[mechanicId]; DELETE /admin/venues/api/mechanics/[mechanicId] |
| `app/admin/(authed)/venues/api/venues/[venueId]/approval-policy/route.test.ts` | 10 | header | Mock signatures mirror the supabase-js fluent builder; column names + filter args we don't inspect inside the test. |
| `app/admin/(authed)/venues/api/venues/[venueId]/current-context/[entryId]/promote/route.test.ts` | 5 | names | POST .../current-context/[entryId]/promote |
| `app/admin/(authed)/venues/api/venues/[venueId]/current-context/[entryId]/route.test.ts` | 3 | names | DELETE /admin/venues/api/venues/[venueId]/current-context/[entryId] |
| `app/admin/(authed)/venues/api/venues/[venueId]/current-context/route.test.ts` | 3 | names | POST /admin/venues/api/venues/[venueId]/current-context |
| `app/admin/(authed)/venues/api/venues/[venueId]/knowledge/route.test.ts` | 6 | names | POST /admin/venues/api/venues/[venueId]/knowledge; POST /admin/venues/api/venues/[venueId]/knowledge — auth pass-through |
| `app/admin/(authed)/venues/api/venues/[venueId]/mechanics/route.test.ts` | 5 | header | Destructuring-to-omit a field for a "missing required field" fixture leaves an intentionally-unused binding. |
| `app/admin/(authed)/venues/api/venues/[venueId]/venue-info/route.test.ts` | 9 | header | Mock signatures mirror the supabase-js fluent builder; column names + filter args we don't inspect inside the test. |
| `app/admin/(authed)/voices/[slug]/_lib/format-last-refined.test.ts` | 8 | names | formatLastRefined |
| `app/admin/(authed)/voices/api/classify-critique/route.test.ts` | 5 | names | POST /admin/voices/api/classify-critique |
| `app/admin/(authed)/voices/api/commit/route.test.ts` | 8 | names | POST /admin/voices/api/commit — edit_only path; POST /admin/voices/api/commit — edit_and_rule path; POST /admin/voices/api/commit — error paths |
| `app/admin/(authed)/voices/api/corpus/[entryId]/route.test.ts` | 8 | names | PATCH /admin/voices/api/corpus/[entryId]; DELETE /admin/voices/api/corpus/[entryId] |
| `app/admin/(authed)/voices/api/patterns/[venueId]/dismiss/route.test.ts` | 2 | header | eslint-disable @typescript-eslint/no-unused-vars |
| `app/admin/(authed)/voices/api/patterns/[venueId]/promote/route.test.ts` | 3 | header | eslint-disable @typescript-eslint/no-unused-vars |
| `app/admin/(authed)/voices/api/patterns/[venueId]/route.test.ts` | 3 | names | GET /admin/voices/api/patterns/[venueId] |
| `app/admin/(authed)/voices/api/persona/[venueId]/route.test.ts` | 4 | header | Mock signatures mirror the supabase-js fluent builder; column names + filter args we don't inspect inside the test. |
| `app/admin/(authed)/voices/api/regenerate/route.test.ts` | 8 | names | POST /admin/voices/api/regenerate |
| `app/admin/(authed)/voices/api/venues/[venueId]/corpus/route.test.ts` | 6 | names | POST /admin/voices/api/venues/[venueId]/corpus; POST /admin/voices/api/venues/[venueId]/corpus — auth pass-through |
| `app/admin/(authed)/voices/api/venues/[venueId]/rules/route.test.ts` | 8 | names | POST /admin/voices/api/venues/[venueId]/rules; DELETE /admin/voices/api/venues/[venueId]/rules |
| `app/admin/_components/nav-items.test.ts` | 7 | names | NAV source; isNavItemActive |
