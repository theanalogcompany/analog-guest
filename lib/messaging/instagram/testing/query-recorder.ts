// TAC-469: a Supabase stand-in that RECORDS every query builder call and
// answers from a script.
//
// For the outbound loaders (window.ts, reply-check.ts, send-target.ts), whose
// correctness is mostly in the filters they send: the channel, the direction,
// the not-null guard on Meta's time, the ordering. A mock that ignored its
// arguments would pass with any of those removed (the TAC-377 and TAC-385
// traps in CLAUDE.md), so tests assert on `calls` directly.
//
// Each `from(table)` takes the next scripted answer for that table, in order,
// and throws when the script runs out, so an unexpected extra query fails the
// test instead of being answered.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/db/types'

export type RecordedQuery = { table: string; calls: Array<[string, ...unknown[]]> }
export type ScriptedAnswer = { data: unknown; error: { message: string; code?: string } | null }

export function queryRecorder(script: Record<string, ScriptedAnswer[]>): {
  client: SupabaseClient<Database>
  queries: RecordedQuery[]
} {
  const queries: RecordedQuery[] = []
  const remaining: Record<string, ScriptedAnswer[]> = Object.fromEntries(
    Object.entries(script).map(([table, answers]) => [table, [...answers]]),
  )

  function from(table: string) {
    const answer = remaining[table]?.shift()
    if (answer === undefined) throw new Error(`query-recorder: no scripted answer left for ${table}`)
    const query: RecordedQuery = { table, calls: [] }
    queries.push(query)
    const builder: Record<string, unknown> = {}
    const chain = (name: string) => (...args: unknown[]) => {
      query.calls.push([name, ...args])
      return builder
    }
    for (const name of ['select', 'eq', 'neq', 'not', 'is', 'in', 'or', 'lte', 'gte', 'gt', 'lt', 'order', 'limit', 'update', 'insert', 'upsert', 'delete']) {
      builder[name] = chain(name)
    }
    builder.maybeSingle = () => {
      query.calls.push(['maybeSingle'])
      return Promise.resolve(answer)
    }
    builder.single = () => {
      query.calls.push(['single'])
      return Promise.resolve(answer)
    }
    builder.then = (resolve: (v: ScriptedAnswer) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(answer).then(resolve, reject)
    return builder
  }

  return { client: { from } as unknown as SupabaseClient<Database>, queries }
}

/** The arguments of every call named `name` on one recorded query. */
export function callsNamed(query: RecordedQuery, name: string): unknown[][] {
  return query.calls.filter(([n]) => n === name).map(([, ...args]) => args)
}
