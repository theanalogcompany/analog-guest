// TAC-540: the one place a typing indicator picks its transport.
//
// dispatch-reply.ts's shape, deliberately, because it is the same problem one
// layer down: one exhaustive switch on the conversation's channel, the text
// arm knowing nothing of Instagram and the Instagram arm owning Meta's API. A
// channel added later is one more case here and `tsc` refuses to compile until
// it has one.
//
// IT EXISTS SO handle-inbound.ts NEVER IMPORTS AN INSTAGRAM MODULE. The inbound
// orchestrator serves both channels, and window-import-guard.test.ts keeps
// Instagram's outbound modules off the shared and SMS paths. Without this
// seam, honouring the ticket would have meant adding handle-inbound.ts itself
// to that allow-list — which is exactly the coupling the guard exists to
// prevent. One file is on the list instead, and it is a switch that routes
// nothing else.
//
// THE TEXT ARM IS A NO-OP, NOT A SENDBLUE CALL. Sendblue's own typing
// indicator already fires from inside scheduleAndSend, at send time, and this
// ticket does not touch it. Wiring it here as well would send a text guest two
// typing beats per reply and put a provider call on a path that never had one.
//
// NULL IS ALSO A NO-OP. handle-inbound stops a null-channel run before
// classifying, so reaching here with null is a caller bug; it is refused
// rather than trusted away, and it is refused SILENTLY because a red alert has
// already been fired by the time any send would route. An indicator is not
// worth a second alert.
//
// FAILS OPEN, ALWAYS. Nothing on the reply path reads the result. Every
// outcome is a value, and the whole call is wrapped even though
// sendInstagramSenderAction is value-returning today, because that guarantee
// lives in another file and this runs where an escaping rejection would be an
// unhandled one.

import { createAdminClient } from '@/lib/db/admin'
import { captureInstagramSenderActionFailed } from '@/lib/analytics/posthog'
import {
  sendInstagramSenderAction,
  type InstagramSenderAction,
  type InstagramSenderActionResult,
} from '@/lib/messaging/instagram/sender-actions'
import {
  loadInstagramSendTarget,
  type InstagramSendTargetResult,
} from '@/lib/messaging/instagram/send-target'
import type { MessageChannel } from '@/lib/schemas/message-channel'

/** Dots on, or dots off. */
export type TypingSignal = 'on' | 'off'

export type TypingIndicatorOutcome =
  /** Sent, as far as Meta told us. */
  | { status: 'sent' }
  /** This channel has no indicator of its own to send here. */
  | { status: 'not_applicable'; channel: MessageChannel | null }
  | { status: 'no_send_target'; problem: string }
  | { status: 'send_failed'; kind: string }

export interface TypingIndicatorTarget {
  venueId: string
  guestId: string
  channel: MessageChannel | null
}

/**
 * Injected so a test asserts on the calls this makes rather than on a mock's
 * opinion of them — `dispatch-instagram-reply.ts`'s shape. In particular
 * `loadTarget` records WHICH venue and guest were asked about, which is the
 * thing a stub that ignored its arguments would let a call site get wrong.
 */
export interface TypingIndicatorDeps {
  loadTarget: (input: {
    venueId: string
    guestId: string
  }) => Promise<InstagramSendTargetResult>
  sendAction: (input: {
    accountId: string
    recipientId: string
    token: string
    action: InstagramSenderAction
  }) => Promise<InstagramSenderActionResult>
}

function defaultDeps(): TypingIndicatorDeps {
  return {
    loadTarget: (input) => loadInstagramSendTarget(createAdminClient(), input),
    sendAction: (input) =>
      sendInstagramSenderAction({ ...input, fetchImpl: fetch }),
  }
}

/**
 * Show or hide the typing indicator for this conversation.
 *
 * Never throws. Returns a value on every path so a caller can log one, and no
 * caller may branch a reply on it.
 */
export async function signalTyping(
  target: TypingIndicatorTarget,
  signal: TypingSignal,
  injected: Partial<TypingIndicatorDeps> = {},
): Promise<TypingIndicatorOutcome> {
  const channel = target.channel
  switch (channel) {
    case 'text':
      // Sendblue's typing already fires inside scheduleAndSend. See the header.
      return { status: 'not_applicable', channel }
    case null:
      return { status: 'not_applicable', channel }
    case 'instagram':
      return sendInstagramTyping(target, signal, {
        ...defaultDeps(),
        ...injected,
      })
    default: {
      const unreachable: never = channel
      throw new Error(`signalTyping: unhandled channel ${String(unreachable)}`)
    }
  }
}

async function sendInstagramTyping(
  target: TypingIndicatorTarget,
  signal: TypingSignal,
  deps: TypingIndicatorDeps,
): Promise<TypingIndicatorOutcome> {
  const action: InstagramSenderAction =
    signal === 'on' ? 'typing_on' : 'typing_off'
  try {
    const targetResult = await deps.loadTarget({
      venueId: target.venueId,
      guestId: target.guestId,
    })
    if (!targetResult.ok) {
      console.warn('[agent] no send target, not signalling typing', {
        event: 'instagram_typing_skipped',
        action,
        reason: targetResult.problem,
        venueId: target.venueId,
        guestId: target.guestId,
      })
      return { status: 'no_send_target', problem: targetResult.problem }
    }
    const sent = await deps.sendAction({
      accountId: targetResult.target.accountId,
      recipientId: targetResult.target.recipientId,
      token: targetResult.target.token,
      action,
    })
    if (!sent.ok) {
      console.warn('[agent] typing indicator failed (cosmetic)', {
        event: 'instagram_sender_action_failed',
        action,
        kind: sent.kind,
        venueId: target.venueId,
        guestId: target.guestId,
      })
      await captureInstagramSenderActionFailed({
        venueId: target.venueId,
        guestId: target.guestId,
        action,
        kind: sent.kind,
      })
      return { status: 'send_failed', kind: sent.kind }
    }
    return { status: 'sent' }
  } catch (e) {
    console.error('[agent] signalTyping threw unexpectedly', {
      event: 'instagram_typing_threw',
      action,
      venueId: target.venueId,
      guestId: target.guestId,
      error: e instanceof Error ? e.message : String(e),
    })
    return { status: 'send_failed', kind: 'unexpected_throw' }
  }
}
