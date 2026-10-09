import {
  V2_FRAME,
  V2_GUEST_STATE,
  V2_HOUSE_SECTIONS,
  V2_PROMPT_VERSION,
} from './template'

// The v2 composer: strictly VOLATILITY-ASCENDING, because the cache is
// prefix-keyed and ONE volatile section poisons everything in front of it
// (lib/relationship/CLAUDE.md):
//
//   system 1  ROLE         static, every venue
//   system 2  THE HOUSE    per venue, owner edits only   <- BREAKPOINT
//   system 3  HOUSE NOTES  retrieval + guest state, per turn
//   turns     the transcript, then the guest's message(s), verbatim
//
// ONE BREAKPOINT, after system 2. Block 1 carries none: at ~590 tokens it is
// under Anthropic's 1024-token minimum cacheable prefix, so it could never
// have produced an entry, and it held one for months anyway. Block 3 changes
// every turn, so a breakpoint after it would write entries nothing reads.
//
// NOTHING PER-TURN MAY MOVE INTO SYSTEM 1 OR 2. That is not tidiness:
// `# What you know` lived at the end of block 2 until 2026-10-08 and cost the
// whole ~6,000-token prefix on every turn, while every comment here called
// the block stable. If a section's content depends on the inbound, the guest
// or the clock, it belongs in block 3.
//
// THE TRANSCRIPT IS NOT CACHED, and that is the price of block 3's position
// (owner-ruled 2026-10-09). System blocks always precede messages, so a
// volatile system block sits in front of the transcript and no breakpoint
// after the transcript can ever hit. Briefly - 2026-10-09 - HOUSE NOTES was a
// user turn BEHIND the transcript and the transcript carried its own
// breakpoint, measured reading 6,016 on turn 3. Worth p50 241 tokens and max
// 555 at Le Mil's against a ~6,000-token prefix, which is what was traded
// away. Moving HOUSE NOTES back behind the transcript is what reopens it.
//
// Never wrap the guest's own words in anything.
//
// Pure assembly - no DB, no model call. The turn runner (phase 3) loads
// section inputs and owns the generate call; the playground renders exactly
// what this returns, block by block.

export interface ComposedSystemBlock {
  text: string
  /** Marks the end of a stable prefix; the generate call sets cache_control here. */
  cacheBreakpoint: boolean
  /** What this block is, for the playground inspector's label. */
  label: string
}

export interface HistoryTurn {
  role: 'user' | 'assistant'
  text: string
}

/**
 * A turn as composed. `cacheBreakpoint` rides the LAST transcript turn so the
 * growing conversation caches incrementally; the generate call translates it
 * into the same `cache_control` it puts on a system block.
 */
export interface ComposedTurn extends HistoryTurn {
  cacheBreakpoint?: boolean
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
  /** The transcript then the inbound - ready for the SDK call. */
  turns: ComposedTurn[]
  /**
   * The rendered HOUSE NOTES, returned BY NAME because the judge is handed it
   * as `situationBrief`. Two callers used to recover it with
   * `turns[history.length]`, which returns the GUEST'S OWN MESSAGE the moment
   * anything is inserted ahead of it - silently, with no type error and no
   * empty string to notice. The one-day experiment that moved this into a
   * system block did exactly that, which is how the hazard was found.
   */
  guestState: string
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
  // Retrieval returning nothing is normal and fails open (run-turn.ts), but an
  // empty heading reads as "the house knows nothing", which is a claim. Say
  // what actually happened instead.
  knowledge: '(nothing retrieved for this message)',
} as const

export function composePrompt(input: ComposeInput): ComposedPrompt {
  const frame = fill(V2_FRAME, {
    venue_name: input.venueName,
    speaker_clause: input.speakerClause,
  })
  const houseSections = fill(V2_HOUSE_SECTIONS, {
    venue_profile: input.venueProfile,
    voice_pack: input.voicePack,
  })
  const guestState = fill(V2_GUEST_STATE, {
    knowledge: input.knowledge.trim() || EMPTY_SECTION_FALLBACKS.knowledge,
    state_line: `${input.stateLabel} (${input.stateKey})`,
    mission: input.mission,
    guest_profile:
      input.guestProfile.trim() || EMPTY_SECTION_FALLBACKS.guestProfile,
    interaction_memory:
      input.interactionMemory.trim() ||
      EMPTY_SECTION_FALLBACKS.interactionMemory,
    open_moves: input.openMoves.trim() || EMPTY_SECTION_FALLBACKS.openMoves,
  })

  // No breakpoint on any turn: HOUSE NOTES is a system block and therefore
  // sits in front of all of them, so nothing here is ever a stable prefix.
  // `ComposedTurn.cacheBreakpoint` stays in the type because the layout that
  // uses it is one move away (see the header), and generate.ts still honours
  // it - an unset flag is not a dead one.
  const turns: ComposedTurn[] = [
    ...input.history,
    ...input.inboundMessages.map((text): ComposedTurn => ({
      role: 'user',
      text,
    })),
  ]

  const system: ComposedSystemBlock[] = [
    { label: 'ROLE', text: frame, cacheBreakpoint: false },
    { label: 'THE HOUSE', text: houseSections, cacheBreakpoint: true },
    { label: 'HOUSE NOTES', text: guestState, cacheBreakpoint: false },
  ]

  return {
    system,
    turns,
    guestState,
    promptCharCount:
      system.reduce((n, b) => n + b.text.length, 0) +
      turns.reduce((n, t) => n + t.text.length, 0),
    promptVersion: V2_PROMPT_VERSION,
  }
}
