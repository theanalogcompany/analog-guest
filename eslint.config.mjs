import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Local scratch dir (see tsconfig.json + .gitignore for symmetry).
    "scripts/sandbox/**",
    // A worktree parked here would otherwise be linted as part of this
    // checkout, the same hazard vitest.config.ts excludes it for.
    ".worktrees/**",
    ".claude/**",
  ]),
]);

export default eslintConfig;
