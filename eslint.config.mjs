import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'
import prettierCompat from 'eslint-config-prettier'

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    // Local scratch dir (see tsconfig.json + .gitignore for symmetry).
    'scripts/sandbox/**',
    // A worktree parked here would otherwise be linted as part of this
    // checkout.
    '.worktrees/**',
    '.claude/**',
  ]),
  // CLAUDE.md's "never import `langfuse` directly from app code" boundary,
  // enforced rather than merely documented. lib/observability/ is the one
  // wrapper allowed to touch the SDK.
  {
    files: ['**/*.{ts,tsx}'],
    ignores: ['lib/observability/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'langfuse',
              message:
                'Import from @/lib/observability instead - app code never touches the langfuse SDK directly.',
            },
          ],
        },
      ],
    },
  },
  // Turn off any stylistic rules that would fight Prettier; formatting is
  // Prettier's job (npx prettier --check . in CI, --write via lint-staged).
  prettierCompat,
])

export default eslintConfig
