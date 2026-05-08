'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Database } from '@/db/types'
import { createBrowserClient } from '@/lib/db/browser'
import { PlaygroundShell } from './_components/playground-shell'
import { Rail } from './_components/rail'
import { ThreadPane } from './_components/thread-pane'
import { ThreadsList } from './_components/threads-list'
import { Topbar } from './_components/topbar'
import type { VoicePageData } from './_lib/load-voice-page'

// Client orchestrator for the per-voice workbench. Owns the flagged-bubble
// selection (`selectedMessageId`) and the realtime subscription. Messages
// themselves come straight from the server prop — realtime events trigger
// a router.refresh() so the server stays canonical and we don't have to
// reconcile a local state shadow with the next render.

interface VoicesClientProps {
  data: VoicePageData
}

type MessageRow = Database['public']['Tables']['messages']['Row']

export function VoicesClient({ data }: VoicesClientProps) {
  const router = useRouter()
  const messages = data.selectedMessages

  // Default-select the most recent outbound — matches the mockup's
  // "click an agent message" framing. If the selected id ever drops out of
  // the messages array (rare; effectively never on this surface), the
  // useMemo below resolves to null and the playground falls back to the
  // unselected state cleanly. The page-level key={selectedGuestId} on the
  // parent forces a fresh mount on guest change, re-running the
  // initializer.
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(
    () => mostRecentOutboundId(messages),
  )

  const selectedMessage = useMemo(
    () => messages.find((m) => m.id === selectedMessageId) ?? null,
    [messages, selectedMessageId],
  )

  // Find the inbound that triggered the selected outbound (via
  // reply_to_message_id) so the playground can render the in/out pair.
  const flaggedPair = useMemo(() => {
    if (!selectedMessage || selectedMessage.direction !== 'outbound') return null
    if (!selectedMessage.replyToMessageId) return null
    const inbound = messages.find((m) => m.id === selectedMessage.replyToMessageId)
    if (!inbound) return null
    return { inbound, outbound: selectedMessage }
  }, [selectedMessage, messages])

  // Realtime: any insert/update for this venue+guest triggers a server
  // re-fetch. Avoids local-state-shadow drift; the operator is staring at
  // the screen so a ~150ms revalidation hop is fine. Same trade-off the
  // conversations viewer makes for the rail mutations.
  const venueId = data.venue.id
  const selectedGuestId = data.selectedGuest?.id ?? null
  useEffect(() => {
    if (!selectedGuestId) return
    const supabase = createBrowserClient()
    const channel = supabase
      .channel(`voices:${venueId}:${selectedGuestId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'messages',
          filter: `venue_id=eq.${venueId}`,
        },
        (payload) => {
          const row = (payload.new ?? payload.old) as MessageRow | undefined
          if (!row || row.guest_id !== selectedGuestId) return
          router.refresh()
        },
      )
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [venueId, selectedGuestId, router])

  const onSelectGuest = useCallback(
    (guestId: string) => {
      router.push(`/admin/voices/${data.venue.slug}?guest=${guestId}`)
    },
    [data.venue.slug, router],
  )

  const onSelectMessage = useCallback((id: string) => {
    setSelectedMessageId(id)
  }, [])

  const onMutate = useCallback(() => {
    router.refresh()
  }, [router])

  const counts = {
    corpus: data.corpus.length,
    rules: data.persona.voiceAntiPatterns.length,
  }

  return (
    <div className="flex flex-col h-full bg-paper">
      <Topbar
        venueName={data.venue.name}
        voiceName={data.persona.voiceName ?? null}
        lastRefinedAt={data.lastRefinedAt}
        counts={counts}
      />

      {data.personaParseError && (
        <div className="px-6 py-2 bg-clay-soft/30 border-b border-clay-soft text-xs text-ink-soft">
          Persona could not be parsed: {data.personaParseError}. Editing the
          persona pane will rebuild the JSONB from a fallback shape — review
          carefully before saving.
        </div>
      )}

      <div className="flex-1 grid grid-cols-[280px_1fr_400px] min-h-0">
        <ThreadsList
          threads={data.threads}
          selectedGuestId={selectedGuestId}
          onSelectGuest={onSelectGuest}
          venueName={data.venue.name}
          voiceName={data.persona.voiceName ?? null}
        />

        <div className="grid grid-rows-[45%_55%] min-h-0 border-r border-stone-light/60">
          <ThreadPane
            messages={messages}
            selectedGuest={data.selectedGuest}
            selectedMessageId={selectedMessageId}
            onSelectMessage={onSelectMessage}
          />
          <PlaygroundShell flaggedPair={flaggedPair} />
        </div>

        <Rail
          venueId={venueId}
          persona={data.persona}
          corpus={data.corpus}
          counts={counts}
          onMutate={onMutate}
        />
      </div>
    </div>
  )
}

function mostRecentOutboundId(
  messages: ReadonlyArray<{ id: string; direction: 'inbound' | 'outbound' }>,
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].direction === 'outbound') return messages[i].id
  }
  return null
}
