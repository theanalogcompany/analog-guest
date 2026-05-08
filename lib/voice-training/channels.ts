// Channel identifiers for voice_corpus writes. Kept in one place so the
// surfaces that PRODUCE (cc-review API, 08-flow CLI, future voices-commit
// endpoint) and the surfaces that CONSUME (rail-corpus rendering, future
// fleet analytics) agree on the strings.
//
// `source_ref` prefix marks the channel the row came from. Stored on
// voice_corpus.source_ref under the partial unique index from migration
// 008. Used for idempotent upsert + paired-row display.
//
// Channel tag is what the rail's corpus pane skips when picking a
// human-meaningful category from a row's tags array — operator-typed tags
// like `menu_fact` should win over storage metadata like `cc_review`.

export const SOURCE_REF_PREFIXES = {
  ccReview: 'cc-review:',
  voicesCommit: 'voices-commit:',
  phase5Review: '08-review:',
} as const

export const REPLY_PAIRED_SOURCE_REF_PREFIXES: ReadonlyArray<string> = [
  SOURCE_REF_PREFIXES.ccReview,
  SOURCE_REF_PREFIXES.voicesCommit,
  SOURCE_REF_PREFIXES.phase5Review,
]

export const CORPUS_CHANNEL_TAGS: ReadonlySet<string> = new Set([
  'cc_review',
  'phase_5_review',
  'voices_commit',
])

export function isReplyPairedSourceRef(sourceRef: string | null): boolean {
  if (!sourceRef) return false
  return REPLY_PAIRED_SOURCE_REF_PREFIXES.some((p) => sourceRef.startsWith(p))
}
