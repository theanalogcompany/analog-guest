import { Eyebrow } from '@/lib/ui'
import { formatLastRefined } from '../_lib/format-last-refined'

// Topbar — reads voiceName/venue from props (server-rendered above), shows
// "Last refined Xh ago", "Corpus · N", "Rules · N". The voiceName itself is
// edited from the persona pane (decision: persona pane field, topbar
// read-only) — `router.refresh()` after the persona PATCH propagates back
// here.

interface TopbarProps {
  venueName: string
  voiceName: string | null
  displayLabel: string
  lastRefinedAt: Date | null
  counts: { corpus: number; rules: number }
}

export function Topbar({
  venueName,
  voiceName,
  displayLabel,
  lastRefinedAt,
  counts,
}: TopbarProps) {
  return (
    <header className="flex items-center justify-between px-6 h-14 border-b border-stone-light/60 bg-paper shrink-0">
      <div className="flex items-baseline gap-3">
        <Eyebrow>Voice</Eyebrow>
        <span
          className="font-fraunces italic text-2xl text-ink leading-none"
          style={{ fontVariationSettings: 'var(--fraunces)' }}
        >
          {displayLabel}
        </span>
        <span className="pl-3 ml-1 border-l border-stone-light/60 text-[11px] text-ink-faint tracking-wide">
          {voiceName ? `used across ${venueName}` : 'unnamed · venue fallback'}
        </span>
      </div>

      <div className="flex items-center gap-5 text-[11px] text-ink-faint">
        <span>Corpus · {counts.corpus}</span>
        <span>Rules · {counts.rules}</span>
        <span className="pl-5 ml-1 border-l border-stone-light/60">
          Last refined {formatLastRefined(lastRefinedAt)}
        </span>
      </div>
    </header>
  )
}
