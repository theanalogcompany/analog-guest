import { redirect } from 'next/navigation'
import { Card } from '@/components/ui/card'
import { Eyebrow, SectionHeader } from '@/lib/ui'
import { resolveAdminSession } from '../../_lib/admin-session'
import { loadVenues } from '../../_lib/load-venues'
import { mark, reportRequestTiming } from '../../_lib/request-timing'
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
// never says, at all: the CSV export is the only place A and B are named.
//
// WHY IT IS NOT THE PROMPT LAB EITHER. The lab's unit of work is a PROMPT
// under edit, with v1 read from storage as a fixed backdrop. Here both arms
// are generated live in the same request so the pair is answered by the two
// engines as they stand right now, and nothing is editable: a judgment is
// only worth recording if the thing judged was not being changed underneath
// it.
//
// The allowlist comes from _lib/admin-session.ts, which the (authed) layout
// has already resolved for this request - the layout confirms analog-admin
// status but not WHICH venues, and this page needs the scope. It is the same
// call, memoized per request, not a second trip through the gate.
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
  const session = await resolveAdminSession()
  if (session.kind === 'no-session') redirect('/admin/sign-in')
  if (session.kind === 'not-admin') redirect('/admin')

  const venues = await loadVenues(session.venueScope)
  mark('venues')
  const params = await searchParams
  // Scoped against the loaded list rather than trusted: `?venue=` is a URL
  // parameter, and `loadVenues` is what applied the allowlist.
  const venueId =
    params.venue !== undefined && venues.some((v) => v.venueId === params.venue)
      ? params.venue
      : (venues[0]?.venueId ?? null)

  // The loader marks its own three queries as it goes.
  const data =
    venueId === null
      ? EMPTY_HUMAN_EVAL
      : await loadHumanEvalPage(venueId, params.session ?? null)

  reportRequestTiming('/admin/tests/human-eval')

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
          Each row generates a reply from BOTH engines for the same inbound and
          shows them as A and B in an order drawn per question. They are graded
          one at a time - B stays hidden until A has a verdict, so the first
          read of A is not an argument with something already on screen - and
          nothing on this page ever says which engine wrote which. The
          better-reply question is only asked when something failed: two
          acceptable replies are not a regression, and a failing row needs a
          comment saying what went wrong.
        </p>
        <p>
          <strong>Submitting is the finish line.</strong> It is offered once
          every question has been generated, judged, and commented wherever
          something failed; it freezes the pass - no more verdicts, no
          re-generating - and generates the CSV, which is the only place A and B
          are named. There is no undo, and an unsubmitted pass has no file.
        </p>
        <p>
          A pass runs {data.judgeableCount} questions four at a time, so about a
          quarter of an hour. Generation only runs while this tab is open, so an
          unfinished pass picks itself back up when you open it - Stop halts it
          for the rest of the visit. The v1 arm writes its transcript to
          production <code className="rounded bg-muted px-1">messages</code>{' '}
          against this venue&apos;s synthetic sandbox guests - so{' '}
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
