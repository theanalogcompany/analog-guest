import type {
  GuestListResponse,
  RunRequestBody,
  RunResponseBody,
  TimelineResponse,
} from './types'

// Client-side fetch wrappers for the playground routes. Errors as values all
// the way to the UI: a failed run renders in the inspector, never a crash.
// Admin API routes live at /admin/playground/api/* (app/admin/CLAUDE.md -
// /api/admin/... 404s in production behind the host gate).

export type FetchResult<T> =
  { ok: true; data: T } | { ok: false; error: string }

async function readError(response: Response): Promise<string> {
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

async function getJson<T>(url: string): Promise<FetchResult<T>> {
  try {
    const response = await fetch(url)
    if (!response.ok) return { ok: false, error: await readError(response) }
    return { ok: true, data: (await response.json()) as T }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'network request failed',
    }
  }
}

/** One full turn through the v2 engine. Takes 15-45s (three model calls). */
export async function postRun(
  body: RunRequestBody,
): Promise<FetchResult<RunResponseBody>> {
  try {
    const response = await fetch('/admin/playground/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) return { ok: false, error: await readError(response) }
    return { ok: true, data: (await response.json()) as RunResponseBody }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'network request failed',
    }
  }
}

export function fetchGuests(
  venueId: string,
): Promise<FetchResult<GuestListResponse>> {
  return getJson(`/admin/playground/api/venues/${venueId}/guests`)
}

export function fetchTimeline(
  venueId: string,
  guestId: string,
): Promise<FetchResult<TimelineResponse>> {
  return getJson(
    `/admin/playground/api/venues/${venueId}/guests/${guestId}/timeline`,
  )
}
