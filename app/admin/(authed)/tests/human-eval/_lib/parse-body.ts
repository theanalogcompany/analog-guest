import { NextResponse } from 'next/server'
import type { z } from 'zod'

// Parse a JSON request body against a Zod schema, or hand back the 400.
//
// The three write routes on this surface all do this, and the shape is worth
// one definition rather than three: a route that forgets the `catch` answers a
// malformed body with a 500 and an unhandled rejection in the log, which reads
// as the surface being broken rather than as a bad request.
//
// Errors as values: the caller returns `result.response` and never throws.

export type ParsedBody<T> =
  { ok: true; body: T } | { ok: false; response: NextResponse }

export async function parseJsonBody<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<ParsedBody<z.infer<S>>> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: 'invalid json' }, { status: 400 }),
    }
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success)
    return {
      ok: false,
      response: NextResponse.json(
        // `detail` carries Zod's own message, which names the field. A bare
        // "invalid body" on a surface that posts four different shapes is a
        // debugging dead end.
        { error: 'invalid body', detail: parsed.error.message },
        { status: 400 },
      ),
    }
  return { ok: true, body: parsed.data as z.infer<S> }
}
