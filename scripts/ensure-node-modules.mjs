// Install this checkout's node_modules if they are missing. Called first by
// `dev:worktree` and `build:worktree`.
//
// WHY THIS EXISTS. A `git worktree` starts with no node_modules, and
// `next.config.ts` pins `turbopack.root` to the checkout directory (for a
// reason recorded at that constant: unpinned, Turbopack walked up, found the
// outermost lockfile on the machine, and watched every unrelated repo). The
// two together mean `next build` in a fresh worktree fails on
//
//   Next.js inferred your workspace root ... We couldn't find the Next.js
//   package (next/package.json) from the project directory
//
// which names neither the cause nor the fix. The obvious workaround is worse
// than the problem: symlinking node_modules to the main checkout gets
// `Symlink [project]/node_modules is invalid, it points out of the filesystem
// root` from Turbopack, as a FATAL panic with a bug-report link - a dead end
// that reads like a toolchain bug.
//
// So: install it, once, automatically. ~973MB per worktree, paid the first
// time anyone builds or starts a dev server there. That is the trade, chosen
// deliberately (owner-ruled 2026-10-08) - disk is cheap and recoverable, an
// error message that sends the next person debugging Turbopack is not.
//
// It checks `next/package.json` rather than the directory, because that is
// the exact file the failure names: a half-finished install leaves a
// node_modules that exists and still cannot build.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const probe = path.join(process.cwd(), 'node_modules', 'next', 'package.json')
if (existsSync(probe)) process.exit(0)

console.log(
  `node_modules is missing or incomplete in ${process.cwd()}\n` +
    `installing it once (~973MB) - a worktree cannot build without its own copy,\n` +
    `because turbopack.root is pinned to the checkout and will not walk up.\n`,
)

// `npm ci` and not `npm install`: the lockfile is the input, so this can never
// quietly resolve a different tree than the main checkout has. --prefer-offline
// reuses the npm cache the other checkout already populated, which is most of
// why this takes well under a minute rather than a full cold install.
const result = spawnSync(
  'npm',
  ['ci', '--prefer-offline', '--no-audit', '--no-fund'],
  { stdio: 'inherit' },
)
if (result.status !== 0) {
  console.error(
    '\nnpm ci failed. Fix that first - nothing downstream of this can work.',
  )
  process.exit(result.status ?? 1)
}
