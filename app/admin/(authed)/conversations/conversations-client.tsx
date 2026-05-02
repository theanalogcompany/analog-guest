'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createBrowserClient } from '@/lib/db/browser'
import type { ApiTraceWithFullDetails } from '@/lib/observability'
import type { GuestState } from '@/lib/recognition'
import type { BrandPersona, VenueInfo } from '@/lib/schemas'
import { ConversationThread, type ThreadMessage } from './_components/conversation-thread'
import { GuestContext } from './_components/guest-context'
import { InboundDetail } from './_components/inbound-detail'
import { TracePanel } from './_components/trace-panel'
import { type Transaction } from './_components/transaction-row'
import { TransactionsList } from './_components/transactions-list'
import { VenueContext } from './_components/venue-context'

// Client surface that owns selection, the trace fetch cache, and the
// Realtime subscription. Server (page.tsx) hands over a fully-loaded
// InitialData and we go from there.

export interface InitialData {
  venue: {
    id: string
    slug: string
    name: string
    timezone: string
    messagingPhone: string
    status: string
    isTest: boolean
  }
  persona: BrandPersona | null
  venueInfo: VenueInfo | null
  mechanics: Array<{
    id: string
    name: string
    minState: string
    redemptionPolicy: string
    redemptionWindowDays: number | null
  }>
  guest: {
    id: string
    firstName: string | null
    lastName: string | null
    phoneNumber: string
    distanceMiles: number | null
    createdVia: string
  }
  state: GuestState | null
  lastVisitAt: Date | null
  /** Earliest of (min message.created_at, min transaction.occurred_at) for guest+venue. */
  sinceAt: Date | null
  visitCountLast90Days: number
  /** Sum of transactions.amount_cents over the last 90 days. */
  spendCents90d: number
  /** Total spend / visit count, rounded to cents. Null when there are no visits. */
  avgPerVisitCents: number | null
  /** All-time message count for venue+guest pair. Independent of the 200-row messages array. */
  totalMessageCount: number
  /** 0–100, rounded. Computed from the loaded messages within responseWindowHours. */
  responseRatePct: number
  responseWindowHours: number
  recentEvents: Array<{ eventType: string; createdAt: Date }>
  messages: Array<ThreadMessage & { providerMessageId: string | null }>
  traceMap: Record<string, ApiTraceWithFullDetails | null>
  todayLocalIso: string
  /** Last 50 transactions in the lookback window, newest-first. */
  transactions: Transaction[]
  /** Window the transactions were filtered against (server uses 90 days). */
  transactionsWindowDays: number
}

interface ConversationsClientProps {
  venueId: string
  guestId: string
  initialData: InitialData
}

interface MessageRow {
  id: string
  body: string
  direction: 'inbound' | 'outbound'
  created_at: string
  langfuse_trace_id: string | null
  reply_to_message_id: string | null
  provider_message_id: string | null
  venue_id: string
  guest_id: string
}

export function ConversationsClient({
  venueId,
  guestId,
  initialData,
}: ConversationsClientProps) {
  const [messages, setMessages] = useState(initialData.messages)
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    // Default selection: most recent outbound, or most recent message overall.
    const outbound = [...initialData.messages].reverse().find((m) => m.direction === 'outbound')
    return outbound?.id ?? initialData.messages[initialData.messages.length - 1]?.id ?? null
  })
  const [traceCache, setTraceCache] = useState<Record<string, ApiTraceWithFullDetails | null>>(
    () => ({ ...initialData.traceMap }),
  )

  const selected = useMemo(
    () => (selectedId ? messages.find((m) => m.id === selectedId) ?? null : null),
    [selectedId, messages],
  )

  // Loading is derived, not state — avoids the setState-in-effect anti-pattern.
  // True iff we have a trace ID for the selected outbound message but the
  // cache hasn't been populated yet (either prefetch missed it or the fetch
  // is still in flight).
  const traceLoading =
    !!selected &&
    selected.direction === 'outbound' &&
    !!selected.langfuseTraceId &&
    !(selected.id in traceCache)

  // Trace fetch on click for outbound messages not in the prefetch cache.
  // Cache is keyed by message id (not trace id) so re-renders with the same
  // selection don't re-fetch.
  useEffect(() => {
    if (!selected || selected.direction !== 'outbound' || !selected.langfuseTraceId) return
    if (selected.id in traceCache) return
    let cancelled = false
    fetch(`/admin/conversations/api/trace/${encodeURIComponent(selected.langfuseTraceId)}`)
      .then(async (r) => {
        if (!r.ok) return null
        const json = (await r.json()) as { trace?: ApiTraceWithFullDetails }
        return json.trace ?? null
      })
      .catch(() => null)
      .then((trace) => {
        if (cancelled) return
        setTraceCache((prev) => ({ ...prev, [selected.id]: trace ?? null }))
      })
    return () => {
      cancelled = true
    }
  }, [selected, traceCache])

  // Realtime: subscribe to message inserts/updates for this venue. Filter on
  // the wire by venue_id (Realtime supports a single column filter cleanly);
  // refine by guest_id client-side. Tear down + re-subscribe when filters
  // change (which happens via a fresh page load via router.replace, but the
  // unmount on navigation handles the cleanup).
  useEffect(() => {
    const supabase = createBrowserClient()
    const channel = supabase
      .channel(`conversations:${venueId}:${guestId}`)
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
                  direction: m.direction === 'outbound' ? 'outbound' : 'inbound',
                  createdAt: new Date(m.created_at),
                  langfuseTraceId: m.langfuse_trace_id,
                  replyToMessageId: m.reply_to_message_id,
                  providerMessageId: m.provider_message_id,
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
                      langfuseTraceId: m.langfuse_trace_id ?? x.langfuseTraceId,
                      replyToMessageId: m.reply_to_message_id ?? x.replyToMessageId,
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
  }, [venueId, guestId])

  // For inbound clicks, find the outbound message that was triggered by it
  // (messages.reply_to_message_id === <inbound id>) so the panel can offer a
  // pivot link to the agent's reply.
  const triggeredByMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const m of messages) {
      if (m.direction === 'outbound' && m.replyToMessageId) {
        map.set(m.replyToMessageId, m.id)
      }
    }
    return map
  }, [messages])

  const onSelectMessage = useCallback((id: string) => setSelectedId(id), [])
  const guestName = useMemo(() => {
    const n = [initialData.guest.firstName, initialData.guest.lastName].filter(Boolean).join(' ')
    return n || initialData.guest.phoneNumber
  }, [initialData.guest])

  // Layout: ConversationsClient occupies the post-Filters slot of
  // FullShell's flex-col, and stacks vertically into:
  //   - conversation/trace block (h-[calc(100dvh-7rem)]): fills viewport-
  //     minus-(TopBar 3.5rem + Filters 3.5rem). 400px / 1fr split with each
  //     child owning overflow-y-auto.
  //   - context cards row (h-[240px]): grid-cols-2; each card scrolls
  //     inside the fixed 240px slot if its content is taller.
  //   - transactions section (natural height, full-width): scrolls into
  //     view as the page scrolls past the conversation block.
  //
  // PR-5: page-level scroll re-introduced. Filters row above stays sticky
  // (in page.tsx) so the operator's orientation isn't lost. The
  // conversation block keeps its internal scroll behavior — the chrome-
  // height calc is bounded so the conversation+trace fill viewport on
  // first paint and the operator scrolls past to reveal the rest.
  return (
    <div className="flex flex-col">
      {/* overflow-hidden makes the height a hard cap — without it the
          grid grows to fit intrinsic content and the inner overflow-y-auto
          on the thread + side panel never engages. min-h-0 lets grid
          children shrink below their content size (default min-height
          on grid items is auto, which would let content push the grid
          taller than the calc height). */}
      <div className="h-[calc(100dvh-7rem)] min-h-0 overflow-hidden grid grid-cols-1 lg:grid-cols-[400px_1fr]">
        <ConversationThread
          messages={messages}
          venueTimezone={initialData.venue.timezone}
          selectedMessageId={selectedId}
          onSelectMessage={onSelectMessage}
        />
        <SidePanel
          selected={selected}
          traceCache={traceCache}
          traceLoading={traceLoading}
          guestName={guestName}
          guestPhone={initialData.guest.phoneNumber}
          venueTimezone={initialData.venue.timezone}
          triggeredByMap={triggeredByMap}
          onSelectMessage={onSelectMessage}
        />
      </div>

      <div className="h-[240px] grid grid-cols-1 lg:grid-cols-2 border-t border-stone-light/60 bg-parchment">
        {initialData.persona && initialData.venueInfo ? (
          <VenueContext
            venue={initialData.venue}
            persona={initialData.persona}
            venueInfo={initialData.venueInfo}
            mechanics={initialData.mechanics}
            todayLocalIso={initialData.todayLocalIso}
          />
        ) : (
          <div className="text-sm text-ink-soft italic p-4">
            Venue config could not be parsed (see server logs). Showing partial detail.
          </div>
        )}
        <GuestContext
          guest={initialData.guest}
          state={initialData.state}
          lastVisitAt={initialData.lastVisitAt}
          sinceAt={initialData.sinceAt}
          visitCountLast90Days={initialData.visitCountLast90Days}
          spendCents90d={initialData.spendCents90d}
          avgPerVisitCents={initialData.avgPerVisitCents}
          totalMessageCount={initialData.totalMessageCount}
          responseRatePct={initialData.responseRatePct}
          venueTimezone={initialData.venue.timezone}
        />
      </div>

      <div className="border-t border-stone-light/60 bg-parchment p-4">
        <TransactionsList
          transactions={initialData.transactions}
          windowDays={initialData.transactionsWindowDays}
          venueTimezone={initialData.venue.timezone}
        />
      </div>
    </div>
  )
}

interface SidePanelProps {
  selected:
    | (ThreadMessage & { providerMessageId: string | null })
    | null
  traceCache: Record<string, ApiTraceWithFullDetails | null>
  traceLoading: boolean
  guestName: string
  guestPhone: string
  venueTimezone: string
  triggeredByMap: Map<string, string>
  onSelectMessage: (id: string) => void
}

function SidePanel({
  selected,
  traceCache,
  traceLoading,
  guestName,
  guestPhone,
  venueTimezone,
  triggeredByMap,
  onSelectMessage,
}: SidePanelProps) {
  if (!selected) {
    return (
      <aside className="w-full h-full overflow-y-auto p-6 bg-paper/50 border-l border-stone-light/60 text-sm text-ink-soft">
        Select a message to see its trace or details.
      </aside>
    )
  }
  if (selected.direction === 'inbound') {
    return (
      <InboundDetail
        message={{
          id: selected.id,
          body: selected.body,
          createdAt: selected.createdAt,
          providerMessageId: selected.providerMessageId,
        }}
        guestName={guestName}
        guestPhone={guestPhone}
        venueTimezone={venueTimezone}
        triggeredOutboundId={triggeredByMap.get(selected.id) ?? null}
        onSelectOutbound={onSelectMessage}
      />
    )
  }
  const trace = selected.id in traceCache ? traceCache[selected.id] : null
  const loading = traceLoading && !(selected.id in traceCache)
  return (
    <TracePanel
      trace={trace}
      loading={loading}
      langfuseTraceId={selected.langfuseTraceId}
    />
  )
}
