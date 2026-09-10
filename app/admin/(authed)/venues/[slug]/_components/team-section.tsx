'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { KnowledgeEntryList, type KnowledgeEntryListRow } from './knowledge-entry-list'
import { EmptySectionNote, SectionShell } from './section-shell'

// Staff depth lives in chunks, not venue_info (§2: "do not widen
// venue_info.staff to carry notes"). This section renders the thin roster
// and the staff_[name] chunks together, but they stay two separate stores —
// editing the roster (whole-array-replace, same convention as the menu
// items table) never touches knowledge_corpus, and vice versa.
export function TeamSection({
  venueId,
  staff,
  entries,
}: {
  venueId: string
  staff: readonly string[]
  entries: readonly KnowledgeEntryListRow[]
}) {
  const router = useRouter()

  const [editing, setEditing] = useState(false)
  const [formStaff, setFormStaff] = useState<string[]>(() => [...staff])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function startEdit() {
    setFormStaff([...staff])
    setEditing(true)
    setError(null)
  }

  async function submit() {
    const cleaned = formStaff.map((s) => s.trim()).filter((s) => s.length > 0)
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/admin/venues/api/venues/${venueId}/venue-info`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ staff: cleaned }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setError((j.detail as string) || (j.error as string) || 'Save failed')
        return
      }
      setEditing(false)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <SectionShell
      title="The team"
      subtitle="staff roster, staff_[name] chunks"
      headerAction={
        !editing && (
          <Button variant="link" size="sm" onClick={startEdit} className="h-auto p-0 text-[11px] text-clay font-medium hover:text-clay-deep">
            Edit roster
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {editing ? (
          <div className="flex flex-col gap-2">
            {formStaff.map((name, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  value={name}
                  onChange={(e) =>
                    setFormStaff((names) => names.map((n, idx) => (idx === i ? e.target.value : n)))
                  }
                  placeholder="Staff name"
                  className="h-auto bg-highlight py-1.5 text-sm"
                />
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => setFormStaff((names) => names.filter((_, idx) => idx !== i))}
                  className="h-auto p-0 text-[10.5px] text-ink-faint hover:text-clay"
                >
                  remove
                </Button>
              </div>
            ))}
            <Button
              variant="link"
              size="sm"
              onClick={() => setFormStaff((names) => [...names, ''])}
              className="h-auto w-fit p-0 text-[11px] text-clay font-medium hover:text-clay-deep"
            >
              + Add staff
            </Button>
            {error && <p className="border-l-2 border-clay bg-clay/5 px-2 py-1 text-xs text-clay-deep">{error}</p>}
            <div className="flex justify-end gap-3 text-[11px]">
              <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={busy} size="sm">
                {busy ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        ) : staff.length === 0 ? (
          <EmptySectionNote>No staff on the roster yet.</EmptySectionNote>
        ) : (
          <div className="flex flex-wrap gap-2">
            {staff.map((name) => (
              <span
                key={name}
                className="rounded-[2px] bg-highlight px-2 py-1 text-sm text-ink"
              >
                {name}
              </span>
            ))}
          </div>
        )}
        <KnowledgeEntryList
          venueId={venueId}
          entries={entries}
          emptyMessage="No per-person knowledge chunks captured yet."
          defaultPrimaryTag="staff"
        />
      </div>
    </SectionShell>
  )
}
