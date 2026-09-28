<!-- GENERATED FILE - do not edit by hand. Run `npm run test-map` to regenerate. -->
<!-- Source: scripts/lib/test-map.ts. Enforced by scripts/lib/test-map.test.ts. -->

# Tests in `lib/auth`

7 test files, 72 `it`/`test` declaration sites, 2 `.each` tables (each expands to several tests at runtime).

The `source` column says where the summary came from. `header` is the file's own leading
comment, written by someone who read the assertions. `names` is derived from `describe`
names and inherits whatever those names get wrong. Neither is evidence that a behaviour is
covered: use this to pick a file to read, then read the assertion.

| file | cases | source | what it covers |
| --- | --- | --- | --- |
| `lib/auth/get-current-operator.test.ts` | 4 | names | getCurrentOperator |
| `lib/auth/link-operator.test.ts` | 14 | names | linkOperatorByAuthUser |
| `lib/auth/normalize-phone.test.ts` | 7 | names | authUserPhoneToE164 |
| `lib/auth/operator-auth.test.ts` | 5 | names | withOperatorAuth |
| `lib/auth/venue-scope.test.ts` | 17 +2e | header | TAC-530. The three-way that the old `allowedVenueIds: string[]` could not express: fleet-wide, a real grant list, and a grant list that is EMPTY. |
| `lib/auth/verify-analog-admin.test.ts` | 12 | names | verifyAnalogAdminRequest (bearer); verifyAnalogAdminAccess (session) |
| `lib/auth/verify-jwt.test.ts` | 13 | names | verifyOperatorRequest |
