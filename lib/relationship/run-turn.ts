import { createAdminClient } from '@/lib/db/admin'
import { startAgentTrace, toAgentUsage } from '@/lib/observability'
import { loadVoicePack } from '@/lib/rag/voice-pack'
import {
  parseVenueLinks,
  venueOwnDomainWildcard,
} from '@/lib/schemas/venue-info'
import { DELIVERED_OUTBOUND_STATUSES } from '@/lib/agent/group-responses'
import { historyForPrompt } from '@/lib/agent/media-history'
import {
  composePrompt,
  type ComposedPrompt,
  type HistoryTurn,
} from '@/lib/ai/v2/compose'
import {
  cacheHitRate,
  generateV2Reply,
  type V2Usage,
} from '@/lib/ai/v2/generate'
import {
  resolveV2Effort,
  resolveV2ModelProfile,
  V2_GENERATE_MAX_OUTPUT_TOKENS,
  V2_MODEL_PROFILES,
  type V2Effort,
  type V2EffortRequest,
  type V2ModelKey,
} from '@/lib/ai/v2/model-call'
import {
  applyPromptBlocks,
  replaceSystemText,
  type PromptBlockOverride,
} from '@/lib/ai/v2/prompt-text'
import { resolveV2TemplateSet } from '@/lib/ai/v2/template-archive'
import { retrieveKnowledgeContext } from '@/lib/rag/retrieve'
import {
  renderVenueProfile,
  venueMenuItemNames,
} from '@/lib/ai/v2/venue-profile'
import { declaredActionTypes, type GenerationOutput } from '@/lib/ai/v2/actions'
import {
  JUDGE_ENABLED,
  judgeResponse,
  type JudgeResult,
} from '@/lib/eval/judge'
import { DEFAULT_POLICY_SET } from '@/lib/policy/default-policies'
import { decideDispatch, type GateDecision } from '@/lib/policy/gate'
import { replyLengthClause } from '@/lib/ai/v2/reply-length-clause'
import { fireGateNotifications } from '@/lib/policy/notify'
import {
  detectSituations,
  GUEST_MEDIA_SITUATION,
  type SituationDetectionOutcome,
} from '@/lib/policy/detect-situations'
import {
  runSemanticCheck,
  type SemanticCheckOutcome,
} from '@/lib/policy/semantic-check'
import {
  applyAssessment,
  ASSESSOR_ENABLED,
  runAssessor,
  type AssessorResult,
} from './assessor'
import { DEFAULT_RELATIONSHIP_GRAPH } from './default-graph'
import {
  EMPTY_MEMORY,
  EMPTY_PROFILE,
  openMoves,
  parseGuestProfile,
  parseInteractionMemory,
  renderGuestProfile,
  renderInteractionMemory,
  renderOpenMoves,
  type GuestProfile,
  type InteractionMemory,
} from './profile'
import {
  parseRelationshipGraph,
  type RelationshipGraph,
  type StatePredicate,
} from './schema'
import {
  frontier,
  requiresAssessor,
  resolveDeterministicState,
  type StateFacts,
} from './state'
import {
  declaredTurnMedia,
  loadTurnMedia,
  type DeclaredTurnMedia,
  type TurnMedia,
} from './turn-media'

// The v2 turn runner: one inbound exchange through the whole pipeline, with
// every stage's input and output captured AS VALUES on a TurnTrace. The
// playground renders the trace, edits any stage via `overrides`, and reruns;
// the eval harness replays through the same path. DRY-RUN BY DESIGN in this
// phase: it reads production data, calls real models, and WRITES NOTHING -
// no dispatch, no DB writes. Production wiring (dispatch + persistence +
// waitUntil post-send batch) is the phase 6 flag flip, and it must go
// through this same function so the playground never diverges from
// production (the TurnTrace IS the debuggability contract).
//
// Latency shape per the design: generate blocks; the semantic check blocks
// (pre-send gate); judge and assessor run after and concurrently - in
// production they ride waitUntil, here they are awaited so the trace is
// complete.
//
// THE GUEST'S MEDIA is a lane of its own, `turn-media.ts`, and everything it
// knows comes from v1: the wording, which messages a turn answers, and the
// rule that holds the reply. It adds one serial read before generation, and it
// has to be serial - the transcript window is its cutoff, so a bracketed line
// can only exist for a message the transcript carries. Its header has the two
// places v2 deliberately differs.

export interface TurnOverrides {
  /** Force the relationship state (key must exist in the graph). */
  stateKey?: string
  /** Replace the mission text the brief renders. */
  mission?: string
  /** Replace rendered sections wholesale. */
  guestProfileText?: string
  interactionMemoryText?: string
  openMovesText?: string
  knowledgeBriefText?: string
  /** Only reaches the prompt on an archived version that retrieves. */
  knowledgeText?: string
  voicePackText?: string
  venueProfileText?: string
  /**
   * SYSTEM BLOCKS, hand-edited, replacing the composer's by label - see
   * `lib/ai/v2/prompt-text.ts` for why by label and not as one document, and
   * for why a turn that runs on one is stamped `+hand-edited`.
   *
   * These do NOT replace the section overrides above, and the two compose in
   * the one direction that makes sense: the sections are still rendered (the
   * trace, the gate and the assessor read them), then a block override wins
   * for what the model is sent. So a `knowledgeText` override is invisible to
   * the model once the block it renders into is overridden. The inspector
   * seeds its editor from the composed blocks, so an operator editing sections
   * and then the text sees their section edit already in the text.
   *
   * THE TRANSCRIPT IS NOT REACHABLE FROM HERE, deliberately. The guest's words
   * are the turn's input; a surface that let them be rewritten in the same box
   * as the house copy is how a reply gets read as an answer to a question that
   * was never asked.
   *
   * An override naming a block the prompt does not carry FAILS THE TURN rather
   * than being skipped - see `applyPromptBlocks`.
   */
  promptBlocks?: PromptBlockOverride[]
  /**
   * The WHOLE system half as one block, replacing all three composed ones.
   *
   * For a surface that edits the prompt as one document rather than by block -
   * the prompt lab. It WINS over `promptBlocks`, because it is a statement
   * about the same thing at a coarser grain, and applying both would mean
   * applying a block override to a prompt that no longer carries that block.
   * `replaceSystemText` says what collapsing the blocks costs.
   */
  systemText?: string
  /**
   * An ARCHIVED template version to compose with, from
   * `lib/ai/v2/template-archive.ts`. Absent means this build's own.
   *
   * It is a fixture, not time travel: every other input is today's. And it can
   * change which LANES run - v2.17.0 retrieves, v2.18.0 does not - which is why
   * this is resolved before the sections are built rather than at compose time.
   */
  templateVersion?: string
  /**
   * The model and its call parameters, for a human comparing two models on one
   * turn. Absent means production's: `V2_GENERATION_MODEL`'s profile, no
   * effort, `V2_GENERATE_MAX_OUTPUT_TOKENS`.
   */
  modelKey?: V2ModelKey
  /** Omit for `V2_DEFAULT_EFFORT`; `'none'` to send no effort at all. */
  effort?: V2EffortRequest
  maxOutputTokens?: number
}

/** Session-carried state for a multi-turn playground chat (sandbox mode). */
export interface PlaygroundSession {
  profile: GuestProfile
  memory: InteractionMemory
  /** Omit to let resolveDeterministicState enter at the graph's own initial state. */
  stateKey?: string
  facts: StateFacts
}

export interface RunTurnInput {
  venueId: string
  /** null = sandbox guest (no DB reads for guest data; session supplies it). */
  guestId: string | null
  /**
   * The guest's message(s) this turn, oldest first.
   *
   * EMPTY IS LEGAL, and means the guest sent media and no words - the shape
   * every one of Le Mil's 120 attachments arrived in. The turn is then carried
   * entirely by the media lines (`media` below), and a turn with neither is
   * the one thing this cannot answer.
   */
  inbound: string[]
  /**
   * The production row this turn answers, when the caller knows which one it
   * is - a replay, and phase 6's dispatch. It is what lets the media lane see
   * THIS TURN's attachments; without it the thread's media still reaches the
   * transcript and still decides the hold, but the "[guest also sent a photo]"
   * line cannot be built because there is no message to read it off.
   *
   * Ignored for a sandbox guest (`guestId: null`), which has no rows at all.
   */
  inboundMessageId?: string
  /**
   * Media a caller STATES rather than stores: a sandbox chat, a golden
   * scenario. Only read when `guestId` is null, and the type cannot express
   * that - a real guest's media comes from their rows, and letting a caller
   * declare it over the top would be a surface that disagrees with the thread
   * it is replaying.
   */
  declaredMedia?: DeclaredTurnMedia
  /** Prior turns for sandbox chats; ignored when guestId is set (history loads from messages). */
  sessionHistory?: HistoryTurn[]
  session?: PlaygroundSession
  overrides?: TurnOverrides
  /**
   * Replay mode: the bubbles production ACTUALLY sent after this inbound.
   * Judged with the same transcript and house notes as the v2 draft, so the
   * two scores are directly comparable - and so the judge itself can be
   * tuned: real replies the owner already knows were good or bad are the
   * ground truth the judge's scores must agree with (phase 4 calibration).
   */
  actualReply?: string[]
  /**
   * Absent or `dry_run` writes nothing, dispatches nothing and notifies
   * nobody. The playground and every measurement harness leave it absent,
   * which is what keeps a sandbox complaint from paging the owner on each
   * sent bubble.
   *
   * `live` is the phase 6 seam, and carries the run id rather than taking it
   * as a sibling optional: an event attributed to a fabricated id is worse
   * than no event, so the type is what refuses a live turn with nothing to
   * attribute it to.
   *
   * TODAY NOTHING PASSES `live` - the only reader is the notify call after
   * the gate, and v2 has no production caller at all yet. Declared, not
   * exercised: it is here so the production wiring is a field on an existing
   * input rather than a second pipeline, per this file's own "production must
   * go through this same function" rule.
   */
  dispatch?: { mode: 'dry_run' } | { mode: 'live'; agentRunId: string }
  now?: Date
  /**
   * Skip the two judges and the assessor. Off by default, so every existing
   * caller is unchanged.
   *
   * WHAT IT COSTS, which decides whether you may use it: no `nextSession`.
   * The assessor is what turns this turn's conversation into the profile and
   * memory the NEXT turn is given, so a caller that chains turns - the
   * playground, `template-regression`, `first-contact-replay`,
   * `turn-one-move` - must never set this. A conversation run with it on
   * forgets everything between turns and the later replies are answering a
   * stranger.
   *
   * WHAT IT DOES NOT COST: the gate. `decideDispatch` reads the semantic
   * check and the inbound-detected situations, never the assessor (the
   * comment at that call says so), so `gate.verdict`, `output.messages` and
   * the resolved state key are byte-identical either way. That is what makes
   * this safe for a single-turn comparison harness like the golden set, whose
   * scenarios carry authored history and never feed a reply back in.
   *
   * The semantic check still runs. It is the gate's input, not an evaluation.
   */
  skipEvaluation?: boolean
}

export interface TurnTrace {
  input: RunTurnInput
  graph: {
    source: 'active_row' | 'default'
    version: number | null
    fellBack: boolean
    /** Set when the relationship_graphs read FAILED - unreadable is not absent. */
    error?: string
    /** The full graph as render data, so the playground can draw nodes and edges. */
    states: Array<{
      key: string
      label: string
      objective: string
      mission: string
      rank: number
      /** Hard requirements, human-rendered ("visits >= 1"); the edge INTO this state. */
      requires: string[]
      assessorGated: boolean
      /** Hard predicates hold for THIS guest's facts right now. */
      inFrontier: boolean
    }>
    moves: Array<{
      key: string
      homeState: string
      goal: string
      /** Profile field names whose presence closes the move. */
      closedWhen: string[]
      /** Closed for THIS guest's profile right now. */
      closed: boolean
    }>
  }
  facts: StateFacts
  state: {
    resolvedKey: string
    label: string
    mission: string
    evidence: string[]
    overridden: boolean
  }
  sections: {
    venueName: string
    venueProfile: string
    voicePack: string
    knowledgeBrief: string
    /**
     * Retrieved chunks. ALWAYS EMPTY on the current template, which stopped
     * retrieving in v2.18.0 - non-empty only on an archived version that still
     * had the lane. Empty here is not "retrieval found nothing", it is "no
     * retrieval ran", and `composed.promptVersion` is what tells them apart.
     */
    knowledge: string
    guestProfile: string
    interactionMemory: string
    openMoves: string
  }
  /**
   * How the venue profile was built. null when the venue has no venue_info
   * row at all. `unrendered` must be empty: a non-empty entry is a stored
   * fact that reached no renderer, which is the defect class that put a
   * fabricated address in two replies (lib/ai/v2/venue-profile.ts).
   * `overridden` says the playground supplied the text, so a clean
   * `unrendered` on an overridden turn proves nothing about the venue.
   */
  venueProfileRender: {
    unrendered: string[]
    charCount: number
    overridden: boolean
  } | null
  history: HistoryTurn[]
  /**
   * What the guest sent besides words, this turn and in the thread.
   *
   * `hold.hold` IS the `guest_media` situation the gate was handed, so a
   * reader comparing this with `gate.matched` sees the whole decision. `kind`
   * and `described` are what the lines were built from, so a line that reads
   * wrong can be traced to the row rather than to the wording.
   *
   * `degraded` says a row read failed: the transcript is thinner than the
   * thread, which from the outside looks exactly like a guest who sent no
   * media. Null only when the turn ran with no media lane at all (a sandbox
   * turn that declared none).
   */
  media: {
    before: string[]
    after: string[]
    hold: TurnMedia['hold']
    degraded: boolean
    kind: TurnMedia['kind']
    storyReply: boolean
    described: TurnMedia['described']
    /** Media-only messages put back into the transcript, and history lines added. */
    historyMessagesWithLines: number
    mediaOnlyInHistory: number
  } | null
  composed: ComposedPrompt
  /**
   * The model and the parameters this turn ASKED FOR, resolved from
   * `V2_GENERATION_MODEL` unless the overrides named others.
   *
   * ON THE TRACE rather than read from a constant by whoever renders it. The
   * playground's v2 column shows `V2_PROMPT_VERSION` by importing it directly,
   * which is sound for a build-time constant and WRONG for this: a reader
   * comparing two turns taken under two different profiles would see one model
   * named for both. Resolve it where the call happens, carry it, render what
   * is carried.
   *
   * It sits on the trace's shared base, so a FAILED generation reports it too
   * - which is when the question "under which model?" matters most.
   */
  modelCall: {
    model: string
    /** null when none was asked for; below `max` no model measured actually thinks. */
    effort: V2Effort | null
    maxOutputTokens: number
  }
  /**
   * What the COMPOSER would have produced, when `overrides.promptText`
   * replaced it - and null when nothing was hand-edited, because then
   * `composed` already is it.
   *
   * Non-null IS the hand-edited flag; `composed.promptVersion`'s
   * `+hand-edited` suffix carries the same fact for anything that stores only
   * the version string.
   *
   * IT IS HERE TO MAKE THE EDIT UNDOABLE, which is not a UI nicety. The
   * inspector seeds its textarea from `composed` and sends an override
   * whenever the two differ, so without this a hand edit became the new
   * baseline the moment it ran: the next regenerate would compare the textarea
   * against itself, send no `promptText`, and quietly go back to the composed
   * prompt - changing the reply for a reason the operator did not ask for and
   * could not see. Costs ~23k chars on the trace of a hand-edited turn only.
   */
  composedWithoutPromptEdit: ComposedPrompt | null
  /** Inbound situation detection (fast axis); null only on pre-generation failures. */
  situations: (SituationDetectionOutcome & { durationMs: number }) | null
  generation:
    | {
        ok: true
        output: GenerationOutput
        durationMs: number
        usage: V2Usage
        /**
         * Cache READ over total input, 0 to 1, null when nothing was
         * reported. On the trace rather than left for a reader to derive,
         * because `usage.inputTokens` already includes both cache buckets and
         * every hand-rolled derivation of this number gets that wrong.
         */
        cacheHitRate: number | null
        /**
         * null when the provider reported no breakdown, which is NOT zero -
         * claude-sonnet-4-6 omits the key at every effort level while
         * claude-haiku-5-5 reports a real 0 below `max`. Rendering a null as 0
         * would claim thinking was measured and found absent.
         */
        thinkingTokens: number | null
        /**
         * The temperature that was SENT, null when the model rejects the
         * parameter and none was.
         *
         * Taken from the generator's own record of its call rather than
         * re-derived here from the profile, so the one fact this layer cannot
         * know has a single source. It matters to a reader because
         * `.claude/rules/v2-template-regression.md` fixes n=3 on the stated
         * grounds that generation runs at temperature 0 - on a profile that
         * rejects the parameter that premise is false and one sample is not a
         * result.
         */
        temperature: number | null
      }
    | { ok: false; error: string }
  semantic: (SemanticCheckOutcome & { durationMs: number }) | null
  gate: GateDecision | null
  /**
   * `{skipped: true}` is NOT `null`. Null already means "generation failed, so
   * no judge ran"; a skip is a caller who asked not to pay for one. Collapsing
   * them would make "we did not look" indistinguishable from "there was
   * nothing to look at", which is the three-state rule in
   * `.claude/rules/errors-as-values.md`.
   */
  judge:
    | { ok: true; result: JudgeResult; durationMs: number }
    | { ok: false; error: string }
    | { skipped: true }
    | null
  /** The judge over input.actualReply (what production sent); null when none was given. */
  actualJudge:
    | { ok: true; result: JudgeResult; durationMs: number }
    | { ok: false; error: string }
    | { skipped: true }
    | null
  /**
   * `{skipped: true}` means NO `nextSession` WAS PRODUCED, which is the one
   * consequence of skipping that bites. A chained caller feeds `nextSession`
   * into the following turn as its profile and memory, so a conversation run
   * with the assessor off loses everything learned between turns. The
   * playground and three harnesses do exactly that - hence a distinct state
   * rather than a null they might read as "no updates this turn".
   */
  assessor:
    | {
        ok: true
        result: AssessorResult
        nextSession: PlaygroundSession
        durationMs: number
      }
    | { ok: false; error: string }
    | { skipped: true }
    | null
  totalDurationMs: number
}

const HISTORY_LIMIT = 30

/**
 * A transcript turn with the clock it happened on, which is what the media
 * merge needs and `HistoryTurn` deliberately does not carry: the composer is
 * handed role and text only, and the timestamps exist to put a media-only
 * message back in its place before that.
 */
type TimedTurn = HistoryTurn & { createdAt: Date }

/**
 * The newest `HISTORY_LIMIT` messages of one thread, ending at `asOfIso` and
 * never including the message the turn is answering.
 *
 * `id` rides along for the media lane: an attachment's bracketed line is keyed
 * to the message it was sent on, and a line that cannot be keyed back to a row
 * cannot be placed in the transcript.
 *
 * EXCLUDING THE CURRENT MESSAGE IS A FIX, not a detail of the media work. The
 * guest's message arrives as `input.inbound` and composes as the last user
 * turn; it was ALSO the newest row this query returned, so every replay put
 * the same sentence in the prompt twice - once as history and once as the
 * thing being answered. Visible as soon as the transcript stopped running past
 * the turn: "For cafe" composed as two consecutive user turns (Le Mil's,
 * 2026-10-13). v1 never had it - `buildRuntimeContext` leaves the current
 * message out of `recentMessages`, and `loadMediaHistory` takes
 * `currentMessageId` for the same reason.
 *
 * It covers the row the caller NAMED. A coalesced burst answers several
 * messages and names one, so the others still arrive as history; that is the
 * same shape the playground has always replayed and is left alone here rather
 * than guessed at by matching text.
 */
function transcriptQuery(
  supabase: ReturnType<typeof createAdminClient>,
  venueId: string,
  guestId: string,
  asOfIso: string | null,
  currentMessageId: string | undefined,
) {
  let query = supabase
    .from('messages')
    .select('id, body, direction, status, created_at')
    .eq('venue_id', venueId)
    .eq('guest_id', guestId)
  if (asOfIso !== null) query = query.lte('created_at', asOfIso)
  if (currentMessageId !== undefined) query = query.neq('id', currentMessageId)
  return query.order('created_at', { ascending: false }).limit(HISTORY_LIMIT)
}

export async function runTurn(input: RunTurnInput): Promise<TurnTrace> {
  const now = input.now ?? new Date()
  const started = Date.now()
  const supabase = createAdminClient()
  const o = input.overrides ?? {}
  const skipEvaluation = input.skipEvaluation === true
  // The judges are off globally while JUDGE_ENABLED is false (lib/eval/judge.ts
  // has the ruling). It folds into the caller's own decline rather than
  // sitting beside it, so both surface on the trace as `{skipped: true}` -
  // "we did not look", which is what both of them are. The ASSESSOR is
  // deliberately not folded in: it decides state, profile and memory, and a
  // turn that skips it produces no `nextSession`.
  const skipJudges = skipEvaluation || !JUDGE_ENABLED
  // Same shape as the judges, and the consequence is bigger: no assessor means
  // no `nextSession`, so a chained caller carries nothing between turns.
  // `ASSESSOR_ENABLED` in assessor.ts lists what that breaks.
  const skipAssessor = skipEvaluation || !ASSESSOR_ENABLED

  // ---- Load the graph (active row, else default; malformed falls back). ----
  const graphRow = await supabase
    .from('relationship_graphs')
    .select('version, graph')
    .eq('venue_id', input.venueId)
    .eq('status', 'active')
    .maybeSingle()
  let graph: RelationshipGraph = DEFAULT_RELATIONSHIP_GRAPH
  // states/moves need the guest's facts and profile; composed into the trace
  // at assembly time via graphRenderData.
  let graphMeta: Omit<TurnTrace['graph'], 'states' | 'moves'> = {
    source: 'default',
    version: null,
    fellBack: false,
  }
  if (graphRow.error) {
    // Unreadable is not absent: the trace must distinguish a DB failure from
    // a venue with no active graph row, or an operator debugging a venue
    // reads an outage as "default graph, all fine".
    graphMeta = { ...graphMeta, error: graphRow.error.message }
  } else if (graphRow.data) {
    const parsed = parseRelationshipGraph(
      graphRow.data.graph,
      DEFAULT_RELATIONSHIP_GRAPH,
    )
    graph = parsed.graph
    graphMeta = {
      source: 'active_row',
      version: graphRow.data.version,
      fellBack: parsed.fellBack,
    }
  }

  // ---- Venue sections. ----
  const venueRow = await supabase
    .from('venues')
    .select('name')
    .eq('id', input.venueId)
    .maybeSingle()
  const venueName = venueRow.data?.name ?? 'the venue'

  // The venue's OWN Instagram handle, so the frame can name the inbox the
  // agent is answering in. `is_active` and `deauthorized_at` are both checked:
  // a disconnected account is not this inbox, and naming it would be worse
  // than naming nothing.
  //
  // FAILS OPEN to '' - an unreadable row renders the frame exactly as it read
  // before this clause existed, which is a less specific prompt rather than a
  // wrong one. There is nothing here worth holding a guest's reply over.
  const igRow = await supabase
    .from('instagram_credentials')
    .select('instagram_username')
    .eq('venue_id', input.venueId)
    .eq('is_active', true)
    .is('deauthorized_at', null)
    .maybeSingle()
  const igUsername = igRow.data?.instagram_username?.trim()
  const instagramClause =
    igUsername === undefined || igUsername.length === 0
      ? ''
      : `, @${igUsername.replace(/^@+/, '')}`

  const configRow = await supabase
    .from('venue_configs')
    .select('venue_info, brand_persona, knowledge_brief')
    .eq('venue_id', input.venueId)
    .maybeSingle()
  // How long this venue's own team writes, from the SAME column v1's length
  // check reads (decision 0010: measured from their replies, never written by
  // us). The frame is the GLOBAL template, so these numbers can only ever
  // arrive as a per-venue clause - a literal here would put one venue's
  // measurements in every venue's prompt.
  //
  // FAILS OPEN to '': a venue with no measured profile gets the frame exactly
  // as it read before this clause, never a number we invented for it.
  const lengthClause = replyLengthClause(configRow.data?.brand_persona)
  // lib/ai/v2/venue-profile.ts renders this; it throws on a malformed row,
  // same as v1's buildRuntimeContext. The "section registry" named in
  // lib/relationship/CLAUDE.md does not exist in code yet, so this is a
  // direct call rather than a registry lookup.
  const rendered = configRow.data?.venue_info
    ? renderVenueProfile(configRow.data.venue_info, now)
    : null
  const venueProfile = o.venueProfileText ?? rendered?.text ?? venueName

  // The curated link allowlist (TAC-509): `venue_info.links` and nothing
  // else - not retrieved knowledge, not the composed prompt. Deriving it
  // from the knowledge section held every Le Mil's draft that mentioned the
  // bare site (the corpus writes "on lemils.com", which no URL regex run
  // over knowledge text should turn into an allowlist), and a link the model
  // legitimately carries from an earlier turn would vanish whenever this
  // turn's retrieval missed the chunk. lib/ai/url-detector.ts states the
  // rule; `unverified_link` in default-policies.ts asks Jev the matching
  // question.
  //
  // ONE ENTRY IS DERIVED, owner-ruled 2026-10-09: `https://<own-host>/*` from
  // `contact.website`, permitting any path on the venue's own site. That is
  // not a loosening of the "curated, never derived" rule above, which is
  // about never reading an allowlist out of RETRIEVED TEXT - this comes from
  // a stored field a human typed. `venueOwnDomainWildcard` says why only the
  // own domain gets one, and the `/*` form is read by `unverified_link`'s
  // criteria in default-policies.ts; the two have to move together.
  const venueInfo = configRow.data?.venue_info
  const venueInfoObject =
    venueInfo !== null &&
    typeof venueInfo === 'object' &&
    !Array.isArray(venueInfo)
      ? (venueInfo as Record<string, unknown>)
      : undefined
  const contact = venueInfoObject?.contact
  const ownDomainWildcard = venueOwnDomainWildcard(
    contact !== null && typeof contact === 'object' && !Array.isArray(contact)
      ? (contact as Record<string, unknown>).website
      : undefined,
  )
  const providedLinks = [
    ...parseVenueLinks(venueInfoObject?.links).map((l) => l.url),
    ...(ownDomainWildcard === null ? [] : [ownDomainWildcard]),
  ]

  let voicePackText = o.voicePackText
  if (voicePackText === undefined) {
    const pack = await loadVoicePack({ venueId: input.venueId })
    voicePackText = pack.ok
      ? pack.data.map((c) => `- ${c.text}`).join('\n')
      : ''
  }

  // v2 does not retrieve (v2.18.0). `# What you know` is one authored artifact
  // per venue, read from the same `venue_configs` row as venue_info, and it
  // renders in system block 2 - so unlike the four chunks it replaced, it is
  // the SAME TEXT on every turn of every conversation at this venue. That is
  // the property the block 2 cache depends on; the 2026-10-08 split exists
  // because retrieval did not have it.
  //
  // No failure direction to choose here, because there is no call to fail.
  // A venue with no brief gets the empty-section fallback in compose.ts, which
  // is the honest statement rather than a silent gap. v1 still retrieves
  // (lib/agent/stages.ts) and this does not touch it.
  //
  // The override stays for the playground inspector's edit-and-regenerate.
  // It is NOT a per-turn input in production: nothing on the dispatch path
  // passes it, and anything that starts to would break the cache.
  const knowledgeBriefText =
    o.knowledgeBriefText ?? configRow.data?.knowledge_brief ?? ''

  // The template this turn composes on, resolved HERE and not at compose time,
  // because an archived version can need a lane the current one deleted.
  const templates = resolveV2TemplateSet(o.templateVersion)

  // RETRIEVAL IS BACK ONLY FOR A VERSION THAT HAD IT. v2.18.0 dropped the call;
  // running v2.17.0's wording with its `{knowledge}` placeholder fed by nothing
  // would be a version that never shipped, so the lane is restored for exactly
  // the sets that declare it. Fails open to [] the way it always did - a less
  // specific reply still ships - and the same `limit: 4` and query shaping the
  // v2.17.0 runner used, so the fixture is the fixture and not an approximation.
  let knowledgeText = o.knowledgeText ?? ''
  if (o.knowledgeText === undefined && templates.usesRetrieval) {
    const knowledge = await retrieveKnowledgeContext({
      venueId: input.venueId,
      query: input.inbound.join('\n').slice(0, 500),
      limit: 4,
    })
    // Fails open: a less specific reply still ships. Lifted verbatim from the
    // runner at 53b52347 - the bullet rendering is part of the fixture, not a
    // detail to re-derive.
    knowledgeText = knowledge.ok
      ? knowledge.data.map((c) => `- ${c.text}`).join('\n')
      : ''
  }

  // ---- Guest data: DB for a real guest, session for a sandbox one. ----
  let profile = input.session?.profile ?? EMPTY_PROFILE
  let memory = input.session?.memory ?? EMPTY_MEMORY
  let facts: StateFacts = input.session?.facts ?? {
    visitCount: 0,
    replyCount: 1,
    daysSinceLastContact: null,
  }
  let storedStateKey: string | null = input.session?.stateKey ?? null
  let history: HistoryTurn[] = input.sessionHistory ?? []
  // Null means no media lane ran at all, which is not the same as a lane that
  // ran and found nothing: the trace keeps them apart.
  let turnMedia: TurnMedia | null = null

  if (input.guestId !== null) {
    // ---- When the turn happened, for a turn that names its own inbound row.
    //
    // THE TRANSCRIPT MUST END AT THE MESSAGE BEING ANSWERED. Without this a
    // replay hands the model the venue's own reply TO THIS TURN as history and
    // asks it to write that reply: measured on Le Mil's (2026-10-13), the
    // described-video turn composed with "That setup is so good!" - the answer
    // production sent - sitting in the transcript above the guest's video. It
    // then reads as a conversation the agent already finished.
    //
    // ONE EXTRA READ, and only on a turn that passes `inboundMessageId`. The
    // bound cannot be derived from the window it bounds, and a caller-supplied
    // timestamp is a second thing that can disagree with the row.
    //
    // It also moves `daysSinceLastContact` onto the replayed turn's own clock,
    // which is more faithful and is a change: `facts` for a replay used to be
    // measured from today. Everything else about a replay is still today's
    // (the graph, the venue's config, the profile) - this is a fixture, not
    // time travel.
    const inboundMessageId = input.inboundMessageId
    // `created_at` VERBATIM, never reformatted: Postgres keeps microseconds
    // and a `Date` keeps milliseconds, so a bound round-tripped through one
    // truncates downward and an inclusive comparison then excludes the row it
    // was built from. That is how it was found (lib/agent/inbound-media.ts
    // records the measurement): the replayed turn could not see its own video.
    let asOfIso: string | null = null
    if (inboundMessageId !== undefined) {
      const row = await supabase
        .from('messages')
        .select('created_at')
        .eq('id', inboundMessageId)
        .eq('venue_id', input.venueId)
        .maybeSingle()
      // A row that is not there (or not this venue's) leaves the bound unset:
      // the turn then behaves exactly as it did before this field existed,
      // rather than pinning the transcript to a time nothing happened at.
      asOfIso = row.data?.created_at ?? null
    }

    const [profileRow, stateRow, txCount, inboundCount, messageRows] =
      await Promise.all([
        supabase
          .from('guest_profiles')
          .select('profile, memory')
          .eq('guest_id', input.guestId)
          .eq('venue_id', input.venueId)
          .maybeSingle(),
        supabase
          .from('guest_relationship_states')
          .select('state_key')
          .eq('guest_id', input.guestId)
          .eq('venue_id', input.venueId)
          .is('exited_at', null)
          .maybeSingle(),
        supabase
          .from('transactions')
          .select('id', { count: 'exact', head: true })
          .eq('venue_id', input.venueId)
          .eq('guest_id', input.guestId)
          // TAC-573: a visit the guest took back is not counted.
          .is('retracted_at', null),
        supabase
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .eq('venue_id', input.venueId)
          .eq('guest_id', input.guestId)
          .eq('direction', 'inbound'),
        transcriptQuery(
          supabase,
          input.venueId,
          input.guestId,
          asOfIso,
          inboundMessageId,
        ),
      ])

    profile = parseGuestProfile(profileRow.data?.profile)
    memory = parseInteractionMemory(profileRow.data?.memory)
    storedStateKey = stateRow.data?.state_key ?? null
    // messageRows is newest-first, so [0] is the most recent contact.
    const newestAt = messageRows.data?.[0]?.created_at
    facts = {
      visitCount: txCount.count ?? 0,
      replyCount: inboundCount.count ?? 0,
      daysSinceLastContact: newestAt
        ? (now.getTime() - new Date(newestAt).getTime()) / 86_400_000
        : null,
    }
    const rows = (messageRows.data ?? []).slice().reverse()

    // ---- The guest's media, this turn and in the thread (turn-media.ts).
    //
    // READ HERE, after the transcript window is known, because the two have to
    // cover the same span: the oldest row loaded is the cutoff, so a bracketed
    // line can only appear for a message the transcript actually carries. It
    // costs one serial round trip before generation. v1 reads its own media
    // context last for the mirror-image reason (handle-inbound.ts) - anything
    // the prompt can mention, the hold rule must be able to see.
    //
    // The whole lane is skipped for a venue with no media at all only in the
    // sense that the reads come back empty; there is no flag, and a guest who
    // has sent nothing composes byte-identically to before this existed.
    const oldestAt = rows[0]?.created_at
    turnMedia = await loadTurnMedia({
      venueId: input.venueId,
      guestId: input.guestId,
      now,
      ...(input.inboundMessageId !== undefined
        ? { currentMessageId: input.inboundMessageId }
        : {}),
      hasText: input.inbound.some((m) => m.trim().length > 0),
      ...(asOfIso !== null ? { asOfIso } : {}),
      historyCutoffIso: oldestAt ?? new Date(0).toISOString(),
      maxMediaOnlyMessages: HISTORY_LIMIT,
      menuItemNames: venueMenuItemNames(configRow.data?.venue_info),
    })

    // A guest message's attachment lines go ABOVE its words, as in v1's chat
    // turns (withAttachmentLines, serializers.ts) - a message with no lines is
    // its body untouched, so a thread with no media is byte-identical.
    //
    // ONLY ROWS THAT HAVE WORDS get a line here. A message with no text at all
    // is not a turn the model reads as the guest writing to us (owner ruling 4,
    // 2026-10-11); it comes back through `turnMedia.mediaOnly` below, which is
    // the same split v1 keeps between `recentMessages` and `mediaOnlyInbounds`.
    const timed = rows
      .filter(
        (m) =>
          m.direction === 'inbound' ||
          DELIVERED_OUTBOUND_STATUSES.has(m.status ?? ''),
      )
      .map((m): TimedTurn => {
        const body = m.body ?? ''
        const lines =
          m.direction === 'inbound' && body.trim().length > 0
            ? (turnMedia?.historyLines.get(m.id) ?? [])
            : []
        return {
          role: m.direction === 'inbound' ? 'user' : 'assistant',
          text: [...lines, body].filter((part) => part !== '').join('\n'),
          createdAt: new Date(m.created_at),
        }
      })
      .filter((t) => t.text.length > 0)

    // The guest's media-only messages back in their place in time, by the one
    // rule that decides it (historyForPrompt, lib/agent/media-history.ts): a
    // photo this turn's own lines already announce is left out, or the model is
    // told about it twice and the second telling carries no instructions.
    const newestInboundAt = rows
      .filter((m) => m.direction === 'inbound')
      .at(-1)?.created_at
    const merged = historyForPrompt<TimedTurn>({
      recentMessages: timed,
      mediaOnlyInbounds: (turnMedia?.mediaOnly ?? []).map(
        (message): TimedTurn => ({
          role: 'user',
          text: message.attachmentLines.join('\n'),
          createdAt: message.createdAt,
        }),
      ),
      inboundMediaAnnounced:
        (turnMedia?.before.length ?? 0) + (turnMedia?.after.length ?? 0) > 0,
      currentMessageAt:
        newestInboundAt === undefined ? null : new Date(newestInboundAt),
    })

    // Merge same-role runs so roles alternate (the splitHistory discipline).
    history = merged.reduce<HistoryTurn[]>((acc, t) => {
      const last = acc[acc.length - 1]
      if (last && last.role === t.role) last.text = `${last.text}\n${t.text}`
      else acc.push({ role: t.role, text: t.text })
      return acc
    }, [])
  } else if (input.declaredMedia !== undefined) {
    // A sandbox or golden turn states its media instead of storing it. It
    // holds, like a loaded one - see declaredTurnMedia.
    turnMedia = declaredTurnMedia(
      input.declaredMedia,
      input.inbound.some((m) => m.trim().length > 0),
    )
  }

  // ---- State. ----
  const resolved = resolveDeterministicState(graph, facts, storedStateKey)
  const stateKey =
    o.stateKey !== undefined && graph.states.some((s) => s.key === o.stateKey)
      ? o.stateKey
      : resolved.stateKey
  const stateDef = graph.states.find((s) => s.key === stateKey)!
  const mission = o.mission ?? stateDef.mission

  // ---- Brief sections. ----
  const moves = openMoves(graph, stateKey, profile)
  const sections: TurnTrace['sections'] = {
    venueName,
    venueProfile,
    voicePack: voicePackText,
    knowledgeBrief: knowledgeBriefText,
    knowledge: knowledgeText,
    guestProfile: o.guestProfileText ?? renderGuestProfile(profile),
    interactionMemory:
      o.interactionMemoryText ?? renderInteractionMemory(memory),
    openMoves: o.openMovesText ?? renderOpenMoves(moves, memory),
  }
  const venueProfileRender: TurnTrace['venueProfileRender'] =
    rendered === null
      ? null
      : {
          unrendered: rendered.unrendered,
          charCount: rendered.charCount,
          overridden: o.venueProfileText !== undefined,
        }

  const composedFromSections = composePrompt(
    {
      venueName,
      speakerClause: '',
      instagramClause,
      lengthClause,
      venueProfile: sections.venueProfile,
      voicePack: sections.voicePack,
      knowledgeBrief: sections.knowledgeBrief,
      knowledge: sections.knowledge,
      history,
      stateLabel: stateDef.label,
      stateKey,
      mission,
      guestProfile: sections.guestProfile,
      interactionMemory: sections.interactionMemory,
      openMoves: sections.openMoves,
      inboundMessages: input.inbound,
      ...(turnMedia === null
        ? {}
        : {
            inboundMediaBefore: turnMedia.before,
            inboundMediaAfter: turnMedia.after,
          }),
    },
    templates,
  )

  // Hand-edited blocks win over the composed ones for what is SENT, and the
  // composed prompt is still built above because the trace, the gate and the
  // assessor all read the sections it was built from - and because a block
  // override is defined AGAINST it. A failure is returned as a failed
  // generation rather than silently falling back.
  const handEdited =
    o.systemText !== undefined
      ? {
          ok: true as const,
          prompt: replaceSystemText(composedFromSections, o.systemText),
        }
      : o.promptBlocks === undefined || o.promptBlocks.length === 0
        ? null
        : applyPromptBlocks(composedFromSections, o.promptBlocks)
  const composed =
    handEdited !== null && handEdited.ok
      ? handEdited.prompt
      : composedFromSections

  const modelProfile =
    o.modelKey === undefined
      ? resolveV2ModelProfile()
      : V2_MODEL_PROFILES[o.modelKey]

  const base = {
    input,
    // On `base`, so BOTH returns carry it: the call is a property of the turn
    // whether generation succeeded or not, and a failed turn is exactly when
    // you want to know which model and which effort failed.
    modelCall: {
      model: modelProfile.id,
      // Resolved through the SAME function the call uses, so a trace can
      // never name an effort the request did not carry.
      effort: resolveV2Effort(modelProfile, o.effort),
      maxOutputTokens: o.maxOutputTokens ?? V2_GENERATE_MAX_OUTPUT_TOKENS,
    },
    composedWithoutPromptEdit:
      handEdited !== null && handEdited.ok ? composedFromSections : null,
    graph: { ...graphMeta, ...graphRenderData(graph, facts, profile) },
    facts,
    state: {
      resolvedKey: stateKey,
      label: stateDef.label,
      mission,
      evidence: resolved.evidence,
      overridden: o.stateKey !== undefined || o.mission !== undefined,
    },
    sections,
    venueProfileRender,
    history,
    media:
      turnMedia === null
        ? null
        : {
            before: turnMedia.before,
            after: turnMedia.after,
            hold: turnMedia.hold,
            degraded: turnMedia.degraded,
            kind: turnMedia.kind,
            storyReply: turnMedia.storyReply,
            described: turnMedia.described,
            historyMessagesWithLines: turnMedia.historyLines.size,
            mediaOnlyInHistory: turnMedia.mediaOnly.length,
          },
    composed,
  }

  // A TURN WITH NOTHING IN IT is a dead turn, and it is reachable now that
  // `inbound` may be empty: a media-only turn whose media could not be read
  // leaves the model a transcript ending in our own last message and a brief,
  // with nothing from the guest. Generating there produces a reply to a
  // message nobody sent. Failed as a value, with the reason, rather than asked
  // for and then puzzled over.
  if (
    input.inbound.length === 0 &&
    (turnMedia === null ||
      turnMedia.before.length + turnMedia.after.length === 0)
  )
    return {
      ...base,
      situations: null,
      generation: {
        ok: false,
        error:
          'the turn has no inbound: no guest message, and no media line to stand for one' +
          (turnMedia?.degraded === true
            ? ' (the media read failed - see trace.media.degraded)'
            : ''),
      },
      semantic: null,
      gate: null,
      judge: null,
      actualJudge: null,
      assessor: null,
      totalDurationMs: Date.now() - started,
    }

  // A block override this cannot apply is a DEAD TURN, not a turn on the
  // composed prompt. The stage is named in the error because the inspector
  // renders `generation.error` verbatim and a bare "invalid prompt" sends the
  // operator hunting.
  if (handEdited !== null && !handEdited.ok)
    return {
      ...base,
      situations: null,
      generation: {
        ok: false,
        error: `hand-edited prompt blocks were not applied: ${handEdited.error}`,
      },
      semantic: null,
      gate: null,
      judge: null,
      actualJudge: null,
      assessor: null,
      totalDurationMs: Date.now() - started,
    }

  // ---- Generate. ----
  const timed = async <T>(
    p: Promise<T>,
  ): Promise<{ value: T; durationMs: number }> => {
    const t0 = Date.now()
    const value = await p
    return { value, durationMs: Date.now() - t0 }
  }

  // ---- Generate, with situation detection alongside (both pre-send).
  // Detection reads only the inbound, so it rides the generation wait and
  // adds no serial latency; its result is what lets situation-scoped policy
  // rows fire in the gate - genuinely pre-send, unlike the assessor's flags.
  const [generated, situationsTimed] = await Promise.all([
    generateV2Reply(composed, {
      ...(o.modelKey !== undefined ? { modelKey: o.modelKey } : {}),
      ...(o.effort !== undefined ? { effort: o.effort } : {}),
      ...(o.maxOutputTokens !== undefined
        ? { maxOutputTokens: o.maxOutputTokens }
        : {}),
    }),
    timed(
      detectSituations({
        inbound_message: input.inbound.join('\n').slice(0, 2000),
        recent_conversation: history
          .slice(-4)
          .map((t) => `${t.role === 'user' ? 'GUEST' : 'VENUE'}: ${t.text}`)
          .join('\n')
          .slice(0, 2000),
      }),
    ),
  ])
  const situationsTrace = {
    ...situationsTimed.value,
    durationMs: situationsTimed.durationMs,
  }
  const detectedSituations = situationsTimed.value.ok
    ? situationsTimed.value.detected
    : []

  if (!generated.ok) {
    return {
      ...base,
      situations: situationsTrace,
      generation: { ok: false, error: generated.error },
      semantic: null,
      gate: null,
      judge: null,
      actualJudge: null,
      assessor: null,
      totalDurationMs: Date.now() - started,
    }
  }
  const output = generated.data.output

  const transcript = [
    ...history.map(
      (t) => `${t.role === 'user' ? 'GUEST' : 'VENUE'}: ${t.text}`,
    ),
    ...input.inbound.map((m) => `GUEST: ${m}`),
    ...output.messages.map((m) => `VENUE (this reply): ${m}`),
  ].join('\n')
  const briefText = composed.guestState

  // Same history, same inbound, same brief - the two judgments differ in
  // nothing but the reply under judgment, so their scores are comparable.
  const actualReply =
    input.actualReply !== undefined && input.actualReply.length > 0
      ? input.actualReply
      : null
  const actualTranscript =
    actualReply === null
      ? null
      : [
          ...history.map(
            (t) => `${t.role === 'user' ? 'GUEST' : 'VENUE'}: ${t.text}`,
          ),
          ...input.inbound.map((m) => `GUEST: ${m}`),
          ...actualReply.map((m) => `VENUE (this reply): ${m}`),
        ].join('\n')

  // ---- Gate (blocking) and post-turn reads (concurrent). ----
  const [semanticTimed, judgedTimed, actualJudgedTimed, assessedTimed] =
    await Promise.all([
      timed(
        runSemanticCheck(
          {
            draft_messages: output.messages,
            declared_actions: JSON.stringify(output.actions ?? []),
            provided_links: providedLinks,
            recent_conversation: transcript.slice(-3000),
          },
          DEFAULT_POLICY_SET,
        ),
      ),
      // The three a caller may decline. They sit in the same `Promise.all`
      // as the semantic check rather than after it, so when they DO run the
      // turn costs max() and not sum - skipping them removes the slowest
      // member of that max, which is the whole point.
      timed(
        skipJudges
          ? Promise.resolve(null)
          : judgeResponse({
              replyMessages: output.messages,
              transcript,
              situationBrief: briefText,
              venueName,
            }),
      ),
      timed(
        !skipJudges && actualReply !== null && actualTranscript !== null
          ? judgeResponse({
              replyMessages: actualReply,
              transcript: actualTranscript,
              situationBrief: briefText,
              venueName,
            })
          : Promise.resolve(null),
      ),
      timed(
        skipAssessor
          ? Promise.resolve(null)
          : runAssessor({
              graph,
              facts,
              currentStateKey: stateKey,
              profile,
              memory,
              transcript,
              now,
            }),
      ),
    ])
  const semantic = semanticTimed.value
  const judged = judgedTimed.value
  const actualJudged = actualJudgedTimed.value
  const assessed = assessedTimed.value

  // A REPLY WRITTEN AROUND MEDIA THE AGENT CANNOT SEE IS HELD (owner-ruled
  // 2026-10-11), and it reaches the gate as a situation rather than a second
  // mechanism - `guest_media_requires_approval` in default-policies.ts is the
  // row. The fact is already settled: turn-media.ts ran v1's own
  // `decideMediaContextHold` over the thread's rows before generation.
  //
  // NOT ON AN OPT-OUT TURN, and this is the one place the two rails collide.
  // `POLICY_EXEMPT_SITUATIONS` strips `opt_out_request` from what rows may
  // MATCH on, so it would not have stopped this row from queueing a stop
  // confirmation that happened to arrive with a photo - and TCPA says that
  // confirmation goes out. v1 never had the collision: it drops the
  // description and sends (handle-inbound.ts). So the situation is withheld
  // here, which is the same answer in the v2 vocabulary.
  //
  // WHAT IT DOES NOT FIX, stated because it is a real asymmetry: detection
  // runs CONCURRENTLY with generation, so an opt-out turn carrying a photo was
  // already composed with the media line in it. The reply sends, as it must;
  // v1 composes without the description because classification precedes
  // generation there. Closing it means serializing detection ahead of every
  // turn's generation, which is latency on all of them for this one.
  const mediaSituations =
    turnMedia?.hold.hold === true &&
    !detectedSituations.includes('opt_out_request')
      ? [GUEST_MEDIA_SITUATION]
      : []

  const gate = decideDispatch({
    draftMessages: output.messages,
    declaredActionTypes: declaredActionTypes(output),
    semantic,
    policySet: DEFAULT_POLICY_SET,
    stateKey,
    // From the INBOUND detection above - genuinely available pre-send. Never
    // from the assessor, whose flags are post-send in production wiring; the
    // gate refuses opt_out_request regardless (POLICY_EXEMPT_SITUATIONS).
    situations: [...detectedSituations, ...mediaSituations],
  })

  // Notify-row hits reach the venue here. Dry-run fires nothing: the trace
  // still carries gate.notifications, and the playground renders them under
  // "Notify-only hits", so the decision is inspectable without the side
  // effect. A sandbox guest has no guestId to attribute an event to, which is
  // a second reason the same branch cannot fire on a playground turn.
  // Langfuse, on the SAME `live` seam as the notifications below. v2's
  // generation is the only call in this pipeline whose cost moves with the
  // prompt layout, and the prompt cache is the thing that moves it: the
  // layout broke on 2026-10-08 and cost ~6,000 tokens a turn for days with
  // nothing anywhere to say so. `input_cached_tokens` and
  // `input_cache_creation` ride `toAgentUsage` (which owns the disjointness
  // arithmetic - `usage.inputTokens` is NOT uncached input), and
  // `cache_hit_rate` goes on metadata as a RATE, because the counts alone
  // cannot answer "is the cache working" without knowing the prompt size, and
  // prompt size moves every time a section is added.
  //
  // DRY-RUN EMITS NOTHING, deliberately: a measurement harness runs hundreds
  // of samples and would bury real traffic. That is also why this is not yet
  // visible anywhere - v2 has no `live` caller until phase 6. The playground
  // reads `trace.generation.cacheHitRate` instead, which is the same number
  // from the same place.
  if (input.dispatch?.mode === 'live') {
    const turnTrace = startAgentTrace({
      name: 'v2.turn',
      agentRunId: input.dispatch.agentRunId,
      metadata: {
        venueId: input.venueId,
        stateKey,
        promptVersion: composed.promptVersion,
      },
    })
    // `generation()`, never `span()`: Langfuse prices only GENERATION
    // observations, so a model call recorded as a plain span reports $0
    // whatever usage it carries. `model` is required for the same reason.
    turnTrace.generation('v2.generate').end({
      model: base.modelCall.model,
      metadata: {
        cache_hit_rate: cacheHitRate(generated.data.usage),
        promptCharCount: composed.promptCharCount,
        systemBlocks: composed.system.length,
      },
      usage: toAgentUsage(generated.data.usage),
    })
    await turnTrace.flushAsync()
  }

  if (input.dispatch?.mode === 'live' && input.guestId !== null) {
    await fireGateNotifications(gate, {
      agentRunId: input.dispatch.agentRunId,
      venueId: input.venueId,
      guestId: input.guestId,
      // "as handed to the gate", which includes the code-set media situation:
      // an event that listed only the detected ones would read as though the
      // thread's media had no part in the decision.
      situations: [...detectedSituations, ...mediaSituations],
      inboundBody: input.inbound.at(-1) ?? null,
      draftMessages: output.messages,
    })
  }

  let assessorTrace: TurnTrace['assessor']
  if (skipAssessor || assessed === null) {
    assessorTrace = { skipped: true }
  } else if (assessed.ok) {
    const applied = applyAssessment(profile, memory, assessed.data.output, now)
    assessorTrace = {
      ok: true,
      result: assessed.data,
      nextSession: {
        profile: applied.profile,
        memory: applied.memory,
        stateKey: assessed.data.validatedStateKey ?? stateKey,
        facts: { ...facts, replyCount: facts.replyCount + 1 },
      },
      durationMs: assessedTimed.durationMs,
    }
  } else {
    assessorTrace = { ok: false, error: assessed.error }
  }

  return {
    ...base,
    situations: situationsTrace,
    generation: {
      ok: true,
      output,
      durationMs: generated.data.durationMs,
      usage: generated.data.usage,
      cacheHitRate: cacheHitRate(generated.data.usage),
      thinkingTokens: generated.data.thinkingTokens,
      temperature: generated.data.call.temperature,
    },
    semantic: { ...semantic, durationMs: semanticTimed.durationMs },
    gate,
    judge: skipJudges
      ? { skipped: true }
      : judged === null
        ? null
        : judged.ok
          ? {
              ok: true,
              result: judged.data,
              durationMs: judgedTimed.durationMs,
            }
          : { ok: false, error: judged.error },
    // Skipped beats "no actual reply was given": a caller who declined the
    // judges never supplied one either, and reporting null here would say
    // the absence was the caller's input rather than their choice.
    actualJudge: skipJudges
      ? { skipped: true }
      : actualJudged === null
        ? null
        : actualJudged.ok
          ? {
              ok: true,
              result: actualJudged.data,
              durationMs: actualJudgedTimed.durationMs,
            }
          : { ok: false, error: actualJudged.error },
    assessor: assessorTrace,
    totalDurationMs: Date.now() - started,
  }
}

function renderPredicate(p: StatePredicate): string {
  switch (p.kind) {
    case 'visit_count_at_least':
      return `visits >= ${p.count}`
    case 'reply_count_at_least':
      return `replies >= ${p.count}`
    case 'days_since_last_contact_at_most':
      return `<= ${p.days} days since contact`
    case 'assessor_judgment':
      return 'assessor judgment'
  }
}

/**
 * The graph as render data for the playground's visual: every state with its
 * requirements human-rendered and its frontier status for THIS guest, every
 * move with its open/closed status for THIS guest's profile (same rule as
 * openMoves in profile.ts, but over all states so the whole board shows).
 */
function graphRenderData(
  graph: RelationshipGraph,
  facts: StateFacts,
  profile: GuestProfile,
): Pick<TurnTrace['graph'], 'states' | 'moves'> {
  const open = new Set(frontier(graph, facts).map((s) => s.key))
  return {
    states: [...graph.states]
      .sort((a, b) => a.rank - b.rank)
      .map((s) => ({
        key: s.key,
        label: s.label,
        objective: s.objective,
        mission: s.mission,
        rank: s.rank,
        requires: s.requires
          .filter((p) => p.kind !== 'assessor_judgment')
          .map(renderPredicate),
        assessorGated: requiresAssessor(s),
        inFrontier: open.has(s.key),
      })),
    moves: graph.moves.map((m) => ({
      key: m.key,
      homeState: m.homeState,
      goal: m.goal,
      closedWhen: m.closedWhen.map((c) => c.profileField),
      closed: m.closedWhen.some((c) => {
        const value = profile.fields[c.profileField]
        return value !== undefined && value.trim().length > 0
      }),
    })),
  }
}
