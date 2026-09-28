<!-- GENERATED FILE - do not edit by hand. Run `npm run test-map` to regenerate. -->
<!-- Source: scripts/lib/test-map.ts. Enforced by scripts/lib/test-map.test.ts. -->

# Tests in `lib/guests`

5 test files, 209 `it`/`test` declaration sites, 4 `.each` tables (each expands to several tests at runtime).

The `source` column says where the summary came from. `header` is the file's own leading
comment, written by someone who read the assertions. `names` is derived from `describe`
names and inherits whatever those names get wrong. Neither is evidence that a behaviour is
covered: use this to pick a file to read, then read the assertion.

| file | cases | source | what it covers |
| --- | --- | --- | --- |
| `lib/guests/commitment-expiry.test.ts` | 35 +1e | names | OBLIGATION_TYPES; horizon constants; venueLocalInstant; venueLocalDate; deriveExpiresAt — recommendations; deriveExpiresAt — comp and discount; deriveExpiresAt — holds; escalationDueAt |
| `lib/guests/commitment-lifecycle-due.test.ts` | 17 | names | processCommitmentLifecycle — escalation; processCommitmentLifecycle — expiry; processCommitmentLifecycle — the escalation guarantee under failure; processCommitmentLifecycle — failure handling |
| `lib/guests/commitments-due.test.ts` | 44 +3e | header | eslint-disable @typescript-eslint/no-unused-vars |
| `lib/guests/commitments.test.ts` | 85 | header | eslint-disable @typescript-eslint/no-unused-vars |
| `lib/guests/context.test.ts` | 28 | header | eslint-disable @typescript-eslint/no-unused-vars |
