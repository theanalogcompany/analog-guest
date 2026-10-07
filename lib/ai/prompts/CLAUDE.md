# lib/ai/prompts - the composed prompt

Loads only when you work in this directory. Call mechanics and schemas are in
`lib/ai/CLAUDE.md`.

**Voice is the product.** A change here changes what every guest at every venue reads, so
this directory is plan-gated: write the plan, post it, get approval, then build. A change
to guest-facing copy shows the new wording verbatim in the plan.

## Assembly order, and why it decides everything

`composePrompt` builds: template -> persona -> venue_info -> voice corpus -> knowledge
corpus -> category instructions. Then the runtime context as the user prompt.

**Later beats earlier.** `# Voice imperative` tells the model the venue's voice wins when
things conflict, and the model reads proximity as authority. This is the single most
expensive lesson in this directory and it has been paid for at least six times:

- A universal rule positioned ahead of `# Voice imperative` still lost to persona content
  rendered later.
- A category instruction (rendered **last**) silently vetoed the intentions block, twice,
  on two different axes.
- An imperative in `venue_info` beat a universal rule that invited judgement.
- A trailing user-prompt block outranked a system-prompt category instruction.

So: **a category instruction governs what the turn is ABOUT.** It may not prescribe
message structure, length, sentence count, hedging, disclosure, or whether to pursue an
open goal. Those belong to the universal layer.

## Universal voice rules

Currently R1 through R43 in `SYSTEM_TEMPLATE`. **Check the file for the count and never
trust a number quoted elsewhere, including this sentence.**

Numbering is **positional and append-only.** Never insert mid-list and never reuse a
retired id (R12 is retired). Renumbering stales every external reference. A consequence:
`UNIVERSAL_RULES_DISPLAY` curates a deliberately non-contiguous set.

**`UNIVERSAL_RULES_DISPLAY` is a dual source of truth** with the template, consumed by the
Voices rail at `app/admin/(authed)/voices/`. Add, remove, renumber or substantially reword
a rule and update both in the same commit. `UNIVERSAL_RULES_UNDISPLAYED` names every
mechanical bullet; the two sets should account for every bullet in the template with none
double-classified.

### Writing a rule

- **Scope it in the trigger clause, not as an exception bolted onto an absolute ban.** A
  same-sentence qualifier reads as self-contradicting and was caught doing so.
- **Give it a boundary against its nearest sibling** when two rules sit near each other on
  the same subject. R23 against R15, R30 against `unknown`'s holding response, R32 against
  R5, R33 against R26, R34 against R21, R35 against the category layer. A rule shipped
  without one was outranked on exactly the turns it targeted.
- **A prohibition needs an alternative**, or the venue's own content wins.
- **No venue names, no real product names.** A lowercase brand name survived a "verified
  clean" pass once; check names, not just punctuation.
- **No em dashes anywhere in prompt copy.** R3 forbids them in output and the model echoes
  what it is shown, so a dash in an example costs a regen attempt.
- A quoted example is the thing a model reproduces verbatim. Omit it when templated
  phrasing is itself the defect.

## Channel copy

The SMS text is written out in full (`SYSTEM_TEMPLATE`, `FIRST_TOUCH_OPENER`) and takes no
substitutions, so it is byte-identical by construction. The Instagram variant is that text
with a table of phrase swaps in `channel-variants.ts`.

**Branch by channel, never converge.** Neutralising both into something vaguer was
rejected: the SMS copy is correct for a guest who texted a number.

Each `from` phrase must occur **exactly once** or the module throws at load. That is safe
and deliberate - the inputs are string constants, so a miss fails at import. Editing an SMS phrase that has an Instagram twin breaks at that phrase instead
of letting the channels drift silently.

The substitution table is the scope of what may differ by channel. Widening it is a
deliberate change in its own ticket, because once the composer can vary by channel every line becomes
a candidate.

Unresolved channel (`null`) gets the Instagram copy, because that copy is false on neither
channel. It is a property of the copy, not a claim about the guest: **nothing may route a
send on `conversationChannel`.**

## Serializers

**Past messages are chat turns, not a block** (v1.81.0). `splitHistory` maps guest messages to
`user` turns and delivered venue messages to `assistant` turns, merging same-role runs so roles
alternate, and `generateMessage` sends them between the system blocks and the final user
message. A draft the guest never received is never an assistant turn; it renders in the user
prompt under `## Drafts the guest has not received`. There is no timing block, and a venue
message before the guest's first one in the window is left out. A harness that calls `generateObject` itself must send `historyTurns` too, or it
silently measures a conversation with no history.

`serializers.ts` renders the user prompt.

**The intentions block renders LAST of the content blocks**, immediately before the emoji
directive. That position is measured, not chosen: from third position the raise rate was
11%, from last it is 37%. Do not move it without re-running
`scripts/measurement/first-touch-question.ts --mode ordinary`.

The emoji directive keeps its own last-block position, separately measured.

## Things that are decided and should not be re-litigated

- **Splitting is decided in code, not by the prompt.** `[[BREAK]]` is retired and the
  template must carry no trace of it. Two prompt-side rounds
  failed identically before `lib/agent/sentence-split.ts` took over.
- **A getting-to-know-you question is separated in code, not by the prompt** (TAC-554).
  Same lesson as splitting, paid for a second time. A persona rule saying the question goes
  in its own bubble failed twice on device the day it was applied, and dispatch is why:
  `resolveDispatchBubbles` splits on sentence boundaries it can detect, so one reply rode a
  fair coin and lost and the other had no detectable boundary at all. Measured before the
  change, 0 of 21 raising turns separated it, and 18 of those 21 could not have split at any
  coin value. The `# Getting-to-know-you questions` block tells the model which FIELD the
  question goes in; it deliberately does not rule on whether to ask, which stays entirely
  the intentions block's call.
- **Emoji cadence is a per-message coin flip in code**, not a frequency word in prose. A
  frequency word has no referent inside a single generation: the measured rate was 10 of 11
  at a venue whose prompt said "not in every text".
- **`sparingly` is empirically identical to `never`** (0 of 188 measured). Recorded, not
  fixed.
- **Recognising a regular's usual order lives in R21 and R23, not in a category block and
  not behind a counter signal.** A guest with cortado on 4 of 5 visits typed "just got a
  cortado" and got "nice". The classifier is a coin flip on one word ("just got a X" is
  `casual_chatter`, "got a X" is `acknowledgment`, 4 of 4 each), both categories are silent
  on recognition, and a new one needs `messages_category_check` widened. R21 already had the
  exact trigger. **R23's carve-out looks redundant and is not:** R23 renders after R21, so on
  most-proximate-wins it beats the recognition clause, and its own "you come in so often"
  example pulls the model the other way. Delete it and the change is silently vetoed. Not
  counter-scoped: `scanArrival` is set only on the delayed scan greeting, and TAC-536's
  carry-forward reaches `visitConfirmedAt`, which goes to intention arming and never to the
  prompt. Full reasoning is the v1.75.0 header in `system-template.ts`.
- **SHIPPED UNDER ITS BAR, on a reading of the bodies rather than a rate** (ruled
  2026-09-30, four runs). Recognition 0/20 and 4/20 control to 15/20 and 16/20 treatment,
  bare labels 15/20 to 0/20: that is the deliverable. The warm half scored 9, 7, 7 against a
  bar of 18. Recorded plainly because **no passing metric covers this rule**, so a later
  regression here will not announce itself.
- **THE WARMTH JUDGE UNDER-COUNTS, compositionally rather than by degree.** Jaipal read 8 of
  20 run-4 replies as warm (freq-01, 02, 03, 08, 10, 12, 17, 19) against the judge's 7, and
  the sets **overlap on only four**. It misses a whole shape: warmth as being glad about
  something the guest did ("glad it's yours", "glad you're keeping it going"), which is what
  the ruling asked for. 7/20 is a floor on a dimension it reads unreliably. **Do not
  re-measure this dimension without fixing that** — same weakness as the item-versus-pick
  pass that already landed, one axis over.
- **Three prohibitions each DISPLACED a phrase instead of supplying warmth**: the bare-label
  ban produced "your usual" at 43%, the well-wish ban produced "that one keeps ..." at 55%,
  the widened length guide produced "coming back to" at 40%. TAC-334's and TAC-525's shape.
  **Do not add a fourth without new evidence.**
- **The length guide was NOT the constraint, measured not argued.** Widening Le Mil's
  `lengthGuide` to ask for two sentences moved median replies 11 words to 15 and moved the
  warm half not at all. Counting CLAUSES settled it: **10 of 11 misses carried two**, so the
  model had the room and spent it on a well-wish or an item detail. **Do not count clauses
  with `splitIntoSentences`** — TAC-319's dispatch splitter needs a capitalised opener, so at
  a lowercase venue it returns 1 for every reply and is blind to the question. The guide was
  ruled to stay widened.
- **FOLLOW-UP, NOT FIXED: the count ban against that widened guide.** It was 0/20 at 11
  median words and took one genuine breach at 15 ("three times and counting"), accepted for
  now, so **the ban ships measured at 1/20**. The two were measured separately and interact.
- **A persona change contaminates the control arm.** The widened guide instructs recognition
  itself, so the control (R21 and R23 sliced out) went 0/20 to 4/20 on recognition and
  warmth, and produced a count of its own. Runs either side of such a change are not a
  single-variable comparison; arms within one run stay clean, both reading the same persona.

---

Root `CLAUDE.md` is the index for the whole repo, `docs/decisions/README.md` holds the
cross-cutting decisions, and `README.md` is the navigable map of both.
