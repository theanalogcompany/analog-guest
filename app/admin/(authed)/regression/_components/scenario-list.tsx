'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card } from '@/components/ui/card'
import type { ScenarioListItem } from '../_lib/load-regression'

// Scenario cards with enable/disable/delete, plus the add form. Writes go
// through the api/ routes (strict boundary); router.refresh() re-runs the
// server loader so the list is always the stored truth, never local state.

export function ScenarioList({ scenarios }: { scenarios: ScenarioListItem[] }) {
  const router = useRouter()
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function patch(key: string, enabled: boolean) {
    setBusyKey(key)
    setError(null)
    const res = await fetch(
      `/admin/regression/api/scenarios/${encodeURIComponent(key)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      },
    )
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string
      } | null
      setError(body?.error ?? `PATCH failed (${res.status})`)
    }
    setBusyKey(null)
    router.refresh()
  }

  async function remove(key: string) {
    if (
      !window.confirm(
        `Hard-delete scenario "${key}"? Disable is the usual path - delete only if it was added in error.`,
      )
    )
      return
    setBusyKey(key)
    setError(null)
    const res = await fetch(
      `/admin/regression/api/scenarios/${encodeURIComponent(key)}`,
      { method: 'DELETE' },
    )
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string
      } | null
      setError(body?.error ?? `DELETE failed (${res.status})`)
    }
    setBusyKey(null)
    router.refresh()
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {scenarios.map((s) => (
        <Card
          key={s.key}
          className={`block rounded-[2px] border-stone-light/60 bg-paper p-4 shadow-none ${s.enabled ? '' : 'opacity-60'}`}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm">{s.key}</span>
                {!s.enabled ? (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                    disabled
                  </span>
                ) : null}
              </div>
              <p className="max-w-2xl text-sm text-muted-foreground">
                {s.lesson}
              </p>
              {s.parseError ? (
                <p className="text-sm text-destructive">
                  stored row fails schema parse ({s.parseError}) - the harness
                  refuses the whole DB set while this persists
                </p>
              ) : (
                <>
                  <div className="flex flex-col gap-1">
                    {s.script.map((line, i) => (
                      <div key={i} className="text-sm">
                        <span className="text-muted-foreground">guest:</span>{' '}
                        {line}
                      </div>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    {s.target.length > 0 ? (
                      <span>bar: pursues {s.target.join(' or ')}</span>
                    ) : null}
                    {s.expectFirstName !== null ? (
                      <span>
                        bar: captures first_name &quot;{s.expectFirstName}
                        &quot;
                      </span>
                    ) : null}
                    {s.noTurnOneNameAsk ? (
                      <span>ceiling: no turn-one name ask</span>
                    ) : null}
                    {s.expectReplyContains !== null ? (
                      <span>
                        bar: reply mentions &quot;{s.expectReplyContains}&quot;
                      </span>
                    ) : null}
                    {s.forbidPolicyKeys.length > 0 ? (
                      <span>
                        ceiling: gate must not match{' '}
                        {s.forbidPolicyKeys.join(', ')}
                      </span>
                    ) : null}
                    <span>
                      ceilings: emoji · dash · assistant register · two
                      questions
                    </span>
                  </div>
                </>
              )}
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                disabled={busyKey === s.key}
                onClick={() => void patch(s.key, !s.enabled)}
                className="rounded-[2px] border border-stone-light/60 px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
              >
                {s.enabled ? 'Disable' : 'Enable'}
              </button>
              <button
                type="button"
                disabled={busyKey === s.key}
                onClick={() => void remove(s.key)}
                className="rounded-[2px] border border-destructive/40 px-2 py-1 text-xs text-destructive hover:bg-destructive/5 disabled:opacity-50"
              >
                Delete
              </button>
            </div>
          </div>
        </Card>
      ))}
      <AddScenarioForm onError={setError} onDone={() => router.refresh()} />
    </div>
  )
}

function AddScenarioForm({
  onError,
  onDone,
}: {
  onError: (message: string | null) => void
  onDone: () => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [key, setKey] = useState('')
  const [lesson, setLesson] = useState('')
  const [script, setScript] = useState('')
  const [target, setTarget] = useState('')
  const [expectFirstName, setExpectFirstName] = useState('')
  const [noTurnOneNameAsk, setNoTurnOneNameAsk] = useState(false)
  const [expectReplyContains, setExpectReplyContains] = useState('')
  const [forbidPolicyKeys, setForbidPolicyKeys] = useState('')

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="self-start rounded-[2px] border border-stone-light/60 px-3 py-1.5 text-sm hover:bg-muted"
      >
        Add scenario
      </button>
    )
  }

  async function submit() {
    setBusy(true)
    onError(null)
    const res = await fetch('/admin/regression/api/scenarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key,
        lesson,
        script: script
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0),
        target: target
          .split(',')
          .map((t) => t.trim())
          .filter((t) => t.length > 0),
        expectFirstName:
          expectFirstName.trim() === '' ? null : expectFirstName.trim(),
        noTurnOneNameAsk,
        expectReplyContains:
          expectReplyContains.trim() === '' ? null : expectReplyContains.trim(),
        forbidPolicyKeys: forbidPolicyKeys
          .split(',')
          .map((k) => k.trim())
          .filter((k) => k.length > 0),
        enabled: true,
      }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string
      } | null
      onError(body?.error ?? `POST failed (${res.status})`)
    } else {
      setOpen(false)
      setKey('')
      setLesson('')
      setScript('')
      setTarget('')
      setExpectFirstName('')
      setNoTurnOneNameAsk(false)
      setExpectReplyContains('')
      setForbidPolicyKeys('')
    }
    setBusy(false)
    onDone()
  }

  return (
    <Card className="block rounded-[2px] border-stone-light/60 bg-paper p-4 shadow-none">
      <div className="flex max-w-xl flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Key (kebab-case)
          <input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className="rounded-[2px] border border-stone-light/60 px-2 py-1 font-mono text-sm"
            placeholder="rushed-regular"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Lesson - what this guards and why it exists
          <textarea
            value={lesson}
            onChange={(e) => setLesson(e.target.value)}
            rows={2}
            className="rounded-[2px] border border-stone-light/60 px-2 py-1 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Guest script - one message per line, oldest first
          <textarea
            value={script}
            onChange={(e) => setScript(e.target.value)}
            rows={3}
            className="rounded-[2px] border border-stone-light/60 px-2 py-1 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Bar: move keys counting as pursuit (comma-separated, optional)
          <input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="rounded-[2px] border border-stone-light/60 px-2 py-1 font-mono text-sm"
            placeholder="learn_name, understand_order"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Bar: expected first_name capture (optional)
          <input
            value={expectFirstName}
            onChange={(e) => setExpectFirstName(e.target.value)}
            className="rounded-[2px] border border-stone-light/60 px-2 py-1 text-sm"
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={noTurnOneNameAsk}
            onChange={(e) => setNoTurnOneNameAsk(e.target.checked)}
          />
          Ceiling: first reply must not ask the name
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Bar: reply must mention this substring (optional)
          <input
            value={expectReplyContains}
            onChange={(e) => setExpectReplyContains(e.target.value)}
            className="rounded-[2px] border border-stone-light/60 px-2 py-1 text-sm"
            placeholder="lemils.com"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Ceiling: gate must not match these policy keys (comma-separated,
          optional)
          <input
            value={forbidPolicyKeys}
            onChange={(e) => setForbidPolicyKeys(e.target.value)}
            className="rounded-[2px] border border-stone-light/60 px-2 py-1 font-mono text-sm"
            placeholder="unverified_link"
          />
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            className="rounded-[2px] border border-stone-light/60 px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          >
            Save scenario
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-[2px] px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted"
          >
            Cancel
          </button>
        </div>
      </div>
    </Card>
  )
}
