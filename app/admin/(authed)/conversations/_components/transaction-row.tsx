'use client'

import { useState } from 'react'
import { differenceInCalendarDays } from 'date-fns'
import { formatInTimeZone } from 'date-fns-tz'
import {
  buildItemsPreview,
  formatPosProvider,
  type ParsedTicket,
  parseTicket,
} from '../lib/parse-ticket'
import { DetailBlock, HairlineDivider } from '../stage-detail/_primitives'

// One transaction row. Collapsed: date · time | items preview | item count |
// amount | chevron. Expanded: ticket detail block (clay left rule + white
// wash, matching the stage drill-down treatment from PR-3) with line items
// + footer (subtotal/tip + card last 4).
//
// Rows with null/unparsable raw_data render in a non-clickable collapsed-
// only form — chevron omitted, items preview shows muted "—". The
// item_count + amount_cents columns still populate from the row-level
// fields.
//
// Color discipline (PR-3 lesson): inline `style` for state-dependent
// chevron color (clay when open, ink-faint when closed).

export interface Transaction {
  id: string
  occurredAt: Date
  // TAC-323: null for a guest-reported order where a resolved item has no
  // price in venue_info — the whole estimate is unavailable, not $0. Render
  // via formatAmount below; never divide/sum this as if it were 0 in a
  // per-row display (aggregates elsewhere already handle the null case).
  amountCents: number | null
  itemCount: number | null
  rawData: unknown
  source: string
}

interface TransactionRowProps {
  tx: Transaction
  venueTimezone: string
  /** Operator's "now" for relative date framing. Pass once per render to keep all rows consistent. */
  now: Date
  /** Fired after a successful delete so the parent can refresh the list. */
  onDeleted?: () => void
}

export function TransactionRow({ tx, venueTimezone, now, onDeleted }: TransactionRowProps) {
  const ticket = parseTicket(tx.rawData)
  const dateLabel = formatTransactionDate(tx.occurredAt, venueTimezone, now)
  const deletable = tx.source === 'guest_reported'

  if (!ticket) {
    // Non-clickable; null raw_data has nothing meaningful to expand into.
    return (
      <div className="flex items-baseline gap-3 px-1 py-1.5 text-sm">
        <span className="text-ink-soft tabular-nums shrink-0 w-[124px]">{dateLabel}</span>
        <span className="flex-1 truncate text-ink-faint italic">—</span>
        <span className="text-ink-soft tabular-nums shrink-0 w-[64px] text-right">
          {formatItemCount(tx.itemCount)}
        </span>
        <span className="text-ink tabular-nums shrink-0 w-[72px] text-right">
          {formatAmount(tx.amountCents)}
        </span>
        {/* No chevron column — preserve column alignment with a spacer. */}
        <span className="w-3 shrink-0" aria-hidden />
        {deletable ? <DeleteButton transactionId={tx.id} onDeleted={onDeleted} /> : null}
      </div>
    )
  }

  return (
    <TransactionRowExpandable
      tx={tx}
      ticket={ticket}
      dateLabel={dateLabel}
      deletable={deletable}
      onDeleted={onDeleted}
    />
  )
}

interface ExpandableProps {
  tx: Transaction
  ticket: ParsedTicket
  dateLabel: string
  deletable: boolean
  onDeleted?: () => void
}

function TransactionRowExpandable({ tx, ticket, dateLabel, deletable, onDeleted }: ExpandableProps) {
  const [open, setOpen] = useState(false)
  const itemsPreview = buildItemsPreview(ticket.lineItems)

  return (
    <div className="flex flex-col">
      <div className="flex items-baseline gap-3 px-1 py-1.5 text-sm">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex flex-1 items-baseline gap-3 text-left cursor-pointer hover:bg-white/30 rounded transition-colors -mx-1 px-1"
          aria-expanded={open}
        >
          <span className="text-ink-soft tabular-nums shrink-0 w-[124px]">{dateLabel}</span>
          <span className="flex-1 truncate text-ink-soft">{itemsPreview}</span>
          <span className="text-ink-soft tabular-nums shrink-0 w-[64px] text-right">
            {formatItemCount(tx.itemCount ?? ticket.lineItems.length)}
          </span>
          <span className="text-ink tabular-nums shrink-0 w-[72px] text-right">
            {formatAmount(tx.amountCents)}
          </span>
          <span
            aria-hidden
            style={{ color: open ? 'var(--clay)' : 'var(--ink-faint)' }}
            className="text-xs w-3 shrink-0 text-right"
          >
            {open ? '▾' : '▸'}
          </span>
        </button>
        {deletable ? <DeleteButton transactionId={tx.id} onDeleted={onDeleted} /> : null}
      </div>

      {open ? <TicketDetail ticket={ticket} /> : null}
    </div>
  )
}

// TAC-323: delete is restricted server-side to source='guest_reported' rows
// (the route re-checks; this button only ever renders for those rows in the
// first place). Native confirm() — an internal admin tool, no need for
// bespoke modal chrome for a single irreversible-but-recoverable action
// (deleting re-arms the extractor, so a mistaken delete just means the guest
// can report again).
function DeleteButton({
  transactionId,
  onDeleted,
}: {
  transactionId: string
  onDeleted?: () => void
}) {
  const [deleting, setDeleting] = useState(false)

  async function handleDelete() {
    if (!window.confirm('Delete this guest-reported order? This cannot be undone.')) return
    setDeleting(true)
    try {
      const res = await fetch(`/admin/conversations/api/transactions/${transactionId}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        console.error('[transaction-row] delete failed', { transactionId, status: res.status })
        window.alert('Delete failed — see console for details.')
        return
      }
      onDeleted?.()
    } finally {
      setDeleting(false)
    }
  }

  return (
    <button
      type="button"
      onClick={handleDelete}
      disabled={deleting}
      className="text-xs text-ink-faint hover:text-clay shrink-0 disabled:opacity-50"
      aria-label="Delete guest-reported transaction"
    >
      {deleting ? '…' : '✕'}
    </button>
  )
}

function TicketDetail({ ticket }: { ticket: ParsedTicket }) {
  const subtotalLabel =
    ticket.subtotalCents !== null ? `subtotal $${formatDollars(ticket.subtotalCents)}` : null
  const tipLabel = ticket.tipCents !== null ? `tip $${formatDollars(ticket.tipCents)}` : null
  const footerLeft = [subtotalLabel, tipLabel].filter(Boolean).join(' · ')

  // Card last four: `card ···{1234}`. Include payment_method label only when
  // it's not the default 'card' (e.g. cash, gift_card).
  const paymentLabel =
    ticket.cardLastFour !== null
      ? `card ···${ticket.cardLastFour}`
      : ticket.paymentMethod && ticket.paymentMethod !== 'card'
        ? ticket.paymentMethod
        : null

  return (
    <DetailBlock>
      <div className="flex items-baseline justify-between gap-3">
        <span
          className="text-[11px] uppercase font-medium text-ink-faint"
          style={{ letterSpacing: 'var(--tracking-eyebrow)' }}
        >
          Ticket {ticket.ticketId ?? '—'}
        </span>
        <span className="text-xs text-ink-soft">{formatPosProvider(ticket.posProvider)}</span>
      </div>

      <div className="flex flex-col gap-1 text-sm">
        {ticket.lineItems.map((item, i) => (
          <div key={`${i}-${item.name}`} className="flex items-baseline gap-3">
            <span className="text-ink-faint tabular-nums shrink-0 w-7">{item.quantity}×</span>
            <span className="flex-1 text-ink">{item.name}</span>
            <span className="text-ink tabular-nums shrink-0">
              {item.unitPriceCents !== null
                ? `$${formatDollars(item.unitPriceCents * item.quantity)}`
                : '—'}
            </span>
          </div>
        ))}
      </div>

      {footerLeft || paymentLabel ? (
        <>
          <HairlineDivider />
          <div className="flex items-baseline justify-between gap-3 text-xs text-ink-soft">
            <span className="tabular-nums">{footerLeft}</span>
            {paymentLabel ? <span className="tabular-nums">{paymentLabel}</span> : null}
          </div>
        </>
      ) : null}
    </DetailBlock>
  )
}

// ---------------------------------------------------------------------------

function formatTransactionDate(date: Date, tz: string, now: Date): string {
  const time = formatInTimeZone(date, tz, 'h:mm a').toLowerCase()
  // Calendar-day diff in venue tz so "today"/"yesterday" matches the
  // operator's intuition for a venue in a different timezone.
  const dateLocal = formatInTimeZone(date, tz, 'yyyy-MM-dd')
  const nowLocal = formatInTimeZone(now, tz, 'yyyy-MM-dd')
  const days = differenceInCalendarDays(
    new Date(`${nowLocal}T00:00:00Z`),
    new Date(`${dateLocal}T00:00:00Z`),
  )
  if (days === 0) return `today · ${time}`
  if (days === 1) return `yesterday · ${time}`
  return `${formatInTimeZone(date, tz, 'MMM d')} · ${time}`
}

function formatDollars(cents: number): string {
  return (cents / 100).toFixed(2)
}

// TAC-323: renders the row-level amount. Null (a guest-reported order with an
// unresolved menu price) shows the muted "—" already used elsewhere in this
// file for "nothing meaningful to show" — never a fabricated "$0.00".
function formatAmount(cents: number | null): string {
  if (cents === null) return '—'
  return `$${formatDollars(cents)}`
}

function formatItemCount(count: number | null): string {
  if (count === null) return '—'
  return `${count} ${count === 1 ? 'item' : 'items'}`
}
