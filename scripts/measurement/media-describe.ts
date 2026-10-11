// TAC-584: describe the media a venue has already been sent, and draft a reply
// to each, once. A smoke run, not a measurement.
//
// WHY THIS IS NOT THE PRE-REGISTERED CHECK. The plan on TAC-584 pre-registered
// a 30-image behavioural check with seven zero-ceiling bars and two control
// arms. The owner ruled on 2026-10-11 to ship without it: every media reply is
// held for an operator, so draft quality is read by hand on real cards. That
// check was written and never run; it is in this branch's history (commit
// c443065) if it is wanted later. What replaced it is this: run the real
// pipeline over the real media one test venue holds, and read what comes out.
//
// WHAT IT PROVES, AND WHAT IT DOES NOT. It proves the plumbing end to end
// against production's own rows: that a stored photo, GIF and video can be
// read from the bucket and turned into frames, that a story link can be
// fetched transiently, that a model call accepts a picture in the shape this
// repo sends it, and that a prompt composed for a turn with no text is one
// the generator answers. It is one describe and one draft per attachment, so
// it says NOTHING about how often a description is wrong, a drink is misnamed
// or a person is commented on. A count from this run is an anecdote.
//
// IT USES THE PRODUCTION DESCRIBE STEP, NOT A COPY. describeMessageAttachments
// is called with three of its dependencies replaced: the row read (so it does
// not select columns migration 081 adds, and this runs before that migration
// is applied), the save and the degrade report (both no-ops). Everything else
// is the code a turn runs: the wait, the kinds that are skipped, the story's
// transient fetch, ffmpeg, the vision call, and the rule that a venue with no
// appearance notes names nothing.
//
// NOTHING IS WRITTEN AND NOTHING IS SENT. No description is saved, no visit
// row, no card. The visit decision is computed with the pure rule and
// printed. Every guest thread is constructed, with the real guest's
// commitments, context, mechanics and intentions cleared.
//
// THE PICTURES GO TO THE MODEL PROVIDER, as they will in production. Run it
// only against a venue whose media is ours to send: the default is the test
// venue.
//
//   npm run measure-media-describe -- --list             what it would describe; no model call
//   npm run measure-media-describe                       le-mils-coffee-test
//   npm run measure-media-describe -- --venue <slug>
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { generateObject } from 'ai'

import { buildRuntimeContext } from '@/lib/agent/build-runtime-context'
import {
  buildAiRuntime,
  classifyStage,
  retrieveCorpusStage,
  retrieveKnowledgeStage,
  retrieveKnowledgeWithContextStage,
} from '@/lib/agent/stages'
import type { RuntimeContext } from '@/lib/agent/types'
import { getGenerationModel } from '@/lib/ai/client'
import { composePrompt } from '@/lib/ai/compose-prompt'
import { DESCRIBE_ATTACHMENT_PROMPT_VERSION } from '@/lib/ai/describe-attachment'
import {
  GeneratedMessageSchema,
  MAX_OUTPUT_TOKENS,
} from '@/lib/ai/generate-message'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import type {
  InboundDescribedMedia,
  KnowledgeCorpusChunk as AiKnowledgeCorpusChunk,
  MessageCategory,
  VoiceCorpusChunk as AiVoiceCorpusChunk,
} from '@/lib/ai/types'
import { createAdminClient } from '@/lib/db/admin'
import {
  type DescribeTarget,
  describeMessageAttachments,
  planDescribe,
} from '@/lib/messaging/attachments/describe'
import type { Frame } from '@/lib/messaging/attachments/frames'
import {
  isAttachmentKind,
  isAttachmentStatus,
} from '@/lib/messaging/attachments/kind'
import { startAgentTrace } from '@/lib/observability/langfuse'
import { loadAppearanceEntries } from '@/lib/rag/appearance-entries'
import {
  evidencesVisit,
  nameableItems,
} from '@/lib/schemas/attachment-description'
import { toParsedGuestContext } from '@/lib/schemas/guest-context'

import { RUN_LOG_DIR, createRunLog } from './run-log'
import { seededFlip } from './seeded-flip'

const DEFAULT_VENUE = 'le-mils-coffee-test'
/** The most messages described in one run. Newest first. */
const MAX_MESSAGES = 12
// What production composes a media-only draft as (handle-inbound.ts,
// MEDIA_ONLY_DRAFT_CATEGORY). Spelled out, so a change there shows up here.
const DRAFT_CATEGORY: MessageCategory = 'casual_chatter'

type BaseCtx = Awaited<ReturnType<typeof buildRuntimeContext>>

/**
 * A constructed guest with nothing of the real one's, at the moment a
 * message with no text arrives. Mirrors what persistMediaOnlyDraft sets.
 */
function constructedContext(
  base: BaseCtx,
  now: Date,
  overrides: Partial<RuntimeContext>,
): RuntimeContext {
  const firstContact = new Date(now.getTime() - 20 * 60_000)
  return {
    ...base,
    guest: {
      ...base.guest,
      firstName: null,
      context: toParsedGuestContext({}, now),
      createdAt: firstContact,
      firstContactedAt: firstContact,
      reviewAskedAt: null,
    },
    currentMessage: {
      id: randomUUID(),
      providerMessageId: `media-describe-${randomUUID()}`,
      body: '',
      receivedAt: now,
      channel: 'instagram',
      referralSource: null,
    },
    recentMessages: [],
    mediaOnlyInbounds: [],
    wroteBeforeHistoryWindow: false,
    recentVisits: [],
    recognition: { ...base.recognition, state: 'new' },
    activeCommitments: [],
    mechanics: [],
    openIntentions: [],
    pendingQuestion: null,
    reviewAsk: null,
    scanArrival: null,
    inquiryFollowup: null,
    visitCheckback: false,
    visitCheckin: null,
    visitCheckinHold: false,
    insideVisitCheckin: false,
    complaintFollowup: null,
    reOptIn: null,
    inboundMedia: null,
    inboundStoryReply: false,
    visitLocalDate: null,
    intentionDerivation: {
      ...base.intentionDerivation,
      quietAfterWarmClose: false,
    },
    retractableReportedVisits: [],
    conversationChannel: 'instagram',
    firstConversation: true,
    signOff: null,
    mediaContext: true,
    ...overrides,
  } as RuntimeContext
}

function coinFor(seed: string): () => number {
  let flip = 0
  return () => {
    flip += 1
    return seededFlip(`${seed}/${flip}`)
  }
}

async function generateDraft(
  composed: ReturnType<typeof composePrompt>,
  images: readonly Frame[],
): Promise<string> {
  const { object } = await generateObject({
    model: getGenerationModel(),
    messages: [
      {
        role: 'system',
        content: composed.cacheableSystemPrefix,
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
      },
      { role: 'system', content: composed.volatileSystemSuffix },
      ...composed.historyTurns,
      {
        role: 'user',
        // The shape generateMessage sends: the picture ahead of the prompt.
        content:
          images.length > 0
            ? [
                ...images.map((frame) => ({
                  type: 'image' as const,
                  image: frame.bytes,
                  mediaType: frame.mediaType,
                })),
                { type: 'text' as const, text: composed.userPrompt },
              ]
            : composed.userPrompt,
      },
    ],
    schema: GeneratedMessageSchema,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  })
  return object.body
}

type Db = ReturnType<typeof createAdminClient>

async function venueAndGuest(
  db: Db,
  slug: string,
): Promise<{ venue: { id: string; slug: string }; guestId: string }> {
  const { data: venue, error } = await db
    .from('venues')
    .select('id, slug')
    .eq('slug', slug)
    .single()
  if (error || !venue) throw new Error(`venue ${slug} not found`)
  const { data: candidates } = await db
    .from('guests')
    .select('id')
    .eq('venue_id', venue.id)
    .is('opted_out_at', null)
    .order('created_at', { ascending: true })
    .limit(1)
  const guestId = candidates?.[0]?.id
  if (!guestId) throw new Error(`need one guest at ${slug}`)
  return { venue, guestId }
}

function baseContext(venueId: string, guestId: string, now: Date) {
  return buildRuntimeContext({
    agentRunId: randomUUID(),
    guestId,
    venueId,
    trace: startAgentTrace({
      name: 'media-describe',
      agentRunId: randomUUID(),
    }),
    // Withholds computeGuestState's write. Nothing else here writes.
    testRun: true,
    currentMessage: {
      id: randomUUID(),
      providerMessageId: `media-describe-probe-${randomUUID()}`,
      body: 'hi',
      receivedAt: now,
      channel: 'instagram' as const,
      referralSource: null,
    },
  })
}

function toRagChunks(
  corpus: Awaited<ReturnType<typeof retrieveCorpusStage>>,
): AiVoiceCorpusChunk[] {
  return corpus.map((ch) => ({
    id: ch.id,
    text: ch.text,
    sourceType: ch.sourceType as AiVoiceCorpusChunk['sourceType'],
    relevanceScore: ch.similarity,
  }))
}

function toKnowledgeChunks(
  matches: Awaited<ReturnType<typeof retrieveKnowledgeStage>>,
): AiKnowledgeCorpusChunk[] {
  return matches.map((c) => ({
    id: c.id,
    text: c.text,
    sourceType: c.sourceType,
    primaryTags: c.primaryTags,
    secondaryTags: c.secondaryTags,
    relevanceScore: c.similarity,
  }))
}

type SmokeRow = DescribeTarget & {
  body: string
  createdAt: string
  guestId: string
}

/** The venue's guest attachments, newest first, without migration 081's columns. */
async function loadRows(db: Db, venueId: string): Promise<SmokeRow[]> {
  const { data, error } = await db
    .from('message_attachments')
    .select(
      'id, message_id, guest_id, kind, status, provider_type, provider_url, storage_path, mime_type, created_at, messages!inner(direction, body)',
    )
    .eq('venue_id', venueId)
    .eq('messages.direction', 'inbound')
    .order('created_at', { ascending: false })
    .limit(80)
  if (error) throw new Error(`attachments: ${error.message}`)
  return (data ?? []).map((row) => ({
    id: row.id,
    messageId: row.message_id,
    kind: isAttachmentKind(row.kind) ? row.kind : 'unknown',
    status: isAttachmentStatus(row.status) ? row.status : 'failed',
    providerType: row.provider_type,
    providerUrl: row.provider_url,
    storagePath: row.storage_path,
    mimeType: row.mime_type,
    // Never described: the columns do not exist until migration 081.
    description: null,
    descriptionMeta: null,
    describedAt: null,
    body: row.messages.body,
    createdAt: row.created_at,
    guestId: row.guest_id,
  }))
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const venueSlug = argv.includes('--venue')
    ? (argv[argv.indexOf('--venue') + 1] ?? DEFAULT_VENUE)
    : DEFAULT_VENUE
  const listOnly = argv.includes('--list')

  const db = createAdminClient()
  const now = new Date()
  const { venue } = await venueAndGuest(db, venueSlug)
  const rows = await loadRows(db, venue.id)
  const messageIds = [...new Set(rows.map((row) => row.messageId))]

  console.log(
    `[media-smoke] venue=${venueSlug} prompt=${PROMPT_VERSION} describe=${DESCRIBE_ATTACHMENT_PROMPT_VERSION}`,
  )
  console.log(
    `[media-smoke] ${rows.length} guest attachments on ${messageIds.length} messages\n`,
  )
  for (const row of rows) {
    const plan = planDescribe(row)
    console.log(
      `  ${row.createdAt.slice(0, 16)}  ${row.kind.padEnd(13)} ${row.status.padEnd(9)} ${
        plan.action === 'describe' ? `describe (${plan.source})` : plan.action
      }${row.body.trim() !== '' ? '  +text' : ''}  ${row.id.slice(0, 8)}`,
    )
  }
  const describable = messageIds
    .filter((id) =>
      rows.some(
        (row) =>
          row.messageId === id && planDescribe(row).action === 'describe',
      ),
    )
    .slice(0, MAX_MESSAGES)
  console.log(
    `\n[media-smoke] ${describable.length} message(s) have something to describe`,
  )
  if (listOnly) {
    console.log('LIST ONLY. No model was called.')
    return
  }
  if (describable.length === 0) return

  // The guest who sent the media, so the conversation's channel resolves as
  // it did for them. Everything else of theirs is cleared below.
  const firstGuestId = rows.find((row) =>
    describable.includes(row.messageId),
  )?.guestId
  if (firstGuestId === undefined) return
  const baseByGuest = new Map<string, Awaited<ReturnType<typeof baseContext>>>()
  const baseFor = async (guestId: string) => {
    const cached = baseByGuest.get(guestId)
    if (cached !== undefined) return cached
    const built = await baseContext(venue.id, guestId, now)
    baseByGuest.set(guestId, built)
    return built
  }
  const base = await baseFor(firstGuestId)
  const menuItems = base.venue.venueInfo.menu.items
  const menuNames = menuItems.map((item) => item.name)
  const notes = await loadAppearanceEntries(db, venue.id)
  console.log(
    `[media-smoke] menu items: ${menuNames.length}; appearance notes: ${notes.ok ? notes.data.length : `unreadable (${notes.error})`}` +
      (notes.ok && notes.data.length === 0
        ? '. With none, no drink can be named: the describe step drops every item.'
        : ''),
  )
  const corpus = await retrieveCorpusStage(base)
  const ragChunks = toRagChunks(corpus)

  const log = createRunLog({
    name: 'media-smoke',
    meta: {
      arm: 'smoke: one describe and one draft per attachment',
      promptVersion: PROMPT_VERSION,
      describePromptVersion: DESCRIBE_ATTACHMENT_PROMPT_VERSION,
      venue: venueSlug,
      appearanceNotes: notes.ok ? notes.data.length : null,
      messages: describable.length,
    },
  })
  const summary: string[] = []

  for (const messageId of describable) {
    const own = rows.filter((row) => row.messageId === messageId)
    const body = own[0]?.body ?? ''
    const guestId = own[0]?.guestId ?? firstGuestId
    const guestBase = await baseFor(guestId)
    // The production describe step, reading these rows, saving nothing.
    const described = await describeMessageAttachments(db, {
      messageIds: [messageId],
      venue: { id: venue.id, menuItemNames: menuNames },
      guestId,
      deps: {
        loadTargets: async () => own,
        save: async () => {},
        report: async (props) => {
          console.log(
            `  [not described] ${props.attachmentId?.slice(0, 8)}: ${props.reason}`,
          )
        },
      },
    })

    const media: InboundDescribedMedia[] = []
    const images: Frame[] = []
    for (const item of described) {
      if (item.meta === null || item.meta.outcome !== 'described') {
        const why =
          item.meta?.outcome === 'skipped' ? item.meta.reason : 'no result'
        summary.push(
          `- **${item.mediaKind}** \`${item.attachmentId.slice(0, 8)}\`: not described (${why}).`,
        )
        log.appendUnit({
          messageId,
          attachmentId: item.attachmentId,
          skipped: why,
        })
        continue
      }
      const clear =
        item.meta.legibility === 'clear' && item.description !== null
      const allowed = clear ? nameableItems(item.meta, menuNames) : []
      media.push({
        word: item.mediaKind,
        description: clear ? item.description : null,
        nameableItems: allowed,
      })
      if (clear) images.push(...item.frames)
      const visit = evidencesVisit(item.meta)
      const line =
        `- **${item.mediaKind}** \`${item.attachmentId.slice(0, 8)}\`` +
        ` (${item.meta.frames} frame${item.meta.frames === 1 ? '' : 's'}, ${item.meta.source})\n` +
        `  - description: ${item.description ?? '(none)'}\n` +
        `  - legibility \`${item.meta.legibility}\`, shows the venue \`${item.meta.showsVenue}\`, people present \`${item.meta.peoplePresent}\`\n` +
        `  - drinks nameable: ${allowed.length > 0 ? allowed.join(', ') : 'none'}\n` +
        `  - visit decision: ${visit ? 'would record (shadow: nothing written)' : 'none'}`
      summary.push(line)
      console.log(`\n${line}`)
      log.appendUnit({
        messageId,
        attachmentId: item.attachmentId,
        kind: item.mediaKind,
        description: item.description,
        meta: item.meta,
        nameable: allowed,
        visit,
      })
    }
    if (media.length === 0) continue

    const ctx = constructedContext(guestBase, now, {
      corpus,
      inboundDescribedMedia: media,
    })
    ctx.currentMessage = {
      ...(ctx.currentMessage as NonNullable<RuntimeContext['currentMessage']>),
      body,
    }
    // A message with words is classified and searched as production does it;
    // one with none is composed as the media-only draft path composes it.
    const hasText = body.trim() !== ''
    const category = hasText
      ? (await classifyStage(ctx)).category
      : DRAFT_CATEGORY
    const named = [...new Set(media.flatMap((m) => m.nameableItems))]
    const knowledge = hasText
      ? toKnowledgeChunks(
          await retrieveKnowledgeWithContextStage(ctx, category, body),
        )
      : named.length > 0
        ? toKnowledgeChunks(
            await retrieveKnowledgeStage(ctx, DRAFT_CATEGORY, named.join(', ')),
          )
        : undefined
    const composed = composePrompt({
      category,
      persona: ctx.venue.brandPersona,
      venueInfo: ctx.venue.venueInfo,
      ragChunks,
      knowledgeChunks: knowledge,
      runtime: buildAiRuntime(ctx, coinFor(messageId)),
      channel: 'instagram',
    })
    const mediaLines = composed.userPrompt
      .split('\n')
      .filter((l) => l.startsWith('[guest '))
    try {
      const draft = await generateDraft(composed, images.slice(0, 8))
      const block =
        `  - the line the model read: \`${mediaLines.join(' ')}\`\n` +
        (hasText
          ? `  - the guest also wrote: "${body}" (classified \`${category}\`)\n`
          : '') +
        `  - **draft** (${images.length} picture${images.length === 1 ? '' : 's'} shown): ${draft.replace(/\n+/g, ' / ')}`
      summary.push(block)
      console.log(block)
      log.appendUnit({ messageId, category, mediaLines, draft })
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      summary.push(`  - **draft FAILED**: ${error}`)
      console.log(`  draft FAILED: ${error}`)
      log.appendUnit({ messageId, category, error })
    }
  }

  mkdirSync(RUN_LOG_DIR, { recursive: true })
  const out = path.join(RUN_LOG_DIR, `media-smoke-${venueSlug}-summary.md`)
  writeFileSync(out, `${summary.join('\n')}\n`)
  console.log(
    `\n[media-smoke] run log: ${log.path}\n[media-smoke] summary: ${out}`,
  )
  console.log(
    'SMOKE ONLY. One describe and one draft per attachment. Nothing was saved, sent or recorded, and nothing here is a rate.',
  )
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
