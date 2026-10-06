import type { NextConfig } from 'next'
import bundleAnalyzer from '@next/bundle-analyzer'

// Opt-in bundle inspection: `ANALYZE=true npm run build` writes the
// treemap reports; a plain build is untouched.
const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === 'true',
})

const nextConfig: NextConfig = {
  // voyageai's published ESM bundle has broken internal paths (directory
  // imports without extensions, missing `local`/`ExtendedClient` modules).
  // transpilePackages forces Next to walk the package's source through the
  // bundler so the internals get resolved/rewritten via the bundler's
  // resolver instead of Node's strict ESM loader.
  transpilePackages: ['voyageai'],
  turbopack: {
    // Pin the workspace root to this checkout. Unset, Turbopack walks up
    // looking for a lockfile, finds several (every `git worktree` under
    // .claude/worktrees/ carries its own, plus whatever sits beside the repo)
    // and picks the OUTERMOST - `/Users/Claude/workspace` on the machine this
    // was found on, meaning the file watcher covered every unrelated repo
    // there. Observed 2026-10-05: a `next dev` in a worktree served one
    // request, then sat at 118% CPU and 862 MB holding port 3000 open,
    // accepting connections and answering none, and ignored SIGTERM. The next
    // `next dev` quietly took port 3001, so the wedged process stayed the one
    // on :3000 and the symptom read as "the playground hangs".
    root: import.meta.dirname,
  },
}

export default withBundleAnalyzer(nextConfig)
