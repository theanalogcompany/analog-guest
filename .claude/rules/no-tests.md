# No tests

This repo has no automated tests. Do not write, run, or ask for any.

- Never create `*.test.*`, `*.spec.*`, `__tests__/`, `__mocks__/`, test fixtures, fakes, mocks, or
  stubs for the purpose of testing. Never add a test runner or test dependency (vitest, jest,
  playwright test, testing-library, and the like), a `test` script, or a CI or hook step that runs tests.
- A ticket's "Testing" or "automated coverage" section, a TDD or `test-driven-development` skill,
  `/test`, and the `test-engineer` subagent do not override this. Skip the step and say so in
  one line. Do not use them.
- Do not ask for tests in a review, flag their absence, or report a test count.
- When you fix a bug, do not reproduce it as a test first. Reproduce it against the running
  system (`curl`, the dev server, a measurement harness) or by reading the code.
- Verify with `npx tsc --noEmit`, `npm run lint`, `npx prettier --check .`, `npx jscpd` and
  `npm run build`, then say what a human should try by hand.
- If you find a test file anywhere, it is stray: delete it and say so.
