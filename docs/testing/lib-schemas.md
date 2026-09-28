<!-- GENERATED FILE - do not edit by hand. Run `npm run test-map` to regenerate. -->
<!-- Source: scripts/lib/test-map.ts. Enforced by scripts/lib/test-map.test.ts. -->

# Tests in `lib/schemas`

17 test files, 298 `it`/`test` declaration sites, 10 `.each` tables (each expands to several tests at runtime).

The `source` column says where the summary came from. `header` is the file's own leading
comment, written by someone who read the assertions. `names` is derived from `describe`
names and inherits whatever those names get wrong. Neither is evidence that a behaviour is
covered: use this to pick a file to read, then read the assertion.

| file | cases | source | what it covers |
| --- | --- | --- | --- |
| `lib/schemas/approval-policy.test.ts` | 30 | header | FIXTURES WRITTEN BEFORE THE MODULE (v1.24.0). |
| `lib/schemas/brand-persona.test.ts` | 13 | names | VoiceAntiPatternSchema; BrandPersonaSchema voiceAntiPatterns; BrandPersonaSchema voiceName |
| `lib/schemas/followup-rules.test.ts` | 13 | names | FOLLOWUP_RULES_DEFAULT; FollowupRulesSchema; parseFollowupRules; FOLLOWUP_REASONS |
| `lib/schemas/guest-commitment.test.ts` | 45 | names | isEmptyCommitmentEmission; isEmptyArrivalCapture; CommitmentEmissionSchema; generateCommitmentCode; pendingFromEmission; PendingCommitmentSchema; toActiveCommitment; GuestCommitmentRowSchema; resolve… |
| `lib/schemas/guest-context.test.ts` | 33 | names | GuestContextSchema; GuestContextPatchSchema; filterActiveLifeContext; toParsedGuestContext; isEmptyGuestContext |
| `lib/schemas/inbound-turn-outcome.test.ts` | 10 | names | migration 055 CHECK constraints match the TS vocabulary; vocabulary shape |
| `lib/schemas/intention-rules.test.ts` | 7 +1e | names | INTENTION_RULES_DEFAULT; parseIntentionRules |
| `lib/schemas/knowledge-tags.test.ts` | 13 | names | isCanonicalPrimaryTag; PrimaryTagSchema |
| `lib/schemas/mechanic.test.ts` | 13 | header | Destructuring-to-omit a field for a "missing required field" fixture leaves an intentionally-unused binding. |
| `lib/schemas/message-channel.test.ts` | 5 | names | parseMessageChannel; MESSAGE_CHANNELS matches messages_channel_check |
| `lib/schemas/message-review.test.ts` | 16 | names | MessageReviewSchema; getReviewedVia |
| `lib/schemas/referral-source.test.ts` | 7 +4e | names | isScanReferral; both callers read the shared predicate, not their own copy |
| `lib/schemas/review-state.test.ts` | 4 | header | TAC-473: the TS constant and migration 056's CHECK must agree. |
| `lib/schemas/thread-message.test.ts` | 8 | names | ThreadMessageSchema; THREAD_MESSAGE_LIMIT |
| `lib/schemas/venue-hours.test.ts` | 51 +5e | names | parseDayRange; classifyDay; formatMinutes; resolveOpenState; resolveOpeningToday (TAC-428); venueLocalMinutes (TAC-428) |
| `lib/schemas/venue-info.test.ts` | 26 | names | filterActiveContext; classifyContextEntry; VenueInfoSchema — services; VenueInfoSchema — links (TAC-509); parseVenueLinks (TAC-509) |
| `lib/schemas/visit-precision.test.ts` | 4 | names | parseVisitPrecision |
