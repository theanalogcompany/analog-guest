import { EmptySectionNote, SectionShell } from '@/app/admin/_components/section-shell'
import { HairlineRow, StatusDot } from '@/lib/ui'
import {
  RECORDED_PROMPTS_LIMIT,
  type IntentionPromptRow,
} from '../../../_lib/load-intention-prompts'
import type { VenueOpenIntentions } from '../../../_lib/load-venue-intentions'
import { formatPromptedAt, resolveDefinition } from '../../../intentions/_lib/definition-display'
import { formatAge } from '../../_lib/commitment-display'

// TAC-381: what the agent is pursuing with this venue's guests.
//
// Two blocks answering two different questions, which is the whole reason both
// are here. OPEN is derived live from recorded eligibility and is what the agent
// would carry into the next conversation. RAISED is the prompted rows of
// guest_intention_prompts (TAC-380: that table also holds eligibility rows now,
// which the loader filters out). A prompted row means the intention was already
// raised and is closed for that guest, unless a newer recommendation or order
// re-armed it, when OPEN lists it too. Collapsing them into one list would
// misreport both.
//
// Every definition string is READ from INTENTION_DEFINITIONS via
// resolveDefinition, never pasted. no-copied-strings.test.ts enforces that at
// the source level across both this surface and the intentions page.

function OpenIntentionsBlock({
  openIntentions,
  now,
}: {
  openIntentions: VenueOpenIntentions
  now: Date
}) {
  const { rows, degraded, cohortTruncated } = openIntentions

  if (rows.length === 0) {
    return (
      <EmptySectionNote>
        {degraded
          ? 'Could not determine what is open — a supporting read failed, so this is not a claim that nothing is.'
          : 'Nothing open. The agent is not carrying a goal into any conversation at this venue.'}
      </EmptySectionNote>
    )
  }

  return (
    <div className="flex flex-col">
      {degraded && (
        // StatusDot rather than a hand-picked amber: it is the repo's own
        // idiom for status colour on internal surfaces, and inventing a hex
        // here would be a second, unbridged source of the same signal.
        <p className="mb-2 flex items-center gap-2 text-xs text-ink-soft">
          <StatusDot tone="neutral" label="degraded" />
          A supporting read failed. This list under-reports — treat it as a floor, not a total.
        </p>
      )}
      {cohortTruncated && (
        <p className="mb-2 text-xs text-ink-faint">
          Guest cohort hit its cap; older guests in the window are not listed.
        </p>
      )}
      {rows.map((row, i) => (
        <HairlineRow
          key={row.guestId}
          last={i === rows.length - 1}
          className="flex flex-col gap-1.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6"
        >
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-sm text-ink">{row.guestLabel}</span>
            <div className="flex flex-col gap-0.5">
              {row.openKeys.map((key) => {
                const resolved = resolveDefinition(key)
                return (
                  <span key={key} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                    <code className="text-ink-soft">{key}</code>
                    {/* Read from the constant, never copied — a drifted copy
                        would misreport what the model actually sees. */}
                    {resolved.known && (
                      <span className="text-ink-faint">{resolved.definition.promptLine}</span>
                    )}
                  </span>
                )
              })}
            </div>
          </div>
          <span className="shrink-0 text-xs text-ink-faint tabular-nums">
            guest since {formatAge(row.guestCreatedAt, now)}
          </span>
        </HairlineRow>
      ))}
    </div>
  )
}

function RaisedIntentionsBlock({ rows }: { rows: readonly IntentionPromptRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptySectionNote>
        Nothing raised at this venue yet. A row appears only after a sent message actually raises
        an open intention.
      </EmptySectionNote>
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
            className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6"
          >
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-sm text-ink">{row.guestLabel}</span>
              <code className="text-xs text-ink-soft">{row.intentionKey}</code>
              {!resolved.known && (
                <span className="text-[11px] text-ink-faint italic">no matching definition</span>
              )}
              {row.promptSource === 'pessimistic' && (
                <span className="text-[11px] text-ink-faint italic">closed without a verdict</span>
              )}
            </span>
            <span className="shrink-0 text-xs text-ink-faint tabular-nums">
              {formatPromptedAt(row.promptedAt)}
            </span>
          </HairlineRow>
        )
      })}
    </div>
  )
}

export function IntentionsSection({
  openIntentions,
  raised,
  raisedHasMore,
  now,
}: {
  openIntentions: VenueOpenIntentions
  raised: readonly IntentionPromptRow[]
  /**
   * True when a raised row beyond RECORDED_PROMPTS_LIMIT exists. Stated, never
   * silently applied — the subtitle below reads as a complete list otherwise,
   * and 200 rows is only 100 prompted guests at one venue. Same TAC-316 lesson
   * the closed-commitments cap already follows.
   */
  raisedHasMore: boolean
  now: Date
}) {
  return (
    <SectionShell
      title="Intentions"
      subtitle="Goals the agent carries into conversations at this venue. Read-only."
    >
      <p className="mb-3 text-xs text-ink-faint max-w-2xl">
        Open means recorded eligible, not yet raised, inside its window, and not answered by a fact
        on record. It is not a promise the block will appear — the brake and several other
        conditions decide that at the moment of a live turn, and none of them are knowable here. An
        intention whose gate opened since the guest last texted appears only after their next
        message. The full list is on the Intentions page.
      </p>
      <OpenIntentionsBlock openIntentions={openIntentions} now={now} />

      <div className="mt-6 border-t border-stone-light/60 pt-4">
        <p className="mb-2 text-xs text-ink-faint max-w-2xl">
          Already raised here · one row per guest per intention, showing its latest prompt. A
          recommendation or order intention that a newer event re-armed is listed as open too.{' '}
          {raisedHasMore
            ? `Showing the ${RECORDED_PROMPTS_LIMIT} most recent; older ones exist and are not listed. `
            : ''}
          Worth reading against the message that produced it: a row recorded off a send that was
          not really making that move is how a mis-classification becomes visible.
        </p>
        <div className="opacity-80">
          <RaisedIntentionsBlock rows={raised} />
        </div>
      </div>
    </SectionShell>
  )
}
