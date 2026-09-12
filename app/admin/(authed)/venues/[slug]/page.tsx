import { notFound, redirect } from 'next/navigation'
import { AuthError, verifyAnalogAdminAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/db/server'
import { Eyebrow, SectionHeader } from '@/lib/ui'
import { loadVenueDetail } from '../../_lib/load-venue-detail'
import { computeReadiness } from '../_lib/readiness'
import { groupKnowledgeByTag } from '../_lib/section-grouping'
import {
  computeUnclaimedMechanicColumns,
  computeUnclaimedVenueInfoFields,
} from '../_lib/unclaimed-fields'
import { parseApprovalPolicy } from '@/lib/schemas/approval-policy'
import { ApprovalPolicySection } from './_components/approval-policy-section'
import { CatchAllSection } from './_components/catch-all-section'
import { EventsSection } from './_components/events-section'
import { MechanicsSection } from './_components/mechanics-section'
import { MenuKnowledgeSection } from './_components/menu-knowledge-section'
import { MenuRosterSection } from './_components/menu-roster-section'
import { OtherSection } from './_components/other-section'
import { ParseErrorBanner } from './_components/parse-error-banner'
import { ReadinessPanel } from './_components/readiness-panel'
import { RightNowSection } from './_components/right-now-section'
import { RoomRulesLogisticsSection } from './_components/room-rules-logistics-section'
import { TeamSection } from './_components/team-section'
import { TheStorySection } from './_components/the-story-section'
import { VenueFactsSection } from './_components/venue-facts-section'
import { VoiceLinkSection } from './_components/voice-link-section'

// TAC-343: /admin/venues/[slug] — the per-venue page. This component itself
// stays a server component that only loads and computes; all editing lives
// in client-side islands the sections render: knowledge_corpus
// add/edit/delete/split/merge in <KnowledgeEntryList>, venue_info/mechanics
// editing in their respective section components, and the currentContext
// expiry queue's Add/Drop/Promote actions in <RightNowSection>.
//
// Section order mirrors the §2 table exactly, so reviewing a venue after an
// interview follows the same order as the interview.

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ slug: string }>
}

export default async function VenueDetailPage({ params }: PageProps) {
  const { slug } = await params

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

  const data = await loadVenueDetail(slug)
  if (!data) notFound()

  // [slug] is operator-supplied — re-check against the loaded venue's id
  // since the layout only confirmed analog-admin status, not which venues
  // this operator can reach. Mirrors voices/[slug]/page.tsx.
  if (allowedVenueIds.length > 0 && !allowedVenueIds.includes(data.venue.id)) {
    notFound()
  }

  const now = new Date()
  const { bySection, unclaimed: unclaimedKnowledge } = groupKnowledgeByTag(
    data.knowledgeEntries,
  )
  const unclaimedVenueInfoFields = computeUnclaimedVenueInfoFields(data.venueInfo)
  const unclaimedMechanicColumnsPerRow = data.mechanics.map((m) => ({
    id: m.id,
    name: m.name,
    columns: computeUnclaimedMechanicColumns(m),
  }))

  const readiness = computeReadiness({
    now,
    voiceCorpusCount: data.voiceCorpusCount,
    knowledgeEntries: data.knowledgeEntries.map((k) => ({
      id: k.id,
      primaryTags: k.primaryTags,
      isProcessed: k.isProcessed,
    })),
    mechanics: data.mechanics.map((m) => ({
      id: m.id,
      name: m.name,
      isActive: m.isActive,
      trigger: m.trigger,
      requiresOperatorApproval: m.requiresOperatorApproval,
      description: m.description,
      qualification: m.qualification,
      rewardDescription: m.rewardDescription,
      redemptionPolicy: m.redemptionPolicy,
      redemptionWindowDays: m.redemptionWindowDays,
    })),
    currentContext: data.venueInfo.currentContext,
    brandPersona: data.brandPersona,
    rawApprovalPolicy: data.rawApprovalPolicy,
  })

  return (
    <div className="flex flex-col gap-10 pb-16">
      <SectionHeader
        eyebrow={<Eyebrow>Command Center · Venues</Eyebrow>}
        title={data.venue.name}
        subtitle={data.venue.timezone}
      />

      {data.venueInfoParseError && (
        <ParseErrorBanner
          message={`venue_info failed to parse: ${data.venueInfoParseError}`}
        />
      )}
      {data.brandPersonaParseError && (
        <ParseErrorBanner
          message={`brand_persona failed to parse: ${data.brandPersonaParseError}`}
        />
      )}

      <ReadinessPanel readiness={readiness} />

      <ApprovalPolicySection
        venueId={data.venue.id}
        policy={parseApprovalPolicy(data.rawApprovalPolicy)}
      />

      <VenueFactsSection venueId={data.venue.id} venueInfo={data.venueInfo} />
      <TheStorySection venueId={data.venue.id} entries={bySection.the_story} />
      <MenuRosterSection venueId={data.venue.id} venueInfo={data.venueInfo} />
      <MenuKnowledgeSection venueId={data.venue.id} entries={bySection.menu_knowledge} />
      <TeamSection
        venueId={data.venue.id}
        staff={data.venueInfo.staff}
        entries={bySection.the_team}
      />
      <RoomRulesLogisticsSection
        venueId={data.venue.id}
        entries={bySection.room_rules_logistics}
      />
      <EventsSection venueId={data.venue.id} entries={bySection.events_merch} />
      <MechanicsSection
        venueId={data.venue.id}
        mechanics={data.mechanics}
        unclaimedColumnsPerRow={unclaimedMechanicColumnsPerRow}
      />
      <VoiceLinkSection slug={data.venue.slug} />
      <OtherSection venueId={data.venue.id} entries={bySection.other} />
      <RightNowSection
        venueId={data.venue.id}
        currentContext={data.venueInfo.currentContext}
        now={now}
      />

      <CatchAllSection
        venueId={data.venue.id}
        unclaimedVenueInfoFields={unclaimedVenueInfoFields}
        unclaimedKnowledgeEntries={unclaimedKnowledge}
      />
    </div>
  )
}
