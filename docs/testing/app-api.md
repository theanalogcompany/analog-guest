<!-- GENERATED FILE - do not edit by hand. Run `npm run test-map` to regenerate. -->
<!-- Source: scripts/lib/test-map.ts. Enforced by scripts/lib/test-map.test.ts. -->

# Tests in `app/api`

26 test files, 271 `it`/`test` declaration sites, 19 `.each` tables (each expands to several tests at runtime).

The `source` column says where the summary came from. `header` is the file's own leading
comment, written by someone who read the assertions. `names` is derived from `describe`
names and inherits whatever those names get wrong. Neither is evidence that a behaviour is
covered: use this to pick a file to read, then read the assertion.

| file | cases | source | what it covers |
| --- | --- | --- | --- |
| `app/api/cron/commitments-due/route.test.ts` | 7 | names | GET /api/cron/commitments-due |
| `app/api/cron/followups-due/route.test.ts` | 7 | names | GET /api/cron/followups-due |
| `app/api/cron/instagram-scan-greetings/route.test.ts` | 6 | header | TAC-536. The auth tests are the load-bearing ones here: this route is the only scheduled path in the repo that sends an unprompted message to a guest, and it is reachable from the public internet. |
| `app/api/cron/instagram-token-refresh/route.test.ts` | 6 | header | TAC-516: the token-refresh cron route's auth, mirroring commitments-due. |
| `app/api/cron/pending-timeout/route.test.ts` | 9 | names | GET /api/cron/pending-timeout |
| `app/api/cron/webhook-silence/route.test.ts` | 2 | header | The webhook-silence alarm is the only liveness check on Sendblue's webhook. Since TAC-468, Instagram inbound rows land in the same `messages` table, so the alarm must look at text messages only: one… |
| `app/api/instagram/callback/route.test.ts` | 25 +3e | header | TAC-516: the public callback. Every branch renders HTML, and none of them may carry a token, an account id, Meta's error message, or the state. |
| `app/api/instagram/data-deletion/route.test.ts` | 10 +1e | header | TAC-516: Meta's data-deletion callback. Meta tests this endpoint directly, so the response shape is as load-bearing as the deletion itself. |
| `app/api/instagram/data-deletion/status/route.test.ts` | 5 +1e | header | TAC-516: the deletion status page Meta's tester opens. |
| `app/api/instagram/deauthorize/route.test.ts` | 8 +1e | header | TAC-516: Meta's deauthorize callback. |
| `app/api/operator/commitments/[id]/acknowledge/route.test.ts` | 8 | header | Integration tests for POST /api/operator/commitments/[id]/acknowledge (TAC-297, cross-repo sibling TAC-298). |
| `app/api/operator/commitments/[id]/draft-decline/route.test.ts` | 20 +1e | header | Integration tests for POST /api/operator/commitments/[id]/draft-decline (TAC-299, cross-repo sibling TAC-298). |
| `app/api/operator/conversations/route.test.ts` | 4 | names | GET /api/operator/conversations |
| `app/api/operator/devices/route.test.ts` | 10 | names | POST /api/operator/devices |
| `app/api/operator/guests/[guestId]/thread/route.test.ts` | 7 | header | Integration tests for GET /api/operator/guests/[guestId]/thread (TAC-297 plan, Task 7). Sibling to app/api/operator/messages/[id]/thread/route.ts (TAC-277) — same Contract-shaped error bodies, same u… |
| `app/api/operator/messages/[id]/approve/route.test.ts` | 3 | header | TAC-467. dispatchOperatorOutbound refuses a guest with no phone number (an Instagram guest) as `no_phone_number`, before the review_state flip. This route must answer it with exactly the response it… |
| `app/api/operator/messages/[id]/edit/route.test.ts` | 3 | header | TAC-467. dispatchOperatorOutbound refuses a guest with no phone number (an Instagram guest) as `no_phone_number`, before the review_state flip. This route must answer it with exactly the response it… |
| `app/api/operator/messages/[id]/resolve-external/route.test.ts` | 15 +1e | header | TAC-473: POST /api/operator/messages/[id]/resolve-external. |
| `app/api/operator/messages/[id]/skip/route.test.ts` | 8 | header | TAC-530: POST /api/operator/messages/[id]/skip. |
| `app/api/operator/messages/[id]/thread/route.test.ts` | 11 | header | Integration tests for GET /api/operator/messages/[id]/thread (TAC-277). Asserts: - 401 body shape is exactly {error: 'unauthorized'} (NOT err.message — the explicit Contract conformance change vs wit… |
| `app/api/operator/messages/[id]/undo/route.test.ts` | 6 | header | TAC-530: POST /api/operator/messages/[id]/undo. |
| `app/api/operator/queue/route.test.ts` | 5 | header | TAC-530: GET /api/operator/queue. |
| `app/api/operator/venues/[venueId]/instagram/connect/route.test.ts` | 12 +1e | header | TAC-516: the connect endpoint. |
| `app/api/operator/venues/[venueId]/route.test.ts` | 8 | header | TAC-516: the venue-state endpoint. Bodies transcribed from the Contract. |
| `app/api/webhooks/instagram/route.test.ts` | 57 +10e | names | GET /api/webhooks/instagram; POST /api/webhooks/instagram; POST /api/webhooks/instagram with recorded Meta payloads; POST /api/webhooks/instagram saving events; POST /api/webhooks/instagram with the… |
| `app/api/webhooks/sendblue/route.test.ts` | 9 | header | TAC-492: pins how the Sendblue inbound route decides a new guest's created_via, before the Instagram route starts setting 'qr_scan' too. |
