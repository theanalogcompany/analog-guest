import { HairlineRow } from '@/lib/ui'

// TAC-379 §3, rewritten for TAC-380. These conditions live OUTSIDE the
// definitions' own text and decide whether an open intention ever reaches the
// prompt. Without them the page implies every definition applies to every guest
// on every turn, which is false several times over.
//
// Deliberately static text, per §3: most of these are composed logic in their
// source files with no single exported constant to read. Numbers are
// deliberately NOT restated: the thresholds are per-venue placeholders, and the
// defaults are on /admin/tunables.
//
// The menu-mention entry describes the rule rather than quoting the prompt line
// it suppresses. no-copied-strings.test.ts catches a quoted definition string but
// not a paraphrase, so the safe move is not to paraphrase one either.

interface Gate {
  title: string
  detail: string
  source: string
}

const GATES: readonly Gate[] = [
  {
    title: 'Inbound turns only',
    detail:
      'Intentions are derived only when the run has a current inbound message. Every follow-up run gets an empty set, because nothing on that path records a prompt to close one.',
    source: 'lib/agent/build-runtime-context.ts',
  },
  {
    title: 'Arming',
    detail:
      "Each intention becomes relevant only after its own event: the guest texting in by scanning the sign, an open recommendation to them, an order they placed, or simply being a guest. Only the newest recommendation or order counts, and only once it is older than the follow-up conversation window: while it is still the conversation it happened in, the intention that asks about it does not render at all. A newer recommendation or order from a later conversation re-arms its intention, even one already raised or run out, unless the guest left its last prompt unanswered; first-contact intentions never re-arm. An event past the intention's window never arms it.",
    source: 'lib/agent/intentions/derive.ts',
  },
  {
    title: 'Conversational gate',
    detail:
      "Every intention except understand_order also needs the guest's response rate at or above the venue's floor and a minimum count of lifetime replies, which is what staggers them. Once an intention is recorded eligible it stays eligible and the gate is not checked again, except when a newer event re-arms a recommendation or order intention, which checks it afresh.",
    source: 'lib/agent/intentions/derive.ts · venue_configs.intention_rules',
  },
  {
    title: 'Unanswered-prompt brake',
    detail:
      "When the guest's most recent prompts each went unanswered, meaning no reply arrived within the follow-up conversation window, no intention renders at all. Intentions closed after a classifier failure don't count as prompts.",
    source: 'lib/agent/intentions/derive.ts · followup_rules.recent_conversation_hours',
  },
  {
    title: 'Menu-mention suppression',
    detail:
      'understand_order is dropped for the current turn when the inbound names a menu item, so the reply answering an order question is never rendered beside a line stating that the order is still unknown.',
    source: 'lib/agent/intentions/derive.ts',
  },
  {
    title: 'Opt-out and pending-question suppression',
    detail:
      'Nothing renders on a turn classified opt_out, or while the guest is still owed an answer to an earlier question. The turn is lost, not the intention: nothing is recorded, so it stays open. Recording reads the same rule, so a classifier failure can never close an intention the guest did not see.',
    source: 'lib/agent/intentions/derive.ts (renderableIntentions)',
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
