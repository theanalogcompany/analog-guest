'use client'

import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { MESSAGE_CATEGORIES } from '@/lib/ai/types'
import type { MessageCategory } from '@/lib/ai/types'
import {
  isPolicyExemptCategory,
  POLICY_EXEMPT_CATEGORIES,
  resolveCategoryPolicy,
  type ApprovalDisposition,
  type ApprovalPolicy,
} from '@/lib/schemas/approval-policy'
import { SectionShell } from './section-shell'

// TAC-307: per-venue approval-policy controls. The write side of
// venue_configs.approval_policy, which until this ticket had a runtime reader
// (trigger 8) but no way to set it short of hand-written SQL.
//
// CATEGORIES COME FROM MESSAGE_CATEGORIES, NOT A LIST MAINTAINED HERE. That
// const is the source the MessageCategory type itself is derived from, so a
// category added to the classifier appears in this UI with no change to this
// file. A hardcoded list here would drift silently — the failure this repo
// has hit repeatedly with parallel category enums.
//
// opt_out is absent by construction: POLICY_EXEMPT_CATEGORIES filters it, and
// the route refuses it independently. See that constant for the TCPA reason.
//
// TWO DELIBERATE UX RULES, both downstream of "a control with exceptions is
// worse than no control":
//
//  1. MASTER SWITCH ON writes {default:'operator_approval', perCategory:{}}
//     and disables every per-category control. It holds everything, with no
//     per-category escape hatch, because the master switch is what gets
//     reached for when something is already wrong.
//
//  2. SAVING WRITES ONLY THE CATEGORIES THE ADMIN ACTUALLY TOUCHED, layered
//     on top of whatever this venue already stored. This is narrower than it
//     first looks and the narrowness is the point.
//
//     It still closes the merge trap: getEffectivePerCategoryPolicy layers
//     APPROVAL_POLICY_DEFAULT on top of stored values, so UNCHECKING a
//     code-defaulted category has to persist an explicit 'auto_send' or the
//     default re-asserts and the box re-checks itself on reload. Unchecking
//     is a touch, so it persists.
//
//     What it avoids is the reverse. comp_complaint renders pre-checked
//     because of the fleet-wide code default, not because anyone chose it.
//     Writing every shown category would turn that into a `stored` entry,
//     which the gate treats as ABSOLUTE — so ticking an unrelated box and
//     hitting Save would silently strip comp_complaint's clarifying-question
//     carve-out and stall complaint openers behind an operator. It would also
//     break the fleet-default mechanism itself: a future ticket adding a
//     category to APPROVAL_POLICY_DEFAULT.perCategory expecting a no-migration
//     rollout would silently skip every venue anyone had ever saved here,
//     because they'd all carry an explicit 'auto_send'.

const EXEMPT_LABEL = POLICY_EXEMPT_CATEGORIES.join(', ')

// Mirrors the grouping comment on MESSAGE_CATEGORIES. Outbound-only
// categories are set by the orchestrator rather than the classifier, but they
// still reach the approval gate, so they are still holdable.
const OUTBOUND_ONLY: readonly MessageCategory[] = [
  'welcome',
  'follow_up',
  'perk_unlock',
  'event_invite',
]

function isOutboundOnly(category: MessageCategory): boolean {
  return OUTBOUND_ONLY.includes(category)
}

export function ApprovalPolicySection({
  venueId,
  policy,
}: {
  venueId: string
  policy: ApprovalPolicy
}) {
  const router = useRouter()

  const categories = useMemo(
    () => MESSAGE_CATEGORIES.filter((c) => !isPolicyExemptCategory(c)),
    [],
  )

  // Seeded from the resolver itself rather than a second hand-written copy of
  // its fall-through rule, so the checkbox state and the runtime decision
  // cannot drift.
  const initial = useMemo(() => {
    const held = new Set<MessageCategory>()
    for (const category of categories) {
      if (resolveCategoryPolicy(policy, category) === 'operator_approval') held.add(category)
    }
    return held
  }, [policy, categories])

  const [holdAll, setHoldAll] = useState(policy.default === 'operator_approval')
  const [held, setHeld] = useState<Set<MessageCategory>>(initial)
  // Only these are persisted. See rule 2 in the header comment.
  const [touched, setTouched] = useState<Set<MessageCategory>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  function toggle(category: MessageCategory) {
    setSaved(false)
    setTouched((prev) => new Set(prev).add(category))
    setHeld((prev) => {
      const next = new Set(prev)
      if (next.has(category)) next.delete(category)
      else next.add(category)
      return next
    })
  }

  async function save() {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const perCategory: Record<string, ApprovalDisposition> = {}
      if (!holdAll) {
        // Carry forward what this venue already stored, minus exempt keys a
        // hand-written row may hold (the route refuses those, and the resolver
        // ignores them anyway).
        for (const [key, value] of Object.entries(policy.perCategory)) {
          if (!isPolicyExemptCategory(key as MessageCategory)) perCategory[key] = value
        }
        for (const category of touched) {
          perCategory[category] = held.has(category) ? 'operator_approval' : 'auto_send'
        }
      }
      const res = await fetch(`/admin/venues/api/venues/${venueId}/approval-policy`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          default: holdAll ? 'operator_approval' : 'auto_send',
          perCategory,
        }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setError((j.detail as string) || (j.error as string) || 'Save failed')
        return
      }
      setSaved(true)
      setTouched(new Set())
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  function renderRow(category: MessageCategory) {
    const checked = holdAll || held.has(category)
    return (
      <label
        key={category}
        className="flex items-center gap-2.5 py-1 text-sm text-ink"
        htmlFor={`policy-${category}`}
      >
        <Checkbox
          id={`policy-${category}`}
          checked={checked}
          disabled={holdAll || busy}
          onCheckedChange={() => toggle(category)}
        />
        <span className={holdAll ? 'text-ink-faint' : undefined}>{category}</span>
      </label>
    )
  }

  return (
    <SectionShell
      title="Approval policy"
      subtitle="Which messages wait for a human before they reach a guest"
    >
      <div className="flex flex-col gap-5">
        <div className="border-b border-stone-light/60 pb-4">
          <label className="flex items-center gap-2.5 text-sm text-ink" htmlFor="policy-hold-all">
            <Checkbox
              id="policy-hold-all"
              checked={holdAll}
              disabled={busy}
              onCheckedChange={() => {
                setSaved(false)
                setHoldAll((v) => !v)
              }}
            />
            <span className="font-medium">Hold everything</span>
          </label>
          <p className="mt-1.5 text-xs text-ink-faint">
            Every message waits for review. No per-category exception applies while this is
            on, and nothing auto-sends past it.
          </p>
        </div>

        <div>
          <p className="mb-2 text-xs uppercase tracking-wide text-ink-faint">
            Hold by category
          </p>
          {holdAll && (
            <p className="mb-2 text-xs text-ink-faint italic">
              All categories are held while “Hold everything” is on.
            </p>
          )}
          <div className="grid gap-x-8 sm:grid-cols-2">
            <div>{categories.filter((c) => !isOutboundOnly(c)).map(renderRow)}</div>
            <div>{categories.filter(isOutboundOnly).map(renderRow)}</div>
          </div>
        </div>

        <p className="text-xs text-ink-faint">
          <code>{EXEMPT_LABEL}</code> is not listed: an opt-out confirmation has to reach the
          guest immediately, so it can never be held.
        </p>

        {error && <p className="text-sm text-[#DC2626]">{error}</p>}

        <div className="flex items-center gap-3">
          <Button size="sm" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save policy'}
          </Button>
          {saved && <span className="text-xs text-ink-faint">Saved. Takes effect immediately.</span>}
        </div>
      </div>
    </SectionShell>
  )
}
