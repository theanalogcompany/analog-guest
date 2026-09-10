'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { KNOWLEDGE_PRIMARY_TAGS, type VenueContextNote } from '@/lib/schemas'
import { StatusDot } from '@/lib/ui'
import { partitionCurrentContext } from '../../_lib/expiry-queue'
import { EmptySectionNote, SectionShell } from './section-shell'

function formatBadge(entry: VenueContextNote, override?: string): string {
  if (override) return override
  return entry.expiresAt ? `until ${new Date(entry.expiresAt).toLocaleDateString()}` : 'permanent'
}

// currentContext is NOT tagged and NOT sectioned (§2) — one flat list.
// Drop works the same way on an active or a queued (expired/malformed)
// entry — §2: "Drop — remove the entry." Promote is queue-only: converting
// something still active doesn't make sense (it hasn't ended yet).
export function RightNowSection({
  venueId,
  currentContext,
  now,
}: {
  venueId: string
  currentContext: readonly VenueContextNote[]
  now: Date
}) {
  const router = useRouter()
  const { active, expired, malformed } = partitionCurrentContext(currentContext, now)

  const [adding, setAdding] = useState(false)
  const [addContent, setAddContent] = useState('')
  const [addExpiresAt, setAddExpiresAt] = useState('')
  const [promotingId, setPromotingId] = useState<string | null>(null)
  const [promoteTag, setPromoteTag] = useState<string>(KNOWLEDGE_PRIMARY_TAGS[0])
  const [promoteSecondaryTags, setPromoteSecondaryTags] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function onMutate() {
    router.refresh()
  }

  async function submitAdd() {
    if (addContent.trim().length === 0) {
      setError('Content cannot be empty')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/admin/venues/api/venues/${venueId}/current-context`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: addContent.trim(),
          expiresAt: addExpiresAt ? new Date(addExpiresAt).toISOString() : undefined,
        }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setError((j.detail as string) || (j.error as string) || 'Add failed')
        return
      }
      setAdding(false)
      setAddContent('')
      setAddExpiresAt('')
      onMutate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Add failed')
    } finally {
      setBusy(false)
    }
  }

  async function drop(entryId: string) {
    if (!window.confirm('Drop this entry? This cannot be undone.')) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/admin/venues/api/venues/${venueId}/current-context/${entryId}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setError((j.detail as string) || (j.error as string) || 'Drop failed')
        return
      }
      onMutate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Drop failed')
    } finally {
      setBusy(false)
    }
  }

  function startPromote() {
    setPromoteTag(KNOWLEDGE_PRIMARY_TAGS[0])
    setPromoteSecondaryTags('')
    setError(null)
  }

  async function submitPromote(entryId: string) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(
        `/admin/venues/api/venues/${venueId}/current-context/${entryId}/promote`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            primaryTag: promoteTag,
            secondaryTags: promoteSecondaryTags
              .split(',')
              .map((t) => t.trim())
              .filter((t) => t.length > 0),
          }),
        },
      )
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setError((j.detail as string) || (j.error as string) || 'Promote failed')
        return
      }
      setPromotingId(null)
      onMutate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Promote failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <SectionShell
      title="Right now"
      subtitle="currentContext"
      headerAction={
        !adding && (
          <Button
            variant="link"
            size="sm"
            onClick={() => {
              setAdding(true)
              setAddContent('')
              setAddExpiresAt('')
              setError(null)
            }}
            className="h-auto p-0 text-[11px] text-clay font-medium hover:text-clay-deep"
          >
            + Add
          </Button>
        )
      }
    >
      {adding && (
        <div className="mb-4 flex flex-col gap-2 border-b border-stone-light/40 pb-4">
          <Textarea
            value={addContent}
            onChange={(e) => setAddContent(e.target.value)}
            placeholder="What's true at the venue right now..."
            className="min-h-[60px] resize-vertical bg-highlight text-sm leading-snug"
            autoFocus
          />
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase tracking-wide text-ink-faint">
              Expires (leave blank for a permanent note)
            </label>
            <Input
              type="date"
              value={addExpiresAt}
              onChange={(e) => setAddExpiresAt(e.target.value)}
              className="h-auto w-fit bg-highlight py-1.5 text-sm"
            />
          </div>
          <div className="flex justify-end gap-3 text-[11px]">
            <Button variant="ghost" size="sm" onClick={() => setAdding(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={submitAdd} disabled={busy} size="sm">
              {busy ? 'Adding…' : 'Add'}
            </Button>
          </div>
        </div>
      )}

      {active.length === 0 ? (
        <EmptySectionNote>Nothing time-bound on file right now.</EmptySectionNote>
      ) : (
        <ul className="flex flex-col">
          {active.map((entry) => (
            <li
              key={entry.id}
              className="flex items-start justify-between gap-3 border-b border-stone-light/40 py-2 last:border-b-0"
            >
              <span className="text-sm text-ink">{entry.content}</span>
              <div className="flex shrink-0 items-center gap-3">
                <span className="text-xs text-ink-faint">{formatBadge(entry)}</span>
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => drop(entry.id)}
                  disabled={busy}
                  className="h-auto p-0 text-[10.5px] text-ink-faint hover:text-clay"
                >
                  drop
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {(expired.length > 0 || malformed.length > 0) && (
        <div className="mt-4 border-t border-stone-light/60 pt-4">
          <div className="mb-2 flex items-center gap-1.5 text-xs uppercase tracking-wide text-ink-faint">
            <StatusDot tone="neutral" label="needs a decision" />
            Expiry queue
          </div>
          <ul className="flex flex-col">
            {[...expired.map((e) => ({ entry: e, badge: 'expired' })), ...malformed.map((e) => ({ entry: e, badge: 'malformed date' }))].map(
              ({ entry, badge }) => {
                const isPromoting = promotingId === entry.id
                return (
                  <li
                    key={entry.id}
                    className="flex flex-col gap-2 border-b border-stone-light/40 py-2 last:border-b-0"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="text-sm text-ink">{entry.content}</span>
                      <div className="flex shrink-0 items-center gap-3">
                        <span className="text-xs text-ink-faint">{formatBadge(entry, badge)}</span>
                        {!isPromoting && (
                          <>
                            <Button
                              variant="link"
                              size="sm"
                              onClick={() => {
                                setPromotingId(entry.id)
                                startPromote()
                              }}
                              disabled={busy}
                              className="h-auto p-0 text-[10.5px] text-ink-faint hover:text-ink"
                            >
                              promote
                            </Button>
                            <Button
                              variant="link"
                              size="sm"
                              onClick={() => drop(entry.id)}
                              disabled={busy}
                              className="h-auto p-0 text-[10.5px] text-ink-faint hover:text-clay"
                            >
                              drop
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                    {isPromoting && (
                      <div className="flex flex-col gap-2 border-l-2 border-stone-light/60 pl-3">
                        <Select value={promoteTag} onValueChange={setPromoteTag}>
                          <SelectTrigger className="h-auto w-fit bg-highlight py-1.5 text-sm">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {KNOWLEDGE_PRIMARY_TAGS.map((tag) => (
                              <SelectItem key={tag} value={tag}>
                                {tag}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Input
                          value={promoteSecondaryTags}
                          onChange={(e) => setPromoteSecondaryTags(e.target.value)}
                          placeholder="secondary tags, comma separated (optional)"
                          className="h-auto bg-highlight py-1.5 text-sm"
                        />
                        <div className="flex justify-end gap-3 text-[11px]">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setPromotingId(null)}
                            disabled={busy}
                          >
                            Cancel
                          </Button>
                          <Button onClick={() => submitPromote(entry.id)} disabled={busy} size="sm">
                            {busy ? 'Promoting…' : 'Promote'}
                          </Button>
                        </div>
                      </div>
                    )}
                  </li>
                )
              },
            )}
          </ul>
        </div>
      )}

      {error && (
        <p className="mt-3 border-l-2 border-clay bg-clay/5 px-2 py-1 text-xs text-clay-deep">
          {error}
        </p>
      )}
    </SectionShell>
  )
}
