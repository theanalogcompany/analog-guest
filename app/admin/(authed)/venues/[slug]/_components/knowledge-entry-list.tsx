'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { KNOWLEDGE_PRIMARY_TAGS, type KnowledgePrimaryTag } from '@/lib/schemas'
import { StatusDot } from '@/lib/ui'
import { EmptySectionNote } from './section-shell'

export interface KnowledgeEntryListRow {
  id: string
  content: string
  primaryTags: string[]
  secondaryTags: string[]
  isProcessed: boolean
}

interface KnowledgeEntryListProps {
  venueId: string
  entries: readonly KnowledgeEntryListRow[]
  emptyMessage: string
  /** Initial value for the primary-tag select on Add — a sensible default
   *  for this section, not an enforced restriction (every canonical tag is
   *  selectable; a new entry lands in whichever section its saved tag maps
   *  to on the next refresh, which may not be this one). Typed against the
   *  canonical union (not bare `string`) so a typo'd call-site literal
   *  fails `tsc` instead of silently becoming a wrong-but-valid-looking
   *  Select default at runtime. */
  defaultPrimaryTag: KnowledgePrimaryTag
  /** CatchAllSection sets this false — adding a new entry INTO the
   *  unclaimed bucket on purpose doesn't make sense. */
  allowAdd?: boolean
}

function parseTagsInput(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

// Naive starting suggestion for the split UI — paragraph boundaries when
// they exist, otherwise the whole content in the first piece and an empty
// second piece for the operator to redistribute by hand. Not a subject-
// boundary detector (see knowledge-corpus.ts's own split comment) — just a
// starting point the operator edits before confirming.
function naiveSplitSuggestion(content: string): [string, string] {
  const paragraphs = content
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  if (paragraphs.length >= 2) {
    return [paragraphs[0], paragraphs.slice(1).join('\n\n')]
  }
  return [content, '']
}

type PrimaryTagOption = (typeof KNOWLEDGE_PRIMARY_TAGS)[number]

function PrimaryTagSelect({
  value,
  onChange,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className="h-auto bg-highlight py-1.5 text-[12px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {KNOWLEDGE_PRIMARY_TAGS.map((tag: PrimaryTagOption) => (
          <SelectItem key={tag} value={tag}>
            {tag}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function KnowledgeEntryList({
  venueId,
  entries,
  emptyMessage,
  defaultPrimaryTag,
  allowAdd = true,
}: KnowledgeEntryListProps) {
  const router = useRouter()

  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [adding, setAdding] = useState(false)
  const [addContent, setAddContent] = useState('')
  const [addPrimaryTag, setAddPrimaryTag] = useState<string>(defaultPrimaryTag)
  const [addSecondaryTags, setAddSecondaryTags] = useState('')

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editContent, setEditContent] = useState('')
  const [editPrimaryTag, setEditPrimaryTag] = useState('')
  const [editSecondaryTags, setEditSecondaryTags] = useState('')

  const [splittingId, setSplittingId] = useState<string | null>(null)
  const [splitPieces, setSplitPieces] = useState<
    Array<{ content: string; primaryTag: string; secondaryTags: string }>
  >([])

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  // Derived, not stored: a checked entry can vanish out from under this
  // component (deleted directly, or merged away by a different selection)
  // without this component's own state resetting — router.refresh() gives
  // this instance a fresh `entries` prop but doesn't touch its useState.
  // Filtering selectedIds down to ids still present in `entries` on every
  // render means a stale id can never ride along into a submitted merge.
  const validSelectedIds = new Set([...selectedIds].filter((id) => entries.some((e) => e.id === id)))
  const [merging, setMerging] = useState(false)
  /** Frozen at startMerge() — see the comment in submitMerge for why this
   *  must not be re-derived from live selection at submit time. */
  const [mergeIds, setMergeIds] = useState<string[]>([])
  const [mergeContent, setMergeContent] = useState('')
  const [mergePrimaryTag, setMergePrimaryTag] = useState<string>(defaultPrimaryTag)
  const [mergeSecondaryTags, setMergeSecondaryTags] = useState('')

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
      const res = await fetch(`/admin/venues/api/venues/${venueId}/knowledge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: addContent.trim(),
          primaryTags: [addPrimaryTag],
          secondaryTags: parseTagsInput(addSecondaryTags),
        }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setError((j.detail as string) || (j.error as string) || 'Add failed')
        return
      }
      setAdding(false)
      setAddContent('')
      setAddSecondaryTags('')
      setAddPrimaryTag(defaultPrimaryTag)
      onMutate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Add failed')
    } finally {
      setBusy(false)
    }
  }

  function startEdit(row: KnowledgeEntryListRow) {
    setEditingId(row.id)
    setEditContent(row.content)
    setEditPrimaryTag(row.primaryTags[0] ?? defaultPrimaryTag)
    setEditSecondaryTags(row.secondaryTags.join(', '))
  }

  async function submitEdit(entryId: string) {
    if (editContent.trim().length === 0) {
      setError('Content cannot be empty')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/admin/venues/api/knowledge/${entryId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          // Always sent, even unchanged — resubmitting content is the
          // retry path for an entry stuck at is_processed=false.
          content: editContent.trim(),
          primaryTags: [editPrimaryTag],
          secondaryTags: parseTagsInput(editSecondaryTags),
        }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setError((j.detail as string) || (j.error as string) || 'Edit failed')
        return
      }
      setEditingId(null)
      onMutate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Edit failed')
    } finally {
      setBusy(false)
    }
  }

  async function removeEntry(entryId: string) {
    if (!window.confirm('Delete this knowledge entry? This cannot be undone.')) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/admin/venues/api/knowledge/${entryId}`, { method: 'DELETE' })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setError((j.detail as string) || (j.error as string) || 'Delete failed')
        return
      }
      onMutate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setBusy(false)
    }
  }

  function startSplit(row: KnowledgeEntryListRow) {
    const [first, second] = naiveSplitSuggestion(row.content)
    const tag = row.primaryTags[0] ?? defaultPrimaryTag
    const secondary = row.secondaryTags.join(', ')
    setSplittingId(row.id)
    setSplitPieces([
      { content: first, primaryTag: tag, secondaryTags: secondary },
      { content: second, primaryTag: tag, secondaryTags: secondary },
    ])
  }

  function addSplitPiece() {
    setSplitPieces((pieces) => [
      ...pieces,
      { content: '', primaryTag: defaultPrimaryTag, secondaryTags: '' },
    ])
  }

  function removeSplitPiece(index: number) {
    setSplitPieces((pieces) => pieces.filter((_, i) => i !== index))
  }

  async function submitSplit(entryId: string) {
    const nonEmpty = splitPieces.filter((p) => p.content.trim().length > 0)
    if (nonEmpty.length < 2) {
      setError('Split needs at least 2 non-empty pieces')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/admin/venues/api/knowledge/${entryId}/split`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pieces: nonEmpty.map((p) => ({
            content: p.content.trim(),
            primaryTags: [p.primaryTag],
            secondaryTags: parseTagsInput(p.secondaryTags),
          })),
        }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setError((j.detail as string) || (j.error as string) || 'Split failed')
        return
      }
      setSplittingId(null)
      setSplitPieces([])
      onMutate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Split failed')
    } finally {
      setBusy(false)
    }
  }

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function startMerge() {
    const ids = [...validSelectedIds]
    const selected = entries.filter((e) => ids.includes(e.id))
    setMergeIds(ids)
    setMergeContent(selected.map((e) => e.content).join('\n\n'))
    setMergePrimaryTag(selected[0]?.primaryTags[0] ?? defaultPrimaryTag)
    setMergeSecondaryTags([...new Set(selected.flatMap((e) => e.secondaryTags))].join(', '))
    setMerging(true)
  }

  async function submitMerge() {
    if (mergeContent.trim().length === 0) {
      setError('Merged content cannot be empty')
      return
    }
    // mergeIds — frozen at startMerge(), NOT live validSelectedIds. Checkboxes
    // are disabled while merging=true so selection can't change underneath
    // the open panel, but freezing here too means even a future UI change
    // that re-enables them can't reopen the gap: a row checked AFTER the
    // panel opened would otherwise ride into originalIds (and get deleted)
    // with its content never folded into mergeContent — a silent loss, not
    // just a confusing UX. Caught in code review before merge.
    if (mergeIds.length < 2) {
      setError('Merge needs at least 2 entries')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/admin/venues/api/knowledge/merge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          originalIds: mergeIds,
          content: mergeContent.trim(),
          primaryTags: [mergePrimaryTag],
          secondaryTags: parseTagsInput(mergeSecondaryTags),
        }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setError((j.detail as string) || (j.error as string) || 'Merge failed')
        return
      }
      setMerging(false)
      setMergeIds([])
      setSelectedIds(new Set())
      onMutate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Merge failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-end gap-3">
        {validSelectedIds.size >= 2 && !merging && (
          <Button
            variant="link"
            size="sm"
            onClick={startMerge}
            className="h-auto p-0 text-[11px] text-clay font-medium hover:text-clay-deep"
          >
            Merge {validSelectedIds.size} selected
          </Button>
        )}
        {allowAdd && !adding && (
          <Button
            variant="link"
            size="sm"
            onClick={() => setAdding(true)}
            className="h-auto p-0 text-[11px] text-clay font-medium hover:text-clay-deep"
          >
            + Add entry
          </Button>
        )}
      </div>

      {adding && (
        <div className="flex flex-col gap-2 border-b border-stone-light/40 pb-3">
          <PrimaryTagSelect value={addPrimaryTag} onChange={setAddPrimaryTag} disabled={busy} />
          <Textarea
            value={addContent}
            onChange={(e) => setAddContent(e.target.value)}
            placeholder="One self-contained claim, naming its own subject..."
            className="min-h-[60px] resize-vertical bg-highlight text-[12.5px] leading-snug"
            autoFocus
          />
          <Input
            value={addSecondaryTags}
            onChange={(e) => setAddSecondaryTags(e.target.value)}
            placeholder="secondary tags, comma separated (optional)"
            className="h-auto bg-highlight py-1.5 text-[12px]"
          />
          <div className="flex justify-end gap-3 text-[11px]">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setAdding(false)
                setAddContent('')
                setAddSecondaryTags('')
                setError(null)
              }}
              disabled={busy}
              className="text-ink-faint hover:text-ink"
            >
              Cancel
            </Button>
            <Button onClick={submitAdd} disabled={busy} size="sm">
              {busy ? 'Adding…' : 'Add'}
            </Button>
          </div>
        </div>
      )}

      {merging && (
        <div className="flex flex-col gap-2 border-b border-stone-light/40 pb-3">
          <p className="text-xs uppercase tracking-wide text-ink-faint">
            Merging {validSelectedIds.size} entries into one
          </p>
          <PrimaryTagSelect value={mergePrimaryTag} onChange={setMergePrimaryTag} disabled={busy} />
          <Textarea
            value={mergeContent}
            onChange={(e) => setMergeContent(e.target.value)}
            className="min-h-[100px] resize-vertical bg-highlight text-[12.5px] leading-snug"
          />
          <Input
            value={mergeSecondaryTags}
            onChange={(e) => setMergeSecondaryTags(e.target.value)}
            placeholder="secondary tags, comma separated (optional)"
            className="h-auto bg-highlight py-1.5 text-[12px]"
          />
          <div className="flex justify-end gap-3 text-[11px]">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setMerging(false)
                setMergeIds([])
                setError(null)
              }}
              disabled={busy}
              className="text-ink-faint hover:text-ink"
            >
              Cancel
            </Button>
            <Button onClick={submitMerge} disabled={busy} size="sm">
              {busy ? 'Merging…' : 'Merge'}
            </Button>
          </div>
        </div>
      )}

      {entries.length === 0 ? (
        <EmptySectionNote>{emptyMessage}</EmptySectionNote>
      ) : (
        <ul className="flex flex-col gap-3">
          {entries.map((entry) => {
            const isEditing = editingId === entry.id
            const isSplitting = splittingId === entry.id
            return (
              <li
                key={entry.id}
                className="flex flex-col gap-1.5 border-b border-stone-light/40 pb-3 last:border-b-0 last:pb-0"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2">
                    {!isEditing && !isSplitting && (
                      <Checkbox
                        checked={validSelectedIds.has(entry.id)}
                        onCheckedChange={() => toggleSelected(entry.id)}
                        // Locked once a merge review panel is open — the
                        // panel's content is a frozen snapshot (mergeIds),
                        // and selection changing underneath it is exactly
                        // the confusion that produced a real silent-loss
                        // bug in review: a newly-checked row's id could
                        // reach the server without its content ever
                        // reaching the merged text.
                        disabled={merging}
                        className="mt-0.5"
                        aria-label="Select for merge"
                      />
                    )}
                    {!isEditing && !isSplitting && (
                      <p className="text-sm text-ink leading-snug">{entry.content}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-3 text-[10.5px]">
                    {!entry.isProcessed && (
                      <span className="flex items-center gap-1.5 text-clay">
                        <StatusDot tone="bad" label="not retrievable" />
                        not retrievable
                      </span>
                    )}
                    {!isEditing && !isSplitting && (
                      <>
                        <Button
                          variant="link"
                          size="sm"
                          onClick={() => startEdit(entry)}
                          className="h-auto p-0 text-[10.5px] text-ink-faint hover:text-ink"
                        >
                          edit
                        </Button>
                        <Button
                          variant="link"
                          size="sm"
                          onClick={() => startSplit(entry)}
                          className="h-auto p-0 text-[10.5px] text-ink-faint hover:text-ink"
                        >
                          split
                        </Button>
                        <Button
                          variant="link"
                          size="sm"
                          onClick={() => removeEntry(entry.id)}
                          disabled={busy}
                          className="h-auto p-0 text-[10.5px] text-ink-faint hover:text-clay"
                        >
                          delete
                        </Button>
                      </>
                    )}
                  </div>
                </div>

                {(entry.primaryTags.length > 0 || entry.secondaryTags.length > 0) &&
                  !isEditing &&
                  !isSplitting && (
                    <div className="flex flex-wrap gap-1.5 pl-6">
                      {entry.primaryTags.map((tag) => (
                        <span
                          key={`p-${tag}`}
                          className="rounded-[2px] bg-highlight px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-soft"
                        >
                          {tag}
                        </span>
                      ))}
                      {entry.secondaryTags.map((tag) => (
                        <span
                          key={`s-${tag}`}
                          className="rounded-[2px] px-1.5 py-0.5 text-[10px] text-ink-faint"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}

                {isEditing && (
                  <div className="flex flex-col gap-2">
                    <PrimaryTagSelect
                      value={editPrimaryTag}
                      onChange={setEditPrimaryTag}
                      disabled={busy}
                    />
                    <Textarea
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      className="min-h-[60px] resize-vertical bg-highlight text-[12.5px] leading-snug"
                      autoFocus
                    />
                    <Input
                      value={editSecondaryTags}
                      onChange={(e) => setEditSecondaryTags(e.target.value)}
                      placeholder="secondary tags, comma separated"
                      className="h-auto bg-highlight py-1.5 text-[12px]"
                    />
                    <div className="flex justify-end gap-3 text-[11px]">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setEditingId(null)
                          setError(null)
                        }}
                        disabled={busy}
                        className="text-ink-faint hover:text-ink"
                      >
                        Cancel
                      </Button>
                      <Button onClick={() => submitEdit(entry.id)} disabled={busy} size="sm">
                        {busy ? 'Saving…' : 'Save'}
                      </Button>
                    </div>
                  </div>
                )}

                {isSplitting && (
                  <div className="flex flex-col gap-3">
                    {splitPieces.map((piece, i) => (
                      <div key={i} className="flex flex-col gap-2 border-l-2 border-stone-light/60 pl-3">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] uppercase tracking-wide text-ink-faint">
                            Piece {i + 1}
                          </span>
                          {splitPieces.length > 2 && (
                            <Button
                              variant="link"
                              size="sm"
                              onClick={() => removeSplitPiece(i)}
                              className="h-auto p-0 text-[10.5px] text-ink-faint hover:text-clay"
                            >
                              remove
                            </Button>
                          )}
                        </div>
                        <PrimaryTagSelect
                          value={piece.primaryTag}
                          onChange={(v) =>
                            setSplitPieces((pieces) =>
                              pieces.map((p, idx) => (idx === i ? { ...p, primaryTag: v } : p)),
                            )
                          }
                          disabled={busy}
                        />
                        <Textarea
                          value={piece.content}
                          onChange={(e) =>
                            setSplitPieces((pieces) =>
                              pieces.map((p, idx) =>
                                idx === i ? { ...p, content: e.target.value } : p,
                              ),
                            )
                          }
                          className="min-h-[60px] resize-vertical bg-highlight text-[12.5px] leading-snug"
                        />
                        <Input
                          value={piece.secondaryTags}
                          onChange={(e) =>
                            setSplitPieces((pieces) =>
                              pieces.map((p, idx) =>
                                idx === i ? { ...p, secondaryTags: e.target.value } : p,
                              ),
                            )
                          }
                          placeholder="secondary tags, comma separated"
                          className="h-auto bg-highlight py-1.5 text-[12px]"
                        />
                      </div>
                    ))}
                    <div className="flex items-center justify-between">
                      <Button
                        variant="link"
                        size="sm"
                        onClick={addSplitPiece}
                        className="h-auto p-0 text-[11px] text-clay font-medium hover:text-clay-deep"
                      >
                        + Add piece
                      </Button>
                      <div className="flex gap-3 text-[11px]">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setSplittingId(null)
                            setSplitPieces([])
                            setError(null)
                          }}
                          disabled={busy}
                          className="text-ink-faint hover:text-ink"
                        >
                          Cancel
                        </Button>
                        <Button onClick={() => submitSplit(entry.id)} disabled={busy} size="sm">
                          {busy ? 'Splitting…' : `Split into ${splitPieces.filter((p) => p.content.trim()).length}`}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {error && (
        <p className="border-l-2 border-clay bg-clay/5 px-2 py-1 text-[11px] text-clay-deep">
          {error}
        </p>
      )}
    </div>
  )
}
