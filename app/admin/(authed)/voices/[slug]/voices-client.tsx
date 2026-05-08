'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createBrowserClient } from '@/lib/db/browser'
import { PlaygroundShell } from './_components/playground-shell'
import { Rail } from './_components/rail'
import { ThreadPane } from './_components/thread-pane'
import { ThreadsList } from './_components/threads-list'
import { Topbar } from './_components/topbar'
import type {
  VoicePageData,
  VoicePageMessage,
} from './_lib/load-voice-page'

// THE-237 (PR-B): client orchestrator for the per-voice workbench. Owns
// selection (which guest's thread is loaded, which outbound bubble is
// "flagged"), Realtime subscription on `messages` for the venue, and the
// top-level wiring between the threads list, thread pane, playground
// shell, and right rail.
//
// Mutations live in their respective rail-* components and the topbar
// voice-name editor. Each calls fetch(...) → router.refresh() to invalidate
// the server-rendered persona/corpus/threads/lastRefinedAt props. See
// page.tsx for the propagation pattern.

interface VoicesClientProps {
  data: VoicePageData
}

interface MessageRow {
  id: string
  guest_id: string
  body: string
  direction: string
  created_at: string
  reply_to_message_id: string | null
  venue_id: string
}

export function VoicesClient({ data }: VoicesClientProps) {
  const router = useRouter()
  const [messages, setMessages] = useState<VoicePageMessage[]>(
    data.selectedMessages,
  )
  // Default-select the most recent outbound — matches the mockup's
  // "click an agent message" framing. If there are no outbounds yet, no
  // selection.
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(
    () => {
      const lastOut = [...data.selectedMessages]
        .reverse()
        .find((m) => m.direction === 'outbound')
      return lastOut?.id ?? null
    },
  )

  const selectedMessage = useMemo(
    () => messages.find((m) => m.id === selectedMessageId) ?? null,
    [messages, selectedMessageId],
  )

  // For the playground shell — find the inbound that triggered the selected
  // outbound (via reply_to_message_id) so we can render the in/out pair.
  const flaggedPair = useMemo(() => {
    if (!selectedMessage || selectedMessage.direction !== 'outbound') return null
    if (!selectedMessage.replyToMessageId) return null
    const inbound = messages.find((m) => m.id === selectedMessage.replyToMessageId)
    if (!inbound) return null
    return { inbound, outbound: selectedMessage }
  }, [selectedMessage, messages])

  // Realtime subscription — duplicates the conversations-viewer pattern as
  // agreed. Extract once we have a second instance.
  useEffect(() => {
    if (!data.selectedGuest) return
    const guestId = data.selectedGuest.id
    const supabase = createBrowserClient()
    const channel = supabase
      .channel(`voices:${data.venue.id}:${guestId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'messages',
          filter: `venue_id=eq.${data.venue.id}`,
        },
        (payload) => {
          const row = (payload.new ?? payload.old) as MessageRow | undefined
          if (!row || row.guest_id !== guestId) return
          if (payload.eventType === 'INSERT' && payload.new) {
            const m = payload.new as MessageRow
            if (!m.body) return
            setMessages((prev) => {
              if (prev.some((x) => x.id === m.id)) return prev
              return [
                ...prev,
                {
                  id: m.id,
                  body: m.body,
                  direction:
                    m.direction === 'outbound' ? 'outbound' : 'inbound',
                  createdAt: new Date(m.created_at),
                  replyToMessageId: m.reply_to_message_id,
                },
              ]
            })
          } else if (payload.eventType === 'UPDATE' && payload.new) {
            const m = payload.new as MessageRow
            setMessages((prev) =>
              prev.map((x) =>
                x.id === m.id
                  ? {
                      ...x,
                      body: m.body || x.body,
                      replyToMessageId:
                        m.reply_to_message_id ?? x.replyToMessageId,
                    }
                  : x,
              ),
            )
          }
        },
      )
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [data.venue.id, data.selectedGuest])

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

  const displayLabel = data.persona.voiceName ?? data.venue.name

  return (
    <div className="flex flex-col h-full bg-paper">
      <Topbar
        venueName={data.venue.name}
        voiceName={data.persona.voiceName ?? null}
        displayLabel={displayLabel}
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
          selectedGuestId={data.selectedGuest?.id ?? null}
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
          venueId={data.venue.id}
          persona={data.persona}
          corpus={data.corpus}
          counts={counts}
          onMutate={onMutate}
        />
      </div>
    </div>
  )
}
