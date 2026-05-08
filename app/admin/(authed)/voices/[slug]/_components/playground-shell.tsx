import type { VoicePageMessage } from '../_lib/load-voice-page'

// Playground shell — flagged-block (inbound + flagged outbound) on top, a
// clay-bordered "coming next" placeholder card below.
//
// PR-B (THE-237) intentionally ships the read-only half. PR-C wires up the
// critique textarea, regen button, attempts stack, and commit footer.
// The visual approval target for PR-B is bubble selection + flagged-block
// + the clay-bordered placeholder communicating what's coming.

interface PlaygroundShellProps {
  flaggedPair: {
    inbound: VoicePageMessage
    outbound: VoicePageMessage
  } | null
}

export function PlaygroundShell({ flaggedPair }: PlaygroundShellProps) {
  return (
    <div className="overflow-y-auto px-8 pt-4 pb-6 bg-highlight flex flex-col gap-3">
      <div className="flex items-baseline justify-between pb-2 border-b border-stone-light/60">
        <span
          className="text-[10px] uppercase font-semibold text-clay"
          style={{ letterSpacing: 'var(--tracking-eyebrow)' }}
        >
          ▸ Refining response
        </span>
        <span className="text-[11px] text-ink-faint">
          {flaggedPair
            ? 'Flag selected · regen wires up next ship'
            : 'Click an agent message above to flag it'}
        </span>
      </div>

      {flaggedPair ? (
        <>
          <div className="bg-paper border-l-2 border-clay rounded-r-[4px] px-3.5 py-3">
            <div
              className="text-[9.5px] uppercase font-semibold text-ink-faint mb-1"
              style={{ letterSpacing: 'var(--tracking-eyebrow)' }}
            >
              Inbound
            </div>
            <div className="text-[13px] text-ink-soft leading-relaxed mb-2.5">
              {flaggedPair.inbound.body}
            </div>
            <div
              className="text-[9.5px] uppercase font-semibold text-clay mb-1"
              style={{ letterSpacing: 'var(--tracking-eyebrow)' }}
            >
              Original response · flagged
            </div>
            <div className="text-[13px] text-ink leading-relaxed">
              {flaggedPair.outbound.body}
            </div>
          </div>

          <div className="bg-clay-soft/15 border-l-2 border-clay rounded-r-[4px] px-3.5 py-3">
            <p
              className="text-[12.5px] text-ink-soft leading-relaxed font-fraunces italic"
              style={{ fontVariationSettings: 'var(--fraunces-text)' }}
            >
              Refining and committing voice changes ships next. For now,
              edit rules, corpus, or persona directly in the right rail —
              changes propagate immediately and you can verify with{' '}
              <span className="font-mono not-italic text-[11px] text-ink">
                npm run send-test
              </span>
              .
            </p>
          </div>
        </>
      ) : (
        <div className="bg-paper/60 border border-stone-light/60 rounded-[4px] px-4 py-6 text-center text-[12px] text-ink-faint italic font-fraunces" style={{ fontVariationSettings: 'var(--fraunces-text)' }}>
          No outbound flagged. Click an agent message in the thread to see
          its inbound + flagged response here.
        </div>
      )}
    </div>
  )
}
