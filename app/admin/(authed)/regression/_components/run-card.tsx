import Link from 'next/link'
import { Card } from '@/components/ui/card'
import { describeTell } from '@/lib/eval/regression-scenarios'
import type { RunListItem } from '../_lib/load-regression'

// One stored harness run: verdict per scenario (stored, harness-computed -
// never re-derived here), expandable per-sample transcripts, breach lines
// with their voice_corpus attributions linking into /admin/voices.
// Server component - <details> gives expand/collapse with no client JS.

function verdictTone(verdict: string): string {
  if (verdict === 'PASS') return 'text-green-700'
  if (verdict.startsWith('BAR')) return 'text-amber-700'
  return 'text-destructive'
}

export function RunCard({ run }: { run: RunListItem }) {
  const started = new Date(run.startedAt)
  return (
    <Card className="block rounded-[2px] border-stone-light/60 bg-paper p-4 shadow-none">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="text-sm font-medium">
          {run.scenariosPassed}/{run.scenariosTotal} passed
        </span>
        <span className="font-mono text-xs text-muted-foreground">
          {run.promptVersion}
        </span>
        <span className="text-xs text-muted-foreground">
          {started.toISOString().replace('T', ' ').slice(0, 16)}Z · n=
          {run.samples} · {run.venueName} · pack {run.packRows} rows
          {run.gitSha ? ` · ${run.gitSha.slice(0, 7)}` : ''}
          {run.fullRun ? '' : ' · FILTERED (cannot certify)'}
        </span>
      </div>

      <div className="mt-3 flex flex-col gap-2">
        {Object.entries(run.verdicts).map(([scenarioKey, verdict]) => {
          const units = run.units.filter((u) => u.scenarioKey === scenarioKey)
          return (
            <details key={scenarioKey} className="group">
              <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-3 text-sm">
                <span className="font-mono">{scenarioKey}</span>
                <span className={`text-xs ${verdictTone(verdict)}`}>
                  {verdict}
                </span>
                <span className="text-xs text-muted-foreground group-open:hidden">
                  expand
                </span>
              </summary>
              <div className="mt-2 flex flex-col gap-3 border-l border-stone-light/60 pl-4">
                {units.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    no stored samples for this scenario
                  </p>
                ) : (
                  units.map((u) => (
                    <div key={u.sample} className="flex flex-col gap-1 text-sm">
                      <span className="text-xs text-muted-foreground">
                        sample {u.sample}
                      </span>
                      {u.unit === null ? (
                        <p className="text-xs text-destructive">
                          stored unit fails schema parse - see the JSONL run log
                        </p>
                      ) : (
                        <>
                          {u.unit.turns.map((t, i) => (
                            <div key={i} className="flex flex-col">
                              <div>
                                <span className="text-muted-foreground">
                                  guest:
                                </span>{' '}
                                {t.inbound}
                              </div>
                              {t.reply.map((m, j) => (
                                <div key={j}>
                                  <span className="text-muted-foreground">
                                    venue:
                                  </span>{' '}
                                  {m}
                                </div>
                              ))}
                              {t.tagged.length > 0 ? (
                                <div className="text-xs text-muted-foreground">
                                  tagged: {t.tagged.join(', ')}
                                </div>
                              ) : null}
                            </div>
                          ))}
                          {u.unit.disqualified ? (
                            <p className="text-xs text-destructive">
                              disqualified: {u.unit.disqualified}
                            </p>
                          ) : null}
                          {u.unit.breaches.map((b, i) => (
                            <div key={i} className="flex flex-col">
                              <p className="text-xs text-destructive">
                                breach {b.tell} (turn {b.turn}): &quot;
                                {b.bubble}&quot;
                                {b.attributedTo.length > 0 ? (
                                  <>
                                    {' '}
                                    · echoes corpus{' '}
                                    {b.attributedTo.map((id, j) => (
                                      <span key={id}>
                                        {j > 0 ? ', ' : ''}
                                        <Link
                                          href={`/admin/voices/${run.venueSlug}`}
                                          className="underline"
                                        >
                                          {id.slice(0, 8)}
                                        </Link>
                                      </span>
                                    ))}
                                  </>
                                ) : null}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {describeTell(b.tell)}
                              </p>
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  ))
                )}
              </div>
            </details>
          )
        })}
      </div>
    </Card>
  )
}
