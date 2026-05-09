'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useMemo, useState } from 'react'
import { HairlineRow } from '@/lib/ui'
import type { Tunable, TunableCategory } from '@/lib/tunables/manifest'

// Read-only viewer for the tunables manifest. Filter (single-select category)
// + search (substring on name) state lives in the URL via router.replace so
// reload preserves view and links are shareable. Row expansion lives in
// component-local state — too noisy to URL-sync, low value across reloads.

const CATEGORIES: ReadonlyArray<{ id: TunableCategory; label: string }> = [
  { id: 'agent_runtime', label: 'Agent runtime' },
  { id: 'classification', label: 'Classification' },
  { id: 'timing', label: 'Timing' },
  { id: 'recognition', label: 'Recognition' },
  { id: 'retrieval', label: 'Retrieval' },
  { id: 'mechanics', label: 'Mechanics' },
]

interface TunablesTableProps {
  tunables: Tunable[]
}

export function TunablesTable({ tunables }: TunablesTableProps) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  const selectedCategory: TunableCategory | null = useMemo(() => {
    const raw = params.get('category')
    if (!raw) return null
    return CATEGORIES.some((c) => c.id === raw) ? (raw as TunableCategory) : null
  }, [params])

  const search = (params.get('search') ?? '').toLowerCase()

  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const updateParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params.toString())
      if (value === null || value === '') {
        next.delete(key)
      } else {
        next.set(key, value)
      }
      const qs = next.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    },
    [params, pathname, router],
  )

  // Counts per category — drives pill enable/disable. Computed once over the
  // full manifest, not the filtered slice.
  const categoryCounts = useMemo(() => {
    const counts: Record<TunableCategory, number> = {
      agent_runtime: 0,
      classification: 0,
      timing: 0,
      recognition: 0,
      retrieval: 0,
      mechanics: 0,
    }
    for (const t of tunables) counts[t.category] += 1
    return counts
  }, [tunables])

  // Sort by category (in pill order), then by name within each category.
  // Stable across renders.
  const sorted = useMemo(() => {
    const order = new Map(CATEGORIES.map((c, i) => [c.id, i]))
    return [...tunables].sort((a, b) => {
      const ca = order.get(a.category) ?? 99
      const cb = order.get(b.category) ?? 99
      if (ca !== cb) return ca - cb
      return a.name.localeCompare(b.name)
    })
  }, [tunables])

  const filtered = useMemo(() => {
    return sorted.filter((t) => {
      if (selectedCategory && t.category !== selectedCategory) return false
      if (search && !t.name.toLowerCase().includes(search)) return false
      return true
    })
  }, [sorted, selectedCategory, search])

  const toggleExpand = useCallback((name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(name)) {
        next.delete(name)
      } else {
        next.add(name)
      }
      return next
    })
  }, [])

  return (
    <div className="flex flex-col">
      {/* Controls row: category pills + search */}
      <div className="px-5 py-4 border-b border-stone-light/60 flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-1.5">
          <CategoryPill
            label="All"
            isActive={selectedCategory === null}
            disabled={false}
            onClick={() => updateParam('category', null)}
          />
          {CATEGORIES.map((c) => {
            const count = categoryCounts[c.id]
            return (
              <CategoryPill
                key={c.id}
                label={`${c.label} (${count})`}
                isActive={selectedCategory === c.id}
                disabled={count === 0}
                onClick={() => updateParam('category', selectedCategory === c.id ? null : c.id)}
              />
            )
          })}
        </div>
        <div className="ml-auto">
          <input
            type="search"
            value={params.get('search') ?? ''}
            onChange={(e) => updateParam('search', e.target.value || null)}
            placeholder="Search by name…"
            className="text-sm px-3 py-1.5 border border-stone-light/60 rounded-[2px] bg-paper text-ink placeholder:text-ink-faint focus:outline-none focus:border-clay w-56"
            aria-label="Search tunables by name"
          />
        </div>
      </div>

      {/* Header row */}
      <div className="px-5 grid grid-cols-[2fr_1fr_0.6fr_0.8fr_1.4fr] gap-4 py-3 border-b border-stone-light/60 text-[11px] uppercase font-medium text-ink-faint" style={{ letterSpacing: 'var(--tracking-eyebrow)' }}>
        <span>Name</span>
        <span>Value</span>
        <span>Type</span>
        <span>Category</span>
        <span>Source</span>
      </div>

      {/* Body */}
      {filtered.length === 0 ? (
        <div data-testid="tunables-empty-state" className="px-5 py-8 text-center text-sm text-ink-soft">
          No tunables match these filters.
        </div>
      ) : (
        <div>
          {filtered.map((t, i) => {
            const isExpanded = expanded.has(t.name)
            const isLast = i === filtered.length - 1
            return (
              <TunableRow
                key={t.name}
                tunable={t}
                isExpanded={isExpanded}
                isLast={isLast}
                onToggle={() => toggleExpand(t.name)}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

interface CategoryPillProps {
  label: string
  isActive: boolean
  disabled: boolean
  onClick: () => void
}

function CategoryPill({ label, isActive, disabled, onClick }: CategoryPillProps) {
  const base = 'text-xs px-2.5 py-1 rounded-[2px] border transition-colors'
  let tone = ''
  if (isActive) {
    tone = 'bg-clay text-paper border-clay'
  } else if (disabled) {
    tone = 'bg-paper text-ink-faint border-stone-light/60 cursor-not-allowed opacity-60'
  } else {
    tone = 'bg-paper text-ink border-stone-light/60 hover:border-clay hover:text-clay'
  }
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`${base} ${tone}`}
      aria-pressed={isActive}
    >
      {label}
    </button>
  )
}

// ---------------------------------------------------------------------------

interface TunableRowProps {
  tunable: Tunable
  isExpanded: boolean
  isLast: boolean
  onToggle: () => void
}

function TunableRow({ tunable, isExpanded, isLast, onToggle }: TunableRowProps) {
  const isObject = tunable.type === 'object'
  return (
    <div className="px-5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        className="w-full text-left grid grid-cols-[2fr_1fr_0.6fr_0.8fr_1.4fr] gap-4 py-3 border-b border-stone-light/60 hover:bg-highlight/40 transition-colors"
        data-testid={`tunable-row-${tunable.name}`}
      >
        <span className="font-mono text-sm text-ink tabular-nums">{tunable.name}</span>
        <span className="text-sm text-ink tabular-nums truncate">
          {isObject ? <span className="text-ink-faint">{'{…}'}</span> : String(tunable.value)}
        </span>
        <span className="text-sm text-ink-soft">{tunable.type}</span>
        <span className="text-sm text-ink-soft">{tunable.category.replace('_', ' ')}</span>
        <span className="text-xs text-ink-soft truncate font-mono">{tunable.source}</span>
      </button>
      {isExpanded ? (
        <HairlineRow
          last={isLast}
          className="bg-parchment px-1 -mx-1"
          data-testid={`tunable-detail-${tunable.name}`}
        >
          <TunableDetail tunable={tunable} />
        </HairlineRow>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------

function TunableDetail({ tunable }: { tunable: Tunable }) {
  const isObject = tunable.type === 'object'
  return (
    <div className="px-5 py-2 flex flex-col gap-3">
      <p className="text-sm text-ink leading-relaxed">{tunable.description}</p>
      {isObject ? (
        <pre className="bg-paper border border-stone-light/60 p-3 text-xs text-ink overflow-x-auto rounded-[2px]">
          {JSON.stringify(tunable.value, null, 2)}
        </pre>
      ) : null}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-ink-soft">
        <dt className="text-ink-faint uppercase font-medium" style={{ letterSpacing: 'var(--tracking-eyebrow)' }}>Source</dt>
        <dd className="font-mono">{tunable.source}</dd>
        {tunable.relatedTickets && tunable.relatedTickets.length > 0 ? (
          <>
            <dt className="text-ink-faint uppercase font-medium" style={{ letterSpacing: 'var(--tracking-eyebrow)' }}>Tickets</dt>
            <dd>{tunable.relatedTickets.join(', ')}</dd>
          </>
        ) : null}
      </dl>
    </div>
  )
}
