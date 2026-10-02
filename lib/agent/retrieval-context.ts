/**
 * TAC-547 — the two pure decisions behind context-aware knowledge retrieval:
 * what the contextual query is, and how two arms' results are merged.
 *
 * Pure by design. No DB, no `lib/ai` import, no `lib/rag` call. That is what
 * lets `lib/voices/regenerate-with-critique.ts` share these two decisions
 * rather than restate them — the mirror on that file has already drifted once
 * (TAC-350's relevance floor, unfixed until TAC-366), and the drift ran in
 * the direction that HID a live bug from anyone reproducing it in the
 * playground. Sharing the helper is what makes the two paths move together.
 *
 * WHY THIS EXISTS. Knowledge retrieval searched with the guest's current
 * message alone, so a follow-up that refers back — "how should I brew it",
 * "which one", "whats in it" — searched blind. Measured against Le Mil's live
 * corpus on 2026-09-28: 7 of 15 two-turn follow-ups retrieved their target
 * entry; 8 retrieved nothing relevant at all.
 */
import type { KnowledgeMatch, RuntimeContext } from './types'
import type { MessageDelivery, RecentMessage } from '@/lib/ai/types'

/**
 * How many prior turns join the contextual query.
 *
 * 2 covers the referent (the agent's answer) and the guest's own question
 * that prompted it, which is the shape of every follow-up this was filed for.
 * Chosen by measurement rather than taste: windows 1, 2 and 3 over the same
 * fixtures gave 13/15, 15/15 and 15/15 follow-ups under the shipped merge
 * rule, all at 15/15 standalone. 2 is the smallest window that clears the
 * bar. A longer window is not free — cosine tracks query length and
 * specificity as much as topicality (TAC-358), so each added turn dilutes the
 * embedding; a fixture here carries exactly two prior turns, so window 3 was
 * necessarily identical to window 2 and bought nothing.
 */
export const CONTEXT_TURNS = 2

/**
 * Cap on each context body, matching the 200 characters a history line gets
 * in the prompt. Bounds the query so one long reply cannot dominate it.
 */
export const MAX_CONTEXT_BODY_CHARS = 200

/** The two merge rules TAC-547 measured. See mergeKnowledgeMatches. */
export type MergeRule = 'best-score' | 'interleave'

/**
 * The rule production ships: INTERLEAVE, not the best-score rule the ticket
 * first specified. Chosen by a pre-registered criterion, and it was not close.
 *
 * Measured against Le Mil's live corpus, 2026-09-28, 15 follow-ups and 15
 * standalone questions (bars set before the run: >=14/15 follow-ups, 0
 * standalone regressions):
 *
 *                      follow-ups   standalone
 *   control (today)         7/15        15/15
 *   best-score             15/15         8/15   <- SEVEN regressions
 *   interleave             15/15        15/15
 *
 * WHY BEST-SCORE FAILS, and it is a fact about cosine rather than about this
 * corpus: the two arms' scores are not on one scale. The contextual query is
 * three messages long, and a longer query embeds to a systematically higher
 * cosine — top-1 median 0.7812 against the bare query's 0.5001, with the two
 * ranges barely overlapping (bare max 0.649, contextual min 0.653). So
 * "keep the best score" is really "keep the contextual arm", which displaced
 * 83 of 120 control entries and cost seven standalone targets. TAC-358
 * measured the same property from another angle: cosine tracks query length
 * and specificity, not answerability.
 *
 * Interleaving ranks instead of scores is scale-free, so it does not care,
 * and it GUARANTEES the control arm's top two survive: with two arms and a
 * limit of 4 the slots are A0, B0, A1, B1. That is the structural half of the
 * no-lost-result claim; see mergeKnowledgeMatches.
 */
export const KNOWLEDGE_MERGE_RULE: MergeRule = 'interleave'

/**
 * Did this message reach the guest?
 *
 * A guest's "it" can only refer to something they actually read, so a draft
 * that never reached them must not steer the search — and a held draft is
 * exactly the text most likely to be about something else. Inbound always
 * counts; outbound counts only when delivered.
 *
 * Exhaustive, so a sixth MessageDelivery value fails `tsc` here rather than
 * defaulting into the query. `answered_outside_app` is NOT delivered: that
 * row was never sent, and what staff actually wrote arrives as its own echo
 * row marked delivered (TAC-473).
 */
export function reachedGuest(message: RecentMessage): boolean {
  if (message.direction === 'inbound') return true
  const delivery: MessageDelivery = message.delivery
  switch (delivery) {
    case 'delivered':
      return true
    case 'awaiting_review':
    case 'skipped_by_operator':
    case 'answered_outside_app':
    case 'never_sent':
      return false
  }
}

function normalizeBody(body: string): string {
  const collapsed = body.replace(/\s*\n\s*/g, ' ').trim()
  return collapsed.length <= MAX_CONTEXT_BODY_CHARS
    ? collapsed
    : collapsed.slice(0, MAX_CONTEXT_BODY_CHARS)
}

/**
 * The prior turns that may join the query: the last `turns` entries that
 * reached the guest and fall inside the conversation window, chronological.
 *
 * The window is `ctx.conversationWindowMs` — `followup_rules.recent_conversation_hours`,
 * 48h by default. Reused rather than reinvented: TAC-380 ruling 1 made that
 * the ONE definition of "still the same conversation", shared with followups
 * and the intention brake, and a second definition is how the two drift.
 *
 * Exported for the measurement harness; `buildContextQuery` is
 * what callers use.
 */
export function contextTurns(
  ctx: RuntimeContext,
  turns = CONTEXT_TURNS,
): RecentMessage[] {
  if (turns <= 0) return []
  // Measured from the CURRENT MESSAGE, not from wall-clock now. The question
  // is whether a prior turn belongs to the same conversation as the message
  // being answered, which is a fact about those two messages.
  //
  // Identical in production, where the inbound is seconds old. It is what
  // makes the Voices regen path work at all: that path pins history with
  // `historyEndIso` while `buildRuntimeContext` stamps `computedAt = new
  // Date()`, so against wall clock every replay older than the window has an
  // empty context and the contextual arm is silently dead — the TAC-367
  // re-dating trap ("historyEndIso pins message history, NOT the clock")
  // arriving through a second consumer. Found in code review.
  const now = (
    ctx.currentMessage?.receivedAt ?? ctx.recognition.computedAt
  ).getTime()
  const windowMs = ctx.conversationWindowMs
  return ctx.recentMessages
    .filter((m) => m.body.trim().length > 0)
    .filter(reachedGuest)
    .filter((m) => now - m.createdAt.getTime() <= windowMs)
    .slice(-turns)
}

/**
 * The contextual query: the prior turns, then the current message last.
 *
 * Returns '' when there is no usable prior turn — a first message, a
 * conversation whose last exchange is older than the window, or one where
 * nothing reached the guest. **The caller must treat '' as "do not run the
 * second arm at all"**, which is what makes a first message byte-identical to
 * today: no second embed, no second RPC, no merge.
 */
export function buildContextQuery(
  ctx: RuntimeContext,
  turns = CONTEXT_TURNS,
): string {
  const current = ctx.currentMessage?.body?.trim()
  if (!current) return ''
  const prior = contextTurns(ctx, turns)
  if (prior.length === 0) return ''
  return [
    ...prior.map((m) => normalizeBody(m.body)),
    normalizeBody(current),
  ].join('\n')
}

/**
 * Merge the arms' results into one slate.
 *
 * Dedupe, keep the best score per entry, then apply the existing top-k and
 * relevance floor — in that order, which is the order production already
 * uses (the RPC's own `match_count` is applied before `filterByRelevance`).
 *
 * DEDUPE IS BY CHUNK `id`, NOT `knowledgeCorpusId`. The type is named for the
 * corpus but `id` is the `knowledge_embeddings` row (the TAC-500 trap). One
 * corpus entry split across several chunks legitimately returns several rows,
 * and collapsing them by corpus id would drop one chunk's TEXT — a regression
 * against the control. (Le Mil's is 1:1 today: 129 entries, 129 embeddings,
 * 0 multi-chunk, measured 2026-09-28. The code has to be right regardless.)
 *
 * Both rules attach the best score to the retained row, so they differ ONLY
 * in which entries are selected and in what order:
 *
 *   best-score — rank by merged score. What the ticket specifies. A control
 *     entry keeps its own score, so it is displaced only by four entries
 *     scoring strictly higher; that is possible, and the standalone arm of
 *     the measurement is what bounds it.
 *   interleave — round-robin by RANK across the arms (A0, B0, A1, B1, …).
 *     Scale-free, so it does not care that a longer query embeds to a
 *     different score range, and with two arms it guarantees the first arm's
 *     top 2 survive **so long as `limit >= 3`** — A1 sits in slot 3. That
 *     condition is not decorative: KNOWLEDGE_RETRIEVE_LIMIT is an editable
 *     tunable surfaced on /admin/tunables, and at limit 2 the slate is
 *     A0, B0 and A1 is displaced.
 *
 * The floor cannot change the result when the arms come from
 * `retrieveKnowledgeStage`, which has already applied it — each merged score
 * is the max of two values that both cleared it. It is applied anyway so a
 * caller passing raw RPC rows gets the same guarantee. Stated so nobody reads
 * it as load-bearing on today's call path.
 */
export function mergeKnowledgeMatches(
  arms: KnowledgeMatch[][],
  // Supplied by the caller rather than imported from './stages', which would
  // make this module import the whole agent stage layer (and Voyage init with
  // it) and create a cycle, costing the purity that lets the
  // Voices mirror load it on its own. There is exactly one production caller,
  // `retrieveKnowledgeWithContextStage`, and it passes the canonical
  // KNOWLEDGE_RETRIEVE_LIMIT and KNOWLEDGE_RELEVANCE_FLOOR — so the values
  // still have one definition each.
  opts: { rule: MergeRule; limit: number; floor: number },
): KnowledgeMatch[] {
  const best = new Map<string, KnowledgeMatch>()
  for (const arm of arms) {
    for (const row of arm) {
      const seen = best.get(row.id)
      if (seen === undefined || row.similarity > seen.similarity)
        best.set(row.id, row)
    }
  }

  const selected =
    opts.rule === 'best-score'
      ? selectByScore(arms, best)
      : selectByRank(arms, best)
  return selected.slice(0, opts.limit).filter((r) => r.similarity >= opts.floor)
}

function selectByScore(
  arms: KnowledgeMatch[][],
  best: Map<string, KnowledgeMatch>,
): KnowledgeMatch[] {
  // `best` is filled in arm order, `Map.set` on an existing key does not move
  // it, and Array.prototype.sort is stable (ES2019) — so a tie already falls
  // out as first arm, then first seen. An explicit tiebreak here was provably
  // inert for every input; it was removed in code review rather than left
  // reading as a guard.
  return [...best.values()].sort((a, b) => b.similarity - a.similarity)
}

function selectByRank(
  arms: KnowledgeMatch[][],
  best: Map<string, KnowledgeMatch>,
): KnowledgeMatch[] {
  const out: KnowledgeMatch[] = []
  const taken = new Set<string>()
  const depth = Math.max(0, ...arms.map((a) => a.length))
  for (let rank = 0; rank < depth; rank += 1) {
    for (const arm of arms) {
      const row = arm[rank]
      if (row === undefined || taken.has(row.id)) continue
      taken.add(row.id)
      out.push(best.get(row.id) ?? row)
    }
  }
  return out
}
