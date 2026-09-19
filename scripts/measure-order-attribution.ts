/**
 * TAC-483. Measures how often the generator conflates two differently named,
 * differently dated guest-reported items into one claimed repeat/streak —
 * the failure caught in production at Le Mil's on 2026-09-18 ("i got the
 * blossom tonic" / "oh and i got the pink panther yesterday" -> "the Pink
 * Panther two days in a row").
 *
 * SHIPS NO FIX. Per the 2026-09-18 ruling on this ticket: this is
 * measurement tooling only, so a baseline can be captured under the CURRENT
 * prompt before any wording is proposed or approved. Do not read a run of
 * this script as evidence a fix works — there is no fix in this file, and
 * none is applied by it. When a prompt change eventually lands, re-running
 * this script against the new PROMPT_VERSION is what produces the "after"
 * number; this file needs no change to do that, since it always calls the
 * live generateMessage.
 *
 * Does NOT touch lib/ai/verify-grounding.ts. It calls verifyGrounding
 * unmodified, as a read-only oracle — the same real check that caught the
 * incident in production (review_reason='knowledge_gap_backstop').
 *
 * Needs a real ANTHROPIC_API_KEY. CI has none and makes no external service
 * calls (see CLAUDE.md's CI section) — this script cannot run there and this
 * PR does not claim to have run it. It is a manual step with real
 * credentials, gated the same way this ticket's own `QA: Device` label
 * gates real-conversation verification.
 *
 * Run: npm run measure-order-attribution -- [--n 20] [--variants 1,2,3]
 */
import { generateMessage } from '@/lib/ai/generate-message'
import type { GenerateMessageInput, RecentMessage } from '@/lib/ai/types'
import { verifyGrounding } from '@/lib/ai/verify-grounding'
import { BrandPersonaSchema, VenueInfoSchema, type BrandPersona, type VenueInfo } from '@/lib/schemas'
import type { MessageChannel } from '@/lib/schemas/message-channel'
import { scoreConflationClaims } from './measure-order-attribution-scoring'

const DEFAULT_N = 20

// The channel copy every generation is measured under. 'text' (Sendblue), not
// 'instagram' and not null, because the incident this replays happened there:
// the held draft is channel 'text' and the guest has a phone number and no
// Instagram ID. It is also the only copy any Le Mil's guest gets today, since
// the agent does not run for Instagram guests until TAC-469 lifts its gate.
// Null would render the Instagram wording (TAC-495), which is a different
// prompt from the one being measured. Held fixed so a later "after" run
// compares against the same channel copy.
const CHANNEL: MessageChannel = 'text'

type VariantId = 1 | 2 | 3
const ALL_VARIANT_IDS: readonly VariantId[] = [1, 2, 3]

type Variant = {
  id: VariantId
  label: string
  // Stated up front, per the ticket's own "state the bar before running"
  // discipline (TAC-401) — what a run of THIS variant is checking for, not
  // what the numbers turn out to say.
  whatThisChecks: string
  recentMessages: RecentMessage[]
  currentMessage: string
}

const NOW = new Date('2026-09-18T18:00:00.000Z')

function minutesAgo(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60_000)
}

// Variant 1: the incident shape, replayed. Two DIFFERENT items, on two
// DIFFERENT named days, one message apart — the exact Le Mil's exchange from
// the ticket. A correct reply keeps the two separate; "two days in a row" or
// equivalent here is a defect.
const VARIANT_1: Variant = {
  id: 1,
  label: 'incident (two different items, two different named days)',
  whatThisChecks:
    'Does the reply claim a repeat/streak that never happened? This is the incident itself, replayed. The bar for a proposed fix is 0/N here; the baseline under the CURRENT prompt is unknown until this runs.',
  recentMessages: [
    { direction: 'inbound', body: 'i got the blossom tonic', createdAt: minutesAgo(2), delivery: 'delivered' },
    {
      direction: 'outbound',
      body: "one of my favorites, honestly. how'd you like it?",
      createdAt: minutesAgo(1),
      delivery: 'delivered',
    },
  ],
  currentMessage: 'oh and i got the pink panther yesterday',
}

// Variant 2: the control. Guest genuinely reports the SAME item on both
// days — a legitimate streak. The guest's own words license the claim (see
// verify-grounding.ts's "Lines marked [guest, ...] ... ARE legitimate
// grounding"), so a reply that notices the repeat here is CORRECT and must
// not read as the defect. A fix that suppresses this is a worse outcome than
// the bug — see the dual-direction guard note under "what this checks".
const VARIANT_2: Variant = {
  id: 2,
  label: 'control (same item, genuinely reported on both days)',
  whatThisChecks:
    'Guardrail against overcorrection: a flag here on a genuine repeat would mean a fix suppressed something true. The bar is UNCHANGED (0 new flags) before and after any prompt change — this variant should stay clean under both the current prompt and any proposed fix.',
  recentMessages: [
    { direction: 'inbound', body: 'i got the blossom tonic', createdAt: minutesAgo(2), delivery: 'delivered' },
    {
      direction: 'outbound',
      body: "one of my favorites, honestly. how'd you like it?",
      createdAt: minutesAgo(1),
      delivery: 'delivered',
    },
  ],
  currentMessage: 'i got the blossom tonic yesterday too',
}

// Variant 3: both items named in a single message, not across turns — checks
// whether the failure is specific to the two-turn shape of the incident or
// generalizes to one message stating both facts at once.
const VARIANT_3: Variant = {
  id: 3,
  label: 'single message (both items and both days named at once)',
  whatThisChecks:
    'Does the conflation survive when there is no cross-turn attribution step at all — both facts sit in one message? A different flag rate here than variant 1 would mean the failure is turn-boundary-specific, not a general attribution error.',
  recentMessages: [],
  currentMessage: 'i got the blossom tonic today and the pink panther yesterday',
}

const VARIANTS: readonly Variant[] = [VARIANT_1, VARIANT_2, VARIANT_3]

function makePersona(): BrandPersona {
  // Representative fixture, not real Le Mil's config — same posture
  // generate-message.test.ts uses for its own fixtures. The failure this
  // measures is a cross-turn attribution error, not persona-dependent.
  return BrandPersonaSchema.parse({
    tone: 'warm, direct, a little playful',
    formality: 'casual',
    speakerFraming: 'venue',
    emojiPolicy: 'sparingly',
    lengthGuide: 'short — 1-2 sentences',
  })
}

function makeVenueInfo(): VenueInfo {
  return VenueInfoSchema.parse({
    address: { line1: '123 Coffee St', city: 'Testville', region: 'CA', postalCode: '94000' },
  })
}

function buildInput(variant: Variant): GenerateMessageInput {
  return {
    category: 'reply',
    persona: makePersona(),
    venueInfo: makeVenueInfo(),
    ragChunks: [{ id: 'c1', text: 'sample voice corpus chunk', sourceType: 'sample_text' }],
    knowledgeChunks: [],
    runtime: {
      inboundMessage: variant.currentMessage,
      recentMessages: variant.recentMessages,
      today: {
        isoDate: '2026-09-18',
        dayOfWeek: 'Friday',
        venueLocalTime: '14:00',
        venueTimezone: 'America/Los_Angeles',
      },
    },
    channel: CHANNEL,
  }
}

type GenerationOutcome = {
  attempt: number
  generation: { ok: true; body: string; voiceFidelity: number } | { ok: false; error: string }
  // null only when generation itself failed, so verifyGrounding never ran.
  verify:
    | { ok: true; hasUngroundedClaim: boolean; ungroundedClaims: string[] }
    | { ok: false; error: string }
    | null
  conflationShaped: boolean
  matchedClaims: string[]
}

async function runOneAttempt(variant: Variant, attempt: number): Promise<GenerationOutcome> {
  const input = buildInput(variant)
  const genResult = await generateMessage(input)
  if (!genResult.ok) {
    return {
      attempt,
      generation: { ok: false, error: genResult.error },
      verify: null,
      conflationShaped: false,
      matchedClaims: [],
    }
  }

  // Reuse verifyGrounding unmodified, as a read-only oracle, passing the SAME
  // inputs it gets in production: the composed USER PROMPT this exact
  // generation call produced (never a re-derived summary — see
  // VerifyGroundingInput.runtimeContext's own contract), the same venueInfo,
  // and [] for knowledgeChunks (this fixture retrieves none).
  const verifyResult = await verifyGrounding({
    inboundBody: variant.currentMessage,
    replyBody: genResult.data.body,
    venueInfo: input.venueInfo,
    knowledgeChunks: [],
    runtimeContext: genResult.data.userPrompt,
    isProactive: false,
  })

  if (!verifyResult.ok) {
    return {
      attempt,
      generation: { ok: true, body: genResult.data.body, voiceFidelity: genResult.data.voiceFidelity },
      verify: { ok: false, error: verifyResult.error },
      conflationShaped: false,
      matchedClaims: [],
    }
  }

  const score = scoreConflationClaims(verifyResult.data.ungroundedClaims)
  return {
    attempt,
    generation: { ok: true, body: genResult.data.body, voiceFidelity: genResult.data.voiceFidelity },
    verify: {
      ok: true,
      hasUngroundedClaim: verifyResult.data.hasUngroundedClaim,
      ungroundedClaims: verifyResult.data.ungroundedClaims,
    },
    conflationShaped: score.isConflationShaped,
    matchedClaims: score.matchedClaims,
  }
}

async function runVariant(variant: Variant, n: number): Promise<GenerationOutcome[]> {
  const outcomes: GenerationOutcome[] = []
  for (let i = 1; i <= n; i++) {
    const outcome = await runOneAttempt(variant, i)
    outcomes.push(outcome)
    const marker = outcome.conflationShaped ? 'CONFLATION' : outcome.verify?.ok && outcome.verify.hasUngroundedClaim ? 'flagged (other)' : 'clean'
    console.log(`  [${i}/${n}] ${marker}`)
  }
  return outcomes
}

function printVariantSummary(variant: Variant, outcomes: GenerationOutcome[]): void {
  const total = outcomes.length
  const genFailures = outcomes.filter((o) => !o.generation.ok)
  const verifyFailures = outcomes.filter((o) => o.verify !== null && !o.verify.ok)
  const flagged = outcomes.filter((o) => o.verify?.ok && o.verify.hasUngroundedClaim)
  const conflationShaped = outcomes.filter((o) => o.conflationShaped)

  console.log(`\n--- Summary: variant ${variant.id} — ${variant.label} ---`)
  console.log(`generations: ${total}`)
  if (genFailures.length > 0) console.log(`generateMessage failures: ${genFailures.length}/${total}`)
  if (verifyFailures.length > 0) console.log(`verifyGrounding failures: ${verifyFailures.length}/${total}`)
  console.log(`flagged by verifyGrounding (any ungrounded claim): ${flagged.length}/${total}`)
  console.log(`conflation-shaped flags (heuristic match, see scoring file): ${conflationShaped.length}/${total}`)

  if (flagged.length > 0) {
    console.log('\nFlagged replies, raw text for a human to read (a keyword match alone can miscount):')
    for (const o of flagged) {
      if (!o.generation.ok || !o.verify?.ok) continue
      console.log(`  [attempt ${o.attempt}] body: ${JSON.stringify(o.generation.body)}`)
      for (const claim of o.verify.ungroundedClaims) {
        console.log(`    claim: ${claim}`)
      }
    }
  }
}

function parseArgs(argv: readonly string[]): { n: number; variantIds: readonly VariantId[] } {
  let n = DEFAULT_N
  let variantIds: readonly VariantId[] = ALL_VARIANT_IDS
  const args = argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--n') {
      const value = args[i + 1]
      const parsed = value ? Number.parseInt(value, 10) : NaN
      if (!Number.isFinite(parsed) || parsed <= 0) {
        console.error(`✗ --n requires a positive integer, got "${value}"`)
        process.exit(1)
      }
      n = parsed
      i++
    } else if (a === '--variants') {
      const value = args[i + 1]
      const ids = (value ?? '')
        .split(',')
        .map((s) => Number.parseInt(s.trim(), 10))
      if (ids.length === 0 || ids.some((id) => !ALL_VARIANT_IDS.includes(id as VariantId))) {
        console.error(`✗ --variants must be a comma-separated list from {1,2,3}, got "${value}"`)
        process.exit(1)
      }
      variantIds = ids as VariantId[]
      i++
    } else {
      console.error(`✗ unknown flag: ${a}`)
      process.exit(1)
    }
  }
  return { n, variantIds }
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      '✗ missing env var: ANTHROPIC_API_KEY — this script calls the real Anthropic API (generateMessage + verifyGrounding, both unmodified) and needs real credentials. It cannot run in CI.',
    )
    process.exit(1)
  }

  const { n, variantIds } = parseArgs(process.argv)
  const variants = VARIANTS.filter((v) => variantIds.includes(v.id))

  console.log('TAC-483 order-attribution measurement — ships no fix, measures the live prompt as-is.')
  console.log(`N=${n} per variant. Variants: ${variantIds.join(', ')}. Channel copy: ${CHANNEL}\n`)

  const allSummaries: Array<{ variant: Variant; outcomes: GenerationOutcome[] }> = []
  for (const variant of variants) {
    console.log(`=== Variant ${variant.id}: ${variant.label} ===`)
    console.log(variant.whatThisChecks)
    const outcomes = await runVariant(variant, n)
    allSummaries.push({ variant, outcomes })
  }

  for (const { variant, outcomes } of allSummaries) {
    printVariantSummary(variant, outcomes)
  }
}

main().catch((e: unknown) => {
  const message = e instanceof Error ? e.message : String(e)
  console.error(`✗ unexpected error: ${message}`)
  process.exit(1)
})
