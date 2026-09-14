import { HairlineRow } from '@/lib/ui'

// TAC-379 §3. These four gates live OUTSIDE the definitions and are the
// reason an intention may never fire for a given guest. Without them the
// page implies every definition applies to everyone, which is false four
// times over.
//
// Deliberately static text, per §3. Two of the four (the qr_scan check and
// the opt_out check) are bare literals in their source files with no exported
// constant to read, so "deriving" this list would mean inventing constants in
// agent-runtime files to serve an admin page.

interface Gate {
  title: string
  detail: string
  source: string
}

const GATES: readonly Gate[] = [
  {
    title: 'Inbound turns only',
    detail:
      'Intentions are derived only when the run has a current inbound message. Every follow-up run gets an empty set, because nothing on that path ever records a prompt to cap it.',
    source: 'lib/agent/build-runtime-context.ts',
  },
  {
    title: 'QR-scan guests only',
    detail:
      'A guest whose created_via is anything other than qr_scan derives no intentions at all.',
    source: 'lib/agent/intentions/derive.ts',
  },
  {
    title: 'Menu-mention suppression',
    detail:
      'learn_first_order is dropped for the current turn when the inbound names a menu item, so the reply answering an order question is never rendered beside a line stating that the order is still unknown.',
    source: 'lib/agent/intentions/derive.ts',
  },
  {
    title: 'Opt-out suppression',
    detail:
      'The whole block is suppressed on any turn classified opt_out. A guest asking to stop being contacted never shares a prompt with a goal to pursue.',
    source: 'lib/ai/prompts/serializers.ts',
  },
]

export function GatingConditions() {
  return (
    <div className="flex flex-col">
      {GATES.map((gate, i) => (
        <HairlineRow key={gate.title} last={i === GATES.length - 1} className="flex flex-col gap-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
            <span className="text-sm text-ink font-medium">{gate.title}</span>
            <code className="text-xs text-ink-faint">{gate.source}</code>
          </div>
          <p className="text-sm text-ink-soft leading-snug max-w-3xl">{gate.detail}</p>
        </HairlineRow>
      ))}
    </div>
  )
}
