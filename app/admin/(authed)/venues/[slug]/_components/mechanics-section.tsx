'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { GUEST_STATES } from '@/lib/recognition'
import {
  MECHANIC_REDEMPTION_POLICIES,
  type MechanicCreate,
  MECHANIC_TRIGGER_TYPES,
  MECHANIC_TYPES,
} from '@/lib/schemas'
import { StatusDot } from '@/lib/ui'
import type { VenueDetailMechanicRow } from '../../../_lib/load-venue-detail'
import { findMissingMechanicFields, parseMechanicTriggerType } from '../../_lib/mechanic-fields'
import { EmptySectionNote, SectionShell } from './section-shell'

interface UnclaimedForMechanic {
  id: string
  name: string
  columns: string[]
}

// The form shape mirrors MechanicCreate exactly (every field required) —
// both Add and Edit submit this same shape; Edit's PATCH is a whole-object
// merge-then-validate server-side (see editMechanic), so sending every
// field on every save is deliberate, not wasteful.
function emptyForm(): MechanicCreate {
  return {
    type: 'perk',
    name: '',
    description: null,
    qualification: null,
    rewardDescription: null,
    minState: 'new',
    redemptionPolicy: 'one_time',
    redemptionWindowDays: null,
    requiresOperatorApproval: false,
    triggerType: 'guest_initiated_request',
    expirationRule: null,
  }
}

function formFromRow(row: VenueDetailMechanicRow): MechanicCreate {
  return {
    type: row.type as MechanicCreate['type'],
    name: row.name,
    description: row.description,
    qualification: row.qualification,
    rewardDescription: row.rewardDescription,
    minState: row.minState as MechanicCreate['minState'],
    redemptionPolicy: row.redemptionPolicy as MechanicCreate['redemptionPolicy'],
    redemptionWindowDays: row.redemptionWindowDays,
    requiresOperatorApproval: row.requiresOperatorApproval,
    triggerType: (parseMechanicTriggerType(row.trigger) ?? 'guest_initiated_request') as MechanicCreate['triggerType'],
    expirationRule: row.expirationRule,
  }
}

function MechanicForm({
  form,
  onChange,
}: {
  form: MechanicCreate
  onChange: (patch: Partial<MechanicCreate>) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        <Input
          value={form.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="Name"
          className="h-auto bg-highlight py-1.5 text-sm"
        />
        <Select value={form.type} onValueChange={(v) => onChange({ type: v as MechanicCreate['type'] })}>
          <SelectTrigger className="h-auto bg-highlight py-1.5 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MECHANIC_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Textarea
        value={form.description ?? ''}
        onChange={(e) => onChange({ description: e.target.value || null })}
        placeholder="Description"
        className="min-h-[50px] resize-vertical bg-highlight text-sm leading-snug"
      />
      <Textarea
        value={form.qualification ?? ''}
        onChange={(e) => onChange({ qualification: e.target.value || null })}
        placeholder="Qualification — who's eligible"
        className="min-h-[50px] resize-vertical bg-highlight text-sm leading-snug"
      />
      <Textarea
        value={form.rewardDescription ?? ''}
        onChange={(e) => onChange({ rewardDescription: e.target.value || null })}
        placeholder="Reward description"
        className="min-h-[50px] resize-vertical bg-highlight text-sm leading-snug"
      />
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase tracking-wide text-ink-faint">Min state</label>
          <Select value={form.minState} onValueChange={(v) => onChange({ minState: v as MechanicCreate['minState'] })}>
            <SelectTrigger className="h-auto bg-highlight py-1.5 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GUEST_STATES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase tracking-wide text-ink-faint">Redemption policy</label>
          <Select
            value={form.redemptionPolicy}
            onValueChange={(v) =>
              onChange({
                redemptionPolicy: v as MechanicCreate['redemptionPolicy'],
                redemptionWindowDays: v === 'one_time' ? null : form.redemptionWindowDays,
              })
            }
          >
            <SelectTrigger className="h-auto bg-highlight py-1.5 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MECHANIC_REDEMPTION_POLICIES.map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {form.redemptionPolicy === 'renewable' && (
        <Input
          type="number"
          min={1}
          value={form.redemptionWindowDays ?? ''}
          onChange={(e) => {
            const v = e.target.value
            if (v === '') {
              onChange({ redemptionWindowDays: null })
              return
            }
            const n = Number(v)
            if (!Number.isNaN(n)) onChange({ redemptionWindowDays: n })
          }}
          placeholder="Redemption window (days)"
          className="h-auto bg-highlight py-1.5 text-sm"
        />
      )}
      <label className="flex items-center gap-2 text-sm text-ink">
        <Checkbox
          checked={form.requiresOperatorApproval}
          onCheckedChange={(checked) => onChange({ requiresOperatorApproval: checked === true })}
        />
        Requires operator approval
      </label>
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase tracking-wide text-ink-faint italic">
            Trigger (not yet read by the agent)
          </label>
          <Select
            value={form.triggerType}
            onValueChange={(v) => onChange({ triggerType: v as MechanicCreate['triggerType'] })}
          >
            <SelectTrigger className="h-auto bg-highlight py-1.5 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MECHANIC_TRIGGER_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase tracking-wide text-ink-faint italic">
            Expiration rule (not yet read by the agent)
          </label>
          <Input
            value={form.expirationRule ?? ''}
            onChange={(e) => onChange({ expirationRule: e.target.value || null })}
            className="h-auto bg-highlight py-1.5 text-sm"
          />
        </div>
      </div>
    </div>
  )
}

export function MechanicsSection({
  venueId,
  mechanics,
  unclaimedColumnsPerRow,
}: {
  venueId: string
  mechanics: readonly VenueDetailMechanicRow[]
  unclaimedColumnsPerRow: readonly UnclaimedForMechanic[]
}) {
  const router = useRouter()

  const [adding, setAdding] = useState(false)
  const [addForm, setAddForm] = useState<MechanicCreate>(emptyForm())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<MechanicCreate>(emptyForm())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function startAdd() {
    setAddForm(emptyForm())
    setAdding(true)
    setError(null)
  }

  async function submitAdd() {
    if (addForm.name.trim().length === 0) {
      setError('Name is required')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/admin/venues/api/venues/${venueId}/mechanics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(addForm),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setError((j.detail as string) || (j.error as string) || 'Add failed')
        return
      }
      setAdding(false)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Add failed')
    } finally {
      setBusy(false)
    }
  }

  function startEdit(row: VenueDetailMechanicRow) {
    setEditForm(formFromRow(row))
    setEditingId(row.id)
    setError(null)
  }

  async function submitEdit(mechanicId: string) {
    if (editForm.name.trim().length === 0) {
      setError('Name is required')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/admin/venues/api/mechanics/${mechanicId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(editForm),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setError((j.detail as string) || (j.error as string) || 'Save failed')
        return
      }
      setEditingId(null)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  async function deactivate(mechanicId: string) {
    if (!window.confirm('Deactivate this mechanic? It will stop appearing as eligible for any guest.')) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/admin/venues/api/mechanics/${mechanicId}`, { method: 'DELETE' })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setError((j.detail as string) || (j.error as string) || 'Deactivate failed')
        return
      }
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Deactivate failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <SectionShell
      title="Mechanics"
      headerAction={
        !adding && (
          <Button variant="link" size="sm" onClick={startAdd} className="h-auto p-0 text-[11px] text-clay font-medium hover:text-clay-deep">
            + Add mechanic
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {adding && (
          <div className="border-b border-stone-light/40 pb-4">
            <MechanicForm form={addForm} onChange={(patch) => setAddForm((f) => ({ ...f, ...patch }))} />
            <div className="mt-3 flex justify-end gap-3 text-[11px]">
              <Button variant="ghost" size="sm" onClick={() => setAdding(false)} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={submitAdd} disabled={busy} size="sm">
                {busy ? 'Adding…' : 'Add'}
              </Button>
            </div>
          </div>
        )}

        {mechanics.length === 0 && !adding ? (
          <EmptySectionNote>No mechanics configured yet.</EmptySectionNote>
        ) : (
          <ul className="flex flex-col gap-4">
            {mechanics.map((m) => {
              const isEditing = editingId === m.id
              const missing = findMissingMechanicFields(m)
              const triggerType = parseMechanicTriggerType(m.trigger)
              // Deactivated mechanics are excluded from every Readiness
              // check — a missing param or a manual_invite gap on a
              // mechanic nobody can hit anymore is not a gap. Mirrored here
              // so the inline warning agrees with the Readiness panel.
              const showGapWarning =
                m.isActive &&
                (missing.length > 0 ||
                  (triggerType === 'manual_invite' && !m.requiresOperatorApproval))
              const unclaimed = unclaimedColumnsPerRow.find((u) => u.id === m.id)?.columns ?? []

              if (isEditing) {
                return (
                  <li key={m.id} className="border-b border-stone-light/40 pb-4 last:border-b-0 last:pb-0">
                    <MechanicForm form={editForm} onChange={(patch) => setEditForm((f) => ({ ...f, ...patch }))} />
                    <div className="mt-3 flex justify-end gap-3 text-[11px]">
                      <Button variant="ghost" size="sm" onClick={() => setEditingId(null)} disabled={busy}>
                        Cancel
                      </Button>
                      <Button onClick={() => submitEdit(m.id)} disabled={busy} size="sm">
                        {busy ? 'Saving…' : 'Save'}
                      </Button>
                    </div>
                  </li>
                )
              }

              return (
                <li
                  key={m.id}
                  className="border-b border-stone-light/40 pb-4 last:border-b-0 last:pb-0"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm font-medium text-ink">
                      {m.name}
                      {!m.isActive && (
                        <span className="ml-2 text-[10px] uppercase tracking-wide text-ink-faint">
                          inactive
                          {m.deactivatedAt
                            ? ` · ${new Date(m.deactivatedAt).toLocaleDateString()}`
                            : ''}
                        </span>
                      )}
                    </span>
                    <div className="flex items-center gap-3 text-[10.5px]">
                      <span className="text-ink-faint">{m.type}</span>
                      <Button
                        variant="link"
                        size="sm"
                        onClick={() => startEdit(m)}
                        className="h-auto p-0 text-[10.5px] text-ink-faint hover:text-ink"
                      >
                        edit
                      </Button>
                      {m.isActive && (
                        <Button
                          variant="link"
                          size="sm"
                          onClick={() => deactivate(m.id)}
                          disabled={busy}
                          className="h-auto p-0 text-[10.5px] text-ink-faint hover:text-clay"
                        >
                          deactivate
                        </Button>
                      )}
                    </div>
                  </div>
                  {m.description && <p className="mt-1 text-sm text-ink-soft">{m.description}</p>}
                  <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    <div>
                      <dt className="text-ink-faint">Qualification</dt>
                      <dd className="text-ink">{m.qualification ?? '—'}</dd>
                    </div>
                    <div>
                      <dt className="text-ink-faint">Reward</dt>
                      <dd className="text-ink">{m.rewardDescription ?? '—'}</dd>
                    </div>
                    <div>
                      <dt className="text-ink-faint">Min state</dt>
                      <dd className="text-ink">{m.minState}</dd>
                    </div>
                    <div>
                      <dt className="text-ink-faint">Redemption policy</dt>
                      <dd className="text-ink">
                        {m.redemptionPolicy}
                        {m.redemptionWindowDays !== null ? ` · ${m.redemptionWindowDays}d` : ''}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-ink-faint">Requires approval</dt>
                      <dd className="text-ink">{m.requiresOperatorApproval ? 'Yes' : 'No'}</dd>
                    </div>
                    <div>
                      <dt className="text-ink-faint italic">Trigger (not yet read by the agent)</dt>
                      <dd className="text-ink">{triggerType ?? '—'}</dd>
                    </div>
                    <div>
                      <dt className="text-ink-faint italic">
                        Expiration rule (not yet read by the agent)
                      </dt>
                      <dd className="text-ink">{m.expirationRule ?? '—'}</dd>
                    </div>
                    <div>
                      <dt className="text-ink-faint italic">Redemption (not editable)</dt>
                      <dd className="text-ink-faint">{JSON.stringify(m.redemption)}</dd>
                    </div>
                  </dl>
                  {showGapWarning && (
                    <div className="mt-2 flex items-center gap-1.5 text-xs text-clay">
                      <StatusDot tone="bad" label="readiness gap" />
                      {[
                        missing.length > 0 ? `missing: ${missing.join(', ')}` : null,
                        triggerType === 'manual_invite' && !m.requiresOperatorApproval
                          ? 'manual_invite without requires_operator_approval'
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  )}
                  {unclaimed.length > 0 && (
                    <p className="mt-2 text-xs text-ink-faint">
                      Unclaimed columns: {unclaimed.join(', ')}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        {error && <p className="border-l-2 border-clay bg-clay/5 px-2 py-1 text-xs text-clay-deep">{error}</p>}
      </div>
    </SectionShell>
  )
}
