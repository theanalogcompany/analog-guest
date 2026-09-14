import { redirect } from 'next/navigation'
import { SectionShell } from '@/app/admin/_components/section-shell'
import { Eyebrow, SectionHeader } from '@/lib/ui'
import { AuthError, verifyAnalogAdminAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/db/server'
import { INTENTION_DEFINITIONS } from '@/lib/agent/intentions/definitions'
import { loadIntentionPrompts, RECORDED_PROMPTS_LIMIT } from '../_lib/load-intention-prompts'
import { DefinitionsList } from './_components/definitions-list'
import { GatingConditions } from './_components/gating-conditions'
import { RecordedPromptsList } from './_components/recorded-prompts-list'

// TAC-379: read-only viewer for intentions (TAC-324, redefined by TAC-380). Nothing here
// creates, edits or retires anything — authoring was cut, because `isSatisfied`
// is a predicate that cannot be stored as a row and `promptLine` renders
// verbatim into the slot universal rule R22 names as the sole authority on
// whether the model pursues an open goal.
//
// Session + allowlist resolve here rather than in the (authed) layout, which
// confirms analog-admin status but not WHICH venues — same split as
// venues/page.tsx.

export const dynamic = 'force-dynamic'

export default async function IntentionsPage() {
  const supabase = await createServerClient()
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) redirect('/admin/sign-in')

  let allowedVenueIds: string[]
  try {
    const op = await verifyAnalogAdminAccess(session.user.id)
    allowedVenueIds = op.allowedVenueIds
  } catch (e) {
    if (e instanceof AuthError && e.status === 403) redirect('/admin')
    throw e
  }

  // Degrades to [] on a query failure. The definitions half is a static
  // import and renders regardless.
  const { rows, hasMore } = await loadIntentionPrompts(allowedVenueIds)

  return (
    <div className="flex flex-col gap-8">
      <SectionHeader
        eyebrow={<Eyebrow>Command Center</Eyebrow>}
        title="Intentions"
        subtitle={`${INTENTION_DEFINITIONS.length} definition${
          INTENTION_DEFINITIONS.length === 1 ? '' : 's'
        } · read-only`}
      />

      <p className="text-sm text-ink-soft leading-relaxed max-w-3xl">
        An intention is a conversational goal the agent carries into a conversation it does not
        control. Open ones render into the{' '}
        <code className="text-ink">## What you&rsquo;re hoping to get to</code> block of the user
        prompt, phrased as a state rather than an instruction. Each becomes eligible on its own
        event, and closes when it is raised, when the fact it asks about is recorded, or when its
        window runs out. First-contact intentions are raised at most once per guest, ever; the two
        that ask about a recommendation or an order re-arm when a newer one arrives in a later
        conversation.
      </p>

      <SectionShell
        title="Definitions"
        subtitle="Defined in code at lib/agent/intentions/definitions.ts. Global across every venue — adding one is a reviewed pull request, not an edit here."
      >
        <DefinitionsList />
      </SectionShell>

      <SectionShell
        title="When an intention reaches the prompt"
        subtitle="Conditions that live outside the definitions. All of them must pass, so a definition listed above may never fire for a given guest."
      >
        <GatingConditions />
      </SectionShell>

      <SectionShell
        title="Recorded prompts"
        subtitle={
          hasMore
            ? `Showing the ${RECORDED_PROMPTS_LIMIT} most recent. Older prompts exist and are not listed here.`
            : `${rows.length} recorded. One row per guest per intention, capped by the table's own unique constraint.`
        }
      >
        <RecordedPromptsList rows={rows} />
      </SectionShell>
    </div>
  )
}
