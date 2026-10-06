import { z } from 'zod'
import {
  JEV_MODEL,
  TYPESAFE_SYSTEMONE_URL,
} from '@/lib/ai/classify-message-jev'
import { checkTypesafeEnv } from '@/lib/ai/typesafe-env'

// Inbound situation detection: the fast axis of policy scoping. The
// relationship graph answers "who is this guest to us" (slow, per-visit);
// a SITUATION answers "what is happening right now" (per-turn) - complaint,
// opt-out request, mechanic request, needs-a-human. Policy rows condition on
// either axis or both; this module is what makes situation-scoped rows fire.
//
// Runs on the INBOUND, before/alongside generation, so the pre-send gate
// genuinely has the result - unlike the assessor's flags, which are
// post-send and must never feed a blocking gate (the run-turn review fix).
//
// One Jev request, one Noul per situation, same mechanics as
// classify-message-jev.ts and semantic-check.ts. FAILS OPEN to no
// situations: a missed situation means a venue-configured approval rule
// does not fire this turn, which is the v1 classifier's own failure posture.
// The TCPA opt-out rail does NOT depend on this module (the gate refuses to
// act on opt_out_request regardless - POLICY_EXEMPT_SITUATIONS in gate.ts);
// detection of it here is observability and phase 6 routing.

// situations-jev-v1.1.0: mechanic_request narrowed to favor-scale perk asks
// after "can i rent out your space" scored 0.55 and "can i book the loft for
// a birthday party" 0.95 under the v1.0.0 wording (playground, 2026-10-05);
// those belong to the new private_event_inquiry situation (venue-hire leads:
// rental, buyout, catering), which scores them 0.97/0.98 while attending-an-
// event questions ("when's the next open mic") stay at 0.02-0.06.
export const SITUATION_DETECT_VERSION = 'situations-jev-v1.1.0'
export const SITUATION_DETECT_TIMEOUT_MS = 1_500

export const SITUATION_KEYS = [
  'complaint',
  'opt_out_request',
  'mechanic_request',
  'private_event_inquiry',
  'needs_human',
] as const
export type SituationKey = (typeof SITUATION_KEYS)[number]

/**
 * P(yes) floors, PLACEHOLDERS until the calibration set measures real
 * distributions. opt_out_request is LOW on the classifier's own asymmetry:
 * missing one has legal weight, and the gate exemption means a false
 * positive costs nothing anyway.
 */
export const SITUATION_THRESHOLDS: Record<SituationKey, number> = {
  complaint: 0.5,
  opt_out_request: 0.3,
  mechanic_request: 0.5,
  private_event_inquiry: 0.5,
  needs_human: 0.5,
}

const QUESTIONS: Record<
  SituationKey,
  { instructions: string; criteria?: { true: string; false: string } }
> = {
  complaint: {
    instructions:
      'In `inbound_message`, is the guest reporting a problem, a quality issue, or an unsatisfactory experience with the venue (stale food, long wait, wrong order, rude service, bad visit)?',
    criteria: {
      true: 'The guest reports something that went wrong with their experience, even mildly or politely phrased.',
      false:
        'No problem is reported. Questions, chatter, compliments, and requests are not complaints.',
    },
  },
  opt_out_request: {
    instructions:
      'In `inbound_message`, is the guest asking to stop receiving messages from this number (stop, unsubscribe, "don\'t text me", or any equivalent)?',
  },
  mechanic_request: {
    instructions:
      'In `inbound_message`, is the guest invoking or claiming a small personal perk or favor from the venue - asking them to hold or set aside a specific item or seat for them, asking whether a specific item is free or on the house for them, redeeming something offered to them, or getting on a sign-up list?',
    criteria: {
      true: 'The guest asks the venue for a concrete favor-scale thing for them personally: hold the couch, set aside a pastry, put them on the open mic list, whether their tea is on the house, claiming a drink that was offered.',
      false:
        'Business and booking inquiries are not perk requests: renting or booking the space or a room, private events or buyouts, catering, wholesale, pricing questions, or asking how perks work in general.',
    },
  },
  private_event_inquiry: {
    instructions:
      'In `inbound_message`, is the guest asking about booking or hiring the venue itself - renting the space or a room, a private event or buyout, catering, or hosting their own gathering there?',
    criteria: {
      true: 'The guest wants the venue for their own purpose: rent the space, book a room or the loft, a private party or buyout, catering an event, a large private group.',
      false:
        'Asking about or attending the venue\'s own events ("when is the next open mic", "what is on this weekend"), ordinary visits or table-for-two type requests, perks, holds, or anything else.',
    },
  },
  needs_human: {
    instructions:
      'Does `inbound_message` genuinely need a human operator before any real reply can be written - a sensitive or escalated situation, a complex custom request, or something no documented venue fact could answer?',
    criteria: {
      true: 'A thoughtful host would not answer this from general knowledge; it needs the owner.',
      false:
        'An ordinary message an informed host answers directly. Not a fallback for ambiguity.',
    },
  },
}

export interface SituationDetectState {
  inbound_message: string
  recent_conversation?: string
}

export type SituationDetectionOutcome =
  | {
      ok: true
      /** Situations whose P(yes) crossed their threshold. */
      detected: SituationKey[]
      /** Raw P(yes) per situation, unthresholded, for the trace and tuning. */
      probabilities: Record<SituationKey, number>
      version: string
    }
  | { ok: false; error: string; errorCode: string }

const NoulAnswerSchema = z.object({ type: z.literal('noul'), noul: z.number() })
const ResponseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), NoulAnswerSchema),
})

export interface SituationDetectDeps {
  env?: Record<string, string | undefined>
  fetchImpl?: typeof fetch
}

export async function detectSituations(
  state: SituationDetectState,
  deps: SituationDetectDeps = {},
): Promise<SituationDetectionOutcome> {
  const env = deps.env ?? process.env
  const fetchImpl = deps.fetchImpl ?? fetch

  const envCheck = checkTypesafeEnv(env)
  if (!envCheck.ok)
    return {
      ok: false,
      error: envCheck.problems.join('; '),
      errorCode: 'jev_env_missing',
    }

  let response: Response
  try {
    response = await fetchImpl(TYPESAFE_SYSTEMONE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.JEV_API_KEY!.trim()}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(SITUATION_DETECT_TIMEOUT_MS),
      body: JSON.stringify({
        model: JEV_MODEL,
        state,
        questions: Object.fromEntries(
          SITUATION_KEYS.map((key) => [
            key,
            { type: 'noul', ...QUESTIONS[key] },
          ]),
        ),
      }),
    })
  } catch (e) {
    const name = e instanceof Error ? e.name : ''
    return {
      ok: false,
      error: `jev fetch failed: ${e instanceof Error ? e.message : String(e)}`,
      errorCode:
        name === 'TimeoutError' || name === 'AbortError'
          ? 'jev_timeout'
          : 'jev_network',
    }
  }

  if (!response.ok)
    return {
      ok: false,
      error: `jev http ${response.status}`,
      errorCode: `jev_http_${response.status}`,
    }

  let body: unknown
  try {
    body = await response.json()
  } catch (e) {
    return {
      ok: false,
      error: `jev body unreadable: ${e instanceof Error ? e.message : String(e)}`,
      errorCode: 'jev_bad_response',
    }
  }

  const parsed = ResponseSchema.safeParse(body)
  if (!parsed.success)
    return {
      ok: false,
      error: `jev response shape: ${parsed.error.message}`,
      errorCode: 'jev_bad_response',
    }

  const probabilities = {} as Record<SituationKey, number>
  for (const key of SITUATION_KEYS) {
    const answer = parsed.data.answers[key]
    if (answer === undefined)
      return {
        ok: false,
        error: `jev answer missing for situation "${key}"`,
        errorCode: 'jev_bad_response',
      }
    probabilities[key] = answer.noul
  }

  return {
    ok: true,
    detected: SITUATION_KEYS.filter(
      (key) => probabilities[key] >= SITUATION_THRESHOLDS[key],
    ),
    probabilities,
    version: SITUATION_DETECT_VERSION,
  }
}
