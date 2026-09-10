'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { MenuItem, VenueInfo } from '@/lib/schemas'
import { HairlineRow } from '@/lib/ui'
import { EmptySectionNote, SectionShell } from './section-shell'

function formatPrice(item: MenuItem): string {
  if (item.price !== undefined) return `$${item.price.toFixed(2)}`
  if (item.priceNote) return item.priceNote
  return '—'
}

// Highlights caution caption — shown in BOTH the read view and the editor.
// TAC-331 ruling, carried forward: highlights are facts about what's on the
// menu, not advice about what to order. The extraction bug that produced
// "first-timer pick" / opinionated-recommendation prose in this exact field
// is what made the agent recommend a latte to a guest already holding a
// drink — this field renders on every prompt turn, so a stray piece of
// advice here isn't cosmetic. Recommendations belong in knowledge_corpus
// (Menu knowledge above), gated by retrieval; this list is always-on.
function HighlightsCaption() {
  return (
    <p className="mb-3 text-xs italic text-ink-faint">
      Facts about what&apos;s on the menu, not advice about what to order —
      recommendations belong in Menu knowledge above.
    </p>
  )
}

// The technical roster — item name, price, one row per item. Distinct from
// MenuKnowledgeSection (what the owner said ABOUT these items). §2:
// "the menu appears twice, on purpose."
//
// Whole-array-replace editing (TAC-343 plan decision): MenuItemSchema has no
// stable id, and resolveReportedItems already treats (name, size) as
// identity elsewhere — every add/edit/delete submits the FULL items array
// in one PATCH rather than addressing a single item server-side.
export function MenuRosterSection({
  venueId,
  venueInfo,
}: {
  venueId: string
  venueInfo: VenueInfo
}) {
  const router = useRouter()
  const { items, notes, highlights } = venueInfo.menu

  const [editing, setEditing] = useState(false)
  const [formItems, setFormItems] = useState<MenuItem[]>(() => items.map((i) => ({ ...i })))
  const [formNotes, setFormNotes] = useState(notes ?? '')
  const [formHighlights, setFormHighlights] = useState<string[]>(() => [...highlights])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function startEdit() {
    setFormItems(items.map((i) => ({ ...i })))
    setFormNotes(notes ?? '')
    setFormHighlights([...highlights])
    setEditing(true)
    setError(null)
  }

  function updateItem(index: number, patch: Partial<MenuItem>) {
    setFormItems((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  function addItem() {
    setFormItems((rows) => [
      ...rows,
      { name: '', category: '', modifiers: [], dietary: [], isOffMenu: false, price: 0 },
    ])
  }

  function removeItem(index: number) {
    setFormItems((rows) => rows.filter((_, i) => i !== index))
  }

  async function submit() {
    const invalid = formItems.find(
      (item) =>
        item.name.trim().length === 0 ||
        item.category.trim().length === 0 ||
        (item.price === undefined && (!item.priceNote || item.priceNote.trim().length === 0)),
    )
    if (invalid) {
      setError('Every item needs a name, category, and either a price or a price note')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/admin/venues/api/venues/${venueId}/venue-info`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          menu: {
            items: formItems,
            notes: formNotes || undefined,
            highlights: formHighlights.filter((h) => h.trim().length > 0),
          },
        }),
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

  if (editing) {
    return (
      <SectionShell title="The menu" subtitle="roster">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3">
            {formItems.map((item, i) => (
              <div key={i} className="flex flex-col gap-2 border-b border-stone-light/40 pb-3">
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    value={item.name}
                    onChange={(e) => updateItem(i, { name: e.target.value })}
                    placeholder="Item name"
                    className="h-auto bg-highlight py-1.5 text-sm"
                  />
                  <Input
                    value={item.size ?? ''}
                    onChange={(e) => updateItem(i, { size: e.target.value || undefined })}
                    placeholder="Size (optional)"
                    className="h-auto bg-highlight py-1.5 text-sm"
                  />
                  <Input
                    value={item.category}
                    onChange={(e) => updateItem(i, { category: e.target.value })}
                    placeholder="Category"
                    className="h-auto bg-highlight py-1.5 text-sm"
                  />
                  <Input
                    value={item.price !== undefined ? String(item.price) : ''}
                    onChange={(e) => {
                      const v = e.target.value
                      if (v === '') {
                        updateItem(i, { price: undefined })
                        return
                      }
                      const n = Number(v)
                      if (!Number.isNaN(n)) updateItem(i, { price: n })
                    }}
                    placeholder="Price (e.g. 4.50)"
                    className="h-auto bg-highlight py-1.5 text-sm"
                  />
                  <Input
                    value={item.priceNote ?? ''}
                    onChange={(e) => updateItem(i, { priceNote: e.target.value || undefined })}
                    placeholder="Price note (e.g. by request)"
                    className="h-auto bg-highlight py-1.5 text-sm"
                  />
                  <Input
                    value={item.description ?? ''}
                    onChange={(e) => updateItem(i, { description: e.target.value || undefined })}
                    placeholder="Notes"
                    className="h-auto bg-highlight py-1.5 text-sm"
                  />
                </div>
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 text-xs text-ink">
                    <Checkbox
                      checked={item.isOffMenu}
                      onCheckedChange={(checked) => updateItem(i, { isOffMenu: checked === true })}
                    />
                    Off-menu
                  </label>
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => removeItem(i)}
                    className="h-auto p-0 text-[10.5px] text-ink-faint hover:text-clay"
                  >
                    remove
                  </Button>
                </div>
              </div>
            ))}
            <Button
              variant="link"
              size="sm"
              onClick={addItem}
              className="h-auto w-fit p-0 text-[11px] text-clay font-medium hover:text-clay-deep"
            >
              + Add item
            </Button>
          </div>

          <Textarea
            value={formNotes}
            onChange={(e) => setFormNotes(e.target.value)}
            placeholder="Always-on menu notes..."
            className="min-h-[60px] resize-vertical bg-highlight text-sm leading-snug"
          />

          <div className="border-t border-stone-light/60 pt-4">
            <p className="mb-1 text-xs uppercase tracking-wide text-ink-faint">Highlights</p>
            <HighlightsCaption />
            <div className="flex flex-col gap-2">
              {formHighlights.map((highlight, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={highlight}
                    onChange={(e) =>
                      setFormHighlights((hs) => hs.map((h, idx) => (idx === i ? e.target.value : h)))
                    }
                    className="h-auto bg-highlight py-1.5 text-sm"
                  />
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => setFormHighlights((hs) => hs.filter((_, idx) => idx !== i))}
                    className="h-auto p-0 text-[10.5px] text-ink-faint hover:text-clay"
                  >
                    remove
                  </Button>
                </div>
              ))}
              <Button
                variant="link"
                size="sm"
                onClick={() => setFormHighlights((hs) => [...hs, ''])}
                className="h-auto w-fit p-0 text-[11px] text-clay font-medium hover:text-clay-deep"
              >
                + Add highlight
              </Button>
            </div>
          </div>

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
      </SectionShell>
    )
  }

  return (
    <SectionShell
      title="The menu"
      subtitle="roster"
      headerAction={
        <Button variant="link" size="sm" onClick={startEdit} className="h-auto p-0 text-[11px] text-clay font-medium hover:text-clay-deep">
          Edit
        </Button>
      }
    >
      {items.length === 0 ? (
        <EmptySectionNote>No menu items on file yet.</EmptySectionNote>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone-light/60 text-left text-xs uppercase tracking-wide text-ink-faint">
                <th className="py-2 pr-3 font-normal">Item</th>
                <th className="py-2 pr-3 font-normal">Category</th>
                <th className="py-2 pr-3 font-normal text-right tabular-nums">Price</th>
                <th className="py-2 font-normal">Notes</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => (
                <tr
                  key={`${item.name}-${item.size ?? ''}-${i}`}
                  className="border-b border-stone-light/30 last:border-b-0"
                >
                  <td className="py-2 pr-3 text-ink">
                    {item.name}
                    {item.size ? ` (${item.size})` : ''}
                    {item.isOffMenu && (
                      <span className="ml-1.5 text-[10px] uppercase tracking-wide text-ink-faint">
                        off-menu
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-ink-soft">{item.category}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-ink">
                    {formatPrice(item)}
                  </td>
                  <td className="py-2 text-ink-faint">{item.description ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {notes && <p className="mt-4 text-sm text-ink-soft">{notes}</p>}

      <div className="mt-6 border-t border-stone-light/60 pt-4">
        <p className="mb-1 text-xs uppercase tracking-wide text-ink-faint">Highlights</p>
        <HighlightsCaption />
        {highlights.length === 0 ? (
          <EmptySectionNote>No highlights on file yet.</EmptySectionNote>
        ) : (
          <ul className="flex flex-col">
            {highlights.map((highlight, i) => (
              <HairlineRow key={`${highlight}-${i}`} last={i === highlights.length - 1}>
                <span className="text-sm text-ink">{highlight}</span>
              </HairlineRow>
            ))}
          </ul>
        )}
      </div>
    </SectionShell>
  )
}
