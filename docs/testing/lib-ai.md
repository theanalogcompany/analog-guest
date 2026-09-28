<!-- GENERATED FILE - do not edit by hand. Run `npm run test-map` to regenerate. -->
<!-- Source: scripts/lib/test-map.ts. Enforced by scripts/lib/test-map.test.ts. -->

# Tests in `lib/ai`

18 test files, 911 `it`/`test` declaration sites, 23 `.each` tables (each expands to several tests at runtime).

The `source` column says where the summary came from. `header` is the file's own leading
comment, written by someone who read the assertions. `names` is derived from `describe`
names and inherits whatever those names get wrong. Neither is evidence that a behaviour is
covered: use this to pick a file to read, then read the assertion.

| file | cases | source | what it covers |
| --- | --- | --- | --- |
| `lib/ai/classify-intention-prompts.test.ts` | 8 | names | classifyIntentionPrompts |
| `lib/ai/classify-message.test.ts` | 47 +1e | names | CLASSIFY_SYSTEM_PROMPT — category list; classifyMessage — schema accepts new categories; CLASSIFY_SYSTEM_PROMPT — new inbound categories (v1.10.0); classifyMessage — basic shape; classifyMessage — re… |
| `lib/ai/compose-prompt.test.ts` | 38 +9e | names | composePrompt — knowledge block rendering (TAC-242); composePrompt — promoted universal rules render on every category (TAC-314); composePrompt — recommendation-request references known order history… |
| `lib/ai/emoji-cadence.test.ts` | 23 | names | EMOJI_PROBABILITY (TAC-362); resolveEmojiDirective (TAC-362); emoji detection (TAC-362) |
| `lib/ai/extract-reported-order.test.ts` | 21 | names | extractReportedOrder |
| `lib/ai/generate-message.test.ts` | 53 | names | generateMessage — dash regex check (THE-225); generateMessage — self-talk check (TAC-355); generateMessage — basic shape; generateMessage — operator-approval self-flag (TAC-212); generateMessage — em… |
| `lib/ai/prompts/categories/index.test.ts` | 92 +4e | names | getCategoryInstructions — round-trip; comp-complaint instructions (v1.24.0 register); mechanic-request instructions (THE-228); recommendation-request instructions (THE-228); recommendation-request re… |
| `lib/ai/prompts/channel-variants.test.ts` | 10 | names | applyChannelSubstitutions (TAC-495); copyVariantFor (TAC-495) |
| `lib/ai/prompts/serializers.test.ts` | 230 +6e | names | venueInfoToProse — menu items; venueInfoToProse — currentContext; venueInfoToProse — hours notes multiline fix; runtimeToProse — today block; runtimeToProse — recent conversation block; runtimeToPros… |
| `lib/ai/prompts/system-template.test.ts` | 258 +1e | names | PROMPT_VERSION; UNIVERSAL_RULES_DISPLAY ↔ SYSTEM_TEMPLATE lockstep (TAC-305, numbering policy TAC-314); SYSTEM_TEMPLATE — single universal-rules heading (TAC-314); SYSTEM_TEMPLATE — arrivalCapture id… |
| `lib/ai/schema-budget.test.ts` | 1 | names | GeneratedMessageSchema optional-field budget (TAC-300) |
| `lib/ai/self-talk-detector.test.ts` | 5 | names | matchSelfTalk — positive (should fire); matchSelfTalk — negative (must NOT fire); matchSelfTalk — accepted over-inclusion; matchSelfTalk — pattern surface |
| `lib/ai/url-detector.test.ts` | 32 | names | extractUrls — what counts as a link; extractUrls — trailing punctuation; findUnverifiedUrls — matching against the curated list; findUnverifiedUrls — a single trailing slash is insignificant; findUnv… |
| `lib/ai/verify-cancellation-claim.test.ts` | 17 | names | verifyCancellationClaim (TAC-513); verifyCancellationClaim — prompt boundaries (TAC-513) |
| `lib/ai/verify-closed-venue-arrival.test.ts` | 12 | header | TAC-363: tests for the closed-venue arrival check. |
| `lib/ai/verify-grounding.test.ts` | 37 | names | verifyGrounding; runtime context in the source material; TAC-409: abridgement and identity are not ungrounded; TAC-376: isProactive (no guest message); TAC-502: the conversation channel is grounding |
| `lib/ai/verify-mechanic-offer.test.ts` | 8 | names | verifyMechanicOffer |
| `lib/ai/verify-prose-promise.test.ts` | 19 +2e | names | verifyProsePromise |
