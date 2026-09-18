import { z } from 'zod'
import type { MessageDelivery, RecentMessage } from '@/lib/ai'
import type { ScenarioResult } from './run-test-scenarios'
import { ScenarioSchema, type Scenario, type ScenarioSheetRow } from './scenario-schema'

/**
 * TAC-481. Pure half of scenario-sequence.ts — no `@/*` imports beyond
 * types, so this loads in vitest with no SDK init (see the module-split-for-
 * testability convention in CLAUDE.md: `./run-test-scenarios` transitively
 * pulls in Voyage at module load, which trips vitest's ESM resolver, but a
 * TYPE-only import of it is erased at compile time and carries none of that
 * weight). `scenario-sequence.ts` re-exports everything here and adds the
 * DB/SDK-touching `runScenarioSequence` orchestrator.
 *
 * Multi-turn conversation support, folded in per the plan-approval ruling
 * (2026-09-18): "an agent reply that fabricates can be caught and held, and
 * the holding path then fabricates again unheld (TAC-484). A harness that
 * only checks the generated reply would have passed that conversation.
 * Whatever you build should be able to assert on what a guest actually
 * receives across a sequence, not only on one turn's draft."
 *
 * A sequence is one conversation for ONE guest: an optional literal `seed`
 * (lines that already happened before the sequence starts — e.g. the exact
 * wording of a prior holding message, copied from a real incident) followed
 * by one or more `turns`, each a guest inbound message run through the REAL
 * per-turn pipeline (runScenario: classify -> retrieve -> generate ->
 * grounding backstop -> approval gate, decision-only).
 *
 * Deliberately NOT a simulation of lib/agent/handle-holding-message.ts's
 * generation ladder (tryGenerateHolding / sendFallback / the timer that
 * fires it) — that is a second, separate generation path this harness does
 * not exercise. A scenario author reproducing a holding-message incident
 * writes the holding message's own wording as a `seed` outbound line
 * instead; what this DOES exercise faithfully is how the real inbound
 * pipeline responds to what follows, which is where TAC-484's damage
 * actually happened (three auto-sent replies escalating a fabrication, none
 * of them the holding message itself).
 *
 * `ctx.pendingQuestion` is NOT reconstructed from a seed line — build-
 * runtime-context.ts loads it fresh from this (real, but empty for a
 * synthetic guest) guest's actual pending draft, which this decision-only
 * harness never creates. A sequence therefore cannot reproduce the
 * `## Unanswered question` prompt block's effect on a later turn; it
 * reproduces the conversational history (`## Recent conversation`) a later
 * turn sees, which is where TAC-484's escalation is visible.
 */

export const SEED_LINE_DELIVERIES = ['delivered', 'awaiting_review', 'skipped_by_operator', 'never_sent'] as const

export const SeedLineSchema = z.object({
  direction: z.enum(['inbound', 'outbound']),
  body: z.string().min(1),
  // Matches lib/ai's MessageDelivery. Defaults to 'delivered' — the common
  // case (a prior message the guest actually saw, or the guest's own
  // message, which is always received by the venue).
  delivery: z.enum(SEED_LINE_DELIVERIES).default('delivered'),
})
export type SeedLine = z.infer<typeof SeedLineSchema>

export const ScenarioSequenceSchema = z.object({
  seed: z.array(SeedLineSchema).default([]),
  turns: z.array(ScenarioSchema).min(1),
})
export type ScenarioSequence = z.infer<typeof ScenarioSequenceSchema>

/** Minutes between synthesized history timestamps — arbitrary but strictly increasing and recent. */
const SEED_STEP_MINUTES = 1

/**
 * Turns an author-facing Scenario into the ScenarioSheetRow shape runScenario
 * takes, filling the sheet-merge provenance fields with fixed literals since
 * a hand-authored scenario file has no sheet to derive them from.
 */
export function toScenarioSheetRow(scenario: Scenario): ScenarioSheetRow {
  return { ...scenario, origin: 'owner', generated_hash: '', exclude: false, notes: '' }
}

/**
 * Synthesizes a RecentMessage[] from literal seed lines, oldest first, ending
 * strictly before `now` so the first real turn's inbound sorts after all of
 * them.
 */
export function buildSeedHistory(seed: readonly SeedLine[], now: Date): RecentMessage[] {
  const startMs = now.getTime() - seed.length * SEED_STEP_MINUTES * 60_000
  return seed.map((line, i) => ({
    direction: line.direction,
    body: line.body,
    createdAt: new Date(startMs + i * SEED_STEP_MINUTES * 60_000),
    delivery: line.delivery,
  }))
}

/**
 * What the guest actually received this turn, or null if nothing reached
 * them. Only a 'sent' outcome (including the crisis-safety fixed reply,
 * which runScenario also reports as outcome='sent') delivers anything in
 * this decision-only harness — there is no operator to later approve a
 * queued draft, and a dropped/refused/failed turn is never persisted in
 * production either (TAC-308 drop, the voice-fidelity refusal, a stage
 * throw), so there is nothing to receive.
 */
export function deriveReceivedBody(result: ScenarioResult): string | null {
  return result.outcome === 'sent' ? result.replyBody : null
}

/**
 * Appends one turn's guest inbound (always received by the venue) and, when
 * the outcome left a row behind, the venue's side of it — mirroring
 * production delivery semantics (TAC-394's MessageDelivery) as closely as a
 * decision-only harness can:
 *   - 'sent'    -> outbound, delivered, the real reply body
 *   - 'queued'  -> outbound, awaiting_review, blanked per TAC-309 when the
 *                  decision says production would blank it
 *   - 'dropped' / 'refused' / 'failed' -> nothing appended; none of these
 *     leave a messages row in production
 */
export function appendTurnToHistory(
  history: readonly RecentMessage[],
  turn: Scenario,
  result: ScenarioResult,
  now: Date,
): RecentMessage[] {
  const inboundAt = new Date(now.getTime())
  const replyAt = new Date(now.getTime() + 1_000)
  const next: RecentMessage[] = [
    ...history,
    { direction: 'inbound', body: turn.inbound_message, createdAt: inboundAt, delivery: 'delivered' },
  ]

  if (result.outcome === 'sent') {
    next.push({ direction: 'outbound', body: result.replyBody ?? '', createdAt: replyAt, delivery: 'delivered' })
  } else if (result.outcome === 'queued') {
    const body = result.wouldBlankBody ? '' : (result.replyBody ?? '')
    next.push({ direction: 'outbound', body, createdAt: replyAt, delivery: 'awaiting_review' as MessageDelivery })
  }
  // 'dropped' / 'refused' / 'failed': no row in production, nothing appended.

  return next
}

export interface SequenceTurnResult {
  result: ScenarioResult
  receivedBody: string | null
}
