import { cache } from 'react'
import { logger } from '@/lib/observability/logger'
import { createStageTimer, SLOW_RENDER_MS } from './stage-timer'

// Per-request stage timing for admin pages, so no part of a page's server
// time is unattributed.
//
// WHY THIS EXISTS. A latency report on /admin/tests/human-eval measured
// 1748ms of server time against 217ms in the browser, and nothing could say
// where the 1748ms went. The conversations page had stage-timer.ts and could
// answer that question for itself; every other admin page could not, because
// using it meant threading a timer through each loader signature. This holds
// one timer per request so a page only marks.
//
// GAP-FREE BY CONSTRUCTION, which is the whole point. `mark` records the time
// since the PREVIOUS mark rather than the duration of a call it wrapped, so
// work between two marks cannot hide: it lands on the next stage instead of
// disappearing. An earlier version of this file timed individual awaited
// calls and would have reported a page as 300ms of stages inside a 1700ms
// request, with the gap invisible and the numbers looking fine.
//
// WHY NOT LANGFUSE. lib/observability/CLAUDE.md is explicit that the span
// processor filters by instrumentation scope on purpose, and that widening it
// exports a span per outbound fetch - ingestion volume nobody chose plus a PII
// surface LANGFUSE_CAPTURE_CONTENT does not gate. Page loads are also not
// agent turns: they would land in the same percentile queries that assume one
// trace per turn. Logs are the right layer for this.
//
// WHY NOT Server-Timing HEADERS. They are the nicer surface - DevTools renders
// them natively - but response headers are committed when the stream opens,
// and these numbers are only known after the awaits that produce them.
//
// WHAT IT STILL CANNOT SEE: React's render and serialization, which happen
// after the last mark. The gap between `totalMs` here and the duration Vercel
// logs for the same request IS that remainder, and that subtraction is the
// point - so do not read `totalMs` as the whole request.

// One timer per server render pass. cache() with no arguments is a
// per-request singleton, which is what keeps this out of loader signatures.
const requestTimer = cache(() => createStageTimer())

// Module scope, so it is per function instance rather than per request. A
// cold instance pays module init, client construction and TLS setup on its
// first request, and that cost is invisible in any per-stage number.
const instanceStartedAt = Date.now()
let requestsServedByThisInstance = 0

/**
 * Close the current stage and name it. Everything since the previous mark
 * counts against it, including work this page did not explicitly wrap.
 */
export function mark(stage: string): void {
  requestTimer().mark(stage)
}

/**
 * Emit this request's stage breakdown. Call once, after the last mark.
 *
 * Warns rather than informs above SLOW_RENDER_MS, matching what the
 * conversations page already does with the same timer.
 */
export function reportRequestTiming(route: string): void {
  const timer = requestTimer()
  requestsServedByThisInstance += 1
  const rendered = {
    route,
    totalMs: timer.totalMs(),
    stages: timer.stages(),
    lastStage: timer.lastStage(),
    // True on the first request an instance serves, which is the one paying
    // cold start. Distinguishing cold from warm in the log is what stops a
    // cold outlier being read as the typical page.
    coldInstance: requestsServedByThisInstance === 1,
    instanceAgeMs: Date.now() - instanceStartedAt,
  }
  if (rendered.totalMs >= SLOW_RENDER_MS) {
    logger.warn('[admin-timing] render slow', rendered)
  } else {
    logger.info('[admin-timing] render', rendered)
  }
}
