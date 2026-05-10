// Category → primary tag preference for knowledge_corpus retrieval (TAC-242).
// Mapped categories filter via SQL `&&` (array overlap, OR semantics —
// chunk qualifies if it has ANY of the listed primary tags). Unmapped
// categories use cosine-only. Sparse-corpus recall is preserved by a
// no-filter fallback in retrieveKnowledgeStage.

import type { MessageCategory } from '@/lib/ai/types'
import type { KnowledgePrimaryTag } from '@/lib/schemas'

export const CATEGORY_TO_PRIMARY_TAG_PREFERENCE: Partial<
  Record<MessageCategory, KnowledgePrimaryTag[]>
> = {
  mechanic_request: ['mechanic'],
  perk_inquiry: ['mechanic'],
  recommendation_request: ['recommendations', 'menu', 'sourcing'],
  event_question: ['events'],
}

/**
 * Resolve the primary-tag preference for a category. Returns undefined when
 * no preference exists (the call site should fall through to cosine-only).
 */
export function getPrimaryTagPreference(
  category: MessageCategory | null,
): KnowledgePrimaryTag[] | undefined {
  if (category === null) return undefined
  return CATEGORY_TO_PRIMARY_TAG_PREFERENCE[category]
}
