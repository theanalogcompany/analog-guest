// Client-side fetch wrappers for the Command Center's own route handlers.
// Errors as values all the way to the UI: a failed request renders in the
// surface that made it, never as a crash.
//
// SHARED BECAUSE THE ERROR READING IS THE POINT. An admin route answers a
// failure as `{error, detail}` with a status, and a surface that only reads
// `response.ok` turns every one of those into "request failed" - which is the
// difference between an operator seeing "venue not allowed" and seeing
// nothing. One definition of how that body is unpacked, rather than one per
// surface, because the second copy is always the one that forgets `detail`.
//
// Admin API routes live at /admin/{surface}/api/* (app/admin/CLAUDE.md -
// /api/admin/... 404s in production behind the host gate), so every caller
// passes a path under /admin.

export type FetchResult<T> =
  { ok: true; data: T } | { ok: false; error: string }

/** The status line plus whatever the route said, when it said anything. */
export async function readFetchError(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json()
    if (body !== null && typeof body === 'object') {
      const { error, detail } = body as { error?: unknown; detail?: unknown }
      const parts = [error, detail].filter(
        (p): p is string => typeof p === 'string' && p.length > 0,
      )
      if (parts.length > 0) return `${response.status}: ${parts.join(' - ')}`
    }
  } catch {
    // fall through to the status line
  }
  return `request failed with status ${response.status}`
}

export async function getJson<T>(url: string): Promise<FetchResult<T>> {
  return request<T>(url, { method: 'GET' })
}

export async function postJson<T>(
  url: string,
  body: unknown,
): Promise<FetchResult<T>> {
  return request<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function patchJson<T>(
  url: string,
  body: unknown,
): Promise<FetchResult<T>> {
  return request<T>(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function deleteJson<T>(url: string): Promise<FetchResult<T>> {
  return request<T>(url, { method: 'DELETE' })
}

async function request<T>(
  url: string,
  init: RequestInit,
): Promise<FetchResult<T>> {
  try {
    const response = await fetch(url, init)
    if (!response.ok)
      return { ok: false, error: await readFetchError(response) }
    return { ok: true, data: (await response.json()) as T }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'network request failed',
    }
  }
}
