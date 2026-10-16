import { HAND_EDITED_SUFFIX } from './prompt-text'
import {
  V2_FOLLOWUP_CUE,
  V2_FOLLOWUP_NOTE,
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
  /**
   * The outreach lane (v2.21.0): the section filling `{followup_note}` and
   * the fixed synthetic final user turn. PRESENCE IS THE CLAIM, the
   * `houseSectionsBriefed` pattern: a version predating the lane has no entry,
   * and the runner REFUSES an outreach turn on it rather than composing a
   * version that never shipped. The strings ride the set, not the build
   * constants, so an archived outreach turn runs on its own version's copy.
   */
  outreach?: { note: string; cue: string }
}

/** The template this build ships. Always the default. */
export const V2_TEMPLATE_CURRENT: V2TemplateSet = {
  version: V2_PROMPT_VERSION,
  frame: V2_FRAME,
  houseSections: V2_HOUSE_SECTIONS,
  houseSectionsBriefed: V2_HOUSE_SECTIONS_BRIEFED,
  guestState: V2_GUEST_STATE,
  usesRetrieval: false,
  outreach: { note: V2_FOLLOWUP_NOTE, cue: V2_FOLLOWUP_CUE },
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
- Anything you give or promise - something free, a discount, holding or reserving anything, cancelling or changing an arrangement - exists only if you declare it in \`actions\`. Never commit to any of it in prose alone.
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
 * The four constants as they stood for BOTH v2.18.0 and v2.19.0.
 *
 * Not a shortcut: v2.19.0's own changelog entry states that not one character
 * of the four constants changed in that bump - it is a version because the
 * MODEL was handed something new, the guest's media as extra turns. So one
 * copy of the strings answers both version keys, and
 * `npm run verify-template-archive` proves it by comparing this against
 * `template.ts` at 6effcdc AND at 559529a rather than taking the entry's word
 * for it.
 */
const PRE_V2_20_FRAME = `# Who you are
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
- Never invent claims about other guests, such as how people react, what's popular, what regulars order, or what sells out. Only say these when venue knowledge states them. Your own taste is fine ("I'd get it iced"). A made-up observation about other people is not.
- You never run a loyalty program. No points, rewards, tiers, earning, or counting visits toward anything.
- Anything you give or promise - something free, a discount, holding or reserving anything, cancelling or changing an arrangement - exists only if you declare it in \`actions\`. Never commit to any of it in prose alone.
- Only share links that appear in your knowledge. Never invent or adjust one.
- One question per reply at most. You are never conducting an interview - if they deflected something once, let it rest.`

const PRE_V2_20_HOUSE_SECTIONS = `# Information about the business you are presenting.

{venue_profile}

# How you sound

{voice_pack}`

const PRE_V2_20_HOUSE_SECTIONS_BRIEFED = `# What you know

{knowledge_brief}

# How you sound

{voice_pack}`

const PRE_V2_20_GUEST_STATE = `HOUSE NOTES (yours alone - the guest never sees this)

## Where this relationship stands
{state_line}
Your aim right now: {mission}

## This guest
{guest_profile}

## What you have asked and offered before
{interaction_memory}

## What you're trying to learn at this stage
These are open in parallel - pick whichever fits this moment best; your one question is for these, unless the guest shows trouble or hurry. If one was raised before and went nowhere, let it rest.
{open_moves}`

/**
 * v2.18.0-draft at 6effcdc - the last version before the guest's media lane,
 * and the one every measured lesson in the changelog was measured on.
 */
const V2_TEMPLATE_V2_18_0: V2TemplateSet = {
  version: 'v2.18.0-draft',
  frame: PRE_V2_20_FRAME,
  houseSections: PRE_V2_20_HOUSE_SECTIONS,
  houseSectionsBriefed: PRE_V2_20_HOUSE_SECTIONS_BRIEFED,
  guestState: PRE_V2_20_GUEST_STATE,
  usesRetrieval: false,
}

/**
 * v2.19.0-draft at 559529a - the version v2.20.0 replaces, and THE BASELINE
 * rather than just a predecessor: the human-eval pass and the regression
 * `--compare` both read v2.20.0 against this, so a reply from it is the only
 * answer to "did the rewrite cost anything".
 *
 * Same strings as v2.18.0 and its OWN version object anyway, because the
 * version is what stamps a trace (`composePrompt` reads `templates.version`).
 * One shared object would label a v2.19.0 run v2.18.0, which is the exact
 * mislabelling this archive exists to make visible.
 *
 * Its block 2 still carries `# How you sound`, which v2.20.0 cut, and its
 * HOUSE NOTES has no `{now_line}` - `fill` ignores a value with no
 * placeholder, so composing on this set simply renders no clock, as it did.
 */
const V2_TEMPLATE_V2_19_0: V2TemplateSet = {
  ...V2_TEMPLATE_V2_18_0,
  version: 'v2.19.0-draft',
}

const V2_21_FRAME = `# Who you are
You are the host at {venue_name}, and this is your Instagram inbox{instagram_clause}. You represent {venue_name} and communicate with guests in their IG DM.
You can't send photos, videos or files. Never say so, and never lead with
what you can't do. When a guest asks to see something, the answer is where
they can see it.
If someone from the team has written in this conversation, continue as
"we". Never introduce yourself or say who you are unless the guest asks.

You're warm but not tryhard. You're glad they wrote, and that shows in how easy you are to talk to, but you don't write in prose.

React to the person before the logistics. If they're planning something,
had a good time, or had a bad one, your first words respond to that,
briefly and genuinely. Then the facts.

When you need something from a guest, invite, never instruct.
"Tell me a bit about it" not "Send me the date, headcount and needs".
Never list fields to fill in.

You have opinions about the menu and share them plainly.
You're never salesy and never servile.

You're discreet. You use what you know about a guest to be thoughtful, never to show off, and never in a way that feels like you're watching them.

You care about what the guest is actually trying to do, and you notice the details of what they wrote. You respond to their message, not to a generic version of it.

You talk like someone who knows the answer, not someone reading it. People
texting compress. They round, drop the year, drop the qualifier, and drop where
and how unless it was asked. Give the gist at the level of detail the question
was asked at, and let the guest ask for more.

You're only exact when the guest will act on that exact thing. That means
something they'll type, pay, or walk to. Everything else gets the gist.

# How you answer
Speak as the venue itself ("we"){speaker_clause}. Do not sign messages with a personal name.

When asked about time, infer if it's important to use the time right now.

You answer the question in front of you, then stop. Anything more has to be
something the guest would be worse off not knowing. Being near the topic
isn't enough.

You don't explain your answer back to people. If they asked whether something
is okay, yes plus the fact is the whole answer.

Never say the same thing twice in different words.

Unless guests ask for the specifics, you only answer casually. That means addresses,
prices, links, contact details, and opening times, dates.

# Texting style
Send 1 to 3 short messages.{length_clause}
Always use obvious abbreviations. Examples: "Advertisement -> Ads". "Street -> St"
Never use slangy words
Your first message answers exactly what they asked and nothing else.
Anything beyond that goes in its own message.
Drop the subject when it's obvious, the way people do in texts.
No period at the end of a message.
Replace your emojis with ":)"
Never the phrase "full stop".
Punctuation is commas, question marks, line breaks, periods between sentences
inside one message, and the occasional exclamation mark when you're genuinely
glad. No colons, semicolons, em dashes, parentheses, or bullet points. Where an
em or en dash would land, end the sentence and start a new one.
Write numbers as digits.

# Extra Notes
Guests sometimes share a name with an AI assistant ("Claude", "Alexa"). It is still simply their name - never a reference to you.

# Intention
You have genuine interest in the guests, their needs and want to help them achieve their intentions and make them feel recognized and remembered.

# Rules

- Never state or imply anything about this guest - visits, orders, preferences, history - that HOUSE NOTES or the conversation does not confirm. If you do not know, you do not know.
- Never invent claims about other guests, such as how people react, what's popular, what regulars order, or what sells out. Only say these when venue knowledge states them. Your own taste is fine ("I'd get it iced"). A made-up observation about other people is not.
- You never run a loyalty program. No points, rewards, tiers, earning, or counting visits toward anything.
- Anything you give or promise - something free, a discount, holding or reserving anything, cancelling or changing an arrangement - exists only if you declare it in \`actions\`. Never commit to any of it in prose alone.
- Only share links that appear in your knowledge. Never invent or adjust one.
- One question per reply at most. You are never conducting an interview - if they deflected something once, let it rest.
- If the guest asks you to stop messaging them (any wording), respond nothing.
- If an opted-out guest clearly asks to get messages again, welcome them back.`

const V2_21_HOUSE_SECTIONS_BRIEFED = `# What you know

{knowledge_brief}`

const V2_21_GUEST_STATE = `HOUSE NOTES (yours alone - the guest never sees this)

## Right now
{now_line}

## Where this relationship stands
{state_line}
Your aim right now: {mission}

## This guest
{guest_profile}

## What you have asked and offered before
{interaction_memory}

## What you're trying to learn at this stage
These are open in parallel - pick whichever fits this moment best; your one question is for these, unless the guest shows trouble or hurry. If one was raised before and went nowhere, let it rest.
{open_moves}{followup_note}`

const V2_21_FOLLOWUP_NOTE = `

## Why you're writing first
The guest hasn't written since your last message, about {hours_quiet} hours ago. You're reaching out, not replying. Pick the thread up exactly where it left off - specific to what was said, never a survey. Never open with a greeting that ignores the conversation, never repeat an unanswered question word for word, and never mention the silence.`

const V2_21_FOLLOWUP_CUE = `[The guest hasn't replied. This turn is yours - you're writing first. HOUSE NOTES says why.]`

/**
 * v2.21.0-draft at 477dea7 - the version v2.22.0 replaces, and the BASELINE
 * for it: the owner's second prompt-lab promotion is read against this, so a
 * reply from it is the only answer to "did the rewrite cost anything".
 *
 * Its `houseSections` is the same frozen literal v2.18.0 and v2.19.0 use,
 * which is a claim the verbatim check tests per key rather than an assumption
 * - the unbriefed block has not changed since v2.17.0.
 *
 * Its briefed block carries NO `# How you sound`: v2.20.0 cut the voice pack
 * from a briefed venue and v2.22.0 put it back, so this is the only archived
 * set in which a briefed prompt has one section. The outreach lane is here
 * because v2.21.0 is the version that added it.
 */
const V2_TEMPLATE_V2_21_0: V2TemplateSet = {
  version: 'v2.21.0-draft',
  frame: V2_21_FRAME,
  houseSections: PRE_V2_20_HOUSE_SECTIONS,
  houseSectionsBriefed: V2_21_HOUSE_SECTIONS_BRIEFED,
  guestState: V2_21_GUEST_STATE,
  usesRetrieval: false,
  outreach: { note: V2_21_FOLLOWUP_NOTE, cue: V2_21_FOLLOWUP_CUE },
}

/**
 * Keyed by the version string, so a stored override, a trace and this registry
 * all name a version the same way - there is no second id to drift from it.
 *
 * FIVE DEEP as of v2.22.0, against the two-deep ruling of 2026-10-12, and
 * each one earns its place rather than being kept out of caution: v2.21.0 is
 * the comparison baseline and the only archived set whose briefed block has no
 * voice pack, v2.18.0 is the version every measured lesson in the changelog
 * was measured on, and v2.17.0 is the only set with `usesRetrieval: true` -
 * dropping it would delete the only exercise of the lane restore in run-turn
 * that the flag exists to drive. v2.19.0 is the weakest of the five now that
 * it is no longer the baseline, and it shares v2.18.0's strings, so this is
 * five keys over four distinct wordings rather than the long unread list the
 * ruling was about.
 */
export const V2_TEMPLATE_SETS: Record<string, V2TemplateSet> = {
  [V2_TEMPLATE_CURRENT.version]: V2_TEMPLATE_CURRENT,
  [V2_TEMPLATE_V2_21_0.version]: V2_TEMPLATE_V2_21_0,
  [V2_TEMPLATE_V2_19_0.version]: V2_TEMPLATE_V2_19_0,
  [V2_TEMPLATE_V2_18_0.version]: V2_TEMPLATE_V2_18_0,
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

// ---------------------------------------------------------------------------
// A hand-edited template set: the prompt lab's template mode.
//
// WHY THE BLOCKS AND NOT THE COMPOSED TEXT. `systemText`
// (`replaceSystemText`) hands the model one flat document with every
// placeholder already filled, which is the right instrument for an ablation
// and the wrong one for anything meant to be PROMOTED: the text contains one
// venue's data, one guest's HOUSE NOTES and one moment's clock, and the
// three-block structure is gone. V2_PROMPT_VERSION's v2.20.0 entry is the
// record of what promoting that costs - 49,100 chars with no placeholders, of
// which 44,393 turned out to be venue data. Editing the SET instead means the
// composer still fills each block per venue and per turn, so what a sweep
// measures is what would ship.
//
// STRINGS ONLY, and the two non-string properties of a set are deliberately
// out of reach:
//
//   `usesRetrieval` is a claim about what the RUNNER must do, and this file's
//   own interface says why it is not derived from the text - letting a wording
//   edit switch a retrieval call on or off is the failure that would make.
//
//   The PRESENCE of the outreach lane is the same kind of claim: it is what
//   makes the runner refuse an outreach turn on a version predating it rather
//   than compose a version that never shipped. An edit may rewrite the note
//   and the cue; it cannot add a lane to a set that has none, or remove one.

/**
 * The strings of a `V2TemplateSet` a surface may hand-edit, each optional so
 * an edit to one block says nothing about the others.
 *
 * Keyed by block rather than carrying a whole set, because a whole-set
 * override would be a second way to express `usesRetrieval` and the outreach
 * lane - see the note above.
 */
export interface V2TemplateBlocks {
  frame?: string
  houseSections?: string
  houseSectionsBriefed?: string
  guestState?: string
  outreachNote?: string
  outreachCue?: string
}

/**
 * One block's position in a set, as a read and a write.
 *
 * `satisfies Record<keyof V2TemplateBlocks, ...>` rather than a plain object:
 * a block added to the interface with no entry here would otherwise be
 * silently ignored, which is an edit the operator typed and the model never
 * saw - `readonly K[]` is not exhaustiveness-checked, this is.
 */
const BLOCK_FIELDS = {
  frame: {
    label: 'ROLE',
    write: (s: V2TemplateSet, text: string) => ({ ...s, frame: text }),
  },
  houseSections: {
    label: 'THE HOUSE (no brief)',
    write: (s: V2TemplateSet, text: string) => ({ ...s, houseSections: text }),
  },
  houseSectionsBriefed: {
    label: 'THE HOUSE (briefed)',
    write: (s: V2TemplateSet, text: string) => ({
      ...s,
      houseSectionsBriefed: text,
    }),
  },
  guestState: {
    label: 'HOUSE NOTES',
    write: (s: V2TemplateSet, text: string) => ({ ...s, guestState: text }),
  },
  outreachNote: {
    label: 'the outreach note',
    // The undefined branch is unreachable - `read` returning undefined is
    // refused before any write - and it is here because a lane cannot be
    // ADDED by an edit, so there is nothing honest to construct.
    write: (s: V2TemplateSet, text: string) =>
      s.outreach === undefined
        ? s
        : { ...s, outreach: { ...s.outreach, note: text } },
  },
  outreachCue: {
    label: 'the outreach cue',
    write: (s: V2TemplateSet, text: string) =>
      s.outreach === undefined
        ? s
        : { ...s, outreach: { ...s.outreach, cue: text } },
  },
} satisfies Record<
  keyof V2TemplateBlocks,
  {
    label: string
    write: (s: V2TemplateSet, text: string) => V2TemplateSet
  }
>

/**
 * One block off a set, by the key `V2TemplateBlocks` names it with.
 *
 * EXPORTED because three surfaces need it - the refusal below, the promotion
 * artifact and the editor - and the outreach pair is the reason it is not a
 * plain index: `outreachNote` lives at `outreach.note`, so every reader needs
 * the same two special cases, and three copies of them is three chances for
 * one to be missed when a block is added.
 */
export function readV2TemplateBlock(
  set: V2TemplateSet,
  key: keyof V2TemplateBlocks,
): string | undefined {
  if (key === 'outreachNote') return set.outreach?.note
  if (key === 'outreachCue') return set.outreach?.cue
  return set[key]
}

/** The same shape `compose.ts`'s `fill` matches, so the two cannot disagree. */
const PLACEHOLDER_RE = /\{[a-z_]+\}/g

/**
 * The distinct placeholders in a template string, in first-seen order.
 *
 * One definition for every surface that asks the question - what a block may
 * fill is a property of the template, and a second regex somewhere else is how
 * the editor would start permitting a form the composer does not fill.
 */
export function v2PlaceholdersIn(text: string): string[] {
  return [...new Set(text.match(PLACEHOLDER_RE) ?? [])]
}

export type V2TemplateBlocksResult =
  | { ok: true; set: V2TemplateSet; edited: boolean }
  | { ok: false; error: string }

/**
 * A template set with hand-edited blocks layered on, or a refusal naming what
 * is wrong with the edit.
 *
 * FAILS CLOSED, and the direction is the one `prompt-text.ts` argues for at
 * length: the alternative is running a turn against a prompt that differs from
 * what the operator is looking at and then reasoning about the reply. A
 * refused edit costs one retype.
 *
 * Two refusals, each for a reason that has a defect behind it:
 *
 * - A block the version does not carry. v2.17.0 has no `houseSectionsBriefed`
 *   and nothing before v2.21.0 has an outreach lane; accepting an edit to one
 *   would compose a version that never existed, dressed as one that did.
 * - A placeholder the version's own copy of that block does not have. The
 *   composer fills a FIXED set per block, so `{venu_name}` is a typo that
 *   `fill` would throw on mid-turn, and `{now_line}` in the frame is the
 *   2026-10-08 cache defect exactly - a clock-derived line in block 1
 *   invalidates the whole prefix in front of it on every turn. Deleting a
 *   placeholder is ALLOWED, because emptying a section is the ablation this
 *   surface exists to make possible.
 *
 * STAMPS `+hand-edited` when any block actually differs, and not otherwise.
 * The stamp is what keeps `eval_judgments`, the regression harness and the
 * golden set from keying a row to a template that produced none of it - the
 * same mechanism and the same marker `replaceSystemText` uses. A surface that
 * sends the version's own blocks back unchanged composes byte-identically to
 * sending no override at all, which is what makes template mode safe to leave
 * switched on.
 */
export function applyV2TemplateBlocks(
  set: V2TemplateSet,
  blocks: V2TemplateBlocks,
): V2TemplateBlocksResult {
  let next = set
  let edited = false
  for (const key of Object.keys(BLOCK_FIELDS) as Array<
    keyof V2TemplateBlocks
  >) {
    const text = blocks[key]
    if (text === undefined) continue
    const field = BLOCK_FIELDS[key]
    const original = readV2TemplateBlock(set, key)
    if (original === undefined)
      return {
        ok: false,
        error: `template ${set.version} has no ${field.label} block, so there is nothing to edit - an override on a block a version does not carry would compose a version that never shipped`,
      }
    if (text === original) continue
    const allowed = v2PlaceholdersIn(original)
    const added = v2PlaceholdersIn(text).filter((p) => !allowed.includes(p))
    if (added.length > 0)
      return {
        ok: false,
        error: `${field.label} carries ${added.join(', ')}, which ${set.version}'s own ${field.label} does not${allowed.length === 0 ? ' (that block takes no placeholders at all)' : ` - it takes ${allowed.join(', ')}`}. Either it is a typo, or it is a placeholder that belongs in another block, and moving one between blocks is a template change with the composer's cache order to answer for. Deleting a placeholder here is fine.`,
      }
    next = field.write(next, text)
    edited = true
  }
  if (!edited) return { ok: true, set, edited: false }
  return {
    ok: true,
    set: { ...next, version: `${set.version}${HAND_EDITED_SUFFIX}` },
    edited: true,
  }
}
