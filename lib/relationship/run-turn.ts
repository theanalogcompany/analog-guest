import { createAdminClient } from '@/lib/db/admin'
import { loadVoicePack } from '@/lib/rag/voice-pack'
import { retrieveKnowledgeContext } from '@/lib/rag/retrieve'
import { DELIVERED_OUTBOUND_STATUSES } from '@/lib/agent/group-responses'
import {
  composePrompt,
  type ComposedPrompt,
  type HistoryTurn,
} from '@/lib/ai/v2/compose'
import { generateV2Reply } from '@/lib/ai/v2/generate'
import { declaredActionTypes, type GenerationOutput } from '@/lib/ai/v2/actions'
import { judgeResponse, type JudgeResult } from '@/lib/eval/judge'
import { DEFAULT_POLICY_SET } from '@/lib/policy/default-policies'
import { decideDispatch, type GateDecision } from '@/lib/policy/gate'
import {
  detectSituations,
  type SituationDetectionOutcome,
} from '@/lib/policy/detect-situations'
import {
  runSemanticCheck,
  type SemanticCheckOutcome,
} from '@/lib/policy/semantic-check'
import { applyAssessment, runAssessor, type AssessorResult } from './assessor'
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
  now?: Date
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
  history: HistoryTurn[]
  composed: ComposedPrompt
  /** Inbound situation detection (fast axis); null only on pre-generation failures. */
  situations: (SituationDetectionOutcome & { durationMs: number }) | null
  generation:
    | {
        ok: true
        output: GenerationOutput
        durationMs: number
        usage: { inputTokens?: number; outputTokens?: number }
      }
    | { ok: false; error: string }
  semantic: (SemanticCheckOutcome & { durationMs: number }) | null
  gate: GateDecision | null
  judge:
    | { ok: true; result: JudgeResult; durationMs: number }
    | { ok: false; error: string }
    | null
  /** The judge over input.actualReply (what production sent); null when none was given. */
  actualJudge:
    | { ok: true; result: JudgeResult; durationMs: number }
    | { ok: false; error: string }
    | null
  assessor:
    | {
        ok: true
        result: AssessorResult
        nextSession: PlaygroundSession
        durationMs: number
      }
    | { ok: false; error: string }
    | null
  totalDurationMs: number
}

const HISTORY_LIMIT = 30

export async function runTurn(input: RunTurnInput): Promise<TurnTrace> {
  const now = input.now ?? new Date()
  const started = Date.now()
  const supabase = createAdminClient()
  const o = input.overrides ?? {}

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

  const configRow = await supabase
    .from('venue_configs')
    .select('venue_info')
    .eq('venue_id', input.venueId)
    .maybeSingle()
  // Crude serialization for now; the section registry's venue-profile
  // renderer (phase 3 polish) replaces this. Override covers the gap.
  const venueProfile =
    o.venueProfileText ??
    (configRow.data?.venue_info
      ? JSON.stringify(configRow.data.venue_info, null, 1).slice(0, 4000)
      : venueName)

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
          .eq('guest_id', input.guestId),
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

  const composed = composePrompt({
    venueName,
    speakerClause: '',
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
  const briefText = composed.turns[history.length]?.text ?? ''

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
            provided_links: extractLinks(sections.knowledge),
            recent_conversation: transcript.slice(-3000),
          },
          DEFAULT_POLICY_SET,
        ),
      ),
      timed(
        judgeResponse({
          replyMessages: output.messages,
          transcript,
          situationBrief: briefText,
          venueName,
        }),
      ),
      timed(
        actualReply !== null && actualTranscript !== null
          ? judgeResponse({
              replyMessages: actualReply,
              transcript: actualTranscript,
              situationBrief: briefText,
              venueName,
            })
          : Promise.resolve(null),
      ),
      timed(
        runAssessor({
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

  let assessorTrace: TurnTrace['assessor']
  if (assessed.ok) {
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
    },
    semantic: { ...semantic, durationMs: semanticTimed.durationMs },
    gate,
    judge: judged.ok
      ? {
          ok: true,
          result: judged.data,
          durationMs: judgedTimed.durationMs,
        }
      : { ok: false, error: judged.error },
    actualJudge:
      actualJudged === null
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

function extractLinks(text: string): string[] {
  return text.match(/https?:\/\/\S+|www\.\S+/gi) ?? []
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
