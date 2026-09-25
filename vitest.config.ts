import path from 'node:path'
import { defineConfig } from 'vitest/config'

// Mirror tsconfig.json's `paths` so vitest can resolve `@/*` imports inside
// production code when a test imports it transitively. Without this, any test
// that loads a module which uses `@/lib/...` fails at resolve time before
// vi.mock has a chance to intercept. CLAUDE.md previously described the
// workaround as "module-split into a -pure.ts variant"; that pattern still
// applies for cases where heavy SDK init runs at module load (Voyage,
// Supabase admin client), but for normal aliased imports this resolver is
// the cleaner fix. THE-231.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
  test: {
    // Refuses to run on a Node major other than .nvmrc's. See that file's
    // header for why — in short, CI pinned 20 while local ran 24 and nothing
    // noticed. globalSetup runs once per run, before any test file loads, so
    // the mismatch is reported in the first second rather than as a confusing
    // failure somewhere in the suite.
    globalSetup: ['./vitest.node-version.ts'],
    // 15s, up from vitest's implicit 5000ms default (2026-09-25).
    //
    // Until this block existed the file carried ONLY the alias above, so every
    // default was implicit — including the timeout that three intermittent
    // failures were all actually hitting. They looked like three unrelated
    // bugs and were one: vitest runs the forks pool at CPU count, so on a
    // loaded machine a fork can be denied CPU long enough to blow a budget
    // that nothing in the test itself comes close to. The clearest evidence:
    // lib/agent/handle-operator-decline.test.ts failed two runs in three while
    // three heavy processes saturated this machine, then passed five for five
    // on the same commit once they finished.
    //
    // 15s rather than something larger, deliberately. It has to absorb
    // contention without swallowing a real hang — and a couple of tests in
    // this repo use a timeout as a SIGNAL that a `sleep` was reintroduced, so
    // the budget must stay small enough that a genuinely stuck test still
    // fails the run rather than merely slowing it.
    //
    // Per-test overrides still exist where the work is genuinely seconds long
    // (the subprocess-spawning tests in scripts/lib, and linear-cli.test.ts).
    // Those stay: they document at the call site that the cost is intentional,
    // and they survive a future change to this number.
    testTimeout: 15_000,
    // A leftover git worktree under either of these makes vitest collect a
    // SECOND full copy of the repo — recorded in CLAUDE.md as having doubled
    // the test count twice. The workaround was to remember
    // `--exclude '.claude/**'` on the command line, which only protects the
    // person who remembers it. Config holds for every invocation, CI included.
    //
    // vitest's own defaults have to be restated here: supplying `exclude`
    // REPLACES the default list rather than extending it, so dropping
    // node_modules/dist from this array would start collecting those too.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.worktrees/**',
      '**/.claude/**',
    ],
    // REPORT-ONLY, and deliberately no thresholds (2026-09-25).
    //
    // There was no coverage measurement in this repo at all, which made 6,200
    // tests a number nobody could point at a risk. A gate added in the same
    // change would have been worse than none: a threshold set before anyone
    // has read the report becomes a number people write tests to satisfy, and
    // the tests written to satisfy it are the least useful ones. Read the
    // report for a while, find where a floor is genuinely earned, then add it.
    //
    // Opt-in via `--coverage`, so the ordinary run stays fast and CI's
    // existing `npx vitest run` step is unchanged.
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html'],
      // Test files, fixtures and the config itself are not subjects. Without
      // this they inflate the number with code that cannot regress.
      exclude: [
        '**/node_modules/**',
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/testing/**',
        '**/fixtures/**',
        '**/.next/**',
        '*.config.ts',
        'vitest.node-version.ts',
        'db/types.ts',
      ],
    },
  },
})
