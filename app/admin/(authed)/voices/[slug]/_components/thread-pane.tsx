'use client'

import { guestNameWithPhone } from '../../../_lib/guest-name'
import type {
  VoicePageData,
  VoicePageMessage,
} from '../_lib/load-voice-page'

// Thread pane — full conversation in iMessage bubbles. Click an outbound
// to "flag" it (clay halo); the playground below picks up the flagged
// pair via voices-client's selectedMessageId state.
//
// Palette intentionally matches the conversations viewer: real iMessage
// blue (#007AFF) + gray (#E5E5EA). Brand discipline yields to fitness-
// for-purpose on this internal surface — same logic as conversations.

interface ThreadPaneProps {
  messages: VoicePageMessage[]
  selectedGuest: VoicePageData['selectedGuest']
  selectedMessageId: string | null
  onSelectMessage: (id: string) => void
}

export function ThreadPane({
  messages,
  selectedGuest,
  selectedMessageId,
  onSelectMessage,
}: ThreadPaneProps) {
  if (!selectedGuest) {
    return (
      <div className="flex items-center justify-center px-8 text-sm text-ink-soft border-b border-stone-light/60">
        Pick a guest from the threads list to see the conversation.
      </div>
    )
  }

  if (messages.length === 0) {
    return (
      <div className="flex items-center justify-center px-8 text-sm text-ink-soft border-b border-stone-light/60">
        No messages with this guest yet.
      </div>
    )
  }

  return (
    <div className="overflow-y-auto px-8 py-5 border-b border-stone-light/60 flex flex-col gap-1.5">
      <div className="text-center text-[10px] text-ink-faint font-semibold uppercase tracking-eyebrow pb-3">
        {guestNameWithPhone(selectedGuest)}
      </div>
      {messages.map((m) => {
        const isOut = m.direction === 'outbound'
        const isSelected = isOut && m.id === selectedMessageId
        return (
          <div
            key={m.id}
            className={`flex ${isOut ? 'justify-end' : 'justify-start'}`}
          >
            <button
              type="button"
              onClick={isOut ? () => onSelectMessage(m.id) : undefined}
              disabled={!isOut}
              className={`max-w-[78%] px-3.5 py-2 text-[13px] leading-snug rounded-[18px] transition-shadow ${
                isOut
                  ? 'bg-[#007AFF] text-white rounded-br-[4px] cursor-pointer'
                  : 'bg-[#E5E5EA] text-ink rounded-bl-[4px] cursor-default'
              } ${isSelected ? 'shadow-[0_0_0_2px_var(--clay)]' : isOut ? 'hover:shadow-[0_0_0_2px_var(--clay-soft)]' : ''}`}
            >
              {m.body}
            </button>
          </div>
        )
      })}
    </div>
  )
}
