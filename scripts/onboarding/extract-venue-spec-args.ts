// Pure CLI-argument parsing + the overwrite-guard decision for
// scripts/extract-venue-spec.ts, split out (TAC-346) so both can be
// unit-tested without importing the entry script itself. Importing the
// entry script directly would have required a main-module guard comparing
// import.meta.url against process.argv[1] — that comparison is unreliable
// on any path containing characters import.meta.url percent-encodes (this
// repo's own path has spaces and a curly apostrophe), so it silently never
// matches and `npm run extract-venue-spec` would exit without running.
// No main guard, no side effects here — this module is safe to import from
// anywhere.

export interface ParsedArgs {
  slug: string
  dryRun: boolean
  force: boolean
  interviewDate: string | null
}

export function parseArgs(argv: string[]): ParsedArgs | null {
  const args = argv.slice(2)
  let slug: string | null = null
  let dryRun = false
  let force = false
  let interviewDate: string | null = null
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--dry-run') {
      dryRun = true
    } else if (a === '--force') {
      force = true
    } else if (a === '--interview-date') {
      const value = args[i + 1]
      if (!value || value.startsWith('--')) {
        console.error('[extract] --interview-date requires a YYYY-MM-DD value')
        return null
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        console.error(`[extract] --interview-date must be YYYY-MM-DD, got "${value}"`)
        return null
      }
      interviewDate = value
      i++ // consume the value
    } else if (a.startsWith('--')) {
      console.error(`[extract] unknown flag: ${a}`)
      return null
    } else if (!slug) {
      slug = a
    } else {
      console.error(`[extract] unexpected positional arg: ${a}`)
      return null
    }
  }
  if (!slug) return null
  return { slug, dryRun, force, interviewDate }
}

/**
 * TAC-346 overwrite guard, pure so it's unit-testable without mocking Drive.
 * Mirrors seed-venue's hard-refuse-on-existing pattern. --dry-run is exempt
 * (per CLAUDE.md: its whole documented purpose is testing an extraction
 * against a venue that already has a live 06-file without touching it), and
 * --force bypasses it deliberately.
 */
export function shouldRefuseOverwrite(existing06Found: boolean, dryRun: boolean, force: boolean): boolean {
  return existing06Found && !dryRun && !force
}
