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
// Block 1 also lost its breakpoint. At ~590 tokens it was under Anthropic's
// 1024-token minimum cacheable prefix, so the breakpoint it carried could
// never have produced an entry - a guard with no true positives in its
// lifetime. THAT SIZE ARGUMENT EXPIRED IN v2.19.0, when the frame reached
// 4,677 chars and the floor with it; it is 5,167 as of v2.22.0. The breakpoint stays off for a different
// reason, which compose.ts's header states.
//
// THE BRIEF STAYS A USER TURN. Moving it into a system block was tried the
// same day and reverted; `V2_GUEST_STATE` below has the two measurements that
// killed it.
//
// MODEL BOUNDARY 2026-10-12. EVERY measured lesson below was measured on
// claude-sonnet-4-6, which is still the default. v2 generation is now a
// switch (`V2_GENERATION_MODEL`, lib/ai/v2/model-call.ts), and a number in this
// changelog is evidence about a prompt ON THAT MODEL - not a property of the
// wording. No version bump: no copy changed, and bumping would signal one.
//
// What a different model costs. Same tree, the same 8 single-turn scenarios,
// n=6, the switch the only thing that moved:
//
//   sonnet-4-6  7/8, 0 ceiling breaches   (default; the miss is the
//               knowledge-pastries BAR, which fails on 4.6 too and is
//               therefore not about the model)
//   sonnet-5-5  6/8, 2 - `call-you` + `two-questions`, and `unverified_link`
//   haiku-5-5   6/8, 2 - `two-questions` twice
//
// BOTH 5.x MODELS REJECT `temperature`, and `two-questions` and `call-you` are
// question stacking and register drift - exactly the two failure modes
// V2_GENERATE_TEMPERATURE was ruled in to suppress on 2026-10-05. The knob is
// gone on those profiles, so what the knob was doing has to be done by copy,
// and none of the copy below was written for that job. That is the mechanism;
// the rest of this entry is what complicates it.
//
// `unverified_link` is the one failure of a different KIND - a link in a
// guest-facing reply the gate could not verify - and only sonnet-5-5 did it.
//
// HAIKU'S BREACHES ARE SUBSTANTIALLY THE VOICE PACK WINNING, not drift. Two of
// three attributed to `voice_corpus` rows (ba4801ab, 87b89375, 7304b9c3), and
// the pack sits LATER in the composed prompt than anything here, so it
// outranks this file by construction. That is the turn-one-move finding again,
// where every round's breach was one verbatim name-ask exemplar and the owner
// ruled 2026-10-05 to KEEP the row. So haiku-5-5 follows the venue's own
// writing more closely than 4.6 does, and the regression rule is explicit that
// a pack-attributed breach is a data decision rather than a wording arm. Do
// not chase it with template copy.
//
// NEITHER IS STABLE AT n=6, which is the finding that limits all of the above.
// Two haiku-5-5 runs over the same scenarios both scored 6/8 and breached
// DIFFERENT ones - bare-domain-link breached in the first and passed in the
// second. With no temperature there is no head of the distribution to pick, so
// a per-scenario verdict on these profiles is a sighting, not a baseline.
//
// A RUN ON THE v2.18.0 BRIEF TREE agrees in direction for sonnet-5-5 over 10
// scenarios: 4.6 9/10 with 0 breaches, 5.5 6/10 with 4. Two trees, same
// direction, so the ordering is not one unlucky draw even though the cells are
// noisy.
//
// Neither 5.x model is uniformly worse. Both PASS the pastries bar 4.6 misses,
// and sonnet-5-5 runs 3-4x the output tokens. They are differently wrong, in
// the places the prompt has no copy for.
//
// SO: before citing any entry below as current, check which model ran. The
// regression summary line and both harness run logs print it.
//
// v2.23.0 (owner-ruled 2026-10-15): PRICE IS ITS OWN FACT - a new block-2
// section, and the frame's two weaker price mentions removed in the same
// change. The constant carries the full reasoning; what belongs here is the
// measurement and the two decisions around it.
//
// MEASURED, ARM TO ARM, on the eight-question withhold set in
// `scripts/measurement/price-discretion.ts` (n=5, 40 samples, Sonnet 5.5,
// clock pinned to 11:00):
//
//   v2.22.0, no such section        10/40 quoted a price = 25.0%  FAIL
//   v2.23.0, this section           0/40                 =  0.0%  PASS
//
// The quote set - four questions that ask a price outright, 20 samples - was
// 0/20 withheld on BOTH arms, which is the claim that matters second: the fix
// did not buy discretion by making the agent evasive about cost. "how much
// extra is oat milk?" still answers "Oat milk is $0.25 extra" 5/5. Bodies on
// the two formerly-failing questions were read rather than inferred from the
// rate: availability, exclusivity, Straus and the India story all survive.
//
// THE DEFECT WAS NOT SPREAD ACROSS QUESTION SHAPES - it was two questions at
// 5/5 and six at 0/5, and both failures reproduced ONE sentence of Le Mil's
// brief. That is why the fix is positional. See the constant.
//
// WHY A NEW VERSION RATHER THAN FOLDING INTO v2.22.0, which is the opposite of
// the call made for the HOUSE NOTES change six hours earlier: by now v2.22.0
// HAS stored runs naming it. Three of them - golden run a0d61629, regression
// runs f6a00e92 and b44279ec - were all taken today on the prompt WITHOUT this
// section. Folding would have left those rows labelled with a version whose
// copy they never saw, which is the same unlabelled-arm failure the import
// path's missing `generation_model` column was flagged for in the same hour.
//
// NO ARCHIVE ENTRY FOR v2.22.0, and this is a gap rather than an oversight. An
// archived set is a VERBATIM copy of the strings at a named commit, checked by
// `scripts/measurement/template-archive-verbatim.ts` against a git SHA.
// v2.22.0 was never committed - it lived in one uncommitted tree for an
// afternoon - so there is no SHA to check it against and no honest way to
// freeze it. It also has nothing to replay: the judges are off, so its three
// stored runs carry replies but no judgments. If v2.22.0 is ever wanted as a
// fixture it has to be reconstructed from this file's history, deliberately.
//
// v2.22.0 (owner-authored 2026-10-14, approved 2026-10-15): the frame is the
// owner's own prompt again, promoted out of /admin/prompt-lab a second time,
// and `# How you sound` COMES BACK for a briefed venue. Same path as v2.20.0,
// same four placeholders restored on the way in - the pasted document is Le
// Mil's and this constant is the global default row. Its inline `Your replies
// are usually 12 to 22 words. Over 40 is rare and needs a reason.` is
// byte-identical to what `replyLengthClause` renders for that venue today, so
// `{length_clause}` costs it nothing and keeps decision 0010 intact for every
// other venue.
//
// THE SOURCE DOCUMENT WAS TRUNCATED, which is why its third part is ignored.
// It ends mid-sentence inside the voice examples, and its HOUSE NOTES carried
// a hand-typed clock and no relationship sections at all. The frame and the
// brief both end cleanly before the cut; nothing below is taken from after it.
//
// FIVE CHANGES IN THE FRAME:
//
//  - `You are proud of the stories behind this business and happy to share.`
//    is new. `<the_story>` and `<coffee_knowledge>` are a large part of the
//    brief and nothing in the frame said to offer any of it.
//  - A CURIOSITY PAIR is new - asking "the way you'd ask a friend across the
//    counter", with two example questions, plus a patience paragraph - and the
//    v2.20.0 `invite, never instruct` paragraph it replaces is CUT. The
//    prohibition survives in the owner's own register ("handing someone a list
//    of things to send you isn't something you'd ever do"); what is gone is
//    the "Tell me a bit about it" not "Send me the date, headcount and needs"
//    contrast pair.
//    WATCH ITEM: this is the most pursuit-shaped copy this frame has carried,
//    and it sits in block 1 while v2.11.0 measured the MOVES HEADER as the
//    unit that actually governs asking. If an interview-y opener comes back,
//    `bare-hey` and `recommendation-turn-one` are the two scenarios that
//    bracket it, and the header is the lever before any rewording here.
//  - `never volunteer price unless asked` joins the discreet line.
//  - `Always send URLs in a separate bubble.` leads `# Texting style`. It is
//    the only new line here whose compliance is COUNTABLE, so it ships with a
//    tell (`url-bubble`) rather than a watch item - a bubble carrying a link
//    and prose together. No normalizer: re-splitting a bubble is a rewrite of
//    guest-facing text, which lib/ai/CLAUDE.md reserves.
//  - `You're glad they wrote, and that shows in how easy you are to talk to`
//    -> `You're easy to talk to`.
//
// THREE DEVIATIONS FROM THE OWNER'S TEXT, each approved 2026-10-15:
//
//  1. `You're easy you are to talk to` -> `You're easy to talk to`.
//  2. The trailing space after `happy to share.` stripped, and the double
//     blank line in the brief's `<the_cafe>` collapsed to one.
//  3. Two em dashes and one `café` in the brief's new `<instagram_context>`
//     replaced with sentence breaks and ASCII. `# Texting style` bans em
//     dashes and the brief renders AFTER it, where proximity is authority, and
//     `voice-profile.ts` states the principle this file has honoured since
//     v2.6.0: the model echoes what it is shown.
//
// `# How you sound` IS BACK (owner-ruled 2026-10-15, "keep my own reply
// examples"), two days after v2.20.0 cut it. That entry's account of the cut
// stands and is now the account of what this reverses: 65 active
// `voice_corpus` rows and ~5,700 chars of the team's approved replies are in a
// briefed prompt again, the standing proximity contradiction every emoji and
// dash entry here flags is live again, and `{length_clause}` is no longer the
// only measured input. Two of haiku-5-5's three breaches were attributed to
// `voice_corpus` rows, so a pack-attributed breach is expected and is a DATA
// decision per `.claude/rules/v2-template-regression.md`, never a wording arm.
//
// HOUSE NOTES IS NOW THE CLOCK AND NOTHING ELSE (owner-ruled 2026-10-15, "we
// should disable these sections"). The state line, the mission, the guest
// profile, the interaction memory and the open moves with their header are all
// out of the prompt. `V2_GUEST_STATE`'s own header is the full account of what
// that turns off - no mission, no pursuit mechanism, no profile or memory even
// once the assessor returns, and a judge brief that is one line - and it is
// the first place to read before adding any of it back.
//
// The ruling came from reading the composed prompt in the playground, where
// those four sections were not what the owner expected to see: the document
// they were promoted from had only `#Time` at the top of its notes, because
// the prompt lab's single-block view collapses all three blocks and shows no
// per-turn brief at all.
//
// THE RELATIONSHIP ENGINE ITSELF IS UNTOUCHED. The graph still resolves a
// state with evidence, `guest_relationship_states` still gets its row, and the
// gate still conditions on `stateKey`. What changed is that none of it is
// rendered into a prompt. That makes `lib/relationship` a system whose output
// no model reads today, which is worth knowing before anyone measures it.
//
// NO SEPARATE VERSION FOR IT. The frame half of this bump sat in an
// uncommitted tree for about an hour before the ruling, so both halves ship as
// v2.22.0 - checked rather than assumed: zero `eval_judgments` rows carry a
// v2.22 version (the judges are off globally anyway) and no playground
// conversation was saved on 2026-10-15, so nothing stored names a v2.22.0 that
// had those sections in it.
//
// THE BRIEF CHANGED IN THE SAME RULING, and it is venue data rather than
// template copy. Le Mil's `venue_configs.knowledge_brief` is replaced
// WHOLESALE by the document's `# What you know` ("abandon the original",
// owner-ruled 2026-10-15), 40,960 -> 41,671 chars. Eight of the ten edits are
// facts; two are behaviour and are recorded here because nothing in the
// template says them:
//
//  - `<refunds_and_complaints>` says to offer a remake first and not to pass a
//    drinks complaint to the team, REVERSING the `<house_rules>` paragraph it
//    replaces. It does not change who sees the draft: `complaint_resolution`
//    (lib/policy/default-policies.ts) matches a draft that answers the
//    substance of a complaint, so the reply still queues for an operator, and
//    a free remake needs a declared `comp` action under this frame's own hard
//    line. What changed is what the draft says, not whether it auto-sends.
//  - `<instagram_context>` makes the venue's own feed answerable, the theft
//    post included. It is the first content in the brief that is about posts
//    rather than about the house.
//
// v2.21.0 (owner-approved 2026-10-13): the OUTREACH lane - the prompt can now
// compose a venue-initiated turn, for the v2 follow-up system (a conversation
// that ended on us and went quiet for about a day gets one check-back).
// `V2_GUEST_STATE` gains a trailing `{followup_note}` placeholder; on an
// inbound turn it fills with '' and the composed prompt is BYTE-IDENTICAL to
// v2.20.0, which is what keeps this bump a no-op for every existing caller.
// On an outreach turn it fills with `V2_FOLLOWUP_NOTE` (below) and the turns
// array gains one fixed synthetic final user turn, `V2_FOLLOWUP_CUE` - the
// documented-legal shape, chosen over trailing-assistant prefill, which is
// untested in this repo under structured output on any profile.
//
// The note renders LAST in HOUSE NOTES because later beats earlier and the
// outreach turn is about exactly that thread; `{open_moves}` fills with ''
// on outreach turns so "your one question is for these" never composes
// against "pick the thread up where it left off".
//
// NO per-turn text enters blocks 1 or 2 - the note is block 3, the cue is a
// turn, and the venue prefix cache is untouched by construction.
//
// WHETHER a follow-up happens is not this file's concern: code detects the
// silence (phase B), the operator approval queue releases the draft (the
// `outreach_requires_approval` policy row), and this copy only governs what
// the model writes once the turn runs.
//
// v2.20.0 (owner-authored 2026-10-13, approved verbatim): the frame is the
// owner's own hand-written prompt, promoted out of /admin/prompt-lab. `# Who
// you are` roughly triples, `# How you answer` is new, `# Texting style` is
// rewritten, and two opt-out bullets join `# Rules`. The owner wrote this copy
// against the golden set by hand; what follows is the record of what it
// overrides, same as v2.13.0.
//
// WHAT IT WAS PROMOTED FROM IS NOT WHAT SHIPPED. The source was ONE flat
// 49,100-char system block from the prompt lab's `replaceSystemText` path, so
// it contained no block structure, no `{placeholders}`, and - because that
// surface collapses all three blocks - neither `# How you sound` nor HOUSE
// NOTES. Four parts of it went four different ways:
//
//  - The frame is below, with `{venue_name}`, `{speaker_clause}`,
//    `{instagram_clause}` and `{length_clause}` restored. "Neha" and
//    "@lemilscoffee" are NOT in this constant, for the reason the v2.14.0
//    entry and the note above V2_PROMPT_VERSION both give: this is the global
//    default row. The name survives as venue data - Le Mil's brief states it
//    under `<who_you_are>` - and the handle arrives through the clause.
//  - `#Time 10AM Oct 13, 2026.` was hand-typed at the top. It is now
//    `{now_line}`, FIRST IN HOUSE NOTES and nowhere else: a clock-derived line
//    in block 1 or 2 invalidates the cached prefix in front of it on every
//    turn, which is the 2026-10-08 defect exactly (lib/relationship/
//    CLAUDE.md states the rule for the venue profile). Without it `When asked
//    about time` pointed at a fact no v2 prompt contained.
//  - `# What you know` plus its `<venue_knowledge>` block is
//    `venue_configs.knowledge_brief` - venue data, not template. The pasted
//    copy is 44,393 chars against the 40,960 stored, so the brief in the
//    database is BEHIND the prompt this entry was written from.
//  - `## Opt-out and opt-in` became two `# Rules` bullets. The owner's
//    document had them last, which is the more proximate slot, and they are
//    here instead because every other hard line is here and because
//    `guestState` goes to the judge as `situationBrief`.
//
// `# How you sound` IS CUT from `V2_HOUSE_SECTIONS_BRIEFED` (owner-ruled
// 2026-10-13, "remove # How you sound for now"), against the recommendation to
// keep it. It removes 65 active `voice_corpus` rows and 5,698 chars of the
// team's own approved replies from every briefed venue's prompt, and the
// `{voice_pack}` input is now rendered for a venue with NO brief only.
// `V2_HOUSE_SECTIONS` is untouched and still carries it, which is what keeps
// this half of the bump a no-op outside Le Mil's.
//
// WHAT IT SETTLES, stated because it has been live and unresolved since
// v2.6.0: the voice pack sat LATER in the composed prompt than this file and
// out-ranked it by proximity, which is the standing contradiction the v2.7.0
// and v2.18.0 entries both flag and the reason two of haiku-5-5's three
// breaches were attributed to `voice_corpus` rows. Nothing in a briefed
// prompt now argues against the frame. The cost is that nothing measured
// speaks for how the venue actually writes either - decision 0010's whole
// subject - and `{length_clause}` is the only measured input left in a
// briefed prompt.
//
// FOUR DEVIATIONS FROM THE OWNER'S TEXT, each approved 2026-10-13:
//
//  1. `Each is usually under 15 words.` -> `{length_clause}`. Decision 0010:
//     how long a venue's replies run is measured from its team's history and
//     never authored by us. Keeping both would put two authors on one question
//     with the later one winning, which is that decision's named failure. At
//     Le Mil's this renders 12-22-40 (v2.15.0); at a venue with no profile it
//     renders nothing and "short" carries alone.
//  2. `Where an em or en dash would land, end the sentence and start a new
//     one.` RE-ADDED to the punctuation paragraph. The owner's list dropped
//     it, `replaceDashesWithPeriod` still runs at the generation seam, and a
//     substitution and its constraint text must agree (lib/ai/CLAUDE.md).
//  3. "with with" -> "with", "its" -> "it's".
//  4. Blank-line runs collapsed to one; trailing spaces stripped.
//
// `No emoji, ever.` IS GONE, replaced by `Replace your emojis with ":)"`. Read
// entry 0 under v2.13.0 before touching this: softening that line is the only
// true-positive v2.7.0's lesson has ever had, measured at 83 EMOJI ACROSS 11
// OF 13 SCENARIOS at n=6. This is a substitution rather than a frequency word,
// which is the form that has worked here, and `:)` is ASCII - so the `emoji`
// regression tell still counts exactly the failure, and a clean run on it is
// the measurement this change owes. The eight emoji-bearing voice_corpus rows
// that used to argue the other way are no longer in a briefed prompt.
//
// `respond nothing` HAD NO MECHANISM and now has a partial one.
// `GenerationOutputSchema.messages` is `.min(1)`, so the model's only
// compliant move on an opt-out was an empty-ish bubble, and the gate exempts
// `opt_out_request` from queueing (POLICY_EXEMPT_SITUATIONS) - so that bubble
// would have auto-sent. generate.ts now drops blank bubbles after the
// MAX_MESSAGES slice, so the turn yields zero messages instead of one empty
// one (owner-ruled 2026-10-13). The schema floor stays: nothing can make the
// model return an empty array, so this is a filter, not a guarantee.
//
// WATCH ITEMS - new copy nothing enforces. `React to the person before the
// logistics`, `invite, never instruct`, `You're discreet`, the gist-not-exact
// pair and `Never say the same thing twice in different words` are all judged
// axes (Reading the guest, Economy, Host ownership), not deterministic tells.
// No regression scenario was added for any of them because none is countable,
// and a `trailing-period` ceiling for `No period at the end of a message` was
// proposed and declined (owner-ruled 2026-10-13). Two scenarios WERE added -
// `media-request` and `opt-out-request` - because those two are.
//
// THE BUBBLE-COUNT AND SPLITTING LINES ARE NEWLY AUTHORED STYLE. `Send 1 to 3
// short messages`, `Anything beyond that goes in its own message` and `No
// period at the end of a message` legislate what actions.ts called the model's
// own job ("the model owns splitting; bubble quality is judged per-response,
// not legislated") - that comment is corrected in this bump. This is not a
// decision-0010 reversal: 0010's mechanisms (`bubbleStyleFor`, the emoji coin,
// the split share) are v1's and v2 has never read them. `MAX_MESSAGES` is
// still 4, so the prompt now asks for less than the contract allows.
//
// v2.19.0: THE GUEST'S MEDIA REACHES THE PROMPT. No template copy changed in
// this bump - not one character of the four constants below - and it is still
// a version, which is the opposite call from the 2026-10-08 cache split. The
// test is what the MODEL is handed: that split was byte-identical on every
// turn, so there was nothing to key. This adds bracketed lines to the turns of
// a prompt whenever the guest sent a photo, a voice note, a video, a story
// reply or a share, so a trace or an `eval_judgments` row stamped v2.18.0
// could not have carried them. Every turn WITHOUT media composes
// byte-identically, which is why no existing measurement moves: all four
// harnesses run sandbox guests that declare none.
//
// WHAT WAS BROKEN. v2 took text only. The transcript query selected `body` and
// dropped every row whose body was empty, so a guest's photo was invisible -
// not mentioned on the turn it arrived, not in the transcript an hour later,
// and nothing holding the reply. At Le Mil's that is not an edge: ALL 120
// attachments on the venue are on messages with no text, so v2 read those
// turns as a guest who had written nothing at all.
//
// NO NEW WORDING, deliberately, and this is the reason the bump carries no
// copy change. Every sentence comes from `lib/ai/prompts/attachment-lines.ts`,
// owner-approved verbatim on TAC-582 and TAC-584 and already in front of
// guests through v1. Writing a v2 phrasing of "a photo arrived and you cannot
// see it" would have put two approved-looking wordings of one fact in the
// codebase, and v1 paid for that sentence twice already - the bare marker made
// the model tell guests the photo "didn't come through" (5 of 20), and the
// fixed wording is what replaced it.
//
// THE LINES ARE THEIR OWN TURNS, not a prefix on the guest's message. This
// file's composer never wraps the guest's words in anything, and the SDK
// merges same-role runs into content blocks, so what the model receives is one
// user message with the guest's text verbatim in its own block. The media line
// sits AFTER it, which is where v1 renders it and where the rules for replying
// to a picture belong: later beats earlier, and "name none of the menu" in
// front of the guest's message would be the weakest position in the prompt.
//
// THE HOLD IS A POLICY ROW, not copy: `guest_media_requires_approval`
// (lib/policy/default-policies.ts), which is v1's `media_context` trigger in
// v2's vocabulary. Owner ruling 2026-10-11, measured on v1 and not to be
// relitigated with wording: the model never described a photo it had not seen,
// but told guests "we can't see it on our end" in 7 of 20 replies, and two
// rewordings moved which false thing it said rather than whether it said one.
// Do not try a third here.
//
// MEASURED ON THE REAL THREADS, 2026-10-13, four of Le Mil's own Instagram
// turns replayed against what production sent: a described media-only video
// (held, and the reply stayed inside the description), a story reply with text
// (held), the guest's NEXT text after the venue answered that story (NOT held
// for media - the negative control), and a text one second after a media-only
// share (held on the unanswered-media clause). The two new regression
// scenarios are `media-only-described` and `media-undescribed-with-text`.
//
// v2.18.0 (owner-ruled 2026-10-12): v2 stops retrieving. `# What you know` is
// no longer four `knowledge_corpus` chunks matched against the inbound; it is
// one authored per-venue artifact, `venue_configs.knowledge_brief`
// (migration 082), rendered verbatim, and the `retrieveKnowledgeContext` call
// is gone from run-turn.ts. v1 still retrieves through lib/agent/stages.ts;
// the table, the rows and the /admin corpus editor are untouched.
//
// WHY, in the owner's terms: putting the facts back into retrieval is a bet
// that the right row gets retrieved, and nobody has measured whether it does.
// The brief removes retrieval as a variable so the replies can be judged on
// the facts alone. The intent is to move some of it back once the replies are
// good, which is a decision this change deliberately defers rather than makes.
//
// THE SECTION MOVED TO BLOCK 2, which REVERSES the 2026-10-08 split, and the
// reason that split was right is the reason this is safe. What broke then was
// VOLATILITY, not position: retrieval ran per turn, so ~150 changing tokens at
// the end of the cached venue block invalidated ~6,100 static ones every turn.
// A column is static per venue. The block 2 contract is unchanged and this
// obeys it. ANYTHING that makes the brief per-turn breaks the cache exactly
// the way retrieval did - `cold-latte-cache-probe.ts` is the check.
//
// It renders BETWEEN the venue profile and the voice pack. That is further
// from the guest's message than block 3 ever was, which strengthens the
// proximity argument `V2_GUEST_STATE`'s header makes rather than dropping it,
// and it leaves `# How you sound` in the last position it already held.
//
// WHAT TO WATCH, and it is not the facts. The brief carries a `<house_rules>`
// section because ~20 corpus rows were written as INSTRUCTIONS, not facts, and
// worked only because retrieval surfaced them on topic. They now render on
// every turn, which is the hazard scripts/CLAUDE.md records as measured ("an
// imperative in the corpus outranks a universal rule"). Two specific tells: an
// unearned Google review ask, and offering a mechanic (roasting session, bean
// sample, referral surprise) to a guest who was never chosen for one. If
// either appears, the fix is that section's position or its existence, not the
// facts above it. The right long-term home is a per-venue instruction slot in
// block 1, which does not exist yet.
//
// The brief also carries the only copy of the assistant's own name. `grep -rn
// "Neha" lib/ app/` returned nothing before this bump: it lived in corpus row
// af9b59db and reached the model only when retrieval happened to surface it.
//
// ALSO IN THIS BUMP (owner-written verbatim 2026-10-12): a second hard line
// about inventing, this time about OTHER guests. The first line has always
// covered this guest - visits, orders, preferences, history - and nothing
// covered claims about other people, so "everyone loves it" and "the regulars
// all order it" sat outside every rule in the prompt. It goes SECOND, next to
// the line it pairs with, rather than last where the list has most authority;
// if fabricated crowd claims survive, last position is the lever to try before
// any rewording.
//
// It is NOT a generic prohibition, which is the form v2.5.0 measured at 0/3
// across eight variants. It names the four shapes, and it names the permitted
// case - the model's own taste, with an example - so there is something to
// comply WITH rather than only something to avoid.
//
// It licenses what venue knowledge states, which Le Mil's brief does in two
// places on purpose ("by far the best seller", "they sell out regularly"). See
// the brief's `<house_rules>`, whose "never share rankings" clause is the one
// thing in the prompt that argues with this line.
//
// NO NEW NUMERALS COPY, and the measurement is recorded here so nobody adds
// any. v2.17.0's one sentence below does not name the sentence-initial case,
// and a longer rule naming it was drafted and then dropped, because an 8-input
// with/without on that sentence alone found it already reaches that case:
// "how much is a flat white" answered "$6" with the rule and "Six dollars."
// without it, and "how many khari" answered "2 pieces" against "Two pieces".
// 0/8 spelled against 2/8, with "just give me one thing to try" clean in both
// arms as the over-suppression control. An earlier hypothesis that the
// punctuation sentence's mark list caused it was also wrong - deleting that
// changed nothing, 3/3 spelled in both arms.
//
// THE DATA CHANGE DID SHIP, and v2.17.0 would lose without it. 39 lines of Le
// Mil's `knowledge_brief` spelled numbers out, and the brief renders in block
// 2, AFTER that line, where proximity is authority - the same mechanism that
// put a salesy knowledge row above "never salesy". Those strings are now
// numerals. The 5 `voice_corpus` rows that spell a number are deliberately NOT
// touched: that is the venue's own writing and decision 0010 says we never
// rewrite it, so the voice pack still argues with the line slightly and that
// is the correct trade.
//
// v2.17.0 (owner-ruled 2026-10-10): `# Texting style` asks for digits.
// Owner-written, one sentence:
//
//   Write numbers as digits, so 25 and not twenty-five.
//
// It sits directly after the em-dash instruction, with the rest of the
// orthography, and before the opinions sentence.
//
// NO NORMALIZER, and this one is not close. The three strippers in
// normalize-output.ts each act on a token with a SAFE substitution; word to
// digit has none - "one of our regulars", "no one", "a couple" are the common
// case, and a list narrow enough to be safe (hyphenated twenty-one through
// ninety-nine) is the case the model gets right anyway. The v1 bracket check
// is explicitly not a precedent for rewriting guest-facing text (lib/ai/
// CLAUDE.md).
//
// EXPECTED TO BE THE WORKING FORM, for whatever that prior is worth: this is a
// standing rule over a literal token class, which is what v2.7.0 measured as
// effective (0 emoji across 240 responses) as against the frequency and
// quantity wording that measured as no control at all. Note the counter-case
// in this same section - the "full stop" ban is also a literal ban and did
// nothing - but that phrase had a 1/16 base rate, so it never had an occasion
// to fire. A spelled-out number does not have that problem.
//
// IT PUSHES ON THE COLON COLLISION v2.16.0 RECORDED. Hours are stored as
// "7:00 AM - 3:00 PM" at every venue, so "what time do you open" is already
// the turn where the colon ban and the venue's own data disagree; asking for
// digits makes "7:00" the likelier draft. "we open at 7" satisfies both lines
// and is the better text, and nothing enforces it in either direction.
//
// HOW A VENUE WRITES NUMBERS IS ORTHOGRAPHY, which decision 0010 puts in the
// class measured from the team's own replies rather than written by us. It is
// shipped as our copy because `voiceProfile` measures no numeral share, so
// this overrides nothing that exists. The standing limit applies, same as the
// emoji and dash lines - the voice pack sits LATER in the composed prompt, so
// a team that spells numbers out out-ranks this.
//
// v2.16.0 (owner-ruled 2026-10-09): `# Texting style` names the punctuation
// set. Two sentences, owner-written:
//
//   Punctuation is commas, periods, question marks, and line breaks only.
//   No colons, semicolons, em dashes, parentheses, or bullet points.
//
// ONE WORD IS NOT THE OWNER'S. The draft read "Punctuation:", which puts the
// banned character inside the rule banning it; `voice-profile.ts` states the
// principle ("the model echoes what it is shown") and this frame has honoured
// it for the em dash since v2.6.0. "Punctuation is" is the whole change.
//
// THE OLD EM-DASH SENTENCE WAS REWRITTEN RATHER THAN KEPT. It read
// `Never an em or en dash (— –): where one would land, end the sentence and
// start a new one` - a colon and a parenthetical, i.e. two of the five things
// the new line forbids, in the sentence immediately before it. The ban moves
// into the new list and the surviving half keeps only the instruction
// ("Where an em or en dash would land, end the sentence and start a new one"),
// which is what replaceDashesWithPeriod needs to agree with.
//
// EN DASHES ARE NOT IN THE OWNER'S LIST and are still banned, by that
// surviving clause. Do not read the list as the complete set.
//
// COLONS COLLIDE WITH HOURS, unresolved by this copy. Every venue stores
// hours as a colon-bearing string ("7:00 AM - 3:00 PM" at Le Mil's, same
// shape at all four venues), so "what time do you open" is the turn where the
// model must choose between the ban and echoing its own data. "we open at 7"
// is the better text anyway; this is flagged because nothing enforces either
// answer and a time is the one colon a person does text.
//
// NO NORMALIZER, deliberately. The three strippers in normalize-output.ts all
// act on tokens with a safe substitution; a colon has none - deleting one from
// "7:30" changes a fact, and the v1 bracket check (parenthetical.ts) was ruled
// on knowing it drops facts and is explicitly not a precedent (lib/ai/
// CLAUDE.md). If the ban measures as weak, per-character strippers are the
// wrong next step.
//
// v2.15.0 (owner-ruled 2026-10-09): `# Texting style` states how long this
// venue's replies usually run, via a fourth placeholder, `{length_clause}`.
// For Le Mil's it renders:
//
//   Your replies are usually 12 to 22 words. Over 40 is rare and needs a reason.
//
// THE NUMBERS ARE NOT OURS. They are `wordsPerReply` median, p75 and p90 out
// of `brand_persona.voiceProfile`, measured from 691 of the team's own
// replies across 306 guests - decision 0010. The owner's draft said "8-25
// words, over 40", which was 40 exactly (reply p90) but mixed units on the
// band: 8 is the BUBBLE median and 25 sits near the reply p75 of 22. This
// venue's splitShare is 1.0, so reply and bubble lengths genuinely differ
// (12-22-40 against 8-13-22) and the sentence says "your replies". Derived
// per reply, ruled 2026-10-09. The draft's en dash also went: the clause
// three sentences later bans en dashes.
//
// WHY IT MIGHT DO NOTHING, stated before the measurement rather than after:
// v2.7.0 found standing prohibitions work on literal tokens while FREQUENCY
// AND QUANTITY wording measured as no control at all, and this is that class.
// The honest expectation is that it is weak. What makes it worth shipping
// anyway is that it is the first copy in this frame whose compliance is
// countable from the venue's own data: `countReplyWords` against p90 is a
// bar, not an opinion. `over-ceiling` in the regression tells is the count.
//
// It is NOT a substitute for porting v1's length check (reply-length.ts),
// which retries once and ships the retry only if it is shorter and kept the
// facts. A prompt line has no retry and no keepsTheFacts floor.
//
// v2.14.0 (owner-ruled 2026-10-09): the frame names the venue's OWN Instagram
// handle - `this is your Instagram inbox, @lemilscoffee` - via a third
// placeholder, `{instagram_clause}`, built exactly like `{speaker_clause}`.
//
// THE MODEL DID NOT KNOW WHICH ACCOUNT IT WAS. It had the handle only as a
// retrieved fact (a knowledge_corpus row, gated on the guest asking about
// social), so asked for farm photos it answered "the best place to look is
// our Instagram. @lemilscoffee is where Himanshu and Milana share that side
// of things" - to a guest already in that inbox. Measured in a 29-question
// sweep, 2026-10-09. The frame already said "this is your Instagram inbox"
// and the handle already existed; nothing joined them.
//
// SOURCED FROM `instagram_credentials.instagram_username`, the account the
// venue connected by OAuth - NOT a venue_info field. A hand-typed handle can
// drift from the real inbox, and the whole point of the clause is to say
// which inbox this is. `is_active` and `deauthorized_at` are both checked: a
// disconnected account is not this inbox. The read fails OPEN to '', which
// renders the frame byte-identically to v2.13.0, so a venue with no connected
// account is unaffected and no turn is ever held over it.
//
// NO RULE SHIPPED WITH IT (owner-ruled). The obvious companion - "never send
// the guest to your own Instagram, they are already there" - was proposed and
// declined in favour of giving the model the fact and nothing else. If the
// redirect survives, that is the next arm, and `off-channel-redirect` in the
// regression harness is the tell. Note that tell did NOT fire on the sweep
// reply above: it matches only preposition-led forms ("through Instagram",
// "via Instagram", "DM us") and deliberately not the bare "our Instagram",
// so it under-counts this exact shape.
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
export const V2_PROMPT_VERSION = 'v2.23.0-draft'

/** Block 1: ROLE. Static across every venue bar the four placeholders. */
export const V2_FRAME = `# Who you are
You are the host at {venue_name}, and this is your Instagram inbox{instagram_clause}. You represent {venue_name} and communicate with guests in their IG DM.
You can't send photos, videos or files. Never say so, and never lead with
what you can't do. When a guest asks to see something, the answer is where
they can see it.
If someone from the team has written in this conversation, continue as
"we". Never introduce yourself or say who you are unless the guest asks.

You're warm but not tryhard. You're easy to talk to, but you don't write in prose.

You are proud of the stories behind this business and happy to share.

React to the person before the logistics. If they're planning something,
had a good time, or had a bad one, your first words respond to that,
briefly and genuinely. Then the facts.

You have opinions about the menu and share them plainly.
You're never salesy and never servile.

You're discreet. You use what you know about a guest to be thoughtful, never to show off, never in a way that feels like you're watching them.

You're curious about people, and you show it the way a good host does,
with easy questions. When you want to know something, you just ask it
plainly, the way you'd ask a friend across the counter. "What's the
occasion?" "How many of you?" You never make people work to talk to you.
You'd never ask someone to describe or explain themselves, and handing
someone a list of things to send you isn't something you'd ever do.

You're patient. You don't need everything at once. You ask about the
one thing that matters most and let the rest come up as you talk.

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
links, contact details, and opening times, dates.

# Texting style
Always send URLs in a separate bubble.
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

/**
 * Price discretion, and it lives in BLOCK 2 - AFTER the venue's facts and not
 * in the frame's `# Rules` - because the thing it has to beat is a sentence in
 * those facts.
 *
 * WHAT IT IS FOR: the venue's own material carries a price on nearly
 * everything, and a guest who asked whether something exists was getting the
 * charge thrown in. Measured on v2.22.0-draft before this section existed:
 * 25% of replies to eight questions that ask nothing about cost quoted a price
 * (10/40, n=5). Every one of those ten was the same defect - Le Mil's brief
 * says "Oat milk is the only non dairy option and costs $0.25 extra", one
 * sentence welding a price to an availability fact, and the model reproduced
 * the sentence whole on both "do you have oat milk?" (5/5) and "what milk do
 * you use?" (5/5). The other six questions were already clean.
 *
 * WHY POSITION, NOT WORDING, WAS THE PROBLEM. The frame already said "never
 * volunteer price unless asked" and listed prices among the things to "only
 * answer casually", and both lost to that one sentence: later beats earlier in
 * a composed prompt, and block 2 is later than the frame. A fourth restatement
 * in the frame would have lost the same way. Those two weaker mentions are
 * GONE rather than kept alongside this - the prompt's own rule is never to say
 * the same thing twice in different words, and three half-rules in three
 * registers is what let the brief win.
 *
 * THE UNWELDING SENTENCE IS THE LOAD-BEARING ONE: "where something above
 * states a price in the same breath as another fact, those are two facts". It
 * is what makes this generic rather than a rule about oat milk - any venue
 * whose brief couples a charge to a fact gets the same treatment, and nothing
 * here names an item, a venue or a figure.
 *
 * The last sentence is NOT padding. Without it the rule reads as "prices are
 * sensitive" and suppresses the answer to "how much is a latte" - which is why
 * the harness measuring this carries a quote set as a ceiling
 * (`scripts/measurement/price-discretion.ts`).
 *
 * Shared by both block-2 variants, briefed and profile-rendered, because a
 * rendered venue profile lists a price on every menu item too.
 */
const V2_PRICE_IS_ITS_OWN_FACT = `# Price is its own fact

What you know carries a price on nearly everything. A price is part of your
answer only when the guest asked what something costs. Asking whether you have
something, what it's like, what's in it, or whether it can be made a certain
way is not asking what it costs, and what an extra or an add-on costs is a
price too. Where something above states a price in the same breath as another
fact, those are two facts, and the one they did not ask for stays unsaid. When
a guest does ask what something costs, give the figure plainly.`

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

${V2_PRICE_IS_ITS_OWN_FACT}

# How you sound

{voice_pack}`

/**
 * Block 2 for a venue that HAS a `knowledge_brief` (v2.18.0). The brief
 * replaces `renderVenueProfile` outright rather than joining it, so this
 * constant has no `{venue_profile}` and that is the point - see compose.ts,
 * where the two were concatenated for one afternoon and rendered the whole
 * menu twice in two voices that disagreed about which items are vegan.
 *
 * The brief therefore owes everything the renderer used to supply, including
 * hours and the dated `currentContext` notes. `renderRightNow` filtered those
 * against `now`; prose cannot, so a date in the brief outlives itself and the
 * brief's own `<whats_on>` paragraph tells the model to check one against
 * today. That is a real decay cost, owner-ruled 2026-10-12 with the
 * alternative on the table.
 *
 * `V2_HOUSE_SECTIONS` stays byte-identical to its pre-v2.18.0 self, which is
 * what makes this bump a no-op for every venue whose brief is NULL.
 *
 * `# How you sound` LEFT IN v2.20.0 AND CAME BACK IN v2.22.0 (owner-ruled
 * 2026-10-15, "keep my own reply examples"). The cut lasted two days; what it
 * bought and what the restoration gives back is on V2_PROMPT_VERSION. The
 * short version: the pack sits later in the prompt than the frame and
 * out-ranks it by proximity, so a venue whose own corpus carries emoji, a
 * spelled-out number or a scripted name-ask is arguing with `# Texting style`
 * again - and the measured account of how the team actually writes is back in
 * the prompt, which is what decision 0010 is about.
 *
 * IT IS IN BLOCK 2, NOT HOUSE NOTES, which is where the owner's own document
 * had it. The pack is static per venue, so here it caches behind the one
 * breakpoint; in HOUSE NOTES it would re-send ~5,700 chars on every turn for
 * the one thing the cut was made to take away, proximity.
 */
export const V2_HOUSE_SECTIONS_BRIEFED = `# What you know

{knowledge_brief}

${V2_PRICE_IS_ITS_OWN_FACT}

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
 * `## What you know` USED TO LEAD this block, for the reason that it was the
 * one section not about this guest and proximity is authority - a knowledge
 * row has out-ranked a tier-0 frame line once (v2.12.0's off-channel
 * redirect). It left in v2.18.0 for block 2, which is further from the
 * guest's message still, so that argument is satisfied more strongly rather
 * than abandoned. Everything in here is now about this guest, which is what
 * the block was named for. `off-channel-redirect` in the regression harness
 * remains the tell.
 *
 * `## Right now` IS THE ONE SECTION HERE THAT IS NOT ABOUT THIS GUEST, and it
 * is here because it cannot be anywhere else: it is derived from the clock, so
 * blocks 1 and 2 are closed to it by construction (compose.ts's header, and
 * lib/relationship/CLAUDE.md on why `renderVenueProfile` taking `now` is safe
 * only because no reader of it is live). SINCE v2.22.0 IT IS THE ONLY SECTION
 * HERE on an inbound turn - the clock, and on an outreach turn the note.
 *
 * WHAT LEFT, owner-ruled 2026-10-15 ("we should disable these sections", after
 * reading them in the playground and saying they were not expected): the state
 * line and mission, the guest profile, the interaction memory, and the open
 * moves with their header. The four of them WERE this block; what remains is
 * the one line that is not about the guest at all.
 *
 * WHAT THAT TURNS OFF, stated in full because none of it fails loudly:
 *
 *  - NO MISSION. The graph still resolves a state and the gate still reads
 *    `stateKey` (policies condition on it), but the model is no longer told
 *    what the house is trying to do at this stage. `relationship_graphs` rows
 *    and `guest_relationship_states` are untouched; the mission text is simply
 *    not rendered anywhere.
 *  - NO PURSUIT MECHANISM. The moves header is the unit v2.11.0's
 *    leave-one-out named as the one governing whose turn the question is -
 *    dropping it was the only one of 22 units that restored an answer, 3/3.
 *    Asking is now entirely the frame's own curiosity paragraph (v2.22.0), and
 *    `bare-hey` and `turn-one-move` are where that shows up. Every pursuit bar
 *    in the regression harness was ALREADY unmeasurable with the assessor off,
 *    so this does not change a green to a red; it changes what the agent does.
 *  - NO PROFILE OR MEMORY IN THE PROMPT. Both were written only by the
 *    assessor, which is off (`ASSESSOR_ENABLED`), so both sections could only
 *    ever render their fallback sentences - "Nothing on file yet" above a
 *    transcript that said otherwise was the 2026-10-08 cold-latte failure.
 *    IF THE ASSESSOR COMES BACK ON, it will write a profile and a memory that
 *    nothing renders. That is the thing to re-add here first.
 *  - THE JUDGE'S BRIEF IS NOW THE CLOCK. `composePrompt` returns this block as
 *    `guestState` and the judge takes it as `situationBrief`, so Recognition
 *    and Reading the guest are scored against one line. The `tested` flag is
 *    what keeps that honest rather than a filler 3 (lib/eval/judge.ts).
 *
 * THE COMPOSER STILL RECEIVES ALL FIVE INPUTS, and that is deliberate: every
 * archived set from v2.17.0 to v2.21.0 carries their placeholders, and `fill`
 * ignores a value whose placeholder is absent. Do not tidy them out of
 * `ComposeInput` - the same note `voicePack` carries.
 */
export const V2_GUEST_STATE = `HOUSE NOTES (yours alone - the guest never sees this)

## Right now
{now_line}{followup_note}`

/**
 * The outreach section, filling `{followup_note}` on an OUTREACH turn only -
 * an inbound turn fills '' and composes byte-identically to v2.20.0. Leading
 * blank lines are the join with `{now_line}` above (they joined `{open_moves}`
 * until v2.22.0 emptied this block of everything else). `{hours_quiet}` is the
 * one substitution, done by the composer.
 *
 * It sits LAST in HOUSE NOTES deliberately: proximity is authority, and the
 * outreach turn exists for this thread and nothing else. Since v2.22.0 it is
 * also the only thing in here besides the clock, so on an outreach turn this
 * note IS the brief - which is the one place that bump made the block stronger
 * rather than thinner.
 */
export const V2_FOLLOWUP_NOTE = `

## Why you're writing first
The guest hasn't written since your last message, about {hours_quiet} hours ago. You're reaching out, not replying. Pick the thread up exactly where it left off - specific to what was said, never a survey. Never open with a greeting that ignores the conversation, never repeat an unanswered question word for word, and never mention the silence.`

/**
 * The fixed synthetic final user turn on an outreach turn. Variable-free: the
 * elapsed time lives in the note above, so this constant is the same bytes on
 * every outreach turn everywhere.
 *
 * It exists because the turns array must not end on an assistant turn -
 * trailing-assistant is prefill semantics under structured output, untested
 * in this repo on any model profile - and because the most-proximate slot is
 * the right place to say whose turn this is. Bracketed, machine-authored,
 * self-describing: it is NOT the guest's words and never wraps any.
 */
export const V2_FOLLOWUP_CUE = `[The guest hasn't replied. This turn is yours - you're writing first. HOUSE NOTES says why.]`
