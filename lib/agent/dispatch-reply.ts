// TAC-469: the one place an agent reply picks its transport.
//
// One exhaustive switch on the conversation's channel. Branch by channel,
// don't converge: the text arm is scheduleAndSend exactly as it was, throws
// included, and knows nothing of Instagram; the Instagram arm is
// dispatchInstagramReply, which owns the window, the byte cap and the reply
// check. A channel added later (TikTok is plausible) is one more case here, and
// `tsc` refuses to compile until it has one.
//
// Nothing routes on an unknown channel. Null means "we can't tell which
// conversation this is", never Instagram, and sending anyway would put the
// reply on a channel chosen by accident. handle-inbound stops a null-channel
// run before generating, so reaching this with null is a caller bug; it is
// still refused here rather than trusted away.
//
// Only replies to something the guest did come through here (an inbound reply,
// the crisis-safety reply, the knowledge-gap holding message). Scheduled
// follow-ups call scheduleAndSend directly, and handleFollowup refuses an
// Instagram conversation before it gets that far (TAC-469 rule 2).

import type { GenerateMessageResult } from '@/lib/ai'
import { fireRedAlert } from './alerts'
import {
  dispatchInstagramReply,
  type InstagramReplyOptions,
  type InstagramReplyOutcome,
} from './dispatch-instagram-reply'
import { scheduleAndSend } from './schedule-and-send'
import type { RuntimeContext } from './types'

export type DispatchReplyOptions = InstagramReplyOptions

/**
 * The Instagram arm's outcomes. The text arm only ever produces `sent` (with
 * nothing undelivered) or throws, exactly as scheduleAndSend always has.
 */
export type DispatchReplyOutcome = InstagramReplyOutcome

export async function dispatchReply(
  ctx: RuntimeContext,
  generation: GenerateMessageResult,
  options: DispatchReplyOptions,
): Promise<DispatchReplyOutcome> {
  const channel = ctx.conversationChannel
  switch (channel) {
    case 'text': {
      const sent = await scheduleAndSend(ctx, generation, {
        skipHumanFeelDelay: options.skipHumanFeelDelay,
        reviewReason: options.reviewReason,
        rng: options.rng,
        renderedIntentions: options.renderedIntentions,
      })
      // The text arm sends the whole reply or throws, so what was delivered is
      // the generated body, verbatim: recording on this path is byte-for-byte
      // what it was before TAC-469.
      return { kind: 'sent', ...sent, deliveredBody: generation.body, undelivered: null }
    }
    case 'instagram':
      return dispatchInstagramReply(ctx, generation, options)
    case null:
      await fireRedAlert({
        agentRunId: ctx.agentRunId,
        venueId: ctx.venue.id,
        guestId: ctx.guest.id,
        kind: ctx.followupTrigger ? 'followup' : 'inbound',
        stage: 'send',
        errorMessage: 'conversation channel unresolved; refusing to route a send on it',
      })
      return { kind: 'not_sent', reason: 'channel_unresolved' }
    default: {
      const unreachable: never = channel
      throw new Error(`dispatchReply: unhandled channel ${String(unreachable)}`)
    }
  }
}
