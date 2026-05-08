// PostgREST-shape helpers. The supabase-js builder embeds related rows as
// either an array OR a single object depending on cardinality inference,
// even on relations that are 1:1 by primary key. Normalize so consumers
// don't all reach for `Array.isArray(x) ? x[0] ?? null : x`.

/**
 * Collapse a possibly-array embedded relation into a single value or null.
 * Use on selects that embed `related_table(...)` and you want a single
 * record-or-null shape regardless of PostgREST's array/object inference.
 */
export function firstOrNull<T>(value: T | T[] | null | undefined): T | null {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return value[0] ?? null
  return value
}
