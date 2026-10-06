/**
 * Which `knowledge_corpus.source_type` values are KNOWLEDGE, and which exist
 * only to tune the venue's voice.
 *
 * Ruled by the owner 2026-10-05: **a voice note is not a source of fact.** It
 * is the owner talking, recorded to make the agent sound like the house. Its
 * content reached `knowledge_corpus` as a side effect of onboarding, and from
 * there it was retrieved and served to guests as if it were canonical - the
 * owner's spoken recollection competing on equal footing with the venue's own
 * site. At Le Mil's that was 52 of 140 rows, every one of them above the 0.7
 * confidence floor, so all 52 contended for the four prompt slots on every
 * turn. The venue's voice is carried by `voice_corpus` and the static voice
 * pack (decision 0008), which is untouched by this and is where voice notes
 * legitimately do their work.
 *
 * `voice_only` rows are left in the table rather than deleted. They are inert
 * at the retrieval boundary, which is reversible; a delete is not.
 *
 * ── WHY THIS IS A MAP AND NOT A LIST ───────────────────────────────────────
 * `match_knowledge_corpus` can only filter with `= any(source_type_filter)`,
 * so the wire format is an ALLOW-LIST, and an allow-list is the shape that
 * silently drops anything nobody remembered to add (decision 0002 is this
 * project's scar on exactly that, from the other direction). The column is a
 * bare `text` with no CHECK constraint, so the database cannot help.
 *
 * `satisfies Record<KnowledgeSourceType, SourceRole>` is what converts that
 * silence into a compile error: a new member of the union with no entry here
 * fails `tsc`, so adding a source type forces a deliberate ruling on whether
 * it is fact or voice. A `readonly []` of the retrievable ones would not be
 * exhaustiveness-checked and is the trap this avoids.
 *
 * The union itself is the honest weak point: the column accepts any string, so
 * a value written outside this union is invisible to the compiler AND excluded
 * at retrieval. `unknownKnowledgeSourceTypes` exists so a caller that reads
 * the table can report drift instead of discovering it as missing knowledge.
 */

/**
 * Every `source_type` present in `knowledge_corpus` today, across all venues
 * (verified against production 2026-10-05: document_import 52,
 * voicenote_transcript 73, manual_entry 37, over two venues).
 */
export const KNOWLEDGE_SOURCE_TYPES = [
  'document_import',
  'voicenote_transcript',
  'manual_entry',
] as const

export type KnowledgeSourceType = (typeof KNOWLEDGE_SOURCE_TYPES)[number]

/**
 * `knowledge` - a statement of fact about the venue, retrievable for grounding.
 * `voice_only` - how someone talks, never served as fact.
 */
export type SourceRole = 'knowledge' | 'voice_only'

export const KNOWLEDGE_SOURCE_ROLES = {
  // The venue's own documents and site pages: the authoritative substrate.
  document_import: 'knowledge',
  // Hand-written by Analog staff against something the venue confirmed.
  manual_entry: 'knowledge',
  // The owner speaking. Voice, not fact - the ruling above.
  voicenote_transcript: 'voice_only',
} satisfies Record<KnowledgeSourceType, SourceRole>

/**
 * The allow-list passed to `match_knowledge_corpus.source_type_filter`.
 *
 * Derived from the map rather than written out, so the two cannot disagree.
 */
export const RETRIEVABLE_SOURCE_TYPES: readonly KnowledgeSourceType[] =
  KNOWLEDGE_SOURCE_TYPES.filter(
    (t) => KNOWLEDGE_SOURCE_ROLES[t] === 'knowledge',
  )

export function isKnowledgeSourceType(
  value: string,
): value is KnowledgeSourceType {
  return (KNOWLEDGE_SOURCE_TYPES as readonly string[]).includes(value)
}

/**
 * Can a row with this `source_type` reach a prompt?
 *
 * An unclassified value answers FALSE, matching what the allow-list actually
 * does rather than what we might wish it did. Offline callers compare against
 * the corpus and must not count a row the agent cannot see as live coverage:
 * the knowledge loader's duplicate report said 67 proposals duplicated an
 * existing row when 24 of those matches were voice-note rows retrieval had
 * already excluded, which inverts the meaning of the number.
 */
export function isRetrievableSourceType(value: string): boolean {
  return (
    isKnowledgeSourceType(value) &&
    KNOWLEDGE_SOURCE_ROLES[value] === 'knowledge'
  )
}

/**
 * Source types present in the given rows that this module has never heard of.
 *
 * Non-empty means rows exist that retrieval is now silently excluding, because
 * the allow-list cannot contain a value the union does not know.
 *
 * Its reader is `scripts/load-venue-knowledge.ts`, which already reads every
 * corpus row's `source_type` before a load and is the one moment a human is
 * deliberately looking at this table. Warn-and-continue rather than throw: an
 * unclassified type is a prompt to rule on it, not a reason to block a load of
 * unrelated entries.
 */
export function unknownKnowledgeSourceTypes(
  rows: ReadonlyArray<{ source_type: string }>,
): string[] {
  const seen = new Set<string>()
  for (const r of rows) {
    if (!isKnowledgeSourceType(r.source_type)) seen.add(r.source_type)
  }
  return [...seen].sort()
}
