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
}

export default withBundleAnalyzer(nextConfig)
