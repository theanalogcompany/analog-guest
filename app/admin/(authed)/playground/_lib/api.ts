import type { PlaygroundConversationTurn } from '@/lib/schemas/playground'
import type { PlaygroundSession } from '@/lib/relationship/run-turn'
import {
  deleteJson,
  getJson,
  postJson,
  type FetchResult,
} from '../../_lib/fetch-json'
import type {
  GuestListResponse,
  RunRequestBody,
  RunResponseBody,
  SavedConversationDetail,
  SavedConversationListResponse,
  SavedConversationSummary,
  TimelineResponse,
} from './types'

// The playground's own routes, one wrapper each. The HTTP half - how a route's
// `{error, detail}` becomes a string the UI can render - is
// `(authed)/_lib/fetch-json.ts`, shared with every other admin surface.
// Admin API routes live at /admin/playground/api/* (app/admin/CLAUDE.md -
// /api/admin/... 404s in production behind the host gate).

export type { FetchResult }

/** One full turn through the v2 engine. Takes 15-45s (three model calls). */
export function postRun(
  body: RunRequestBody,
): Promise<FetchResult<RunResponseBody>> {
  return postJson('/admin/playground/api/run', body)
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

export function fetchSavedConversations(
  venueId: string,
): Promise<FetchResult<SavedConversationListResponse>> {
  return getJson(`/admin/playground/api/venues/${venueId}/conversations`)
}

export function fetchSavedConversation(
  venueId: string,
  conversationId: string,
): Promise<FetchResult<SavedConversationDetail>> {
  return getJson(
    `/admin/playground/api/venues/${venueId}/conversations/${conversationId}`,
  )
}

export function postSaveConversation(
  venueId: string,
  body: {
    name: string
    turns: PlaygroundConversationTurn[]
    nextSession: PlaygroundSession | null
  },
): Promise<FetchResult<SavedConversationSummary>> {
  return postJson(`/admin/playground/api/venues/${venueId}/conversations`, body)
}

export function deleteSavedConversation(
  venueId: string,
  conversationId: string,
): Promise<FetchResult<{ ok: true }>> {
  return deleteJson(
    `/admin/playground/api/venues/${venueId}/conversations/${conversationId}`,
  )
}
