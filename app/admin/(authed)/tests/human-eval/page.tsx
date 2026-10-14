import { redirect } from 'next/navigation'
import { Card } from '@/components/ui/card'
import { Eyebrow, SectionHeader } from '@/lib/ui'
import { AuthError, devAuthBypass, verifyAnalogAdminAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/db/server'
import type { VenueScope } from '@/lib/auth/venue-scope'
import { loadVenues } from '../../_lib/load-venues'
import { EMPTY_HUMAN_EVAL, loadHumanEvalPage } from './_lib/load-human-eval'
import { HumanEvalClient } from './human-eval-client'

// /admin/tests/human-eval - v1 and v2 answer the golden set, the two replies
// are shown as A and B in a random order, and a human marks each one pass or
// fail. When one fails they say which was better and why. The whole pass
// exports as a CSV.
//
// WHY IT IS NOT THE GOLDEN SET PAGE. That page is for READING two answers
// side by side, labelled, with everything about them on screen - which is the
// right surface for debugging a prompt and the wrong one for judging it,
// because knowing which engine wrote a reply changes how it reads. This one
// withholds that until both verdicts are in.
//
// WHY IT IS NOT THE PROMPT LAB EITHER. The lab's unit of work is a PROMPT
// under edit, with v1 read from storage as a fixed backdrop. Here both arms
// are generated live in the same request so the pair is answered by the two
// engines as they stand right now, and nothing is editable: a judgment is
// only worth recording if the thing judged was not being changed underneath
// it.
//
// Session + allowlist resolve here rather than in the (authed) layout - same
// split as playground/page.tsx and prompt-lab/page.tsx, which confirm
// analog-admin status but not WHICH venues.
//
// The venue and the pass come from the URL rather than client state because
// both are server-loaded: a client-side venue switch would leave one venue's
// replies on screen beside another venue's pass.

export const dynamic = 'force-dynamic'

export default async function HumanEvalPage({
  searchParams,
}: {
  searchParams: Promise<{ venue?: string; session?: string }>
}) {
  let venueScope: VenueScope
  // Local-dev bypass (lib/auth/dev-bypass.ts): triple-guarded, null anywhere
  // but a developer's own `next dev` on localhost.
  const bypass = await devAuthBypass()
  if (bypass) {
    venueScope = bypass.venueScope
  } else {
    const supabase = await createServerClient()
    const {
      data: { session },
    } = await supabase.auth.getSession()
    if (!session) redirect('/admin/sign-in')

    try {
      const op = await verifyAnalogAdminAccess(session.user.id)
      venueScope = op.venueScope
    } catch (e) {
      if (e instanceof AuthError && e.status === 403) redirect('/admin')
      throw e
    }
  }

  const venues = await loadVenues(venueScope)
  const params = await searchParams
  // Scoped against the loaded list rather than trusted: `?venue=` is a URL
  // parameter, and `loadVenues` is what applied the allowlist.
  const venueId =
    params.venue !== undefined && venues.some((v) => v.venueId === params.venue)
      ? params.venue
      : (venues[0]?.venueId ?? null)

  const data =
    venueId === null
      ? EMPTY_HUMAN_EVAL
      : await loadHumanEvalPage(venueId, params.session ?? null)

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        eyebrow={<Eyebrow>Command Center</Eyebrow>}
        title="Human eval"
        subtitle={`${data.judgeableCount} scenarios · both engines live · blind A/B`}
      />

      {data.degraded !== null ? (
        <Card className="block rounded-[2px] border-destructive/40 bg-destructive/5 p-4 text-sm">
          {data.degraded}
        </Card>
      ) : null}

      <div className="flex flex-col gap-2 text-xs text-muted-foreground">
        <p>
          Each row generates a reply from BOTH engines for the same inbound,
          shows them as A and B in an order drawn per question, and records what
          you decide. Reveal unlocks once both replies have a verdict - the
          export says, per row, whether a verdict was written after it, so
          &quot;this pass was blind&quot; is checkable rather than asserted. The
          better-reply question is only asked when something failed: two
          acceptable replies are not a regression.
        </p>
        <p>
          A pass runs {data.judgeableCount} questions four at a time, so about a
          quarter of an hour, and the v1 arm writes its transcript to production{' '}
          <code className="rounded bg-muted px-1">messages</code> against this
          venue&apos;s synthetic sandbox guests - so{' '}
          <strong>run it during the venue&apos;s open hours</strong>, and not at
          the same time as{' '}
          <code className="rounded bg-muted px-1">
            npm run measure-golden-set
          </code>
          , which shares those guests. Questions are code (
          <code className="rounded bg-muted px-1">lib/eval/golden-set.ts</code>
          ).
        </p>
      </div>

      {data.excluded.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Not in a blind pass ({data.excluded.length} of {data.questionCount})
          </h2>
          <p className="text-xs text-muted-foreground">
            Only one engine can be asked these, so there is no pair to scramble:
            a reply in one column beside a labelled gap in the other names the
            engine and is not a comparison. Listed rather than dropped, because
            a pass over {data.judgeableCount} of {data.questionCount} would
            otherwise read as the whole set.
          </p>
          <div className="flex flex-col gap-1">
            {data.excluded.map((gap) => (
              <div key={gap.key} className="flex flex-col">
                <span className="text-sm">
                  {gap.question}{' '}
                  <span className="font-mono text-xs text-muted-foreground">
                    {gap.key}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {gap.reason}
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {venueId === null ? (
        <p className="text-sm text-muted-foreground">
          No venue is in your allowlist, so there is nothing to run a pass
          against.
        </p>
      ) : (
        <HumanEvalClient venues={venues} venueId={venueId} data={data} />
      )}
    </div>
  )
}
