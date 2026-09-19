// Category instructions govern REGISTER: how to sound, how long, how literal,
// what shape the reply takes for THIS kind of turn. They carry no FORM
// authority (TAC-314 — length/structure/hedging belong to SYSTEM_TEMPLATE's
// universal layer) and no PURSUIT authority (TAC-327 — what goals are open,
// and the restraint around raising them, belongs to the first-touch
// intentions block in lib/agent/intentions/). A line here that says what to
// pursue or not pursue is a leak, not a register rule — see CLAUDE.md
// "Category instruction layer carries NO pursuit authority (TAC-327)".
import type { MessageChannel } from '@/lib/schemas/message-channel'
import type { MessageCategory } from '../../types'
import { applyChannelSubstitutions, type ChannelSubstitution, copyVariantFor } from '../channel-variants'
import { ACKNOWLEDGMENT_INSTRUCTIONS } from './acknowledgment'
import { CASUAL_CHATTER_INSTRUCTIONS } from './casual-chatter'
import { COMP_COMPLAINT_INSTRUCTIONS } from './comp-complaint'
import { EVENT_INVITE_INSTRUCTIONS } from './event-invite'
import { EVENT_QUESTION_INSTRUCTIONS } from './event-question'
import { FOLLOW_UP_INSTRUCTIONS } from './follow-up'
import { MANUAL_INSTRUCTIONS } from './manual'
import { MECHANIC_REQUEST_INSTRUCTIONS } from './mechanic-request'
import { NEW_QUESTION_INSTRUCTIONS } from './new-question'
import { OPT_OUT_INSTRUCTIONS } from './opt-out'
import { PERK_INQUIRY_INSTRUCTIONS } from './perk-inquiry'
import { PERK_UNLOCK_INSTRUCTIONS } from './perk-unlock'
import { PERSONAL_HISTORY_QUESTION_INSTRUCTIONS } from './personal-history-question'
import { RECOMMENDATION_REQUEST_INSTRUCTIONS } from './recommendation-request'
import { REPLY_INSTRUCTIONS } from './reply'
import { UNKNOWN_INSTRUCTIONS } from './unknown'
import { WELCOME_INSTRUCTIONS } from './welcome'

export function getCategoryInstructions(category: MessageCategory): string {
  switch (category) {
    case 'welcome':
      return WELCOME_INSTRUCTIONS
    case 'follow_up':
      return FOLLOW_UP_INSTRUCTIONS
    case 'reply':
      return REPLY_INSTRUCTIONS
    case 'new_question':
      return NEW_QUESTION_INSTRUCTIONS
    case 'opt_out':
      return OPT_OUT_INSTRUCTIONS
    case 'perk_unlock':
      return PERK_UNLOCK_INSTRUCTIONS
    case 'perk_inquiry':
      return PERK_INQUIRY_INSTRUCTIONS
    case 'event_invite':
      return EVENT_INVITE_INSTRUCTIONS
    case 'event_question':
      return EVENT_QUESTION_INSTRUCTIONS
    case 'manual':
      return MANUAL_INSTRUCTIONS
    case 'acknowledgment':
      return ACKNOWLEDGMENT_INSTRUCTIONS
    case 'comp_complaint':
      return COMP_COMPLAINT_INSTRUCTIONS
    case 'mechanic_request':
      return MECHANIC_REQUEST_INSTRUCTIONS
    case 'recommendation_request':
      return RECOMMENDATION_REQUEST_INSTRUCTIONS
    case 'casual_chatter':
      return CASUAL_CHATTER_INSTRUCTIONS
    case 'personal_history_question':
      return PERSONAL_HISTORY_QUESTION_INSTRUCTIONS
    case 'unknown':
      return UNKNOWN_INSTRUCTIONS
  }
}

// TAC-495: channel variants of the category instructions, made the same way as
// the system template's (../channel-variants.ts). getCategoryInstructions above
// stays the SMS copy and takes no substitutions. Instagram swaps one phrase in
// `unknown` ("texting back" is a claim about the channel), approved on
// 2026-09-19; every other category is identical on both channels. Each swap
// must match exactly once or this module throws at load. Adding a row here is
// adding channel-specific copy, and the scope guard in index.test.ts fails
// until it is updated on purpose.
const CATEGORY_CHANNEL_SUBSTITUTIONS = {
  text: {},
  instagram: {
    unknown: [{ from: 'a real busy person texting back', to: 'a real busy person messaging back' }],
  },
} as const satisfies Record<MessageChannel, Partial<Record<MessageCategory, readonly ChannelSubstitution[]>>>

const CATEGORY_INSTRUCTIONS_BY_CHANNEL: Record<MessageChannel, Partial<Record<MessageCategory, string>>> = {
  text: {},
  instagram: Object.fromEntries(
    Object.entries(CATEGORY_CHANNEL_SUBSTITUTIONS.instagram).map(([category, substitutions]) => [
      category,
      applyChannelSubstitutions(
        getCategoryInstructions(category as MessageCategory),
        substitutions,
        `CATEGORY/${category}/instagram`,
      ),
    ]),
  ),
}

/**
 * The category instructions for a conversation's channel; null gets the
 * Instagram copy (copyVariantFor). composePrompt is the only caller.
 */
export function categoryInstructionsFor(category: MessageCategory, channel: MessageChannel | null): string {
  return CATEGORY_INSTRUCTIONS_BY_CHANNEL[copyVariantFor(channel)][category] ?? getCategoryInstructions(category)
}
