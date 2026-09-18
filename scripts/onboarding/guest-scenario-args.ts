// TAC-481. Pure CLI-argument parsing for scripts/run-guest-scenario.ts, split
// out so it's importable from a test without importing the entry script
// itself — same reasoning as extract-venue-spec-args.ts (TAC-346): the entry
// script's unconditional top-level main() call means importing it directly
// would trigger a real run.
import { GUEST_STATES, type GuestState } from '../../lib/recognition/types'

export interface ParsedGuestScenarioArgs {
  venue: string
  guest: GuestState
  scenario: string
  out: string | null
  force: boolean
}

const GUEST_STATE_SET: ReadonlySet<string> = new Set(GUEST_STATES)

export function parseGuestScenarioArgs(argv: string[]): ParsedGuestScenarioArgs | null {
  const args = argv.slice(2)
  let venue: string | null = null
  let guest: string | null = null
  let scenario: string | null = null
  let out: string | null = null
  let force = false

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--venue') {
      venue = args[++i] ?? null
    } else if (a === '--guest') {
      guest = args[++i] ?? null
    } else if (a === '--scenario') {
      scenario = args[++i] ?? null
    } else if (a === '--out') {
      out = args[++i] ?? null
    } else if (a === '--force') {
      force = true
    } else {
      console.error(`[run-guest-scenario] unknown or unexpected argument: ${a}`)
      return null
    }
  }

  if (!venue) {
    console.error('[run-guest-scenario] --venue <slug> is required')
    return null
  }
  if (!guest) {
    console.error('[run-guest-scenario] --guest <new|returning|regular|raving_fan> is required')
    return null
  }
  // Restricted to the four canonical synthetic states — no arbitrary phone
  // number accepted. This, plus assertVenueGuard's hard is_test refusal, is
  // what makes this command unable to point at a real guest however it's
  // invoked (safety by construction, not by convention).
  if (!GUEST_STATE_SET.has(guest)) {
    console.error(
      `[run-guest-scenario] --guest must be one of: ${GUEST_STATES.join(', ')} (got "${guest}")`,
    )
    return null
  }
  if (!scenario) {
    console.error('[run-guest-scenario] --scenario <path> is required')
    return null
  }
  if (force && out === null) {
    console.error('[run-guest-scenario] --force is only meaningful alongside --out')
    return null
  }

  return { venue, guest: guest as GuestState, scenario, out, force }
}
