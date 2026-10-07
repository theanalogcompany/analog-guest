import { RelationshipGraphSchema, type RelationshipGraph } from './schema'

// The seed graph every venue starts from. Ruled in the v2 redesign
// conversation (2026-10-03); the six states and the first five missions are
// the owner's own wording, edited only to make them venue-neutral ("Le Mil"
// generalized) - except first_contact's final sentence, owner-approved
// 2026-10-04 from the turn-one-move round-5 winner (see its header). The
// `routine` mission is DRAFT wording, not yet approved -
// flagged in the phase 1 report. Mission text is prompt-facing: changing a
// line here is a guest-facing-copy change under the plan gate.
//
// Venues diverge by writing a new draft row in `relationship_graphs` and
// promoting it; this constant is only the starting point and the live-boundary
// fallback (parseRelationshipGraph).
//
// The `requires` thresholds are PLACEHOLDERS, not calibrations - there is no
// v2 traffic to derive them from yet. Labelled so a bare number is not read
// as measured (the KNOWLEDGE_RELEVANCE_FLOOR lesson).

const DEFAULT_GRAPH_INPUT = {
  initialState: 'first_contact',
  states: [
    {
      key: 'first_contact',
      label: 'First contact',
      objective: 'Establish presence',
      // Final sentence appended 2026-10-04 (owner-approved, measured by
      // turn-one-move round 5): without it 1/3 of thin openers got the name
      // ask as the entire first reply. Mission-level etiquette, never a
      // scripted ask - the moves below stay goal-and-gap only.
      // "Establish a recognizable personality" CUT 2026-10-05 (owner-ruled):
      // personality is the voice pack's job - the owner's own corpus and,
      // eventually, what the venue actually sends - never a mission
      // instruction. The clause licensed performative wit ("anything catch
      // your eye, or want a nudge in a direction?").
      mission:
        'Make the guest comfortable interacting with you. Keep the welcome warm without demanding their attention. The first thing a guest ever gets from you is a welcome in the house voice; your curiosity about them earns its turn as the exchange warms up.',
      rank: 0,
      requires: [],
    },
    {
      key: 'discovery',
      label: 'Discovery',
      objective: 'Understand the guest',
      mission:
        'Learn what brought them in, what interests them, and what kind of experience they are looking for.',
      rank: 10,
      // Reached mainly by guests who start the conversation before a visit
      // (Instagram DM). A QR-scan guest usually skips straight past it: the
      // scan confirms a visit, so first_visit's frontier is already open.
      requires: [
        { kind: 'reply_count_at_least', count: 1 },
        { kind: 'assessor_judgment' },
      ],
    },
    {
      key: 'first_visit',
      label: 'First visit',
      objective: 'Deliver a memorable experience',
      mission:
        'Help them discover something they genuinely enjoy. Make the visit feel worth repeating.',
      rank: 20,
      requires: [{ kind: 'visit_count_at_least', count: 1 }],
    },
    {
      key: 'returning',
      label: 'Returning guest',
      objective: 'Establish familiarity',
      mission:
        'Recognize them, remember relevant preferences, and develop shared conversational context.',
      rank: 30,
      requires: [{ kind: 'visit_count_at_least', count: 2 }],
    },
    {
      key: 'regular',
      label: 'Regular',
      objective: 'Develop rapport',
      mission:
        'Move beyond purely transactional hospitality. Create a relationship with its own humor, opinions, and conversational rhythm.',
      rank: 40,
      requires: [
        { kind: 'visit_count_at_least', count: 4 },
        { kind: 'assessor_judgment' },
      ],
    },
    {
      key: 'routine',
      label: 'Part of the routine',
      objective: 'Become part of their routine',
      // DRAFT wording, pending approval - the redesign conversation supplied
      // the objective but no mission for the sixth state.
      mission:
        'Be a steady part of the rhythm of their week. Notice when something changes, mark the moments that matter, and never take the familiarity for granted.',
      rank: 50,
      requires: [
        { kind: 'visit_count_at_least', count: 8 },
        { kind: 'assessor_judgment' },
      ],
    },
  ],
  // Seeded from the retired intention set, phrased as ACTIVE AIMS the model
  // pursues in parallel within a state (owner-ruled 2026-10-04): the earlier
  // passive phrasing ("you don't know X yet") plus "silence is always
  // acceptable" produced an agent that never asked anything. Still no gates,
  // windows or priorities: the model picks the aim that fits the moment,
  // interaction memory (now move-linked) replaces prompted-once, the judge's
  // working_the_room axis prices both failure directions (decision 0009).
  moves: [
    {
      key: 'learn_name',
      homeState: 'first_contact',
      // Goal-and-gap only (owner-ruled 2026-10-04, turn-one-move rounds
      // 4-5). The round-3 wording scripted the ask ("a warm, casual ask
      // ... is the host's natural reply") and the model obeyed literally -
      // the name ask became the entire first reply, 9/9 samples. Listing
      // "the welcome" among what attaches to the name re-licensed the same
      // ask; this wording plus the mission's welcome-first sentence went
      // 0 turn-one asks across 9 samples while still pursuing.
      goal: 'Their name. You do not have it yet, and everything you remember about them later - the memory, the recognition - attaches to it.',
      closedWhen: [{ profileField: 'first_name' }],
    },
    {
      key: 'understand_order',
      homeState: 'first_contact',
      // "or what they'd want" CUT (owner-ruled 2026-10-04): the move means
      // what they ordered WITH US - the clause licensed generic taste
      // questions ("what are you drinking these days?") on guests with no
      // order to ask about. Rephrased goal-and-gap in round 5 alongside
      // learn_name; same meaning, measured together with it.
      goal: 'What they order with us - what they got this visit, or what they usually get. You do not know yet. If they have not been in, there is nothing to ask about.',
      closedWhen: [{ profileField: 'usual_order' }],
    },
    {
      key: 'why_theyre_here',
      homeState: 'discovery',
      goal: 'Learn what brought them in - routine, a treat, meeting someone, new to the neighborhood. Interest in them, never an intake form.',
      closedWhen: [{ profileField: 'reason_for_visiting' }],
    },
    {
      key: 'find_their_thing',
      // first_contact, not first_visit (owner-ruled 2026-10-05): on a guest
      // with no order yet, offering a pointer is okay behavior from the very
      // first exchange - the 2026-10-05 regression run produced exactly that
      // reply 6/6 on hi-then-good and the assessor could not credit it
      // because the move was not yet open. Empty closedWhen keeps it
      // evergreen either way.
      homeState: 'first_contact',
      // Goal flattened 2026-10-05 (owner-approved verbatim): the old
      // aphoristic wording ("Point, don't quiz: offer something specific and
      // see what lands") was read back to the guest nearly verbatim - "want
      // a pointer?" / "a nudge in a direction?" - the v2.8.0 instruction-echo
      // family, and its register bled into the reply. Goal-and-gap only,
      // nothing quotable.
      goal: 'Their thing - the one drink or pastry they would come back for. You do not know it yet. Offering one specific thing from the menu is how you find out.',
      closedWhen: [],
    },
    {
      // The GUEST's own agenda, owner-approved 2026-10-06. Every other move
      // is the house learning something about the guest, each closed by a
      // profile field - so the moves header's "your one question is for
      // these" had nothing in "these" standing for what the guest actually
      // asked. Measured on v2.10.0-draft: "what is a good first order?"
      // returned a bare welcome 11/11 while retrieval had already handed the
      // model the answer, and leave-one-out over all 22 prompt units put the
      // cause in that header - the last instruction before the guest's
      // message. This move removes the conflict instead of rewording it:
      // 3/3 on the defect, service-desk register 0/3 on a bare "hey"
      // (matching control, where earlier wordings scored 3/3).
      //
      // The second sentence is load-bearing and owner-ruled: without it the
      // move becomes an aim to EXTRACT intent and pulls "what can I help you
      // with?" onto an opener that asked nothing. Self-disabling, the same
      // shape understand_order uses ("if they have not been in, there is
      // nothing to ask about").
      //
      // closedWhen is empty and always will be - no profile field can close
      // what the guest wants from you this turn.
      key: 'what_they_came_for',
      homeState: 'first_contact',
      goal: 'What they asked you for, when they have asked for something. Nothing to draw out of them - if their message carries no request, there is nothing here.',
      closedWhen: [],
    },
    {
      key: 'first_or_returning',
      homeState: 'first_visit',
      goal: "Learn whether this was their first time in or they've been coming a while - it changes how you talk to them.",
      closedWhen: [{ profileField: 'history_here' }],
    },
    {
      key: 'are_they_local',
      homeState: 'returning',
      goal: 'Learn whether they live or work nearby - a neighbor and a pilgrim get different kinds of welcome.',
      closedWhen: [{ profileField: 'home_base' }],
    },
    {
      key: 'their_rhythm',
      homeState: 'returning',
      goal: 'Learn when they tend to come by - morning rush, slow afternoon - so you can meet them inside their routine.',
      closedWhen: [{ profileField: 'usual_time_of_day' }],
    },
  ],
} satisfies RelationshipGraph

/**
 * Parsed through the schema at module load so the seed itself can never
 * drift from the contract: an offline boundary, failing CLOSED and loudly
 * (a bad seed is a build-time catch, not a runtime degrade).
 */
export const DEFAULT_RELATIONSHIP_GRAPH: RelationshipGraph =
  RelationshipGraphSchema.parse(DEFAULT_GRAPH_INPUT)
