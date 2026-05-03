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
})
