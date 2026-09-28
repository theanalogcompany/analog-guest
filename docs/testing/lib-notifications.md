<!-- GENERATED FILE - do not edit by hand. Run `npm run test-map` to regenerate. -->
<!-- Source: scripts/lib/test-map.ts. Enforced by scripts/lib/test-map.test.ts. -->

# Tests in `lib/notifications`

7 test files, 122 `it`/`test` declaration sites.

The `source` column says where the summary came from. `header` is the file's own leading
comment, written by someone who read the assertions. `names` is derived from `describe`
names and inherits whatever those names get wrong. Neither is evidence that a behaviour is
covered: use this to pick a file to read, then read the assertion.

| file | cases | source | what it covers |
| --- | --- | --- | --- |
| `lib/notifications/apns/client.test.ts` | 12 | names | sendApnsRequest |
| `lib/notifications/apns/env.test.ts` | 16 | names | checkApnsEnv — happy path; checkApnsEnv — missing vars; checkApnsEnv — APNS_AUTH_KEY shape; checkApnsEnv — identifiers and host selection |
| `lib/notifications/apns/jwt.test.ts` | 6 | names | getApnsJwt |
| `lib/notifications/push-policy.test.ts` | 11 | header | Drift guard for the draft-flagged push fire-set. |
| `lib/notifications/send-commitment-push.test.ts` | 21 | names | buildArrivalContext; buildCommitmentPushBody; sendCommitmentArrivalPush — privacy invariant + payload shape |
| `lib/notifications/send-instagram-window-push.test.ts` | 16 | header | TAC-473: the one-hour Instagram reply-window warning push. |
| `lib/notifications/send.test.ts` | 40 | names | shouldSendDraftFlaggedPush; buildPushTitle / buildPushBody (TAC-532); sendDraftFlaggedPush; sendDraftFlaggedPush — generation_failed context (TAC-364) |
