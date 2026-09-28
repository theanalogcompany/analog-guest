<!-- GENERATED FILE - do not edit by hand. Run `npm run test-map` to regenerate. -->
<!-- Source: scripts/lib/test-map.ts. Enforced by scripts/lib/test-map.test.ts. -->

# Tests in `lib/voices`

6 test files, 61 `it`/`test` declaration sites.

The `source` column says where the summary came from. `header` is the file's own leading
comment, written by someone who read the assertions. `names` is derived from `describe`
names and inherits whatever those names get wrong. Neither is evidence that a behaviour is
covered: use this to pick a file to read, then read the assertion.

| file | cases | source | what it covers |
| --- | --- | --- | --- |
| `lib/voices/classify-critique-pure.test.ts` | 5 | names | buildClassifyCritiqueUserPrompt; ClassifyCritiqueOutputSchema |
| `lib/voices/classify-critique.test.ts` | 3 | names | classifyCritique |
| `lib/voices/find-pattern-cluster-pure.test.ts` | 12 | names | hasEnoughCandidates; buildVerificationPrompt; ClusterVerificationOutputSchema; projectCluster |
| `lib/voices/find-pattern-cluster.test.ts` | 7 | header | eslint-disable @typescript-eslint/no-unused-vars |
| `lib/voices/persist-critique.test.ts` | 5 | header | eslint-disable @typescript-eslint/no-unused-vars |
| `lib/voices/regenerate-with-critique.test.ts` | 29 | header | eslint-disable @typescript-eslint/no-unused-vars |
