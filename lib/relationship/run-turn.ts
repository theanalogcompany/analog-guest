import { GENERATION_MODEL_ID } from '@/lib/ai/client'
import { createAdminClient } from '@/lib/db/admin'
import { startAgentTrace, toAgentUsage } from '@/lib/observability'
import { loadVoicePack } from '@/lib/rag/voice-pack'
import { retrieveKnowledgeContext } from '@/lib/rag/retrieve'
import {
  parseVenueLinks,
  venueOwnDomainWildcard,
} from '@/lib/schemas/venue-info'
import { DELIVERED_OUTBOUND_STATUSES } from '@/lib/agent/group-responses'
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
import { renderVenueProfile } from '@/lib/ai/v2/venue-profile'
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

export interface TurnOverrides {
  /** Force the relationship state (key must exist in the graph). */
  stateKey?: string
  /** Replace the mission text the brief renders. */
  mission?: string
  /** Replace rendered sections wholesale. */
  guestProfileText?: string
  interactionMemoryText?: string
  openMovesText?: string
  knowledgeText?: string
  voicePackText?: string
  venueProfileText?: string
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
  /** The guest's message(s) this turn, oldest first. */
  inbound: string[]
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
  composed: ComposedPrompt
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
    .select('venue_info, brand_persona')
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

  let knowledgeText = o.knowledgeText
  if (knowledgeText === undefined) {
    const knowledge = await retrieveKnowledgeContext({
      venueId: input.venueId,
      query: input.inbound.join('\n').slice(0, 500),
      limit: 4,
    })
    // Fails open: a less specific reply still ships.
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

  if (input.guestId !== null) {
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
        supabase
          .from('messages')
          .select('body, direction, status, created_at')
          .eq('venue_id', input.venueId)
          .eq('guest_id', input.guestId)
          .order('created_at', { ascending: false })
          .limit(HISTORY_LIMIT),
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
    history = rows
      .filter(
        (m) =>
          m.direction === 'inbound' ||
          DELIVERED_OUTBOUND_STATUSES.has(m.status ?? ''),
      )
      .map((m): HistoryTurn => ({
        role: m.direction === 'inbound' ? 'user' : 'assistant',
        text: m.body ?? '',
      }))
      .filter((t) => t.text.length > 0)
    // Merge same-role runs so roles alternate (the splitHistory discipline).
    history = history.reduce<HistoryTurn[]>((acc, t) => {
      const last = acc[acc.length - 1]
      if (last && last.role === t.role) last.text = `${last.text}\n${t.text}`
      else acc.push({ ...t })
      return acc
    }, [])
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

  const composed = composePrompt({
    venueName,
    speakerClause: '',
    instagramClause,
    lengthClause,
    venueProfile: sections.venueProfile,
    voicePack: sections.voicePack,
    knowledge: sections.knowledge,
    history,
    stateLabel: stateDef.label,
    stateKey,
    mission,
    guestProfile: sections.guestProfile,
    interactionMemory: sections.interactionMemory,
    openMoves: sections.openMoves,
    inboundMessages: input.inbound,
  })

  const base = {
    input,
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
    composed,
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
    generateV2Reply(composed),
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

  const gate = decideDispatch({
    draftMessages: output.messages,
    declaredActionTypes: declaredActionTypes(output),
    semantic,
    policySet: DEFAULT_POLICY_SET,
    stateKey,
    // From the INBOUND detection above - genuinely available pre-send. Never
    // from the assessor, whose flags are post-send in production wiring; the
    // gate refuses opt_out_request regardless (POLICY_EXEMPT_SITUATIONS).
    situations: detectedSituations,
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
      model: GENERATION_MODEL_ID,
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
      situations: detectedSituations,
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
