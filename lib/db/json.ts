import type { Json } from '@/db/types'

/**
 * Coerce a structurally-clean JS value into the supabase-js `Json` type so
 * it can be written to a JSONB column. Round-trips through JSON to drop
 * `undefined` keys and any non-serializable wrappers (Date instances become
 * strings, etc.) — same behavior `JSON.stringify` documents.
 *
 * The `as Json` cast is the type-system bridge: the runtime guarantees
 * structural correctness, the cast tells TypeScript to trust the result.
 */
export function toJson<T>(value: T): Json {
  return JSON.parse(JSON.stringify(value)) as Json
}
