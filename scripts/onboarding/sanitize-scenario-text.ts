/**
 * TAC-347 Stage 1 (redesign): deterministic register safety net, replacing
 * register-variants.ts's text-reshaping (which is what introduced the em
 * dash and coffee-cup emoji the redesign review flagged). Generation
 * prompts instruct "no em dashes, emoji only occasionally" — this is the
 * backstop for when that instruction doesn't hold, mirroring why
 * lib/ai/generate-message.ts hard-blocks em dashes in production replies
 * (SYSTEM_TEMPLATE's R3 says the same thing in prose and still needed a
 * regex backstop, per CLAUDE.md's TAC-313/THE-225 history) rather than
 * trusting the prompt alone a second time.
 */

const EM_DASH = '—'
const EN_DASH = '–'

/**
 * Replace em/en dashes with the punctuation a real text message would use
 * in that position: ", " when the dash joins two clauses with surrounding
 * spaces, "-" when it's tight against non-space characters (a range like
 * "9-5" or a hyphenated word).
 */
export function stripLongDashes(text: string): string {
  return text.replace(/\s*[—–]\s*/g, (match) => {
    const spaced = match.startsWith(' ') || match.endsWith(' ')
    return spaced ? ', ' : '-'
  })
}

export function sanitizeScenarioText(text: string): string {
  return stripLongDashes(text).trim()
}

/** True if the text contains a long dash — used to log/count sanitizer hits. */
export function containsLongDash(text: string): boolean {
  return text.includes(EM_DASH) || text.includes(EN_DASH)
}

/**
 * Apply the sanitizer to every scenario's guest-facing/reviewer-facing text
 * field. Returns the sanitized array plus a count of scenarios that
 * actually needed a fix, so the CLI can report how often the prompt
 * instruction alone didn't hold.
 */
export function sanitizeScenarios<
  T extends { inbound_message: string; scenario: string; expected_facts: string[] },
>(scenarios: T[]): { scenarios: T[]; dashHitCount: number } {
  let dashHitCount = 0
  const sanitized = scenarios.map((s) => {
    const hit =
      containsLongDash(s.inbound_message) ||
      containsLongDash(s.scenario) ||
      s.expected_facts.some(containsLongDash)
    if (hit) dashHitCount += 1
    return {
      ...s,
      inbound_message: sanitizeScenarioText(s.inbound_message),
      scenario: sanitizeScenarioText(s.scenario),
      expected_facts: s.expected_facts.map(sanitizeScenarioText),
    }
  })
  return { scenarios: sanitized, dashHitCount }
}
