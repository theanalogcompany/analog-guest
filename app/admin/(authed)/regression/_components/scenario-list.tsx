'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card } from '@/components/ui/card'
import type { ScenarioListItem } from '../_lib/load-regression'

// Scenario cards. There is no add form: a scenario is an entry in
// REGRESSION_SCENARIOS (lib/eval/regression-scenarios.ts), so it arrives by
// PR, not by typing into this page (decision 0011). What this surface owns is
// enable/disable, which writes the overlay row and needs no deploy.
//
// router.refresh() re-runs the server loader so the list is always the
// resolved truth - code definitions plus stored flags - never local state.

export function ScenarioList({ scenarios }: { scenarios: ScenarioListItem[] }) {
  const router = useRouter()
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function send(key: string, init: RequestInit, label: string) {
    setBusyKey(key)
    setError(null)
    const res = await fetch(
      `/admin/regression/api/scenarios/${encodeURIComponent(key)}`,
      init,
    )
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string
      } | null
      setError(body?.error ?? `${label} failed (${res.status})`)
    }
    setBusyKey(null)
    router.refresh()
  }

  const patch = (key: string, enabled: boolean) =>
    send(
      key,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      },
      'PATCH',
    )

  async function clearOverride(key: string, orphan: boolean) {
    if (
      !window.confirm(
        orphan
          ? `Remove the stale overlay row "${key}"? It defines nothing and does not run.`
          : `Clear the stored flag for "${key}"? Its enabled state goes back to whatever the code says.`,
      )
    )
      return
    await send(key, { method: 'DELETE' }, 'DELETE')
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
                {!s.enabled && s.source === 'code' ? (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                    disabled
                  </span>
                ) : null}
                {s.enabledOverridden ? (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                    flag overridden here, not in code
                  </span>
                ) : null}
                {s.source === 'orphan' ? (
                  <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive">
                    orphan row · not running
                  </span>
                ) : null}
              </div>
              <p className="max-w-2xl text-sm text-muted-foreground">
                {s.lesson}
              </p>
              {s.source === 'code' ? (
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
              ) : null}
            </div>
            <div className="flex shrink-0 gap-2">
              {s.source === 'code' ? (
                <button
                  type="button"
                  disabled={busyKey === s.key}
                  onClick={() => void patch(s.key, !s.enabled)}
                  className="rounded-[2px] border border-stone-light/60 px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                >
                  {s.enabled ? 'Disable' : 'Enable'}
                </button>
              ) : null}
              {s.enabledOverridden || s.source === 'orphan' ? (
                <button
                  type="button"
                  disabled={busyKey === s.key}
                  onClick={() =>
                    void clearOverride(s.key, s.source === 'orphan')
                  }
                  className="rounded-[2px] border border-destructive/40 px-2 py-1 text-xs text-destructive hover:bg-destructive/5 disabled:opacity-50"
                >
                  {s.source === 'orphan' ? 'Remove row' : 'Clear override'}
                </button>
              ) : null}
            </div>
          </div>
        </Card>
      ))}
    </div>
  )
}
