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
  },
})
