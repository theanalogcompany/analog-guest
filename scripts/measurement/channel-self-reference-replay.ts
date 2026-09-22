// TAC-502: does handing the verifier the conversation's channel stop it
// flagging true statements about that channel, WITHOUT making anything else
// permissible?
//
// A verifier-only replay against hand-built, self-contained fixtures. No
// database, no venue lookup, no generation, no send — only `verifyGrounding`
// runs, so the bodies cannot drift underneath the thing being measured and the
// script is re-runnable whenever this prompt changes. It needs
// ANTHROPIC_API_KEY and therefore cannot run in CI, same posture as
// measure-order-attribution.ts and prose-promise-catch-rate.ts.
//
// TWO ARMS, ONE VARIABLE — whether the `## Conversation channel` section is in
// the source material.
//
//   arm `channel` — conversationChannel is the fixture's real channel, so the
//                   section renders. This is what production does after this
//                   ticket.
//   arm `null`    — conversationChannel is null, so the section does not
//                   render at all. This reproduces the SOURCE MATERIAL a
//                   pre-TAC-502 call had.
//
// BE PRECISE ABOUT WHAT THE `null` ARM IS, because it is easy to overclaim: it
// runs against the v1.6.0 SYSTEM PROMPT, which carries the new bullet. It is
// "new prompt, no channel section", not "the old prompt". That is the right
// control for the question being asked — the bullet is explicitly conditional
// on the section ("When a '## Conversation channel' section is present below")
// so with no section it has no referent — but it is NOT a measurement of
// v1.5.0 and must not be reported as one.
//
// WHAT EACH ARM HAS TO SHOW:
//
//   - The two self-reference fixtures must flag in the `null` arm. If they do
//     not, the replay has not reproduced the defect and it can say nothing
//     about whether the fix addressed it. This is the arm-integrity check, and
//     it is the reason the control arm exists at all.
//   - The same two must go clean in the `channel` arm. That is AC2, on both
//     channels — the Instagram half being the gap the audit named, since every
//     prior run on this defect hard-coded text.
//   - The four flag fixtures must flag in BOTH arms. Two of them are TAC-501's
//     shape (a number named for someone who is not in this conversation) and
//     two are the genuine production catches AC5 names. An exemption that
//     leaked would show up here as a flag fixture going clean in the `channel`
//     arm only.
//
// N REPEATS PER CELL, NOT 1. The verifier runs at temperature 0.2, so one
// verdict is a draw from a distribution and not a property of the body. This
// repo has a documented case (TAC-409) of eight drafts reasoned about as eight
// behaviours when a replay showed three had no stable verdict at all. A single
// draw per cell would reproduce that mistake exactly.
//
// TELEMETRY: this calls lib/ai/verify-grounding.ts directly, not the stage, so
// it fires no PostHog event and no Slack relay. It also means the stage's skip
// conditions and its TAC-424 retry are not exercised here. What is under test
// is the check's JUDGEMENT, which is the thing a prompt change moves.
//
// Run: npm run measure-channel-self-reference
//      REPEATS=5 npm run measure-channel-self-reference

import { verifyGrounding, VERIFY_GROUNDING_PROMPT_VERSION } from '@/lib/ai/verify-grounding'
import type { MessageChannel } from '@/lib/schemas/message-channel'
import { VenueInfoSchema, type VenueInfo } from '@/lib/schemas'
import { createRunLog } from './run-log'

/** Repeats per cell. One verdict at temperature 0.2 is a draw, not a property. */
const REPEATS = Number(process.env.REPEATS ?? '5')
/** Cells judged concurrently. Keeps the run to a couple of minutes without 429s. */
const CONCURRENCY = Number(process.env.CONCURRENCY ?? '4')

const ARMS = ['channel', 'null'] as const
type Arm = (typeof ARMS)[number]

/**
 * Le Mil's shape, which is the configuration the defect turns on: a venue with
 * NO public phone number, correctly, because it does not have one. Nothing in
 * `contact` can ever support a claim about texting, which is what made the
 * static contact list the wrong place for the verifier to look.
 *
 * Hand-built rather than loaded, so this script has no database dependency and
 * the fixture cannot change underneath a re-run. Not a copy of any production
 * row: the address and menu are invented, and only the properties the
 * measurement turns on (no phone, holds unavailable) mirror the real venue.
 */
function leMilsShaped(overrides: Record<string, unknown> = {}): VenueInfo {
  // PARSED, never cast. The first version of this fixture was
  // `{...} as VenueInfo` with menu items shaped `{name, priceCents}` — a
  // field that does not exist, against a schema that requires `category` and
  // `isOffMenu`. The cast made it compile, `formatMenuItems` threw on
  // `a.category.localeCompare`, and ALL 60 calls failed. The run then printed
  // "flagged 0/5 ... as expected" for the two fixtures whose clean result is
  // the entire claim, because a failed call and a clean verdict were both
  // zero flags. Parsing is what makes a malformed fixture fail loudly at
  // startup instead of arriving as a green measurement.
  return VenueInfoSchema.parse({
    address: {
      line1: '1 Example Ave',
      city: 'San Francisco',
      region: 'CA',
      postalCode: '94110',
    },
    contact: {
      publicEmail: 'shopper@example.com',
      website: 'https://example.com',
    },
    hours: {
      monday: '7:00 AM \u2013 3:00 PM',
      tuesday: '7:00 AM \u2013 3:00 PM',
      wednesday: '7:00 AM \u2013 3:00 PM',
      thursday: '7:00 AM \u2013 3:00 PM',
      friday: '7:00 AM \u2013 3:00 PM',
      saturday: '8:00 AM \u2013 3:00 PM',
      sunday: '8:00 AM \u2013 3:00 PM',
    },
    menu: {
      highlights: [],
      items: [
        { name: 'Pink Panther', category: 'drinks', price: 7, isOffMenu: false },
        { name: 'Blossom Tonic', category: 'drinks', price: 7, isOffMenu: false },
        { name: 'Olive Oil Cake', category: 'pastry', price: 6, isOffMenu: false },
      ],
    },
    staff: [],
    currentContext: [],
    ...overrides,
  })
}

/**
 * A plausible composed user prompt. `runtimeContext` is the generator's own
 * prompt verbatim in production; here it is hand-built, which is fine because
 * every fixture's claim is judged against what this string does or does not
 * contain, and each fixture says which.
 */
function runtimeContext(blocks: string[]): string {
  return [
    '## Right now',
    '- Date: Saturday, 2026-09-20',
    '- Time at venue: 11:14 AM (America/Los_Angeles)',
    '- Status: OPEN right now, closes at 3:00 PM.',
    ...blocks,
  ].join('\n\n')
}

const NO_PERKS = [
  '## What this guest can access',
  "Nothing right now beyond the standard menu and answering questions. There's nothing set aside for this guest to be recognized with yet. Do not offer perks of any kind. Do not offer comps, remakes, replacements, or discounts either. None of those are available for this guest.",
].join('\n')

interface Fixture {
  id: string
  /**
   * What the `channel` arm must do — the claim under test, judged strictly
   * (every repeat).
   *
   * It also decides what the `null` arm's job is, because the two kinds of
   * fixture ask the null arm for different things:
   *
   *   `no_flag` (a self-reference body) — the null arm is the CONTROL and has
   *     to REPRODUCE the defect: flag at least once, and more often than the
   *     channel arm. It is NOT held to every repeat. The defect is a
   *     probabilistic verdict at temperature 0.2, not a deterministic rule,
   *     and the ticket's own prior measurement reported cells at 5/5 and 1/5
   *     as both being evidence of it. Requiring 5/5 here would be importing
   *     the channel arm's strictness into a question it does not fit.
   *     (Loosened after the first real run, which returned 2/5 and 4/5 —
   *     recorded as a criterion change, not applied silently.)
   *
   *   `flag` (a boundary or production-catch body) — both arms are held
   *     strictly. These test rules that should not depend on chance, and a
   *     channel arm that went clean while the null arm flagged is precisely
   *     the leak this set exists to detect.
   */
  expect: 'flag' | 'no_flag'
  channel: MessageChannel
  inboundBody: string
  body: string
  venueInfo: VenueInfo
  runtimeContext: string
  /**
   * For a `flag` fixture: a pattern at least one NAMED claim must match.
   *
   * Without it a cell can score 10/10 for the wrong reason and read as
   * covered. `hold_promise_no_holds` is the case that makes this necessary:
   * the reply contains both a hold promise AND a channel-adjacent line, so
   * flagging only the channel line would be a FALSE POSITIVE scoring as a
   * pass on the fixture that exists to prove the hold still flags. That is
   * the `comp_regex_backstop` shape this repo documents — a gate whose green
   * signal was never checked against what it actually fired on.
   */
  claimMustMatch?: RegExp
  /** Why this fixture is in the set, and what a miss would mean. */
  why: string
}

const FIXTURES: readonly Fixture[] = [
  {
    id: 'self_reference_text',
    expect: 'no_flag',
    channel: 'text',
    inboundBody: "how do i let you know when i'm on my way?",
    // Verbatim from the ticket: the production draft that queued.
    body: "just text here 😊 this is the number. what's your name?",
    venueInfo: leMilsShaped(),
    runtimeContext: runtimeContext([NO_PERKS]),
    why: "The defect, verbatim. True as the guest reads it — they are texting that number — and flagged because texting is absent from venue_info.contact. AC2's text half.",
  },
  {
    id: 'self_reference_instagram',
    expect: 'no_flag',
    channel: 'instagram',
    inboundBody: "how do i let you know when i'm on my way?",
    // TAC-495's Instagram copy says "message", never "DM".
    body: "just message here when you're close 😊 this is where you can reach me. what's your name?",
    venueInfo: leMilsShaped(),
    runtimeContext: runtimeContext([NO_PERKS]),
    why: "AC2's Instagram half, and the gap the audit named: every prior measurement of this defect hard-coded channel 'text', so the Instagram side of the exemption had never been exercised at all.",
  },
  {
    id: 'other_number_on_text',
    expect: 'flag',
    channel: 'text',
    inboundBody: 'my friend wants to order for pickup, whats the best number for them to call?',
    body: "give them a ring on (415) 555-0142 and they'll sort the pickup out.",
    venueInfo: leMilsShaped(),
    runtimeContext: runtimeContext([NO_PERKS]),
    claimMustMatch: /555-0142|\(415\)/i,
    why: "AC3, on the channel where the exemption is most likely to leak: the section for 'text' talks about 'this number', and this reply names a DIFFERENT specific number for someone who is not in the conversation. TAC-501's exact shape. A clean verdict in the channel arm means the exemption became a licence.",
  },
  {
    id: 'other_number_on_instagram',
    expect: 'flag',
    channel: 'instagram',
    inboundBody: 'can my partner call ahead for a big order?',
    body: 'sure, have them call (415) 555-0199 and we can get it started.',
    venueInfo: leMilsShaped(),
    runtimeContext: runtimeContext([NO_PERKS]),
    claimMustMatch: /555-0199|\(415\)/i,
    why: 'The same boundary on Instagram, where a phone number is not even the medium of the exchange. The venue has no public phone number, so this is fabricated either way.',
  },
  {
    id: 'order_history_misstatement',
    expect: 'flag',
    channel: 'text',
    inboundBody: 'just picked up my pink panther, thanks!',
    // AC5 catch #1, body verbatim from the 2026-09-21 ruling
    // (message b577dff5-39b5-4ef8-9025-fb37d44a36cf at le-mils-coffee).
    body: 'oh nice, the Pink Panther two days in a row 😄 first time trying it, or a regular thing?',
    venueInfo: leMilsShaped(),
    // THE VISIT HISTORY HELD ONE BLOSSOM TONIC AND NO PINK PANTHER, which is
    // the reconstruction TAC-483 already established and checked in
    // (scripts/measure-order-attribution.ts, VARIANT_4_VISITS): the Pink
    // Panther transaction was written by the fire-and-forget extractor AFTER
    // this turn's inbound, so it was never in the prompt that produced this
    // reply. `[just now]` is the delta production rendered, because TAC-325
    // anchors an approximate same-day report to venue-local noon, which sat
    // in the turn's own future.
    //
    // A first version of this fixture put a Pink Panther in the history
    // instead and the body went 1/5 in one arm and 0/5 in the other — not a
    // leak, an unfaithful fixture that made "two days in a row" MORE
    // supportable than production's did. Corrected against the repo's own
    // record rather than tuned until it flagged.
    runtimeContext: runtimeContext([
      [
        '## Visit history',
        "Recent transactions, most recent first. Use this to recognize patterns and offer relevant suggestions — don't recite history back at the guest.",
        '- [just now] blossom tonic',
      ].join('\n'),
      NO_PERKS,
    ]),
    claimMustMatch: /pink panther|two days/i,
    why: "AC5 catch #1, a genuine production flag. The reply says the guest had the Pink Panther two days running; the visit history the live prompt carried held one blossom tonic and no Pink Panther at all. It must still flag, and nothing about the channel bears on it.",
  },
  {
    id: 'hold_promise_no_holds',
    expect: 'flag',
    channel: 'text',
    inboundBody: 'the olive oil cake i got today was completely dried out',
    // AC5 catch #2, body verbatim from the 2026-09-21 ruling
    // (message 91686e18-1d12-4645-b2bf-f9d5d3f2f66c at le-mils-coffee).
    body: "really sorry about that, the cake should never be like that. i want to make it right. come back and i'll have a fresh one waiting for you, give me a heads up when you're on your way ☕",
    venueInfo: leMilsShaped({
      services: {
        aheadOrdering: false,
        holds: false,
        reservations: false,
        delivery: false,
      },
    }),
    runtimeContext: runtimeContext([NO_PERKS]),
    claimMustMatch: /hold|set aside|waiting|fresh one/i,
    why: 'AC5 catch #2, a genuine production flag: a hold promised at a venue whose services say it does not hold items. It is also the sharpest leak test in the set, because the same reply ALSO contains a channel-adjacent line ("give me a heads up when you\'re on your way"). An exemption that over-applied could take the whole reply clean.',
  },
  {
    id: 'self_referential_number_on_text',
    expect: 'flag',
    channel: 'text',
    inboundBody: 'can you remind me what number this is so i can save it?',
    body: "of course! you can reach me at (415) 555-0142, that's this number \u2014 save it and text any time.",
    venueInfo: leMilsShaped(),
    runtimeContext: runtimeContext([NO_PERKS]),
    claimMustMatch: /555-0142|\(415\)/i,
    why: "The shape the bullet's last sentence promises to keep checked, and the one neither other number fixture covers: a number WRITTEN OUT and presented as this very conversation's number. That is where the exemption's first half (describe the current exchange) and its second exclusion (a number is an ordinary claim) pull hardest against each other, and the verifier cannot check the digits \u2014 it never sees venues.messaging_phone_number. It is also the natural co-occurrence of TAC-501's fabrication with this exemption.",
  },
  {
    id: 'cross_channel_future_promise_on_text',
    expect: 'flag',
    channel: 'text',
    inboundBody: 'let me know when the ethiopia is back',
    body: "no problem, i'll message you on instagram about it.",
    venueInfo: leMilsShaped(),
    runtimeContext: runtimeContext([NO_PERKS]),
    claimMustMatch: /instagram/i,
    why: "The Q1 boundary, built so it can actually be measured. A bare same-channel promise (\"I'll text you when I hear back\") is not independently an unsupported claim, so a clean verdict there would be ambiguous between 'the exemption held its scope' and 'there was nothing to flag' \u2014 which is why the plan declined to fixture it. Naming the OTHER channel makes it independently ungrounded: this is a text conversation, the channel section says so, and nothing supports reaching this guest on Instagram. If the exemption were widened to 'any way to reach the venue, at any time' \u2014 the mutant code review found passing 36/36 \u2014 this would go clean.",
  },
]

interface Verdict {
  flagged: boolean
  claims: string[]
  failed: boolean
  error?: string
}

async function judgeOnce(fixture: Fixture, arm: Arm): Promise<Verdict> {
  const r = await verifyGrounding({
    inboundBody: fixture.inboundBody,
    replyBody: fixture.body,
    venueInfo: fixture.venueInfo,
    knowledgeChunks: [],
    runtimeContext: fixture.runtimeContext,
    isProactive: false,
    conversationChannel: arm === 'channel' ? fixture.channel : null,
  })
  if (!r.ok) return { flagged: false, claims: [], failed: true, error: r.error }
  return {
    flagged: r.data.hasUngroundedClaim,
    claims: r.data.ungroundedClaims,
    failed: false,
  }
}

interface CellResult {
  fixture: Fixture
  arm: Arm
  verdicts: Verdict[]
  flaggedCount: number
  failedCount: number
}

/** Run `work` over `items` with a fixed number of workers. */
async function pooled<T, R>(items: T[], size: number, work: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      for (;;) {
        const i = next++
        if (i >= items.length) return
        out[i] = await work(items[i]!)
      }
    }),
  )
  return out
}

/**
 * A failed call is NOT a verdict, and this guard is the load-bearing half of
 * both criteria below.
 *
 * It is here because this script got it wrong on its first real run. A failed
 * call flags nothing, so "zero flags" was true for all five repeats of a cell
 * where the verifier was never successfully called at all — and the run duly
 * printed "flagged 0/5 ... as expected" for the two fixtures whose clean
 * result IS the ticket's claim. Sixty failed calls presented as a passing
 * measurement. A cell with any failure is not a result.
 */
function hasVerdicts(cell: CellResult): boolean {
  return cell.failedCount === 0
}

/**
 * The claim under test, judged strictly: every repeat went the expected way.
 *
 * Deliberately not a majority. The point of repeating is to SEE instability,
 * and a 3/5 reported as a pass would hide exactly the "no stable verdict at
 * all" case TAC-409 found in eight drafts that had been reasoned about as
 * eight behaviours.
 */
function channelArmMeets(fixture: Fixture, cell: CellResult, reps: number): boolean {
  if (!hasVerdicts(cell)) return false
  if (fixture.expect !== 'flag') return cell.flaggedCount === 0
  return cell.flaggedCount === reps && namedTheRightClaim(fixture, cell)
}

/**
 * Did a flag fixture flag for the REASON it exists, not merely flag?
 *
 * The script already collected every named claim and, until code review, read
 * none of them. `hold_promise_no_holds` is what makes this load bearing: its
 * reply carries a hold promise AND a channel-adjacent line, so flagging only
 * the channel line is a FALSE POSITIVE that would still score 10/10 on the
 * fixture whose whole job is proving the hold still flags. A gate whose green
 * signal is never checked against what it actually fired on is the
 * `comp_regex_backstop` shape this repo documents.
 *
 * A fixture with no pattern is unconstrained, so this can only tighten.
 */
function namedTheRightClaim(fixture: Fixture, cell: CellResult): boolean {
  const pattern = fixture.claimMustMatch
  if (pattern === undefined) return true
  return cell.verdicts.every((v) => !v.flagged || v.claims.some((c) => pattern.test(c)))
}

/**
 * How often the control must reproduce the defect before the comparison means
 * anything: a third of the repeats, floored at one.
 *
 * Code review caught that the original criterion ("more often than the
 * channel arm") collapses to "at least once" whenever the channel arm passes,
 * because a passing channel arm is 0 by definition — so the prose described
 * more than the code enforced, and at REPEATS=5 a single flag would have
 * printed as "the defect reproduced and the comparison means something". A
 * third is still lenient on purpose: this is a probabilistic verdict, and the
 * ticket's own prior measurement counted a 1/5 cell as evidence. The
 * arm-integrity line prints the rate either way, so a reader sees the number
 * rather than only a verdict.
 */
function controlFloor(reps: number): number {
  return Math.max(1, Math.ceil(reps / 3))
}

/**
 * What the `null` arm has to show, which depends on the fixture's role — see
 * `Fixture.expect`. For a self-reference body it is the control and must
 * reproduce the defect at a higher rate than the channel arm; for a boundary
 * or production-catch body it is held strictly, like the channel arm.
 */
function nullArmMeets(
  fixture: Fixture,
  nullCell: CellResult,
  channelCell: CellResult,
  reps: number,
): boolean {
  if (!hasVerdicts(nullCell)) return false
  if (fixture.expect === 'flag') {
    return nullCell.flaggedCount === reps && namedTheRightClaim(fixture, nullCell)
  }
  return (
    nullCell.flaggedCount >= controlFloor(reps) &&
    nullCell.flaggedCount > channelCell.flaggedCount
  )
}

function nullArmExpectation(fixture: Fixture): string {
  return fixture.expect === 'flag'
    ? 'flag every repeat'
    : `reproduce the defect (flag >= ${controlFloor(REPEATS)}/${REPEATS}, and more often than the channel arm)`
}

async function main(): Promise<void> {
  if (!Number.isInteger(REPEATS) || REPEATS < 1) {
    console.error(`REPEATS must be a positive integer, got ${process.env.REPEATS}`)
    process.exit(2)
  }
  // Same guard, because the asymmetry was arbitrary: CONCURRENCY=0 makes
  // `pooled` spawn no workers, leaves every cell undefined, and the run dies
  // with an opaque TypeError after making zero model calls.
  if (!Number.isInteger(CONCURRENCY) || CONCURRENCY < 1) {
    console.error(`CONCURRENCY must be a positive integer, got ${process.env.CONCURRENCY}`)
    process.exit(2)
  }

  const cells: { fixture: Fixture; arm: Arm }[] = []
  for (const fixture of FIXTURES) for (const arm of ARMS) cells.push({ fixture, arm })

  const log = createRunLog({
    name: 'tac502-channel-self-reference',
    outputPath: process.env.OUTPUT_PATH,
    meta: {
      arm: 'channel-vs-null',
      promptVersion: VERIFY_GROUNDING_PROMPT_VERSION,
      repeats: REPEATS,
      concurrency: CONCURRENCY,
      fixtureCount: FIXTURES.length,
      note: "the `null` arm reproduces pre-TAC-502 SOURCE MATERIAL against the v1.6.0 system prompt; it is not a measurement of v1.5.0",
    },
  })

  console.log(
    `[replay] ${FIXTURES.length} fixtures x ${ARMS.length} arms x ${REPEATS} repeats = ${cells.length * REPEATS} calls`,
  )
  console.log(`[replay] prompt ${VERIFY_GROUNDING_PROMPT_VERSION}`)
  console.log(`[replay] writing ${log.path}\n`)

  let done = 0
  const results = await pooled(cells, CONCURRENCY, async ({ fixture, arm }) => {
    const verdicts: Verdict[] = []
    for (let i = 0; i < REPEATS; i++) verdicts.push(await judgeOnce(fixture, arm))
    const result: CellResult = {
      fixture,
      arm,
      verdicts,
      flaggedCount: verdicts.filter((v) => v.flagged).length,
      failedCount: verdicts.filter((v) => v.failed).length,
    }
    // Checkpoint per cell, not at the end — the expensive half is the model
    // calls, and a late throw in the cheap half must not lose them.
    log.appendUnit({
      fixtureId: fixture.id,
      arm,
      channel: arm === 'channel' ? fixture.channel : null,
      expect: arm === 'channel' ? fixture.expect : nullArmExpectation(fixture),
      flaggedCount: result.flaggedCount,
      failedCount: result.failedCount,
      repeats: REPEATS,
      body: fixture.body,
      why: fixture.why,
      verdicts,
    })
    done += 1
    console.log(
      `[replay] ${done}/${cells.length}  ${fixture.id} (${arm}) flagged ${result.flaggedCount}/${REPEATS}`,
    )
    return result
  })

  const cellFor = (id: string, arm: Arm) =>
    results.find((r) => r.fixture.id === id && r.arm === arm)!

  console.log('\n=== Per fixture, both arms ===')
  const misses: string[] = []
  for (const fixture of FIXTURES) {
    const channelArm = cellFor(fixture.id, 'channel')
    const nullArm = cellFor(fixture.id, 'null')
    const channelOk = channelArmMeets(fixture, channelArm, REPEATS)
    const nullOk = nullArmMeets(fixture, nullArm, channelArm, REPEATS)
    if (!channelOk) misses.push(`${fixture.id} (channel arm: expected ${fixture.expect})`)
    if (!nullOk) misses.push(`${fixture.id} (null arm: expected to ${nullArmExpectation(fixture)})`)

    console.log(`\n  ${fixture.id}  [${fixture.channel}]`)
    console.log(`     body: ${fixture.body}`)
    const failNote = (c: CellResult) =>
      c.failedCount > 0 ? `  [${c.failedCount}/${REPEATS} CALLS FAILED — not a verdict]` : ''
    console.log(
      `     channel arm: flagged ${channelArm.flaggedCount}/${REPEATS}  expected ${fixture.expect}  ${channelOk ? 'as expected' : 'MISS'}${failNote(channelArm)}`,
    )
    console.log(
      `     null arm:    flagged ${nullArm.flaggedCount}/${REPEATS}  expected to ${nullArmExpectation(fixture)}  ${nullOk ? 'as expected' : 'MISS'}${failNote(nullArm)}`,
    )
    const claim = [...channelArm.verdicts, ...nullArm.verdicts].find((v) => v.flagged)
    if (claim !== undefined && claim.claims.length > 0) {
      console.log(`     a claim it named: ${claim.claims[0]}`)
    }
    console.log(`     why: ${fixture.why}`)
  }

  // The arm-integrity check, stated separately because a replay that did not
  // reproduce the defect can say nothing about whether the fix addressed it —
  // and a broken arm produces exactly the "the fix works" shape.
  const reproduced = FIXTURES.filter((f) => f.expect === 'no_flag').every((f) =>
    nullArmMeets(f, cellFor(f.id, 'null'), cellFor(f.id, 'channel'), REPEATS),
  )
  console.log('\n=== Arm integrity ===')
  console.log(
    reproduced
      ? '  Both self-reference fixtures flagged in the null arm, more often than in the channel arm, so the defect reproduced and the comparison means something.'
      : '  AT LEAST ONE self-reference fixture did NOT reproduce the defect in the null arm. Without that, a clean channel arm is indistinguishable from a body that was never going to flag, so this run cannot speak to whether the fix addressed anything. Read every number below as unfounded.',
  )

  const failed = results.reduce((a, r) => a + r.failedCount, 0)
  console.log(`\n=== Check health ===\n  failed calls: ${failed}/${cells.length * REPEATS}`)
  if (failed > 0) {
    const example = results.flatMap((r) => r.verdicts).find((v) => v.failed)
    console.log(`  first error: ${example?.error}`)
    // Said plainly and early, because the first run of this script had all 60
    // calls fail and still printed "as expected" against the two fixtures the
    // ticket's whole claim rests on. A failed call is not a clean verdict.
    console.log(
      '  A FAILED CALL FLAGS NOTHING, so any cell above with failures is not a result whatever its flag count reads.',
    )
  }

  console.log('\n=== Summary ===')
  if (misses.length === 0) {
    console.log('  Every cell went the way it was supposed to.')
  } else {
    console.log(`  ${misses.length} cell(s) did not:`)
    for (const m of misses) console.log(`    - ${m}`)
    console.log(
      '\n  A "flag" fixture that came back clean in the channel arm means the exemption leaked and must be read before merging.',
    )
  }
  console.log(`\n[replay] wrote ${log.path}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
