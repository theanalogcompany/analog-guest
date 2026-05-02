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
  amountCents: number
  itemCount: number | null
  rawData: unknown
  source: string
}

interface TransactionRowProps {
  tx: Transaction
  venueTimezone: string
  /** Operator's "now" for relative date framing. Pass once per render to keep all rows consistent. */
  now: Date
}

export function TransactionRow({ tx, venueTimezone, now }: TransactionRowProps) {
  const ticket = parseTicket(tx.rawData)
  const dateLabel = formatTransactionDate(tx.occurredAt, venueTimezone, now)

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
          ${formatDollars(tx.amountCents)}
        </span>
        {/* No chevron column — preserve column alignment with a spacer. */}
        <span className="w-3 shrink-0" aria-hidden />
      </div>
    )
  }

  return <TransactionRowExpandable tx={tx} ticket={ticket} dateLabel={dateLabel} />
}

interface ExpandableProps {
  tx: Transaction
  ticket: ParsedTicket
  dateLabel: string
}

function TransactionRowExpandable({ tx, ticket, dateLabel }: ExpandableProps) {
  const [open, setOpen] = useState(false)
  const itemsPreview = buildItemsPreview(ticket.lineItems)

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-baseline gap-3 px-1 py-1.5 text-sm text-left cursor-pointer hover:bg-white/30 rounded transition-colors"
        aria-expanded={open}
      >
        <span className="text-ink-soft tabular-nums shrink-0 w-[124px]">{dateLabel}</span>
        <span className="flex-1 truncate text-ink-soft">{itemsPreview}</span>
        <span className="text-ink-soft tabular-nums shrink-0 w-[64px] text-right">
          {formatItemCount(tx.itemCount ?? ticket.lineItems.length)}
        </span>
        <span className="text-ink tabular-nums shrink-0 w-[72px] text-right">
          ${formatDollars(tx.amountCents)}
        </span>
        <span
          aria-hidden
          style={{ color: open ? 'var(--clay)' : 'var(--ink-faint)' }}
          className="text-xs w-3 shrink-0 text-right"
        >
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open ? <TicketDetail ticket={ticket} /> : null}
    </div>
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
              ${formatDollars(item.unitPriceCents * item.quantity)}
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

function formatItemCount(count: number | null): string {
  if (count === null) return '—'
  return `${count} ${count === 1 ? 'item' : 'items'}`
}
