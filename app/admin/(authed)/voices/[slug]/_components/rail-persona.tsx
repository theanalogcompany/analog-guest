'use client'

import { useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import type { BrandPersona } from '@/lib/schemas'

// Persona pane — every editable BrandPersona field. voiceName lives at the
// top above the warning copy; topbar renders read-only and refreshes via
// router.refresh() once the PATCH lands.
//
// Save batches all dirty fields into a single PATCH so the persona JSONB
// gets one round trip per save rather than one per field. Optimistic UI
// updates ride on the local form state — server is source of truth, the
// onMutate callback re-fetches. Controls reskinned to shadcn (TAC-306); the
// diff + PATCH logic is unchanged.

interface RailPersonaProps {
  venueId: string
  persona: BrandPersona
  onMutate: () => void
}

interface PersonaForm {
  voiceName: string
  tone: string
  formality: BrandPersona['formality']
  speakerFraming: BrandPersona['speakerFraming']
  speakerName: string
  emojiPolicy: BrandPersona['emojiPolicy']
  lengthGuide: string
  signaturePhrases: string[]
  bannedTopics: string[]
  voiceTouchstones: string[]
}

function toForm(p: BrandPersona): PersonaForm {
  return {
    voiceName: p.voiceName ?? '',
    tone: p.tone,
    formality: p.formality,
    speakerFraming: p.speakerFraming,
    speakerName: p.speakerName ?? '',
    emojiPolicy: p.emojiPolicy,
    lengthGuide: p.lengthGuide,
    signaturePhrases: [...p.signaturePhrases],
    bannedTopics: [...p.bannedTopics],
    voiceTouchstones: [...p.voiceTouchstones],
  }
}

function shallowEqual(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function diffPersona(form: PersonaForm, persona: BrandPersona): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  // voiceName: empty form value means "no change" rather than "clear it" —
  // the schema rejects empty strings, and there's no clear-name affordance
  // yet. Sending no key leaves the stored value untouched.
  if (form.voiceName !== (persona.voiceName ?? '')) {
    if (form.voiceName.trim().length > 0) out.voiceName = form.voiceName.trim()
  }
  if (form.tone !== persona.tone) out.tone = form.tone
  if (form.formality !== persona.formality) out.formality = form.formality
  if (form.speakerFraming !== persona.speakerFraming) out.speakerFraming = form.speakerFraming
  if (form.speakerName !== (persona.speakerName ?? '')) out.speakerName = form.speakerName
  if (form.emojiPolicy !== persona.emojiPolicy) out.emojiPolicy = form.emojiPolicy
  if (form.lengthGuide !== persona.lengthGuide) out.lengthGuide = form.lengthGuide
  if (!shallowEqual(form.signaturePhrases, persona.signaturePhrases)) {
    out.signaturePhrases = form.signaturePhrases
  }
  if (!shallowEqual(form.bannedTopics, persona.bannedTopics)) {
    out.bannedTopics = form.bannedTopics
  }
  if (!shallowEqual(form.voiceTouchstones, persona.voiceTouchstones)) {
    out.voiceTouchstones = form.voiceTouchstones
  }
  return out
}

// Shared field chrome — shadcn controls themed onto the rail's highlight wash.
const FIELD_CLS = 'h-auto w-full bg-highlight py-1.5 text-[12.5px]'
const TEXTAREA_CLS = 'w-full bg-highlight text-[12.5px] leading-snug resize-vertical'

export function RailPersona({ venueId, persona, onMutate }: RailPersonaProps) {
  const [form, setForm] = useState<PersonaForm>(() => toForm(persona))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Single source of truth for both the dirty flag and the save payload.
  const partial = useMemo(() => diffPersona(form, persona), [form, persona])
  const dirty = Object.keys(partial).length > 0

  async function save() {
    setBusy(true)
    setError(null)
    try {
      const body = partial

      const res = await fetch(`/admin/voices/api/persona/${venueId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setError((j.detail as string) || (j.error as string) || 'Save failed')
        return
      }
      onMutate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {/* voiceName at the very top — discoverable, single PATCH writer */}
      <PersonaField label="Voice name" help="Rendered in the topbar + sidebar voice list">
        <Input
          value={form.voiceName}
          onChange={(e) => setForm({ ...form, voiceName: e.target.value })}
          placeholder="e.g. Sana"
          className={FIELD_CLS}
        />
      </PersonaField>

      <div className="my-1 px-2.5 py-2 bg-clay-soft/15 border-l-2 border-clay rounded-r-[3px] text-[11px] text-ink-soft italic font-fraunces font-fraunces-text leading-relaxed">
        The configurational layer sits upstream of rules and corpus. If <em>tone</em>{' '}
        or <em>length guide</em> read as polished prose, the agent will return polished
        prose to match — even with strong rules.
      </div>

      <PersonaField label="Tone" help="Free text · the voice in one or two breaths">
        <Textarea
          value={form.tone}
          onChange={(e) => setForm({ ...form, tone: e.target.value })}
          rows={3}
          className={TEXTAREA_CLS}
        />
      </PersonaField>

      <PersonaField label="Formality">
        <Select
          value={form.formality}
          onValueChange={(v) => setForm({ ...form, formality: v as BrandPersona['formality'] })}
        >
          <SelectTrigger className={FIELD_CLS}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="casual">casual — contractions, lowercase starts okay</SelectItem>
            <SelectItem value="warm">warm — conversational, no stiffness</SelectItem>
            <SelectItem value="formal">formal — complete sentences, proper caps</SelectItem>
          </SelectContent>
        </Select>
      </PersonaField>

      <PersonaField label="Length guide" help="How long replies should run">
        <Textarea
          value={form.lengthGuide}
          onChange={(e) => setForm({ ...form, lengthGuide: e.target.value })}
          rows={2}
          className={TEXTAREA_CLS}
        />
      </PersonaField>

      <PersonaField label="Speaker framing">
        <Select
          value={form.speakerFraming}
          onValueChange={(v) => setForm({ ...form, speakerFraming: v as BrandPersona['speakerFraming'] })}
        >
          <SelectTrigger className={FIELD_CLS}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="venue">venue — &quot;we&quot; / unnamed</SelectItem>
            <SelectItem value="named_person">named person — sign as a specific person</SelectItem>
            <SelectItem value="owner">owner — first person, owner&apos;s voice</SelectItem>
          </SelectContent>
        </Select>
      </PersonaField>

      {form.speakerFraming === 'named_person' && (
        <PersonaField label="Speaker name" help="Required for the named-person framing">
          <Input
            value={form.speakerName}
            onChange={(e) => setForm({ ...form, speakerName: e.target.value })}
            placeholder="e.g. Sana"
            className={FIELD_CLS}
          />
        </PersonaField>
      )}

      <PersonaField label="Emoji policy">
        <Select
          value={form.emojiPolicy}
          onValueChange={(v) => setForm({ ...form, emojiPolicy: v as BrandPersona['emojiPolicy'] })}
        >
          <SelectTrigger className={FIELD_CLS}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="never">never</SelectItem>
            <SelectItem value="sparingly">sparingly</SelectItem>
            <SelectItem value="frequent">frequent</SelectItem>
          </SelectContent>
        </Select>
      </PersonaField>

      <PersonaField
        label="Signature phrases"
        help="Phrases the venue actually uses · don't stuff"
      >
        <PillEditor
          values={form.signaturePhrases}
          onChange={(next) => setForm({ ...form, signaturePhrases: next })}
        />
      </PersonaField>

      <PersonaField label="Banned topics" help="Subjects to deflect or refuse">
        <PillEditor
          values={form.bannedTopics}
          onChange={(next) => setForm({ ...form, bannedTopics: next })}
        />
      </PersonaField>

      <PersonaField label="Voice touchstones" help="Reference points · how the voice should land">
        <PillEditor
          values={form.voiceTouchstones}
          onChange={(next) => setForm({ ...form, voiceTouchstones: next })}
        />
      </PersonaField>

      {error && (
        <p className="text-[11px] text-clay-deep border-l-2 border-clay px-2 py-1 bg-clay-soft/15">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-3 mt-3 pt-3 border-t border-stone-light/60 sticky bottom-0 bg-paper">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setForm(toForm(persona))}
          disabled={!dirty || busy}
          className="text-[11px] text-ink-faint hover:text-ink"
        >
          Reset
        </Button>
        <Button
          onClick={save}
          disabled={!dirty || busy}
          size="sm"
          className="hover:bg-clay-deep uppercase text-[10.5px] tracking-wider"
        >
          {busy ? 'Saving…' : dirty ? 'Save persona' : 'Saved'}
        </Button>
      </div>
    </div>
  )
}

function PersonaField({
  label,
  help,
  children,
}: {
  label: string
  help?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5 py-2 border-b border-stone-light/60 last:border-b-0">
      <div className="flex items-baseline justify-between">
        <span className="text-[9.5px] uppercase font-semibold tracking-eyebrow text-ink">
          {label}
        </span>
        {help && (
          <span className="text-[11px] text-ink-faint italic font-fraunces font-fraunces-text leading-snug max-w-[60%] text-right">
            {help}
          </span>
        )}
      </div>
      {children}
    </div>
  )
}

function PillEditor({
  values,
  onChange,
}: {
  values: string[]
  onChange: (next: string[]) => void
}) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')

  function commitDraft() {
    const t = draft.trim()
    if (t.length === 0) {
      setAdding(false)
      setDraft('')
      return
    }
    onChange([...values, t])
    setDraft('')
    setAdding(false)
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map((v, idx) => (
        <Badge
          key={`${v}-${idx}`}
          variant="secondary"
          className="gap-1 rounded-full bg-parchment border-stone-light/60 pl-2.5 pr-1 py-[3px] text-[11.5px] font-normal text-ink"
        >
          {v}
          <Button
            type="button"
            variant="ghost"
            onClick={() => onChange(values.filter((_, i) => i !== idx))}
            className="size-4 p-0 text-ink-faint hover:text-clay hover:bg-transparent text-[14px] leading-none"
            aria-label={`Remove ${v}`}
          >
            ×
          </Button>
        </Badge>
      ))}
      {adding ? (
        <Input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commitDraft()
            } else if (e.key === 'Escape') {
              setAdding(false)
              setDraft('')
            }
          }}
          className="h-auto w-auto min-w-[80px] rounded-full bg-highlight border-clay px-2.5 py-[3px] text-[11.5px]"
        />
      ) : (
        <Button
          type="button"
          variant="outline"
          onClick={() => setAdding(true)}
          className="h-auto rounded-full border-dashed border-stone-dark bg-transparent px-2.5 py-[3px] text-[11.5px] text-ink-faint hover:text-clay hover:border-clay"
        >
          + add
        </Button>
      )}
    </div>
  )
}
