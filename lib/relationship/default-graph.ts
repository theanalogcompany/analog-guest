import { RelationshipGraphSchema, type RelationshipGraph } from './schema'

// The seed graph every venue starts from. Ruled in the v2 redesign
// conversation (2026-10-03); the six states and the first five missions are
// the owner's own wording, edited only to make them venue-neutral ("Le Mil"
// generalized). The `routine` mission is DRAFT wording, not yet approved -
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
      mission:
        'Make the guest comfortable interacting with you. Establish a recognizable personality and a welcoming atmosphere without demanding their attention.',
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
      // "right after being useful is the natural opening" was CUT (owner
      // goal, 2026-10-04, measured by turn-one-move): on a thin opener the
      // model has not been useful yet, so that clause deferred the move
      // forever - 0/3 pursuit across four prompt arms; this wording 3/3.
      goal: 'Learn their name, early - a first exchange that goes well usually ends with it. A thin opener ("hey") is itself the opening: when there is nothing else to react to, a warm, casual ask for their name is the host\'s natural reply.',
      closedWhen: [{ profileField: 'first_name' }],
    },
    {
      key: 'understand_order',
      homeState: 'first_contact',
      // "or what they'd want" CUT (owner-ruled 2026-10-04): the move means
      // what they ordered WITH US - the clause licensed generic taste
      // questions ("what are you drinking these days?") on guests with no
      // order to ask about.
      goal: 'Learn what they ordered with us - what they got this visit, or what they usually get. If they have not been in yet, this move waits; it is about their order, not their tastes in general.',
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
      homeState: 'first_visit',
      goal: "Find their thing - the drink or pastry that becomes their reason to come back. Point, don't quiz: offer something specific and see what lands.",
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
