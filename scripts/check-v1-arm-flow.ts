/**
 * check-v1-arm-flow.ts - does the playground's v1 arm work end to end, for £0?
 *
 * The arm's job is wiring: materialize a sandbox transcript, run the real v1
 * pipeline in test mode, come back with bubbles and never send or persist a
 * reply. None of that depends on what the model writes, so the models are
 * mocked (scripts/lib/mock-providers.ts) and a canned string stands in for
 * the generation. This answers every question about the FLOW and no question
 * about reply quality - for that, run one real turn deliberately.
 *
 *   npx tsx --env-file=.env.local scripts/check-v1-arm-flow.ts <venue-uuid>
 *
 * Needs the database (Supabase passes through the mock untouched): the whole
 * point of the arm is that v1 builds its context from real rows.
 *
 * It CLEARS the recorder tables for the sandbox guest before running, so
 * check 4 is about what this run wrote rather than what was lying around.
 *
 * Checks, each able to fail independently:
 *   1. the arm returns ok with at least one bubble
 *   2. the draft is stamped with v1's prompt version, not v2's
 *   3. NO outbound row was persisted for the sandbox guest
 *   4. no ledger row, no recognition-band row
 *   5. the sandbox guest is is_test_synthetic and NOT is_demo
 *   6. re-running does not duplicate the transcript
 *   7. no live provider call escaped the mock
 */
import { createAdminClient } from '@/lib/db/admin'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import { draftV1ForSandbox } from '@/app/admin/(authed)/playground/api/run/v1-arm'
import { installProviderMocks } from './lib/mock-providers'

const CANNED = 'mock reply: yes, we have oat milk.'

/**
 * NO ASSISTANT TURNS, and that is what makes check 3 mean anything. The
 * sandbox arm materializes the transcript as real `messages` rows, so an
 * assistant turn in the history becomes an OUTBOUND row - indistinguishable,
 * after the fact, from v1 having persisted its reply. With a guest-only
 * history, any outbound row at all is necessarily a persisted reply.
 * The first version of this check passed a 'hey, welcome!' assistant turn and
 * then reported its own fixture as a failure.
 */
const GUEST_ONLY_HISTORY = [
  { role: 'user' as const, text: 'hi' },
  { role: 'user' as const, text: 'quick question' },
]

// Telemetry off: a stage failure here would otherwise page a real Slack
// channel about a test run. Set before any module reads them.
process.env.SLACK_ALERTS_WEBHOOK_URL = ''
process.env.NEXT_PUBLIC_POSTHOG_KEY = ''
process.env.LANGFUSE_ENABLED = 'false'

const venueId = process.argv[2]
if (venueId === undefined) {
  console.error('usage: check-v1-arm-flow.ts <venue-uuid>')
  process.exit(1)
}

/**
 * Every table a turn's recorders touch. `transactions` is the one that also
 * cost a model call (extractReportedOrder) on each test run.
 */
const RECORDER_TABLES = [
  'inbound_turn_outcomes',
  'guest_states',
  'transactions',
  'visit_checkins',
] as const

let failures = 0
function check(label: string, pass: boolean, detail = ''): void {
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`,
  )
  if (!pass) failures += 1
}

/**
 * The sandbox guest's id, or null if no run has created it yet.
 *
 * Scoped by the sandbox phone prefix, not by `is_test_synthetic` alone - other
 * synthetic guests exist at a live venue for unrelated reasons, and one with a
 * null phone number is already on file at the pilot venue.
 */
async function sandboxGuestId(
  supabase: ReturnType<typeof createAdminClient>,
): Promise<string | null> {
  const guest = await supabase
    .from('guests')
    .select('id')
    .eq('venue_id', venueId)
    .like('phone_number', '+1555010%')
    .maybeSingle()
  return guest.data?.id ?? null
}

async function main(): Promise<void> {
  const mocks = installProviderMocks({ generationText: CANNED })
  const supabase = createAdminClient()

  // CLEAR THE RECORDER TABLES FIRST, or check 4 proves nothing.
  //
  // It asserts "this run wrote no row", and a row already on file from an
  // earlier run reads identically to one this run just wrote. The first
  // version of this check skipped the clear and passed - but only because a
  // row had been deleted BY HAND minutes earlier while proving the readOnly
  // guard. On the next run it reported a leftover from 18 minutes before as a
  // live failure. A pre-state nobody established is not a control.
  const stale = await sandboxGuestId(supabase)
  if (stale !== null) {
    for (const table of RECORDER_TABLES) {
      await supabase.from(table).delete().eq('guest_id', stale)
    }
  }

  try {
    const first = await draftV1ForSandbox({
      venueId,
      sessionHistory: GUEST_ONLY_HISTORY,
      inbound: ['do you have oat milk?'],
    })

    check(
      '1. arm returns a draft',
      first.ok,
      first.ok ? '' : `${first.stage}: ${first.error}`,
    )
    if (!first.ok) return

    check(
      '1b. draft carries bubbles',
      first.data.bubbles.length > 0,
      `bubbles=${JSON.stringify(first.data.bubbles)}`,
    )
    check(
      '2. stamped with v1 prompt version',
      first.data.promptVersion === PROMPT_VERSION,
      `got ${first.data.promptVersion}`,
    )

    const guest = await supabase
      .from('guests')
      .select('id, is_test_synthetic, is_demo')
      .eq('venue_id', venueId)
      .like('phone_number', '+1555010%')
      .maybeSingle()
    if (!guest.data) {
      check('5. sandbox guest exists', false, 'not found')
      return
    }
    check(
      '5. sandbox guest is synthetic and not demo',
      guest.data.is_test_synthetic === true && guest.data.is_demo !== true,
      `is_test_synthetic=${guest.data.is_test_synthetic} is_demo=${guest.data.is_demo}`,
    )

    const msgs = await supabase
      .from('messages')
      .select('direction')
      .eq('venue_id', venueId)
      .eq('guest_id', guest.data.id)
    const outbound = (msgs.data ?? []).filter((m) => m.direction === 'outbound')
    check(
      '3. no outbound row persisted',
      outbound.length === 0,
      `${outbound.length} outbound rows`,
    )

    // THE FIRE-AND-FORGET WRITES LAND AFTER THE CALL RETURNS, so counting
    // immediately reads zero whether they were gated or not - which is
    // exactly how six of them went unnoticed through a whole round of
    // checking. Settle first, then count, or this block proves nothing.
    await new Promise((r) => setTimeout(r, 3000))

    for (const table of RECORDER_TABLES) {
      const r = await supabase
        .from(table)
        .select('*', { count: 'exact', head: true })
        .eq('guest_id', guest.data.id)
      check(`4. no ${table} row`, (r.count ?? 0) === 0, `count=${r.count ?? 0}`)
    }

    // Re-run with the SAME history: the transcript is replaced, not appended,
    // so the row count must not grow. An append-only bug here would have v1
    // answering a guest who said everything twice.
    const before = (msgs.data ?? []).length
    await draftV1ForSandbox({
      venueId,
      sessionHistory: GUEST_ONLY_HISTORY,
      inbound: ['do you have oat milk?'],
    })
    const after = await supabase
      .from('messages')
      .select('*', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .eq('guest_id', guest.data.id)
    check(
      '6. rerun does not duplicate the transcript',
      (after.count ?? 0) === before,
      `before=${before} after=${after.count ?? 0}`,
    )
  } finally {
    mocks.restore()
  }

  const live = Object.keys(mocks.calls).filter((k) =>
    k.startsWith('passthrough:'),
  )
  const billableLeak = live.filter((k) =>
    ['anthropic', 'voyage', 'moonshot', 'typesafe'].some((m) => k.includes(m)),
  )
  check(
    '7. no live provider call escaped',
    billableLeak.length === 0,
    billableLeak.join(', '),
  )
  console.log(`\nintercepted: ${JSON.stringify(mocks.calls)}`)
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
