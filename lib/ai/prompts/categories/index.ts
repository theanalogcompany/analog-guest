import type { MessageCategory } from '../../types'
import { ACKNOWLEDGMENT_INSTRUCTIONS } from './acknowledgment'
import { EVENT_INVITE_INSTRUCTIONS } from './event-invite'
import { FOLLOW_UP_INSTRUCTIONS } from './follow-up'
import { MANUAL_INSTRUCTIONS } from './manual'
import { NEW_QUESTION_INSTRUCTIONS } from './new-question'
import { OPT_OUT_INSTRUCTIONS } from './opt-out'
import { PERK_UNLOCK_INSTRUCTIONS } from './perk-unlock'
import { REPLY_INSTRUCTIONS } from './reply'
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
    case 'event_invite':
      return EVENT_INVITE_INSTRUCTIONS
    case 'manual':
      return MANUAL_INSTRUCTIONS
    case 'acknowledgment':
      return ACKNOWLEDGMENT_INSTRUCTIONS
  }
}