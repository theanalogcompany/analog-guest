<!-- GENERATED FILE - do not edit by hand. Run `npm run test-map` to regenerate. -->
<!-- Source: scripts/lib/test-map.ts. Enforced by scripts/lib/test-map.test.ts. -->

# Tests in `lib/operator`

11 test files, 231 `it`/`test` declaration sites, 11 `.each` tables (each expands to several tests at runtime).

The `source` column says where the summary came from. `header` is the file's own leading
comment, written by someone who read the assertions. `names` is derived from `describe`
names and inherits whatever those names get wrong. Neither is evidence that a behaviour is
covered: use this to pick a file to read, then read the assertion.

| file | cases | source | what it covers |
| --- | --- | --- | --- |
| `lib/operator/conversations.test.ts` | 12 | header | lib/operator/conversations.test.ts |
| `lib/operator/dispatch-instagram-outbound.test.ts` | 19 +1e | names | prepareInstagramOperatorSend: checked before the card leaves the queue; restoreCardAfterRefusedSend: a refused send stays a card (rule 4); stampInstagramOperatorSend: the echo got here first (rule 6)… |
| `lib/operator/dispatch-intentions.test.ts` | 26 | header | TAC-385 PR 1. Recording the ask on the operator-approved and operator-edited dispatch paths. |
| `lib/operator/dispatch-operator-outbound.test.ts` | 32 +1e | header | TAC-309. Coverage for the empty-body refusal on the operator dispatch path. |
| `lib/operator/guest-thread.test.ts` | 7 | names | loadGuestThreadByGuestId |
| `lib/operator/heads-up-queue.test.ts` | 13 | header | eslint-disable @typescript-eslint/no-unused-vars |
| `lib/operator/instagram-fields.test.ts` | 18 | header | TAC-473: the three Contract fields, at the unit level. |
| `lib/operator/queue.test.ts` | 64 +5e | names | listPendingQueue; listPendingQueue: what approving creates (TAC-527); listPendingQueue: the replied-to message (TAC-534) |
| `lib/operator/reached-guest-condition.test.ts` | 15 +2e | header | TAC-395: one condition, written in three places, kept in step here. |
| `lib/operator/thread.test.ts` | 13 | header | Offline tests for loadGuestThread's lookup + projection layer (TAC-277). Mirrors the queue.test.ts shape: mock the admin client at the boundary, drive the supabase-js fluent builder via vi.fn returni… |
| `lib/operator/venue-connection.test.ts` | 12 +2e | header | TAC-516: venue connection state. |
