import {
  V2_FRAME,
  V2_PROMPT_VERSION,
  V2_SITUATION_BRIEF,
  V2_VENUE_SECTIONS,
} from './template'

// The v2 composer: sections in VOLATILITY-TIER order, because cache is
// prefix-based and anything per-turn must sit after everything stable
// (lib/relationship/CLAUDE.md, "volatility tiers decide placement"):
//
//   tier 0  frame + hard lines        system block, cache breakpoint
//   tier 1  venue profile/voice/knowledge  system block, cache breakpoint
//   tier 2  conversation history      real alternating chat turns
//   tier 3  situation brief           ONE injected user turn, second-to-last
//   -       the guest's message(s)    the real final user turns, verbatim
//
// NEVER move a tier-3 section earlier: guest data in a system block
// invalidates the cached history on every turn. Never wrap the guest's own
// words in anything.
//
// Pure assembly - no DB, no model call. The turn runner (phase 3) loads
// section inputs and owns the generate call; the playground renders exactly
// what this returns, block by block.

export interface ComposedSystemBlock {
  text: string
  /** Marks the end of a stable prefix; the generate call sets cache_control here. */
  cacheBreakpoint: boolean
}

export interface HistoryTurn {
  role: 'user' | 'assistant'
  text: string
}

export interface ComposeInput {
  venueName: string
  /** '' for venue-voice framing; ', in {name}\'s voice' etc. once speaker framing lands. */
  speakerClause: string
  venueProfile: string
  voicePack: string
  knowledge: string
  /** Oldest first; must alternate (merge same-role runs before calling). */
  history: HistoryTurn[]
  stateLabel: string
  stateKey: string
  mission: string
  guestProfile: string
  interactionMemory: string
  /** Rendered move goals, one per line; empty string when none are open. */
  openMoves: string
  /** The guest's message(s) this turn, oldest first, verbatim. */
  inboundMessages: string[]
}

export interface ComposedPrompt {
  system: ComposedSystemBlock[]
  /** history, then the situation brief, then the inbound - ready for the SDK call. */
  turns: HistoryTurn[]
  promptCharCount: number
  /** Stamped so traces and eval_judgments key to the template that produced them. */
  promptVersion: string
}

function fill(template: string, values: Record<string, string>): string {
  const out = template.replace(/\{([a-z_]+)\}/g, (_, key: string) => {
    const value = values[key]
    if (value === undefined)
      throw new Error(`compose: no value for placeholder {${key}}`)
    return value
  })
  return out
}

const EMPTY_SECTION_FALLBACKS = {
  guestProfile: 'Nothing on file yet - this guest is new to you.',
  interactionMemory: 'You have not asked or offered anything yet.',
  openMoves: '(nothing right now - just be present)',
} as const

export function composePrompt(input: ComposeInput): ComposedPrompt {
  const frame = fill(V2_FRAME, {
    venue_name: input.venueName,
    speaker_clause: input.speakerClause,
  })
  const venueSections = fill(V2_VENUE_SECTIONS, {
    venue_profile: input.venueProfile,
    voice_pack: input.voicePack,
    knowledge: input.knowledge,
  })
  const brief = fill(V2_SITUATION_BRIEF, {
    state_line: `${input.stateLabel} (${input.stateKey})`,
    mission: input.mission,
    guest_profile:
      input.guestProfile.trim() || EMPTY_SECTION_FALLBACKS.guestProfile,
    interaction_memory:
      input.interactionMemory.trim() ||
      EMPTY_SECTION_FALLBACKS.interactionMemory,
    open_moves: input.openMoves.trim() || EMPTY_SECTION_FALLBACKS.openMoves,
  })

  const turns: HistoryTurn[] = [
    ...input.history,
    { role: 'user', text: brief },
    ...input.inboundMessages.map((text): HistoryTurn => ({
      role: 'user',
      text,
    })),
  ]

  const system: ComposedSystemBlock[] = [
    { text: frame, cacheBreakpoint: true },
    { text: venueSections, cacheBreakpoint: true },
  ]

  return {
    system,
    turns,
    promptCharCount:
      system.reduce((n, b) => n + b.text.length, 0) +
      turns.reduce((n, t) => n + t.text.length, 0),
    promptVersion: V2_PROMPT_VERSION,
  }
}
