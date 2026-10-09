// The v2 prompt template: the maitre d' frame. Three sections - who you are,
// what you know, hard lines - and nothing else. Style is the persona's job
// and the judge's job; etiquette is the model's judgment over the facts in
// the situation brief. The 39-rule layer and the category instruction layer
// have no successor here, deliberately (decision 0009).
//
// ENTIRE FILE IS DRAFT COPY, pending verbatim approval, and ships only as
// the seed row of `prompt_templates` (global default, venue NULL). Live
// edits happen as draft rows promoted through the eval loop, not here; this
// constant is the starting point and the fallback.
//
// {placeholders} are substituted by compose.ts; a placeholder it cannot fill
// is a composition error, never rendered text.

// v2.1.0: moves section reframed from passive facts ("things you don't know
// yet / silence is always acceptable") to parallel active aims - the old
// wording taught the model to never ask (owner-ruled 2026-10-04, the
// Himanshu-conversation target).
// v2.2.0: host-not-service-desk identity line; dropped "only when it fits
// what the guest just said" from the question hard line - measured by
// first-contact-replay: that clause read a bare "Hi!" as fitting nothing,
// so the agent opened with "what can I do for you?" and pursued zero moves
// in both arms.
// v2.3.0: "the notes are one message stale; the message wins" - measured:
// the agent re-asked the name in the same turn the guest answered it,
// because the brief still listed the name unknown.
// v2.4.0: the moves header's "or none if the moment is wrong" CUT - measured
// by turn-one-move: on a thin opener ("hey") every arm took the exit, 0/3
// pursuing an open aim across all four arms, while spending its question on
// pleasantry or a freelance probe. The wrong-moment escape stays, scoped to
// what it was for: trouble or hurry.
// v2.5.0: one collision sentence added to the frame - a guest who answered
// the name ask with "Claude." was read as ADDRESSING the assistant ("still
// here! what's your name?"), 2/2 reproduced, control name clean. This is
// the measured MINIMUM: eight variants screened (identity paragraphs,
// "a name a guest sends is theirs", "take their next message as given",
// a named speaker persona) and every generic form failed 0/3 or worse -
// some made the model correct the guest ("ha - I meant yours"). Only
// naming the exact confusion carried it, 3/3. The assessor was never
// confused; generation alone misread.
// v2.6.0: no-em-dash voice line (owner-ruled 2026-10-04). Paired with the
// deterministic normalizer at the generation seam (normalize-output.ts) -
// the line and the substitution ask for the same thing, a sentence break,
// per the v1 replaceDashes lesson. The line reduces dash drafts; the
// normalizer is the guarantee (voice-pack exemplars sit LATER in the
// composed prompt and can out-rank any tier-0 rule).
// v2.7.0: flat no-emoji line (owner-ruled 2026-10-05, "no emojis for now").
// The standing-prohibition form is the one TAC-362 proved: 0 emoji across
// 240 responses under a persona-level "Do not use emoji", while frequency
// wording measured as no control at all - so if emoji ever come back it is
// per-policy rendering plus the emoji-cadence coin, never a softer sentence
// here. v2 only; v1 venues keep their owner-captured emojiPolicy. Known
// limit, same as the dash line: voice-pack exemplars sit later and could
// out-rank this if a venue's corpus itself carries emoji.
// v2.8.0 (owner-ruled 2026-10-05), two changes to the host paragraph:
// "what to call them" -> "their name" - a playground turn asked the
// assistant-onboarding "what should i call you?", and the frame's own
// clause read back as a question is the cheapest explanation (the
// learn_name move text was already goal-and-gap and names no phrasing).
// And the `not a "how can I help"` negative CUT at owner direction,
// leaving the positive framing to carry alone. WATCH ITEM: that negative
// was part of v2.2.0's measured fix - first-contact-replay is the harness
// that would catch the service-desk opener coming back. Watch RETIRED
// 2026-10-05: owner ruled the service-desk opener okay to ask, so the
// v2.2.0 register lesson no longer gates anything - the regression
// harness's service-desk tells and scenario were retired with it.
// v2.9.0 (owner-ruled 2026-10-05), the either-or sweep. Root cause of
// "anything catch your eye, or want a nudge in a direction?": the
// find_their_thing goal's own wording read back at the guest (instruction
// echo, the v2.8.0 family) with its aphoristic register riding along, and
// the mission's "recognizable personality" clause licensing the wit. No
// template text changed in this bump - the copy changes are in the seed
// graph (goal flattened to goal-and-gap, personality clause cut), the
// structural guarantee is stripEitherOrQuestion at the generation seam
// (normalize-output.ts; comma form only - "iced or hot?" is a real
// choice), and the harness gains an either-or ceiling tell sharing the
// strip's pattern. Deliberately NO "never ask either/or" frame line: the
// v2.5.0 measurement showed generic prohibitions underperform, and the
// normalizer is the guarantee.
// v2.10.0 (owner-ruled 2026-10-05): the venue profile is RENDERED, not a
// sliced JSON blob. No template text changed in this bump; what changed is
// the content {venue_profile} receives. run-turn.ts had been passing
// `JSON.stringify(venue_info, null, 1).slice(0, 4000)`, and at Le Mil's that
// row is 22,258 characters, so the cut landed inside `menu` and menu was the
// only key the model ever saw - no address, hours, contact, amenities,
// services, staff or currentContext in any v2 prompt to date. Measured: "where
// are you located?" and "what's your address?" each returned a Polk Street
// number found nowhere in the venue's data, differing between two runs of the
// identical prompt, and the gate sent both. The renderer
// (lib/ai/v2/venue-profile.ts) has no character budget by owner ruling - every
// section is a fact needed to answer, so a budget can only pick which question
// to get wrong - and it reports any stored key that reached no renderer.
// WATCH ITEM, deliberately NOT fixed with copy: the hard lines forbid
// inventing a GUEST fact and inventing a link, and say nothing about inventing
// a VENUE fact. A generic prohibition is what v2.5.0 measured as the weakest
// available instrument (eight variants, every generic form 0/3) and what
// v2.9.0 declined on the same grounds, so the fix here is supplying the facts.
// If a fabricated venue fact survives this bump, that is the evidence a line
// would need.
// v2.11.0 (owner-approved 2026-10-06): the guest's own agenda becomes a move
// (`what_they_came_for` in the seed graph). No template text changed in this
// bump - the copy change is graph data, same shape as v2.9.0.
// Root cause, found by leave-one-out over all 22 units of the composed prompt
// (frame paragraphs, hard-line bullets, tier-1 sections, brief sections) at
// n=3: dropping the MOVES HEADER was the only unit that restored the answer,
// 3/3, with all 21 others at 0/3. The header sits last before the guest's
// message and says the turn's question is for the open moves - and every move
// was a house aim, so a guest who ASKED for something had no representation in
// the mechanism at all. "What is a good first order?" returned a bare welcome
// 11/11 while retrieval had already supplied the answer; "what is a good
// order?" answered 2/2, so the trigger was the collision between the guest's
// "first" and the brief's own framing of the turn as the opening.
// Deliberately NOT fixed in the header or with a frame line. A frame sentence
// naming the confusion scored 11/11 on the phrase and is exactly the
// symptom-shaped copy v2.5.0 and v2.9.0 both declined; rewording the header's
// question-ownership clause worked too, but the move is the structural fix and
// is venue-tunable graph data rather than template copy.
// WATCH ITEM: every wording that framed the move as understanding the guest's
// intention pulled the service-desk opener onto a bare "hey" (0/3 control ->
// 3/3), because a move IS a question target. The shipped goal self-disables
// when the message carries no request, which measured 0/3 - if that register
// drift appears, this is the cause, and `recommendation-turn-one` plus
// `bare-hey` are the two scenarios that bracket it.
// Thinking does not rescue the defect (sonnet-4-6 + 2k budget: 0/3) and opus
// does not need the fix (3/3 unaided) - it was a prompt defect throughout,
// not reasoning depth.
// v2.12.0 (owner-ruled 2026-10-06): the frame says Instagram, because v2 is
// Instagram-only. Three phrases carried SMS framing on every turn of every
// venue - "this is your phone - guests text this number, you text back",
// "You text the way a person texts", "A guest who texts you" - so the model
// was told, in tier 0, that it was somewhere it was not. Caught on a Le Mil's
// buyout turn that answered "best way to get the details sorted is through
// Instagram, @lemilscoffee" to a guest already in the Instagram inbox.
//
// NO CHANNEL PARAMETER, deliberately. v1 branches its copy by channel
// (lib/ai/prompts/channel-variants.ts, exactly-once substitutions applied at
// module load) because v1 serves both SMS and Instagram venues. v2 serves one
// channel, so the frame states it outright: a channel field, a resolver and a
// substitution table would all be mechanism with one possible value, and the
// trace would gain a dimension nothing can vary. If v2 ever takes an SMS
// venue, v1's table is the shape to copy - not to import, because the phrases
// differ.
//
// NOT the whole fix for the motivating turn, and the smaller half of it. The
// redirect came from a knowledge row ("Private events and café buyouts are
// available ... Inquiries can be made through Instagram", 9cad1ee2), which
// renders in tier 1 - AFTER this frame, where most-proximate-wins gives it the
// authority. Measured at the time: that row was the ONLY buyout chunk
// retrieval returned for "can i rent out your space" (rank 3 of 4, similarity
// 0.450; the three others were seating, laptops and the landlord). The
// sibling row saying "Interested guests can ask here" did not rank in the top
// 30 on any buyout phrasing, because its own text leads with walk-in-only and
// reservations. So the row was rewritten in place rather than retired - an
// unreachable correct row is not a fix - and this frame change stands on its
// own merits rather than on that turn.
//
// Deliberately NO hard line against off-channel redirects (owner-ruled). The
// v2.5.0 screen put eight generic prohibitions at 0/3 and v2.9.0 and v2.10.0
// both declined one on those grounds; a line in tier 0 would also be arguing
// with a tier-1 knowledge row, which is the losing position. Supplying correct
// knowledge is the instrument. `off-channel-redirect` in the regression
// harness is the tell that would say otherwise.
//
// NO VERSION BUMP, 2026-10-08: the prompt cache was repaired, and the fix is
// BYTE-IDENTICAL to the model. `V2_VENUE_SECTIONS` split into
// `V2_HOUSE_SECTIONS` + `V2_KNOWLEDGE_SECTION`, which concatenate back to
// exactly the old string (the leading blank line on the knowledge constant is
// what guarantees it, and `cold-latte-cache-probe.ts` asserts the two arms are
// byte-identical before it reports a single number). Same text, same order,
// only the block boundary and the breakpoint moved - so there is nothing for a
// new version to key, and bumping would be the false signal
// .claude/rules/prompt-versioning.md warns about.
//
// WHAT WAS BROKEN. `# What you know` is retrieved per turn (run-turn.ts
// queries with the inbound) and it sat at the END of the cached venue block,
// so ~150 volatile tokens invalidated ~6,100 static ones on every single turn.
// generate.ts's own header asserted "both system blocks are stable per venue",
// which is what kept anyone from looking. Measured on Le Mil's, cold:
// write 6,326 then write 6,267, reuse 0. After: write 6,133 then reuse 6,133.
// Knowledge was confirmed to differ between the two turns (637 against 435
// chars), so this is a property of the layout, not of one unlucky pair.
//
// Block 1 also lost its breakpoint. At ~590 tokens it is under Anthropic's
// 1024-token minimum cacheable prefix, so the breakpoint it carried could
// never have produced an entry - a guard with no true positives in its
// lifetime.
//
// THE BRIEF STAYS A USER TURN. Moving it into a system block was tried the
// same day and reverted; `V2_GUEST_STATE` below has the two measurements that
// killed it.
//
// v2.13.0 (owner-ruled 2026-10-09): the frame is reorganized into named
// sections - Who you are, Texting style, Extra Notes, Intention, Rules - and
// `# What you know` moves out of the system blocks into HOUSE NOTES. The
// owner wrote this copy; what follows is the record of what it overrides, so
// the next person reads a decision rather than a regression.
//
// THREE MEASURED LESSONS ARE DELIBERATELY REVERSED. Each was raised with the
// owner against its evidence and reaffirmed. A FOURTH was tried and reverted
// on the measurement, which is recorded first because it is the only
// true-positive v2.7.0's lesson has ever had:
//
//  0. "No emoji, ever" -> "Use emojis sparingly" -> BACK TO THE PROHIBITION,
//     same day, owner-ruled on the number. v2.7.0 had recorded that the
//     standing-prohibition form produced 0 emoji across 240 responses
//     (TAC-362) while FREQUENCY WORDING MEASURED AS NO CONTROL AT ALL. The
//     softer sentence shipped for one regression run and produced 83 EMOJI
//     ACROSS 11 OF 13 SCENARIOS at n=6 - "hey! welcome to Le Mil's 😊 what can
//     I do for you?" on a stranger's first message. Not sparing: near every
//     reply. The lesson now has a measurement on both sides of it.
//     IF EMOJI EVER COME BACK, the instrument is per-policy rendering plus the
//     emoji-cadence coin (lib/ai/emoji-cadence.ts, `resolveEmojiDirective`,
//     carried over from v1), never a sentence here. Note the standing
//     contradiction that motivated the attempt is still live and unresolved:
//     Le Mil's own voice pack is full of emoji and sits LATER in the prompt,
//     where proximity lets it out-rank this line.
// ALSO IN THIS BUMP: `Never the phrase "full stop".` in # Texting style
// (owner-ruled 2026-10-09). A pure model tic - the phrase appears in no
// template, in no voice_corpus or knowledge_corpus row AT ANY VENUE, and in
// no outbound message this product has ever sent, so nothing later in the
// prompt is arguing for it and the fix was never a data fix.
//
// THIS LINE IS NOT THE MECHANISM, AND DOES NOT WORK ON ITS OWN - MEASURED.
// It shipped alone first, on the reasoning that a flat ban on one literal
// token is the form that works here (the emoji and em-dash lines). It is not.
// A paired ablation over 8 complaint turns - this one sentence present vs.
// deleted from system block 1, everything else byte-identical - read 1/8 with
// the ban and the SAME 1/8 without it, the same input breaching in both arms.
// A ban-stripped sweep over 16 emphatic-grievance turns put the base rate at
// 1/16, all of it one input ("waited 25 minutes for a drip coffee"). So the
// single occasion the line had to fire, it did not.
//
// The mechanism is `stripFullStop` at the generation seam
// (lib/ai/v2/normalize-output.ts), owner-ruled the same day. The sentence
// stays here for the reason replaceDashesWithPeriod keeps its voice line - a
// substitution and its constraint text must agree - and for nothing else. Do
// not cite it as evidence that a prohibition works, and do not delete the
// stripper on the strength of it.
//
// `full-stop` in the regression tells now counts STRIPPER MISSES, not model
// behaviour: a hit there means a shape stripFullStop does not catch.
//
//  1. The opt-out hard line is CUT ("a guest who asks to stop hearing from you
//     gets a brief, warm confirmation and nothing else"). The gate exempts
//     `opt_out_request` from queueing (POLICY_EXEMPT_SITUATIONS, gate.ts), so
//     that reply auto-sends with no operator and now with no instruction on
//     how to write it. Contained only because v2 has no production caller yet
//     (nothing passes `dispatch: live`); it stops being contained at phase 6.
//  2. "Never re-ask what they just told you" is CUT, with the rest of the
//     HOUSE NOTES explainer. That sentence is v2.3.0, added because the agent
//     re-asked the guest's name on the very turn they gave it.
//  3. The pursuit clause is CUT ("the house notes tell you what you are still
//     curious about; a good first exchange usually ends with you knowing one
//     more of those things than you did"). `# Intention` replaces it. Pursuit
//     bars in the regression harness are what would show the cost.
//
// `@lemilscoffee` was in the owner's draft and is NOT here: venue_info carries
// no Instagram handle, and this constant is the GLOBAL default row (venue
// NULL), so a literal handle would put one venue's account in every venue's
// prompt. Same reason `{venue_name}` stays a placeholder. It needs a
// venue_info field first.
export const V2_PROMPT_VERSION = 'v2.13.0-draft'

/** Block 1: ROLE. Static across every venue bar the two placeholders. */
export const V2_FRAME = `# Who you are
You are the virtual maitre d' of {venue_name}, not a service desk, and this is your Instagram inbox.

You are a real presence of the house: its memory, its taste, its hospitality. You speak as the venue{speaker_clause}.

# Texting style
You write the way a person messages - short, warm, specific, never corporate. No emoji, ever. Never the phrase "full stop". Never an em or en dash (— –): where one would land, end the sentence and start a new one. You have opinions about the menu and you share them plainly. You are never salesy and never servile. Mimic how you sound section to tune your voice.

# Extra Notes
Guests sometimes share a name with an AI assistant ("Claude", "Alexa"). It is still simply their name - never a reference to you.

# Intention
You have genuine interest in the guests, their needs and want to help them achieve their intentions and make them feel recognized and remembered.

# Rules

- Never state or imply anything about this guest - visits, orders, preferences, history - that HOUSE NOTES or the conversation does not confirm. If you do not know, you do not know.
- You never run a loyalty program. No points, rewards, tiers, earning, or counting visits toward anything.
- Anything you give or promise - something free, a discount, holding or reserving anything, cancelling or changing an arrangement - exists only if you declare it in \`actions\`. Never commit to any of it in prose alone.
- Only share links that appear in your knowledge. Never invent or adjust one.
- One question per reply at most. You are never conducting an interview - if they deflected something once, let it rest.`

/**
 * Block 2: the venue's own material. Changes only when an owner edits it, so
 * this is THE LAST STABLE THING IN THE PROMPT AND THE CACHE BREAKPOINT GOES
 * AFTER IT.
 *
 * NOTHING PER-TURN MAY BE ADDED HERE. `# What you know` lived at the end of
 * this block until 2026-10-08 and cost the entire cache while every comment
 * in the file called the block stable. It is retrieval, so it now renders in
 * HOUSE NOTES below.
 */
export const V2_HOUSE_SECTIONS = `# Information about the business you are presenting.

{venue_profile}

# How you sound

{voice_pack}`

/**
 * EVERYTHING VOLATILE, as the LAST SYSTEM BLOCK (owner-ruled 2026-10-09).
 * Retrieval and guest state both live here, which is what keeps blocks 1 and
 * 2 stable enough to cache.
 *
 * WHAT ITS POSITION COSTS, recorded because it was measured and traded away
 * rather than overlooked. System blocks always precede messages, so a
 * volatile system block sits in front of the transcript and no breakpoint
 * after the transcript can ever hit. For part of 2026-10-09 this was a USER
 * TURN behind the transcript and the transcript carried its own breakpoint,
 * measured reading 6,016 tokens on turn 3 of a conversation. That is worth
 * p50 241 and max 555 at Le Mil's, against a ~6,000-token prefix that caches
 * either way.
 *
 * The behavioural argument for the user-turn position is RETIRED, not
 * forgotten: second-to-last is the most-proximate slot in the prompt and the
 * lever v2.4.0 and v2.11.0 both pulled, and moving this block ahead of the
 * transcript put `bare-hey` at pursuit 0/6 where the previous layout passed,
 * n=6. The owner ruled that reply acceptable on 2026-10-09, which is what
 * freed the position. If pursuit is ever wanted back, this block moving
 * behind the transcript is the first thing to try.
 *
 * `## What you know` LEADS, so retrieval sits furthest from the guest's
 * message of anything in here. It is the one section that is not about this
 * guest, and proximity is authority: a knowledge row has already out-ranked a
 * tier-0 frame line once (v2.12.0's off-channel redirect). `off-channel-
 * redirect` in the regression harness is the tell if that comes back.
 */
export const V2_GUEST_STATE = `HOUSE NOTES (yours alone - the guest never sees this)

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
{open_moves}`
