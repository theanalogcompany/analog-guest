import { HairlineRow } from '@/lib/ui'
import type { IntentionPromptRow } from '../../_lib/load-intention-prompts'
import { formatPromptedAt, resolveDefinition } from '../_lib/definition-display'

// TAC-379. One row per guest_intention_prompts record. The table's unique
// constraint is (guest_id, intention_key), so a row here means "this guest was
// asked this". Since TAC-380 that is once, ever, for first-contact intentions;
// an event-armed row shows only its latest prompt, and a newer event can re-arm it.

export function RecordedPromptsList({ rows }: { rows: readonly IntentionPromptRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-ink-faint italic max-w-2xl">
        No intention prompts recorded yet. A row appears here only after a sent message actually
        raises an open intention, which the conditions above make rare.
      </p>
    )
  }

  return (
    <div className="flex flex-col">
      {rows.map((row, i) => {
        const resolved = resolveDefinition(row.intentionKey)
        return (
          <HairlineRow
            key={row.id}
            last={i === rows.length - 1}
            className="flex flex-col gap-1.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6"
          >
            <div className="flex flex-col gap-1 min-w-0">
              <span className="text-sm text-ink">{row.guestLabel}</span>
              <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <code className="text-xs text-ink-soft">{row.intentionKey}</code>
                {/* An intention_key with no live definition still renders.
                    The column has no FK, so a renamed or removed definition
                    leaves history behind — hiding it would hide the cap that
                    row still enforces. */}
                {resolved.known ? null : (
                  <span className="text-[11px] text-ink-faint italic">
                    no matching definition
                  </span>
                )}
                {/* TAC-380: the classifier failed twice and this was closed
                    without anyone judging the message. It may never have been
                    asked, so it must not read as a real prompt. */}
                {row.promptSource === 'pessimistic' ? (
                  <span className="text-[11px] text-ink-faint italic">
                    closed without a verdict
                  </span>
                ) : null}
              </span>
            </div>
            <div className="flex flex-col gap-1 sm:items-end shrink-0">
              <span className="text-xs text-ink-faint tabular-nums">
                {formatPromptedAt(row.promptedAt)}
              </span>
              <span className="text-xs text-ink-faint">
                {row.venueName}
                {/* Says only what the column proves. ON DELETE SET NULL
                    (migration 035) makes a deleted message the likely cause,
                    but null alone cannot establish that. */}
                {row.messageId ? null : ' · no linked message'}
              </span>
            </div>
          </HairlineRow>
        )
      })}
    </div>
  )
}
