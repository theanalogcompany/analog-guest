import { StatusDot } from '@/lib/ui'
import { EmptySectionNote } from './section-shell'

export interface KnowledgeEntryListRow {
  id: string
  content: string
  primaryTags: string[]
  secondaryTags: string[]
  isProcessed: boolean
}

// Shared row rendering for every knowledge_corpus-backed section (TAC-343
// Stage A). The `isProcessed` marker is load-bearing, not decoration: a row
// with is_processed=false has no knowledge_embeddings and is therefore
// invisible to retrieval even though it looks like ordinary content here —
// the same silent-gap class as knowledge_corpus having no floor at all
// (per the plan-review addition on surfacing embed failures).

export function KnowledgeEntryList({
  entries,
  emptyMessage,
}: {
  entries: readonly KnowledgeEntryListRow[]
  emptyMessage: string
}) {
  if (entries.length === 0) {
    return <EmptySectionNote>{emptyMessage}</EmptySectionNote>
  }

  return (
    <ul className="flex flex-col gap-3">
      {entries.map((entry) => (
        <li
          key={entry.id}
          className="flex flex-col gap-1.5 border-b border-stone-light/40 pb-3 last:border-b-0 last:pb-0"
        >
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm text-ink leading-snug">{entry.content}</p>
            {!entry.isProcessed && (
              <span className="flex shrink-0 items-center gap-1.5 text-xs text-clay">
                <StatusDot tone="bad" label="not retrievable" />
                not retrievable
              </span>
            )}
          </div>
          {(entry.primaryTags.length > 0 || entry.secondaryTags.length > 0) && (
            <div className="flex flex-wrap gap-1.5">
              {entry.primaryTags.map((tag) => (
                <span
                  key={`p-${tag}`}
                  className="rounded-[2px] bg-highlight px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-soft"
                >
                  {tag}
                </span>
              ))}
              {entry.secondaryTags.map((tag) => (
                <span
                  key={`s-${tag}`}
                  className="rounded-[2px] px-1.5 py-0.5 text-[10px] text-ink-faint"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}
