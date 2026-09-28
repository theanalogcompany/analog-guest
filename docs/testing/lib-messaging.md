<!-- GENERATED FILE - do not edit by hand. Run `npm run test-map` to regenerate. -->
<!-- Source: scripts/lib/test-map.ts. Enforced by scripts/lib/test-map.test.ts. -->

# Tests in `lib/messaging`

28 test files, 396 `it`/`test` declaration sites, 24 `.each` tables (each expands to several tests at runtime).

The `source` column says where the summary came from. `header` is the file's own leading
comment, written by someone who read the assertions. `names` is derived from `describe`
names and inherits whatever those names get wrong. Neither is evidence that a behaviour is
covered: use this to pick a file to read, then read the assertion.

| file | cases | source | what it covers |
| --- | --- | --- | --- |
| `lib/messaging/expressions.test.ts` | 4 | names | sendTypingIndicator; markAsRead |
| `lib/messaging/instagram/agent-gate.test.ts` | 15 +3e | header | The gate that decides whether the agent replies to an Instagram guest (TAC-469), and — since TAC-523 — what the ledger records when it does not. Three separate rules, tested separately: - the gate it… |
| `lib/messaging/instagram/credentials-store.test.ts` | 22 | names | loadInstagramCredential; resolveInstagramAccessToken; upsertInstagramCredential; readInstagramAccessToken; deauthorizeInstagramCredential |
| `lib/messaging/instagram/delete-venue-data.test.ts` | 15 | header | TAC-516: what the data-deletion callback actually erases. |
| `lib/messaging/instagram/fetch-profile.test.ts` | 13 | header | The two Graph reads, against a fetch the test controls. Response bodies follow Meta's documented shapes (the User Profile API page, and Graph's standard error object); none has been captured from Met… |
| `lib/messaging/instagram/first-visit.test.ts` | 9 | header | TAC-492: from Meta's recorded delivery to the first-visit behaviours. |
| `lib/messaging/instagram/fixtures.test.ts` | 9 +2e | header | Real Instagram webhook deliveries, captured on 2026-09-17 (TAC-458), with identifiers and text replaced. fixtures/README.md says what was replaced and how. The assertions in the first block are the b… |
| `lib/messaging/instagram/handle-events.test.ts` | 47 +1e | header | What the handler writes for each kind of event, run against Meta's recorded deliveries (fixtures/) and an in-memory store (testing/db-fake.ts) that throws on any query shape the handler shouldn't sen… |
| `lib/messaging/instagram/mark-seen.test.ts` | 9 +2e | header | TAC-540: Seen fires for a live venue, and for nothing else this module decides. |
| `lib/messaging/instagram/oauth-exchange.test.ts` | 21 +2e | header | TAC-516: the four Meta calls the connect callback makes, against a stubbed Meta. Nothing here reaches the network. |
| `lib/messaging/instagram/oauth-state-store.test.ts` | 9 | header | TAC-516: the REPLAY refusal, which is the one the signature cannot make. |
| `lib/messaging/instagram/oauth-state.test.ts` | 14 +3e | header | TAC-516: the three refusals the acceptance criteria name — unverified, expired, replayed — split across the two halves that can actually catch them. This file covers the first two. The third is oauth… |
| `lib/messaging/instagram/parse-events.test.ts` | 26 | header | The first block runs Meta's recorded deliveries (fixtures/, captured 2026-09-17) through the parser. The IDs and text asserted there are the replacements fixtures/README.md documents, typed out here… |
| `lib/messaging/instagram/record-turn.test.ts` | 9 | names | recordInstagramTurnNotRun |
| `lib/messaging/instagram/refresh-profile.test.ts` | 18 +1e | header | The profile refresh, run against the in-memory store (with guests updatable) and a fetch the test controls. The write payloads are pinned whole with toEqual: which columns a refresh touches is the po… |
| `lib/messaging/instagram/refresh-tokens.test.ts` | 15 | header | TAC-516 / TAC-460: the token refresh tick. |
| `lib/messaging/instagram/reply-check.test.ts` | 17 | names | findAnsweringOutbound (ruled 2026-09-19); findReplyToInbound |
| `lib/messaging/instagram/resolve-external.test.ts` | 17 +2e | header | TAC-473: a card answered from the Instagram app clears itself. |
| `lib/messaging/instagram/send-target.test.ts` | 9 +1e | names | loadInstagramSendTarget; readInstagramAccessToken |
| `lib/messaging/instagram/send.test.ts` | 15 +1e | header | The Send API transport, against a fetch the test controls. Response and error bodies follow Meta's documented shapes; none has been captured from a real send yet. The transport smoke test after merge… |
| `lib/messaging/instagram/sender-actions.test.ts` | 10 +1e | header | TAC-540: the sender-action transport, against a fetch the test controls. |
| `lib/messaging/instagram/signed-request.test.ts` | 10 +2e | header | TAC-516: Meta's signed_request parser. |
| `lib/messaging/instagram/summarize-payload.test.ts` | 11 +1e | names | summarizeInstagramPayload |
| `lib/messaging/instagram/token-crypto.test.ts` | 10 | names | instagram token crypto |
| `lib/messaging/instagram/verify-webhook.test.ts` | 18 | names | verifyInstagramSignature; verifyMetaChallengeToken |
| `lib/messaging/instagram/window-import-guard.test.ts` | 5 +1e | header | TAC-469 rule 1, made structural: Instagram's constraints (the 24-hour window, the 1000-byte cap, the reply check, the Send API) never reach the shared or SMS send path. "Branch by channel, don't conv… |
| `lib/messaging/instagram/window.test.ts` | 11 | names | the constants; instagramWindowState; loadLastGuestActionAt |
| `lib/messaging/send.test.ts` | 8 +1e | names | sendMessage — recipient without a phone number (TAC-467); sendMessage — content guard (TAC-309) |
