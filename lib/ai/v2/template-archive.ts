import {
  V2_FRAME,
  V2_GUEST_STATE,
  V2_HOUSE_SECTIONS,
  V2_HOUSE_SECTIONS_BRIEFED,
  V2_PROMPT_VERSION,
} from './template'

// Past prompt versions, frozen, so one turn can be run on two templates and
// the replies read side by side.
//
// WHAT AN ARCHIVED SET IS: a FIXTURE, not the live template. It is a verbatim
// copy of the strings `lib/ai/v2/template.ts` exported at a named commit, and
// it will never change again. Every other input - the venue's data, its voice
// pack, the graph, the model - is TODAY'S. So a reply from an archived set
// says "what this wording does now", never "what the agent did then", and no
// number taken from one belongs in the changelog as if it were contemporaneous.
//
// WHY A SET AND NOT JUST THE STRINGS. A version is not three strings, it is
// three strings plus which lanes the turn runs. v2.17.0's HOUSE NOTES carries
// a {knowledge} placeholder and v2.18.0's does not, because v2.18.0 stopped
// retrieving. A fixture copying only the strings would fill that placeholder
// with nothing and quietly test a v2.17.0 that had no knowledge in it at all -
// a fourth version that never existed. `usesRetrieval` is what makes the
// runner restore the lane.
//
// TWO VERSIONS DEEP, owner-ruled 2026-10-12: current, and the one before the
// knowledge brief. Deeper is cheap to add and was declined - most changelog
// entries will never be run, and a long list of fixtures nobody uses reads as
// coverage.
//
// EXTRACTED BY SCRIPT FROM GIT, never retyped. Check any line of it with:
//   git show 53b52347bc:lib/ai/v2/template.ts

export interface V2TemplateSet {
  /** What `V2_PROMPT_VERSION` held, which is what stamps the trace. */
  version: string
  frame: string
  /** Block 2 for a venue with no knowledge brief. */
  houseSections: string
  /**
   * Block 2 for a venue that HAS one. Undefined on a version predating the
   * brief, and the composer then renders `houseSections` for every venue -
   * which is exactly what that version did.
   */
  houseSectionsBriefed?: string
  guestState: string
  /**
   * True when `guestState` carries a `{knowledge}` placeholder, so the turn
   * runner has to retrieve for it.
   *
   * NOT derived by searching the string for the placeholder, though it could
   * be. This is a claim about what the RUNNER must do, and deriving it would
   * let a wording change silently switch a retrieval call on or off.
   */
  usesRetrieval: boolean
}

/** The template this build ships. Always the default. */
export const V2_TEMPLATE_CURRENT: V2TemplateSet = {
  version: V2_PROMPT_VERSION,
  frame: V2_FRAME,
  houseSections: V2_HOUSE_SECTIONS,
  houseSectionsBriefed: V2_HOUSE_SECTIONS_BRIEFED,
  guestState: V2_GUEST_STATE,
  usesRetrieval: false,
}

/**
 * v2.17.0-draft at 53b52347bc - the last version before the authored knowledge
 * brief replaced the retrieval lane.
 *
 * No `houseSectionsBriefed`: block 2 was the rendered venue profile plus the
 * voice pack for every venue, and the brief column did not exist yet.
 */
const V2_TEMPLATE_V2_17_0: V2TemplateSet = {
  version: 'v2.17.0-draft',
  frame: `# Who you are
You are the virtual maitre d' of {venue_name}, not a service desk, and this is your Instagram inbox{instagram_clause}.

You are a real presence of the house: its memory, its taste, its hospitality. You speak as the venue{speaker_clause}.

# Texting style
You write the way a person messages - short, warm, specific, never corporate. No emoji, ever.{length_clause} Never the phrase "full stop". Punctuation is commas, periods, question marks, and line breaks only. No colons, semicolons, em dashes, parentheses, or bullet points. Where an em or en dash would land, end the sentence and start a new one. Write numbers as digits, so 25 and not twenty-five. You have opinions about the menu and you share them plainly. You are never salesy and never servile. Mimic how you sound section to tune your voice.

# Extra Notes
Guests sometimes share a name with an AI assistant ("Claude", "Alexa"). It is still simply their name - never a reference to you.

# Intention
You have genuine interest in the guests, their needs and want to help them achieve their intentions and make them feel recognized and remembered.

# Rules

- Never state or imply anything about this guest - visits, orders, preferences, history - that HOUSE NOTES or the conversation does not confirm. If you do not know, you do not know.
- You never run a loyalty program. No points, rewards, tiers, earning, or counting visits toward anything.
- Anything you give or promise - something free, a discount, holding or reserving anything, cancelling or changing an arrangement - exists only if you declare it in \\\`actions\\\`. Never commit to any of it in prose alone.
- Only share links that appear in your knowledge. Never invent or adjust one.
- One question per reply at most. You are never conducting an interview - if they deflected something once, let it rest.`,
  houseSections: `# Information about the business you are presenting.

{venue_profile}

# How you sound

{voice_pack}`,
  guestState: `HOUSE NOTES (yours alone - the guest never sees this)

## What you know
{knowledge}

## Where this relationship stands
{state_line}
Your aim right now: {mission}

## This guest
{guest_profile}

## What you have asked and offered before
{interaction_memory}

## What you're trying to learn at this stage
These are open in parallel - pick whichever fits this moment best; your one question is for these, unless the guest shows trouble or hurry. If one was raised before and went nowhere, let it rest.
{open_moves}`,
  usesRetrieval: true,
}

/**
 * Keyed by the version string, so a stored override, a trace and this registry
 * all name a version the same way - there is no second id to drift from it.
 */
export const V2_TEMPLATE_SETS: Record<string, V2TemplateSet> = {
  [V2_TEMPLATE_CURRENT.version]: V2_TEMPLATE_CURRENT,
  [V2_TEMPLATE_V2_17_0.version]: V2_TEMPLATE_V2_17_0,
}

export const V2_TEMPLATE_VERSIONS: string[] = Object.keys(V2_TEMPLATE_SETS)

/**
 * FAILS OPEN to the current template on an unknown version, loudly.
 *
 * Same direction and same reason as `resolveV2ModelProfile`: a stale version
 * string in a saved playground conversation must not take the turn down. The
 * cost of failing open is a silent wrong template, so the resolved version is
 * what stamps the trace - that is the thing which disagrees if the pick did
 * not take, rather than a comment claiming it did.
 */
export function resolveV2TemplateSet(
  version: string | undefined,
): V2TemplateSet {
  if (version === undefined) return V2_TEMPLATE_CURRENT
  const set = V2_TEMPLATE_SETS[version]
  if (set === undefined) {
    console.warn(
      `v2 template version "${version}" is not archived (${V2_TEMPLATE_VERSIONS.join(', ')}); using ${V2_TEMPLATE_CURRENT.version}`,
    )
    return V2_TEMPLATE_CURRENT
  }
  return set
}
