// Pure helper for the guest-card "Messages" line. Operates on the already-
// loaded conversation messages array (limit 200 in page.tsx) — for high-
// volume guests (>200 messages in the loaded window), the count under-counts;
// note it on the card with a "stats from N loaded messages" caveat if/when
// that becomes a real concern. For Jaipal's run (~38 messages) the loaded
// window is the full history and stats are exact.
//
// Response-rate rule: an outbound message counts as "replied" if the same
// guest sent any inbound message within RESPONSE_WINDOW_HOURS of the
// outbound's createdAt. Total = outbound count. Pct = replied / outbound,
// rounded. Returns 0 when there are no outbound messages.

const DEFAULT_RESPONSE_WINDOW_HOURS = 24
const MS_PER_HOUR = 60 * 60 * 1000

export interface MessageStatRow {
  direction: 'inbound' | 'outbound'
  createdAt: Date
}

export interface MessageStats {
  totalMessages: number
  outboundCount: number
  inboundCount: number
  repliedCount: number
  /** 0–100, rounded. */
  responseRatePct: number
  /** Window used to compute response rate, in hours. Surfaced for UI captioning. */
  responseWindowHours: number
}

export function computeMessageStats(
  messages: MessageStatRow[],
  windowHours: number = DEFAULT_RESPONSE_WINDOW_HOURS,
): MessageStats {
  const windowMs = windowHours * MS_PER_HOUR
  // Sort once so the inbound-after-outbound check can stop as soon as a
  // candidate inbound is found. Sort by createdAt ascending.
  const sorted = [...messages].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  let outboundCount = 0
  let inboundCount = 0
  let repliedCount = 0
  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i]
    if (m.direction === 'inbound') {
      inboundCount++
      continue
    }
    outboundCount++
    const replyDeadline = m.createdAt.getTime() + windowMs
    // Walk forward until either an inbound within window arrives (replied) or
    // we exceed the window (not replied) or we run out of messages.
    for (let j = i + 1; j < sorted.length; j++) {
      const candidate = sorted[j]
      const t = candidate.createdAt.getTime()
      if (t > replyDeadline) break
      if (candidate.direction === 'inbound') {
        repliedCount++
        break
      }
    }
  }
  const responseRatePct =
    outboundCount > 0 ? Math.round((repliedCount / outboundCount) * 100) : 0
  return {
    totalMessages: sorted.length,
    outboundCount,
    inboundCount,
    repliedCount,
    responseRatePct,
    responseWindowHours: windowHours,
  }
}
