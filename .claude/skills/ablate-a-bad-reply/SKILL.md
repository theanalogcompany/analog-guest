---
name: ablate-a-bad-reply
description: Root-cause a bad v2 agent reply (wrong deflection, fabricated fact, wrong tone, missed answer) down to the single prompt unit or data row that causes it, by leave-one-out ablation. Use when someone says "it shouldn't say X" about a playground conversation, a saved playground conversation, a Langfuse trace, or a production reply.
---

# Ablate a bad reply

The deliverable is **one named unit** - a config row, a knowledge row, a profile line, a
template clause - that, when removed or rewritten, makes the defect go away, plus the sibling
inputs that prove the rewrite broke nothing. Anything short of that is a guess.

The repo rule this implements: *fix the mechanism, never the symptom, and find the mechanism
by ablation* (root `CLAUDE.md`). A fix is not proposed until something was removed and the
defect went away.

## Do not use `runTurn` in the ablation loop

This is the single biggest time sink and the reason this skill exists.

`runTurn` awaits the semantic check, the judge **and** the assessor so the TurnTrace is
complete for the inspector (its own header says so). That is ~40s a sample. An ablation
question only ever needs the draft, which is ~8-12s.

Call `runTurn` **once** to harvest the live sections, then loop on
`composePrompt` + `generateV2Reply`. A 5-arm x 3-sample matrix drops from ~10 minutes to
~75 seconds, and the arms run concurrently.

```ts
const seed = await runTurn({ venueId: VENUE, guestId: null, inbound: ['hi'] })
// seed.sections.{venueName,venueProfile,voicePack,knowledge,guestProfile,
//                interactionMemory,openMoves} and seed.state.{label,resolvedKey,mission}

const prompt = composePrompt({
  venueName: seed.sections.venueName,
  speakerClause: '',
  venueProfile: arm.profile,          // <- the unit under ablation
  voicePack: seed.sections.voicePack,
  knowledge: arm.knowledge,           // <- or this one
  history: testCase.history,
  stateLabel: seed.state.label,
  stateKey: seed.state.resolvedKey,
  mission: seed.state.mission,
  guestProfile: seed.sections.guestProfile,
  interactionMemory: seed.sections.interactionMemory,
  openMoves: seed.sections.openMoves,
  inboundMessages: testCase.inbound,
})
const r = await generateV2Reply(prompt)
```

**Retrieve per case, not once.** `seed.sections.knowledge` is the retrieval for the *seed*
inbound, not for your test case. Freezing it silently gives every sibling the wrong knowledge
and invents defects that are not there (it made a wholesale question look like the agent
denied wholesale). Call `retrieveKnowledgeContext({venueId, query: inbound.join('\n').slice(0, 500), limit: 4})`
per case - the same call `run-turn.ts` makes.

Scratch scripts go in `scripts/_scratch-*.ts`, run with
`npx tsx --env-file=<main checkout>/.env.local scripts/_scratch-x.ts`, and are **deleted when
done**. A worktree has no `.env.local` of its own; never write one. If the harness earns a
place in the repo, it moves to `scripts/measurement/` and takes on that directory's
conventions (`scripts/CLAUDE.md`) - timestamped run log, checkpointing, arm recorded in the
file.

## Binary search does not work here, and repeats are not optional

Generation is nondeterministic. A single sample per arm cannot distinguish "this unit caused
it" from "the model did something else that time". **3 samples minimum per arm per case**, and
report every sample, not a rate - the bodies are the evidence and a phrase-list detector
systematically under-counts whichever arm is not echoing a script
(`scripts/CLAUDE.md`, rule 7).

Bisection also mis-frames the search: causes compose. Two units each produced the handoff in
the case the other did not cover, so a bisect would have "found" one and stopped.

## The procedure

1. **Reproduce the exact turn first.** Load the real artifact - the saved playground
   conversation row, the Langfuse trace, the message thread - and rerun it. Rebuild history
   the way the client does (`sessionHistoryFromTurns` in
   `app/admin/(authed)/playground/_lib/history.ts`); a hand-typed approximation is a different
   input. Confirm the defect appears in your rerun before touching anything. If it does not
   reproduce, you are debugging the wrong turn.

2. **Enumerate candidate units from the composed prompt, not from memory.** Dump
   `trace.composed.system` blocks and `trace.composed.turns`, then grep them for the offending
   content and its near-synonyms. Only what is actually in the prompt can be the cause. In the
   buyout case this cut the candidate set from "the whole persona config" to three lines,
   because `brand_persona.tone` - which read exactly like the culprit - **is not composed into
   the v2 prompt at all**.

3. **Check what retrieval actually returned.** It is often nothing relevant. A short follow-up
   ("next month") has no topical signal, so the knowledge rows that would have said the right
   thing were never retrieved. A knowledge row cannot be the cause of a turn it was absent
   from - and "the right row exists but never arrives" is itself a finding worth reporting.

4. **Leave one out, then leave out combinations.** Arms: control, minus-each-unit,
   minus-all. `TurnOverrides` replaces a rendered section wholesale
   (`venueProfileText`, `knowledgeText`, `voicePackText`, `guestProfileText`,
   `interactionMemoryText`, `openMovesText`, `mission`, `stateKey`), so most ablations are a
   string edit on `seed.sections.*`. There is no override for the template frame - to ablate
   that, edit `lib/ai/prompts/` locally and revert.

5. **Deletion often does not fix it - try the positive rewrite.** This is the most useful
   finding in the skill. Deleting a bad capability line left a vacuum that the model filled
   the same way, because the surrounding copy ("Anything not listed here has not been stated
   either way") plus a staff roster naming an owner still pointed at a handoff. Replacing it
   with an affirmative "this is handled here" was 3/3 clean while deletion was 0/3. **If
   minus-all still shows the defect, you have not found the mechanism - widen, and test
   rewrites, not just removals.**

6. **Measure the fix on siblings it was never tuned on, plus the case the unit exists to
   protect.** Copy that names the failing input passes its own test and leaves every sibling
   broken. For a contact-deflection bug the siblings are: the adjacent services (catering,
   wholesale, events), a direct ask for the thing you removed ("what's your email" - giving it
   is *correct* there), and the negative the unit was written for (the venue genuinely does
   not do X). Cross the fixes: a 2-cause bug needs a `V only` / `K only` / `V+K` grid, or you
   will ship half of it and call it done.

## Where the causes actually live

Ranked by how often they are the answer, and none of them is code:

| unit | storage | how it reaches the prompt |
| --- | --- | --- |
| capability lines | `venue_configs.venue_info.services.alsoOffers` / `alsoDoesNotOffer` | `renderWhatYouDo`, `lib/ai/v2/venue-profile.ts` |
| knowledge rows | `knowledge_corpus.content` | retrieval, top 4 per turn |
| contact, staff, room notes | `venue_configs.venue_info.*` | `renderVenueProfile` |
| voice examples | `voice_corpus.content` | `loadVoicePack` (static per venue, no similarity) |
| state mission, move goals | `relationship_graphs.graph` | the HOUSE NOTES brief |
| frame and hard lines | `lib/ai/prompts/` | system block 0 |

`alsoOffers` is free text and is therefore the highest-leverage place for a wrong instruction
to hide: it renders inside `- You do offer: ...`, which the model reads as settled house
policy, and it **outranks the knowledge section**. Two knowledge rows said "interested guests
can ask here" and lost to one `alsoOffers` string saying the owner handles it by email.

`venue_configs` is operator-owned data. A fix there is a plan item for the operator to apply,
not an edit to make - and prompt-facing copy goes through the plan gate verbatim
(root `CLAUDE.md`).

## Report

- the defect, quoted from the real reply
- the guilty unit, by table, column and verbatim content
- the ablation grid: arms x cases, every sample body, control included
- the proposed rewrite verbatim, with its sibling results
- what you could not explain. A unit you suspected and cleared is worth a line - it stops the
  next person re-testing it.
