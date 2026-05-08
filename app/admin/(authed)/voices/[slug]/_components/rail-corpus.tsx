'use client'

import { useState } from 'react'
import {
  ADD_CORPUS_SOURCE_TYPES,
  type AddCorpusSourceType,
  CORPUS_CHANNEL_TAGS,
  isReplyPairedSourceRef,
} from '@/lib/voice-training'
import type { VoicePageCorpusRow } from '../_lib/load-voice-page'

interface RailCorpusProps {
  venueId: string
  corpus: VoicePageCorpusRow[]
  onMutate: () => void
}

// Pull the first non-channel-marker tag as the displayed category. Storage
// markers (cc_review, phase_5_review, voices_commit) signal which channel
// the row came in from; operators care about the topical category that
// sits alongside them (menu_fact, recommendation_request, etc.).
function categoryLabel(row: VoicePageCorpusRow): string {
  const cat = row.tags.find((t) => !CORPUS_CHANNEL_TAGS.has(t))
  return cat ?? row.sourceType
}

export function RailCorpus({ venueId, corpus, onMutate }: RailCorpusProps) {
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Add modal state
  const [addContent, setAddContent] = useState('')
  const [addSource, setAddSource] = useState<AddCorpusSourceType>('manual_entry')
  const [addTags, setAddTags] = useState('')

  // Edit-in-place state
  const [editContent, setEditContent] = useState('')

  async function submitAdd() {
    if (addContent.trim().length === 0) {
      setError('Content cannot be empty')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const tags = addTags
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
      const res = await fetch(`/admin/voices/api/venues/${venueId}/corpus`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: addContent.trim(),
          sourceType: addSource,
          tags,
        }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setError((j.detail as string) || (j.error as string) || 'Add failed')
        return
      }
      setAdding(false)
      setAddContent('')
      setAddTags('')
      setAddSource('manual_entry')
      onMutate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Add failed')
    } finally {
      setBusy(false)
    }
  }

  async function submitEdit(entryId: string) {
    if (editContent.trim().length === 0) {
      setError('Content cannot be empty')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/admin/voices/api/corpus/${entryId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: editContent.trim() }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setError((j.detail as string) || (j.error as string) || 'Edit failed')
        return
      }
      setEditingId(null)
      setEditContent('')
      onMutate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Edit failed')
    } finally {
      setBusy(false)
    }
  }

  async function removeEntry(entryId: string) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/admin/voices/api/corpus/${entryId}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setError((j.detail as string) || (j.error as string) || 'Remove failed')
        return
      }
      onMutate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Remove failed')
    } finally {
      setBusy(false)
    }
  }

  function startEdit(row: VoicePageCorpusRow) {
    setEditingId(row.id)
    setEditContent(row.content)
  }

  return (
    <section className="flex flex-col gap-3">
      <header className="flex items-baseline justify-between pb-1.5 border-b border-stone-light/60">
        <h3 className="text-[10.5px] uppercase font-semibold tracking-eyebrow text-ink">
          Voice corpus · {corpus.length} entries
        </h3>
        {!adding && (
          <button
            onClick={() => setAdding(true)}
            className="text-[11px] text-clay font-medium hover:text-clay-deep"
          >
            + Add entry
          </button>
        )}
      </header>

      {adding && (
        <div className="flex flex-col gap-2 py-3 border-b border-stone-light/60">
          <select
            value={addSource}
            onChange={(e) => setAddSource(e.target.value as AddCorpusSourceType)}
            className="bg-highlight border border-stone-light/60 rounded-[3px] px-2 py-1.5 text-[12px] text-ink focus:outline-none focus:border-clay focus:bg-paper"
            disabled={busy}
          >
            {ADD_CORPUS_SOURCE_TYPES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <textarea
            value={addContent}
            onChange={(e) => setAddContent(e.target.value)}
            placeholder="Voice example — how this venue actually communicates..."
            className="bg-highlight border border-stone-light/60 rounded-[3px] px-2.5 py-2 text-[12.5px] text-ink leading-snug focus:outline-none focus:border-clay focus:bg-paper resize-vertical min-h-[60px]"
            autoFocus
          />
          <input
            value={addTags}
            onChange={(e) => setAddTags(e.target.value)}
            placeholder="tags, comma separated (optional)"
            className="bg-highlight border border-stone-light/60 rounded-[3px] px-2 py-1.5 text-[12px] text-ink focus:outline-none focus:border-clay focus:bg-paper"
          />
          <div className="flex justify-end gap-3 text-[11px]">
            <button
              onClick={() => {
                setAdding(false)
                setAddContent('')
                setAddTags('')
                setError(null)
              }}
              disabled={busy}
              className="text-ink-faint hover:text-ink"
            >
              Cancel
            </button>
            <button
              onClick={submitAdd}
              disabled={busy}
              className="bg-ink text-paper px-3 py-1 rounded-[3px] uppercase font-semibold text-[10.5px] tracking-wider hover:bg-clay-deep disabled:opacity-50"
            >
              {busy ? 'Adding…' : 'Add'}
            </button>
          </div>
        </div>
      )}

      {corpus.length === 0 && !adding && (
        <p className="text-[12px] text-ink-faint italic py-2">
          No corpus entries yet.
        </p>
      )}

      {corpus.map((row) => {
        const isEditing = editingId === row.id
        const paired = isReplyPairedSourceRef(row.sourceRef)
        return (
          <div
            key={row.id}
            className="flex flex-col gap-1.5 py-3 border-b border-stone-light/60 last:border-b-0"
          >
            <div className="flex items-baseline justify-between">
              <span className="text-[9.5px] uppercase font-semibold tracking-eyebrow text-clay">
                {categoryLabel(row)}
              </span>
              <div className="flex items-center gap-3 text-[10.5px]">
                {!isEditing && (
                  <button
                    onClick={() => startEdit(row)}
                    className="text-ink-faint hover:text-ink"
                  >
                    edit
                  </button>
                )}
                {!isEditing && (
                  <button
                    onClick={() => removeEntry(row.id)}
                    disabled={busy}
                    className="text-ink-faint hover:text-clay disabled:opacity-50"
                  >
                    delete
                  </button>
                )}
              </div>
            </div>

            {isEditing ? (
              <div className="flex flex-col gap-2">
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  className="bg-highlight border border-stone-light/60 rounded-[3px] px-2.5 py-2 text-[12.5px] text-ink leading-snug focus:outline-none focus:border-clay focus:bg-paper resize-vertical min-h-[60px]"
                  autoFocus
                />
                <div className="flex justify-end gap-3 text-[11px]">
                  <button
                    onClick={() => {
                      setEditingId(null)
                      setEditContent('')
                      setError(null)
                    }}
                    disabled={busy}
                    className="text-ink-faint hover:text-ink"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => submitEdit(row.id)}
                    disabled={busy}
                    className="bg-ink text-paper px-3 py-1 rounded-[3px] uppercase font-semibold text-[10.5px] tracking-wider hover:bg-clay-deep disabled:opacity-50"
                  >
                    {busy ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
            ) : paired ? (
              // Reply-paired entries display the body as the "out" half.
              // The triggering inbound isn't joined into the row today, so
              // only the embedded content renders here.
              <div className="flex flex-col gap-1">
                <div className="flex gap-2 text-[12.5px] leading-snug">
                  <span className="text-[9px] uppercase font-semibold tracking-wider text-ink-faint pt-[3px] w-5 shrink-0">
                    out
                  </span>
                  <span className="text-ink">{row.content}</span>
                </div>
              </div>
            ) : (
              <p className="text-[12.5px] text-ink leading-snug">{row.content}</p>
            )}
          </div>
        )
      })}

      {error && (
        <p className="text-[11px] text-clay-deep border-l-2 border-clay px-2 py-1 bg-clay-soft/15">
          {error}
        </p>
      )}
    </section>
  )
}
