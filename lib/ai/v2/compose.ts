import { V2_TEMPLATE_CURRENT, type V2TemplateSet } from './template-archive'

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
  /**
   * ', @handle' naming the venue's OWN Instagram account, or '' when no
   * account is connected. The model could not previously tell which account's
   * inbox it was answering in: it knew the handle only as a retrieved fact
   * (knowledge_corpus, gated on the guest asking about social), so it sent a
   * guest who asked for farm photos off to "our Instagram" while that guest
   * was sitting in exactly that inbox.
   *
   * Sourced from `instagram_credentials.instagram_username`, which is the
   * account the venue actually connected by OAuth - not an operator-typed
   * field that could drift from the real inbox.
   */
  instagramClause: string
  /**
   * ' Your replies are usually 12 to 22 words. Over 40 is rare and needs a
   * reason.' for a venue with a measured voice profile, '' for one without.
   * Built by `replyLengthClause` from `brand_persona.voiceProfile`, never
   * written as a literal - see that function for why.
   */
  lengthClause: string
  /**
   * `renderVenueProfile`'s output. IGNORED when `knowledgeBrief` is non-empty
   * - the brief REPLACES this rather than sitting under it (owner-ruled
   * 2026-10-12). Pass it anyway: the trace reports what the renderer produced
   * either way, which is what keeps `unrendered` honest about stored keys no
   * renderer reads.
   */
  venueProfile: string
  voicePack: string
  /**
   * Retrieved knowledge chunks, for a template version whose HOUSE NOTES still
   * carries a `{knowledge}` placeholder.
   *
   * EMPTY ON THE CURRENT TEMPLATE, which stopped retrieving in v2.18.0. It is
   * here for the archived sets (`template-archive.ts`): a fixture that could
   * not be given the lane it was written around would be a version that never
   * shipped, dressed as one that did.
   */
  knowledge?: string
  /**
   * `venue_configs.knowledge_brief`, verbatim, and the SOLE venue content in
   * block 2 when it is set. STATIC PER VENUE, which is the whole reason it may
   * sit in block 2 at all - see V2_PROMPT_VERSION's v2.18.0 note. It replaced
   * four retrieved chunks matched against the inbound; anything that makes
   * this per-turn again poisons the cached prefix in front of it.
   *
   * Empty means this venue has no brief, and then `venueProfile` renders as it
   * always did - byte-identical, which is what keeps every venue but Le Mil's
   * unaffected by v2.18.0.
   */
  knowledgeBrief: string
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
  // Only reachable on an archived set that retrieves. Retrieval returning
  // nothing was normal and failed open, but an empty heading read as "the
  // house knows nothing", which is a claim - so it said what happened instead.
  // Verbatim from v2.17.0; this is a fixture's copy, not new wording.
  knowledge: '(nothing retrieved for this message)',
  // NO knowledgeBrief fallback, deliberately. An empty brief does not render
  // an empty `# What you know` for something to apologise in - it selects
  // `V2_HOUSE_SECTIONS`, which has no such heading at all. A fallback string
  // here would be unreachable, and an unreachable guard reads as a guard.
} as const

/**
 * `templates` defaults to what this build ships, so every production caller is
 * unchanged by the archive existing. Only the playground passes another, and
 * what it passes is the thing that stamps `promptVersion` below.
 */
export function composePrompt(
  input: ComposeInput,
  templates: V2TemplateSet = V2_TEMPLATE_CURRENT,
): ComposedPrompt {
  const frame = fill(templates.frame, {
    venue_name: input.venueName,
    speaker_clause: input.speakerClause,
    instagram_clause: input.instagramClause,
    length_clause: input.lengthClause,
  })
  // Block 2 is assembled rather than filled from one template, because the
  // venue half of it is EITHER the rendered profile OR the authored brief and
  // never both. Concatenating them put the whole menu in the prompt twice, in
  // two voices that disagreed - `menu.highlights` said two pastries are vegan
  // while the brief said five items are, 30k chars apart in one block.
  //
  // A version that predates the brief carries no briefed variant at all, and
  // then the profile renders for every venue - which is what that version did.
  // Not a fallback: there is nothing to fall back FROM.
  const brief = input.knowledgeBrief.trim()
  const houseSections =
    brief === '' || templates.houseSectionsBriefed === undefined
      ? fill(templates.houseSections, {
          venue_profile: input.venueProfile,
          voice_pack: input.voicePack,
        })
      : fill(templates.houseSectionsBriefed, {
          knowledge_brief: brief,
          voice_pack: input.voicePack,
        })
  const guestState = fill(templates.guestState, {
    // Only a set that declares the lane gets the placeholder filled. `fill`
    // throws on a placeholder with no value and ignores a value with no
    // placeholder, so passing this unconditionally would be harmless on the
    // current template and silently wrong the day one is added back.
    ...(templates.usesRetrieval
      ? {
          knowledge:
            (input.knowledge ?? '').trim() || EMPTY_SECTION_FALLBACKS.knowledge,
        }
      : {}),
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
    // From the SET, never the build constant. A turn composed on an archived
    // template that stamped today's version would be the exact mislabelling
    // the archive exists to make visible.
    promptVersion: templates.version,
  }
}
