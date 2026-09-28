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
open goal. Those belong to the universal layer. `categories/index.test.ts` enforces both
prohibitions with forbidden-pattern sweeps; they are literal-revert canaries, so a
differently-worded reintroduction passes and needs a human to catch.

## Universal voice rules

Currently R1 through R39 in `SYSTEM_TEMPLATE`. **Check the file for the count and never
trust a number quoted elsewhere, including this sentence.**

Numbering is **positional and append-only.** Never insert mid-list and never reuse a
retired id (R12 is retired). Renumbering stales every external reference. A consequence:
`UNIVERSAL_RULES_DISPLAY` curates a deliberately non-contiguous set, and its test asserts
the exact id sequence rather than contiguity.

**`UNIVERSAL_RULES_DISPLAY` is a dual source of truth** with the template, consumed by the
Voices rail at `app/admin/(authed)/voices/`. Add, remove, renumber or substantially reword
a rule and update both in the same commit. `UNIVERSAL_RULES_UNDISPLAYED` names every
mechanical bullet, and a completeness test asserts the two sets account for every bullet in
the template with none double-classified.

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
- Pin a new rule in tests as **one contiguous literal**, not several fragments. A sentence
  can be reversed while every asserted fragment survives - three mutants did exactly that
  and passed 36 of 36.
- A quoted example is the thing a model reproduces verbatim. Omit it when templated
  phrasing is itself the defect, and pin the absence.

## Channel copy

The SMS text is written out in full (`SYSTEM_TEMPLATE`, `FIRST_TOUCH_OPENER`) and takes no
substitutions, so it is byte-identical by construction. The Instagram variant is that text
with a table of phrase swaps in `channel-variants.ts`.

**Branch by channel, never converge.** Neutralising both into something vaguer was
rejected: the SMS copy is correct for a guest who texted a number.

Each `from` phrase must occur **exactly once** or the module throws at load. That is safe
and deliberate - the inputs are string constants, so a miss fails every importing test and
cannot ship. Editing an SMS phrase that has an Instagram twin breaks at that phrase instead
of letting the channels drift silently.

A **scope guard** pins which lines may differ by channel. Widening it is a deliberate
change in its own ticket, because once the composer can vary by channel every line becomes
a candidate.

Unresolved channel (`null`) gets the Instagram copy, because that copy is false on neither
channel. It is a property of the copy, not a claim about the guest: **nothing may route a
send on `conversationChannel`.**

## Serializers

`serializers.ts` renders the user prompt. Block order is asserted whole in
`serializers.test.ts` - a substring assertion answers "is this fact present", only an exact
block answers "is this block what we think it is". A whole new line entered `## Right now`
once with 5,701 tests green because every assertion was a substring.

**The intentions block renders LAST of the content blocks**, immediately before the emoji
directive. That position is measured, not chosen: from third position the raise rate was
11%, from last it is 37%. Do not move it without re-running
`scripts/measurement/first-touch-question.ts --mode ordinary`.

The emoji directive keeps its own last-block position, separately measured. The full
block-order test is the only thing that catches a move past it.

## Things that are decided and should not be re-litigated

- **Splitting is decided in code, not by the prompt.** `[[BREAK]]` is retired and the
  template must carry no trace of it; a test asserts the absence. Two prompt-side rounds
  failed identically before `lib/agent/sentence-split.ts` took over.
- **Emoji cadence is a per-message coin flip in code**, not a frequency word in prose. A
  frequency word has no referent inside a single generation: the measured rate was 10 of 11
  at a venue whose prompt said "not in every text".
- **`sparingly` is empirically identical to `never`** (0 of 188 measured). Recorded, not
  fixed.
