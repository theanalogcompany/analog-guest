// TAC-520: does the agent state a date the way a person would, or the way a
// system would? Generate-only. NOTHING IS SENT.
//
// ONE WRITE IS POSSIBLE AND IT IS NOT THIS SCRIPT'S. `buildRuntimeContext`
// documents its own side effect: `computeGuestState` writes a state-transition
// row when the computed band differs from the persisted one, which the next
// real agent run would have written anyway. This file inserts, updates and
// deletes nothing itself. An earlier version of this header said "nothing is
// written to the database", which was false, and it was stamped into every run
// log's provenance note; "writes nothing" is the kind of sentence that stops
// being true without anyone noticing (the same note `first-touch-question.ts`
// carries).
//
// On 2026-09-22 a guest at Le Mil's asked "did masala mixer start" and the
// draft came back "not yet, that's planned for September 2026" about something
// days away. The cause was a `currentContext` entry reading "planned for
// September 2026 in the loft area", repeated verbatim into the reply.
//
// THE TWO ARMS ARE TWO RUNS OF THIS FILE, and that is a TRADEOFF rather than a
// constraint. The variable under test is the system prompt itself, so the arms
// are: run once with the rule absent (`--arm before`, from a worktree at
// origin/main), add the rule, run again (`--arm after`). `createRunLog` stamps
// the prompt version and git sha into each header, which is what tells them
// apart; compare by `scenarioId`.
//
// The alternative, which `first-touch-question.ts` uses, is to compose the
// prompt once and string-replace the rule text for the BEFORE arm inside a
// single run. That holds the clock and the venue config perfectly still, and
// it was NOT chosen here because it bypasses `generateStage`, losing the regen
// loop, the fidelity floor and the real approval gate — and this harness runs
// the real grounding backstop precisely so its verdict is the gate's verdict.
// Worth revisiting if run-to-run drift ever costs more than that.
//
// WHAT IS NOT AUTOMATICALLY HELD STILL, since two runs means two clocks:
//   - The injected entries are computed from each run's own `now`, so two arms
//     on different days inject different text. Pass `--now <iso>` to pin them.
//   - `## Right now` carries the real date, venue-local time and the
//     open/closed line, which move between runs. CLAUDE.md records the same
//     caveat for `run-test-scenarios`.
//   - The three `inject: null` scenarios read the venue's LIVE `currentContext`,
//     which a human can edit between arms.
// Before comparing two files, check their headers agree on `injectedEntries`.
// The harness does not enforce any of this; it records what it saw.
//
// THE BACKSTOP RUNS IN THE LOOP. In production the incident draft was HELD for
// approval rather than sent, so a run that measured generation alone would be
// measuring something other than what ships. `verifyGroundingStage` is the
// same call the gate makes, so its verdict here is the verdict the gate would
// see. It also answers a regression question the bar does not: whether the new
// rule makes the model hold more drafts than before.
//
// TELEMETRY: the stages fire PostHog events and some Slack relays. Run with
// NEXT_PUBLIC_POSTHOG_KEY and SLACK_ALERTS_WEBHOOK_URL unset and both go inert
// (PostHog throws inside its own try/catch, Slack warns and skips), so a
// measurement run pollutes neither.
//
// Reads the venue's live config and corpora, so results are comparable only
// across runs that saw the same config. Costs roughly 3 model calls per
// generation.

import { randomUUID } from 'node:crypto'

import { createAdminClient } from '@/lib/db/admin'
import { buildRuntimeContext } from '@/lib/agent/build-runtime-context'
import {
  classifyStage,
  generateStage,
  retrieveCorpusStage,
  retrieveKnowledgeStage,
  shouldRetrieveKnowledge,
  verifyGroundingStage,
} from '@/lib/agent/stages'
import { startAgentTrace } from '@/lib/observability/langfuse'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import { computeCalendar } from '@/lib/agent/calendar'
import { createRunLog } from './run-log'
import { countByKind, findDateLanguage } from './date-language'

/**
 * The injected `## Current context` entries, built from today.
 *
 * Hardcoding "September 2026" would reproduce the incident this month and
 * teach the wrong thing every month after, so each is computed. The literal
 * strings are written into the run log's header, so a file always states the
 * text the model actually saw.
 *
 * `venueLocalNow` is deliberately not used: the entries are venue notes, and a
 * note's wording does not depend on the venue's clock. The scenarios are read
 * against the same `## Right now` the model gets either way.
 */
function buildInjectedEntries(now: Date): {
  undated: string
  thisWeek: string
  farOff: string
  pastRecent: string
  pastStale: string
  thisWeekWeekday: string
  thisWeekIso: string
} {
  const monthYear = new Intl.DateTimeFormat('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'America/Los_Angeles',
  }).format(now)

  const thisWeek = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000)
  const thisWeekWeekday = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    timeZone: 'America/Los_Angeles',
  }).format(thisWeek)
  const thisWeekIso = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
  }).format(thisWeek)
  const thisWeekLong = new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'America/Los_Angeles',
  }).format(thisWeek)

  // TAC-522: two past dates, because the limit on the past-date criterion is
  // not uniform. The calendar runs FORWARD, so neither of these is in it, and
  // recognising them is a comparison against `- Date:` rather than a lookup.
  // 17 days back is usually the same month or the one before, which is an
  // easy numeric comparison; 90 days back is months stale, which is the weak
  // case. Measuring both is the point.
  //
  // 90 RATHER THAN 120, and the reason is a measurement flaw rather than a
  // preference. At 120 the date landed in MAY, and `may` is the one month
  // date-language.ts deliberately under-matches so it cannot fire on the
  // modal verb. The scenario reported 0/20 numeric dates in BOTH arms while
  // the replies were plainly stating "May 25" — a clean-looking number nobody
  // could trust. The offset moved rather than the detector gaining a month
  // special case (ruled 2026-09-23).
  //
  // Which shape this tests still depends on the run date: 90 days back from
  // a date early in the year crosses into the previous year, and from
  // mid-year it does not. The cross-year case is therefore not guaranteed by
  // this scenario and is not claimed by it.
  const pastRecentLong = new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'America/Los_Angeles',
  }).format(new Date(now.getTime() - 17 * 24 * 60 * 60 * 1000))
  const pastStaleLong = new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'America/Los_Angeles',
  }).format(new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000))

  const farOff = new Date(now.getTime() + 300 * 24 * 60 * 60 * 1000)
  const farOffLong = new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'America/Los_Angeles',
  }).format(farOff)

  return {
    // The incident entry, in its pre-fix shape: a month and a year for
    // something that is in fact days away, with no actual day.
    //
    // NO SECOND SENTENCE, deliberately. An earlier version appended "Exact
    // date not confirmed yet.", which is not in the entry the ticket quotes
    // and which HANDS THE MODEL THE ANSWER: the rule's not-set clause asks it
    // to say the date is not set, and with that sentence present both arms can
    // reach it by plain restatement, so the clause is measured on a case that
    // does not need it. It also hides the one interaction worth seeing, since
    // with a month-granularity note "no date set yet" is an inference from
    // absence and the grounding verifier may read it as unsupported.
    undated: `Masala Mixer is planned for ${monthYear} in the loft area.`,
    // A real date, close enough that a person would say the weekday.
    thisWeek: `Latte art throwdown on ${thisWeekLong}, 7pm in the loft. Free to watch, signups at the counter.`,
    // Genuinely far off, where naming the year is the RIGHT answer. This is
    // the case that stops the rule being read as a flat ban on years.
    farOff: `The shop's anniversary party is planned for ${farOffLong}.`,
    // Written as a forward-looking plan whose date has since gone by, which
    // is the shape a venue note actually rots into. Le Mil's has a live one:
    // a changing table "expected to be installed by end of September 2026".
    pastRecent: `The new pastry case is expected to be installed by ${pastRecentLong}.`,
    pastStale: `The new pastry case is expected to be installed by ${pastStaleLong}.`,
    thisWeekWeekday,
    thisWeekIso,
  }
}

/**
 * PRE-REGISTERED, and posted to the ticket before a single body was generated.
 *
 * Each scenario pulls for date language rather than sampling typical traffic:
 * a run of ordinary menu questions reports clean and proves nothing. Every one
 * carries its `why` so a later reader can tell a load-bearing case from a
 * control.
 */
const SCENARIOS: ReadonlyArray<{
  id: string
  body: string
  why: string
  /** Which injected entry this scenario needs in `## Current context`. */
  inject: 'undated' | 'thisWeek' | 'farOff' | 'pastRecent' | 'pastStale' | null
}> = [
  {
    id: 'event-undated',
    body: 'did masala mixer start',
    why: 'AC1. The incident, verbatim, against the entry restored to its pre-fix wording. This is the case the whole ticket is about: if the after arm does not beat the before arm here, the change has not earned its place.',
    inject: 'undated',
  },
  {
    id: 'event-this-week',
    body: "when's the latte art throwdown",
    why: 'AC2. A real date three days out, stored as an absolute. A person says the weekday. Reading back the full date is the same defect as the incident with a day attached.',
    inject: 'thisWeek',
  },
  {
    id: 'event-far-off',
    body: "when's the anniversary party",
    why: 'AC3. Genuinely far off, so the year is CORRECT here. The case that proves the rule permits a year rather than banning one, and the case a flat ban would have failed.',
    inject: 'farOff',
  },
  {
    id: 'event-past-recent',
    body: 'is the new pastry case in yet',
    why: "TAC-522 AC. A forward-looking note whose date went by 17 days ago. The agent must not state it as still upcoming. NO DETECTOR CATCHES THIS \u2014 'expected by September 5' scores clean on every kind, because saying a date as a plan is a semantic judgement. Read the bodies.",
    inject: 'pastRecent',
  },
  {
    id: 'event-past-stale',
    body: 'is the new pastry case in yet',
    why: 'TAC-522 AC, the WEAK half of the stated limit. Same note, 90 days stale, so the comparison crosses months. Measured rather than pre-empted by widening the calendar backwards.',
    inject: 'pastStale',
  },
  {
    id: 'hours-today',
    body: 'what time do you close',
    why: 'Control on R2, which already tells the model to answer for today off the ## Right now block. Must not regress, and must not acquire a year it never had.',
    inject: null,
  },
  {
    id: 'comp-expiry',
    body: 'how long do i have to use the free drink',
    why: "A commitment's expiry is NOT rendered into the prompt at all, so there is no date to state. Tests the failure direction a date rule could plausibly create: inducing a fabricated date where none exists.",
    inject: null,
  },
  {
    id: 'no-date-control',
    body: 'do you have oat milk',
    why: 'Proves the rule does not leak date language into replies that have nothing to do with dates. A rule that made every reply mention today would pass every other case here.',
    inject: null,
  },
]

function parseArgs(argv: readonly string[]): {
  venue?: string
  guest?: string
  arm?: string
  reps: number
  only?: string
  now?: string
} {
  const out: {
    venue?: string
    guest?: string
    arm?: string
    reps: number
    only?: string
    now?: string
  } = {
    reps: 5,
  }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--venue') out.venue = argv[++i]
    else if (argv[i] === '--guest') out.guest = argv[++i]
    else if (argv[i] === '--arm') out.arm = argv[++i]
    else if (argv[i] === '--reps') out.reps = Number(argv[++i])
    // One scenario at high --reps. Added because n=5 turned out to be far too
    // small: two runs of IDENTICAL code produced 4/5 and 1/5 on the same
    // metric, so the control arm alone reproduced the full spread of the
    // effect being looked for. Narrowing to one case is what makes a
    // high-rep run affordable enough to settle that.
    else if (argv[i] === '--only') out.only = argv[++i]
    // Pins the injected entries so two arms run on different days still
    // inject identical text. It does NOT pin `## Right now`, which the agent
    // builds from the real clock.
    else if (argv[i] === '--now') out.now = argv[++i]
  }
  return out
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (
    !args.venue ||
    !args.guest ||
    (args.arm !== 'before' && args.arm !== 'after') ||
    !Number.isInteger(args.reps) ||
    args.reps < 1
  ) {
    console.error(
      '✗ usage: npm run measure-date-phrasing -- --venue <slug> --guest <guest-uuid> --arm before|after [--reps N]',
    )
    process.exit(2)
  }
  const arm = args.arm

  const supabase = createAdminClient()
  const { data: venue } = await supabase
    .from('venues')
    .select('id, slug, timezone')
    .eq('slug', args.venue)
    .maybeSingle()
  if (!venue) {
    console.error(`✗ venue ${args.venue} not found`)
    process.exit(1)
  }

  const now = args.now ? new Date(args.now) : new Date()
  if (Number.isNaN(now.getTime())) {
    console.error(`✗ --now is not a date: ${args.now}`)
    process.exit(2)
  }
  const injected = buildInjectedEntries(now)

  const scenarios = args.only ? SCENARIOS.filter((s) => s.id === args.only) : SCENARIOS
  if (scenarios.length === 0) {
    console.error(`✗ no scenario with id "${args.only}"`)
    process.exit(2)
  }

  const log = createRunLog({
    name: `tac520-date-phrasing-${arm}`,
    meta: {
      arm,
      promptVersion: PROMPT_VERSION,
      venue: venue.slug,
      guestId: args.guest,
      reps: args.reps,
      scenarios: scenarios.map((s) => ({ id: s.id, body: s.body, inject: s.inject })),
      // Recorded verbatim: a file that does not say what text the model saw
      // cannot be compared against another run, and these are computed from
      // the run's own clock rather than fixed.
      injectedEntries: injected,
      // Accurate, and deliberately not "writes nothing": see the header.
      note: 'generate-only; nothing sent; this script writes nothing, though buildRuntimeContext may write one guest_states transition row',
      nowPinned: args.now ?? null,
    },
  })
  console.log(`arm: ${arm}   prompt: ${PROMPT_VERSION}`)
  console.log(`run log: ${log.path}`)
  console.log(`${scenarios.length} scenarios x ${args.reps} reps\n`)

  const trace = startAgentTrace({
    name: 'measurement.date-phrasing',
    agentRunId: randomUUID(),
    metadata: { venueId: venue.id, guestId: args.guest, arm },
  })

  for (const scenario of scenarios) {
    for (let rep = 0; rep < args.reps; rep += 1) {
      const ctx = await buildRuntimeContext({
        agentRunId: randomUUID(),
        guestId: args.guest,
        venueId: venue.id,
        trace,
        currentMessage: {
          id: randomUUID(),
          providerMessageId: `measurement-${scenario.id}-${rep}`,
          body: scenario.body,
          receivedAt: now,
          channel: 'text',
          // TAC-518 made this required so no construction site can default to
          // "no scan" silently. Null is the right answer here and is a
          // decision, not a default: the measurement guest is a synthetic
          // non-QR guest and every scenario is an ordinary inbound. A scan
          // referral would arm the first-touch opener, which would change the
          // prompt and make the two arms differ by more than the rule.
          referralSource: null,
        },
      })

      // Injected AFTER the context build and BEFORE generation, so the model
      // sees it in `## Current context` exactly as a real entry would render:
      // `venueInfoToProse` reads `ctx.venue.venueInfo` at compose time. The
      // entry REPLACES the venue's live ones for this scenario rather than
      // appending, so a live entry about the same event cannot answer the
      // question underneath the injected one and make the case inert.
      if (scenario.inject) {
        ctx.venue.venueInfo = {
          ...ctx.venue.venueInfo,
          currentContext: [
            {
              id: `measurement-${scenario.inject}`,
              content: injected[scenario.inject],
              source: 'tac520_measurement',
              addedAt: now,
              // No expiresAt: these are injected downstream of
              // filterActiveContext, so an expiry would not be honoured here
              // anyway and leaving it off keeps the entry honest about that.
            },
          ],
        }
      }

      const classification = await classifyStage(ctx)
      ctx.classification = classification
      ctx.corpus = await retrieveCorpusStage(ctx)
      ctx.knowledgeCorpus = shouldRetrieveKnowledge(ctx)
        ? await retrieveKnowledgeStage(ctx, classification.category, scenario.body)
        : []

      const generated = await generateStage(ctx, classification.category)
      const body = generated.status === 'success' ? generated.result.body : null
      const matches = body ? findDateLanguage(body) : []
      const counts = countByKind(matches)

      const grounding =
        generated.status === 'success' ? await verifyGroundingStage(ctx, generated.result) : null

      log.appendUnit({
        scenarioId: scenario.id,
        inbound: scenario.body,
        rep,
        arm,
        promptVersion: PROMPT_VERSION,
        injected: scenario.inject ? injected[scenario.inject] : null,
        category: classification.category,
        conversationChannel: ctx.conversationChannel,
        status: generated.status,
        body,
        voiceFidelity: generated.status === 'success' ? generated.result.voiceFidelity : null,
        attempts: generated.status === 'success' ? generated.result.attempts : null,
        counts,
        matches,
        // skipped | clean | flagged | truncated. `flagged` means production
        // would have queued this rather than sent it.
        groundingStatus: grounding?.status ?? null,
        groundingClaims: grounding?.status === 'flagged' ? grounding.claims : [],
        // Recorded so the weekday case can be read without re-deriving it.
        expectedWeekday: scenario.id === 'event-this-week' ? injected.thisWeekWeekday : null,
        // The calendar as the model saw it, so a run log explains a lookup
        // that went wrong without re-deriving the window by hand.
        calendar: computeCalendar(venue.timezone ?? 'America/Los_Angeles', now).map(
          (d) => `${d.weekday} ${d.monthDay}`,
        ),
      })

      const flags = [
        counts.year_stated > 0 ? `year x${counts.year_stated}` : null,
        counts.numeric_date > 0 ? `numeric x${counts.numeric_date}` : null,
        counts.month_named > 0 ? `month x${counts.month_named}` : null,
      ].filter((f): f is string => f !== null)
      const held = grounding?.status === 'flagged' ? ' [backstop HELD]' : ''
      // `month_named` is CORRECT on event-far-off (the scenario's own `why`
      // says so), so a right answer there must not print as a failure.
      const defectFlags =
        scenario.id === 'event-far-off'
          ? flags.filter((f) => !f.startsWith('month') && !f.startsWith('year'))
          : flags
      const mark =
        generated.status !== 'success'
          ? '·'
          : defectFlags.length > 0
            ? '✗'
            : counts.person_shaped > 0
              ? '✓'
              : '~'
      console.log(
        `${mark} ${scenario.id.padEnd(16)} rep${rep} ${
          generated.status !== 'success'
            ? `(${generated.status})`
            : flags.length > 0
              ? flags.join(', ')
              : `person-shaped x${counts.person_shaped}`
        }${held}`,
      )
      if (body) console.log(`    ${body.replace(/\s+/g, ' ')}`)
    }
  }

  await trace.flushAsync()
  console.log(`\nDone (${arm}). Run log: ${log.path}`)
  console.log('Compare the two arms by scenarioId. ✗ is a date stated system-shaped;')
  console.log('~ is a reply that named no date at all, which is not automatically a win.')
}

main().catch((e: unknown) => {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
