<!-- GENERATED FILE - do not edit by hand. Run `npm run test-map` to regenerate. -->
<!-- Source: scripts/lib/test-map.ts. Enforced by scripts/lib/test-map.test.ts. -->

# Tests in `lib/pos`

12 test files, 70 `it`/`test` declaration sites.

The `source` column says where the summary came from. `header` is the file's own leading
comment, written by someone who read the assertions. `names` is derived from `describe`
names and inherits whatever those names get wrong. Neither is evidence that a behaviour is
covered: use this to pick a file to read, then read the assertion.

| file | cases | source | what it covers |
| --- | --- | --- | --- |
| `lib/pos/credentials-store.test.ts` | 4 | header | eslint-disable @typescript-eslint/no-explicit-any |
| `lib/pos/crypto.test.ts` | 4 | names | token crypto |
| `lib/pos/devices.test.ts` | 4 | names | device token hashing; deriveTapToken; buildDeviceEvents |
| `lib/pos/reconcile-tap.test.ts` | 9 | header | eslint-disable @typescript-eslint/no-explicit-any |
| `lib/pos/reconcile.test.ts` | 8 | header | eslint-disable @typescript-eslint/no-explicit-any |
| `lib/pos/square/client.test.ts` | 3 | names | resolveSquareEnv |
| `lib/pos/square/map.test.ts` | 13 | names | mapSquarePaymentToTransaction; mapSquareOrderLineItems; mapSquareInventoryCounts; mapSquareCatalogObjects |
| `lib/pos/square/oauth-state.test.ts` | 4 | names | OAuth state signing |
| `lib/pos/square/oauth.test.ts` | 4 | names | buildSquareAuthorizeUrl |
| `lib/pos/square/parse-webhook.test.ts` | 5 | names | parseSquareWebhook |
| `lib/pos/square/verify-webhook.test.ts` | 5 | names | verifySquareWebhook |
| `lib/pos/sync.test.ts` | 7 | header | eslint-disable @typescript-eslint/no-explicit-any |
