// TAC-584: does the agent describe a guest's picture, name only what is
// unmistakable, leave people out, and record a visit only for the venue? The
// half that spends model calls. The scoring is media-describe-score.ts.
//
// THE CHECK IS PRE-REGISTERED on the ticket's plan (2026-10-11): the images,
// the arms, the counts and the seven bars were fixed before any generation.
// A re-run is informational. Read that plan before reading a result.
//
// IT NEEDS IMAGES THIS REPO DOES NOT HOLD. The repo is public, so no image is
// committed. fixtures/media-describe-manifest.json lists thirty and what each
// should show; the files go in measurement-runs/media-describe-images/
// (gitignored) and each one's truth is labelled BY A PERSON before any model
// call. This script refuses to start, and calls nothing, while any image is
// missing, unlabelled, or does not hash to what its label was written for.
//
// WHAT IT RUNS.
//   Stage 1, describe  every image 5 times with the venue's appearance notes
//                      (the main arm, 150 calls), and two controls that exist
//                      so the main arm has something to disagree with:
//                        no_notes  sets A, B and the two look-alikes in D,
//                                  with the notes left out. A model that
//                                  still calls a drink unmistakable is naming
//                                  from its own idea of the drink.
//                        swapped   the single-drink images in set A, with the
//                                  two distinctive drinks' notes exchanged.
//                                  The names should follow the notes.
//   Stage 2, drafts    one describe result per image, fixed, then three
//                      drafts in each of two arms:
//                        image        the description AND the picture, which
//                                     is what production sends
//                        description  the description alone. The plan's
//                                     pushback: the picture gives the
//                                     generator a way round the describe
//                                     step's rules, and this arm is what says
//                                     whether it uses it.
//                      plus a history arm: ten descriptions as an earlier
//                      line, then the guest asking what to get next time.
//   Stage 3, visits    no calls. The visit decision is a pure function of
//                      stage 1's output and is scored with it.
//
// NOTHING IS SENT OR WRITTEN. Every guest thread is constructed, with the
// real guest's commitments, context, mechanics and intentions cleared (a
// leaked open comp reached a ruling on TAC-575). The describe step's own
// writes are not exercised: this calls describeAttachment directly.
//
// IT IS GENERATE-ONLY, SO IT BYPASSES what generateMessage does after the
// call: the regeneration loop and the dash, length and bracket checks. It
// measures what the prompt produces, which is the thing under test.
//
// RUN IT DURING THE VENUE'S OPEN HOURS, like run-test-scenarios: the prompt
// carries the venue's open state.
//
//   npm run measure-media-describe -- --hash    fill in sha256 from the files
//   MEASURE_DRY=1 npm run measure-media-describe   check everything, call nothing
//   npm run measure-media-describe -- --smoke   one describe and one draft on
//                                               a generated test pattern, to
//                                               prove the plumbing. Scores
//                                               nothing and is not the check.
//   npm run measure-media-describe              the check
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { generateObject } from 'ai'

import { buildRuntimeContext } from '@/lib/agent/build-runtime-context'
import { buildMediaHistory } from '@/lib/agent/media-history'
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
import {
  DESCRIBE_ATTACHMENT_PROMPT_VERSION,
  type DescribeAttachmentResult,
  type DescribedMediaKind,
  describeAttachment,
} from '@/lib/ai/describe-attachment'
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
  type Frame,
  ffmpegBinaryPath,
  imageToFrame,
  videoToFrames,
} from '@/lib/messaging/attachments/frames'
import { startAgentTrace } from '@/lib/observability/langfuse'
import { loadAppearanceEntries } from '@/lib/rag/appearance-entries'
import {
  cleanDescription,
  nameableItems,
} from '@/lib/schemas/attachment-description'
import { toParsedGuestContext } from '@/lib/schemas/guest-context'

import {
  type DescribeUnit,
  type DraftUnit,
  type ImageTruth,
  evaluate,
} from './media-describe-score'
import { createRunLog } from './run-log'
import { seededFlip } from './seeded-flip'

const MANIFEST_PATH = path.join(
  'scripts',
  'measurement',
  'fixtures',
  'media-describe-manifest.json',
)
const DEFAULT_IMAGES_DIR = path.join(
  'measurement-runs',
  'media-describe-images',
)

const MAIN_REPS = 5
const CONTROL_REPS = 5
const DRAFT_REPS = 3
const HISTORY_IMAGES = 10
const HISTORY_REPS = 2
const HISTORY_INBOUND = 'what should I get next time?'
// What production composes a media-only draft as (handle-inbound.ts,
// MEDIA_ONLY_DRAFT_CATEGORY). Spelled out, so a change there is a void run
// here and not a silent change of what was measured.
const DRAFT_CATEGORY: MessageCategory = 'casual_chatter'

type ManifestImage = {
  id: string
  set: string
  file: string
  shoot: string
  sha256: string | null
  labelled: boolean
  truth: Omit<ImageTruth, 'id' | 'set'> & { isVenue: boolean | null }
}
type Manifest = {
  venueSlug: string
  swapPair: [string, string]
  images: ManifestImage[]
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function loadManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest
}

/** Every reason the manifest is not ready. Empty means it is. */
function manifestProblems(manifest: Manifest, dir: string): string[] {
  const problems: string[] = []
  for (const image of manifest.images) {
    const file = path.join(dir, image.file)
    if (!existsSync(file)) {
      problems.push(`${image.id}: no file at ${file}`)
      continue
    }
    if (!image.labelled) problems.push(`${image.id}: not labelled`)
    if (image.truth.isVenue === null) {
      problems.push(`${image.id}: truth.isVenue is not set`)
    }
    if (image.sha256 === null) {
      problems.push(`${image.id}: no sha256 (run with --hash)`)
    } else if (image.sha256 !== sha256(file)) {
      problems.push(
        `${image.id}: the file is not the one its label was written for (hash differs)`,
      )
    }
  }
  return problems
}

function mediaKindOf(image: ManifestImage): DescribedMediaKind {
  if (/\.(mp4|mov|m4v|webm)$/i.test(image.file)) return 'video'
  return image.set === 'H' ? 'story' : 'photo'
}

async function framesOf(file: string): Promise<Frame[]> {
  const bytes = new Uint8Array(readFileSync(file))
  const isVideo = /\.(mp4|mov|m4v|webm)$/i.test(file)
  const mime = isVideo
    ? 'video/mp4'
    : /\.png$/i.test(file)
      ? 'image/png'
      : /\.gif$/i.test(file)
        ? 'image/gif'
        : /\.webp$/i.test(file)
          ? 'image/webp'
          : 'image/jpeg'
  const result = isVideo
    ? await videoToFrames(bytes)
    : await imageToFrame(bytes, mime)
  if (!result.ok) throw new Error(`no frames from ${file}: ${result.error}`)
  return result.frames
}

/** The two distinctive drinks' names exchanged in every note that has one. */
function swapNotes(notes: readonly string[], pair: [string, string]): string[] {
  const [a, b] = pair
  const hold = '\u0000swap\u0000'
  return notes.map((note) =>
    note.split(a).join(hold).split(b).join(a).split(hold).join(b),
  )
}

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

function toDescribeUnit(
  image: string,
  arm: DescribeUnit['arm'],
  rep: number,
  data: DescribeAttachmentResult,
): DescribeUnit {
  return {
    image,
    arm,
    rep,
    description: data.description,
    legibility: data.legibility,
    showsVenue: data.showsVenue,
    peoplePresent: data.peoplePresent,
    items: data.items,
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

async function smoke(): Promise<void> {
  // A generated test pattern, so this needs no image from anyone. It proves
  // three things the harness under scripts/harness/ cannot: that ffmpeg
  // runs, that a model call accepts an image part in the shape this repo
  // sends it, and that a prompt composed for a turn with no text is one the
  // generator answers. It says nothing about what a model makes of a drink.
  const binary = ffmpegBinaryPath()
  if (binary === null) throw new Error('ffmpeg-static resolved to no binary')
  const { execFileSync } = await import('node:child_process')
  const png = execFileSync(
    binary,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=1280x720:rate=1',
      '-frames:v',
      '1',
      '-f',
      'image2pipe',
      '-vcodec',
      'png',
      'pipe:1',
    ],
    { maxBuffer: 20_000_000 },
  )
  const framed = await imageToFrame(new Uint8Array(png), 'image/png')
  if (!framed.ok) throw new Error(`smoke: no frame (${framed.error})`)
  console.log(
    `[smoke] ffmpeg ok: 1 frame, ${framed.frames[0].bytes.byteLength} bytes, ${framed.frames[0].mediaType}`,
  )

  const described = await describeAttachment({
    frames: framed.frames,
    kind: 'photo',
    venueName: 'Smoke Test Cafe',
    menuItemNames: ['Cortado', 'Latte'],
    appearanceNotes: [],
  })
  if (!described.ok)
    throw new Error(`smoke: describe failed: ${described.error}`)
  console.log('[smoke] describe ok:', {
    description: described.data.description,
    legibility: described.data.legibility,
    showsVenue: described.data.showsVenue,
    peoplePresent: described.data.peoplePresent,
    items: described.data.items,
    model: described.data.modelId,
    usage: described.data.usage,
  })

  const db = createAdminClient()
  const manifest = loadManifest()
  const now = new Date()
  const { venue, guestId } = await venueAndGuest(db, manifest.venueSlug)
  const base = await baseContext(venue.id, guestId, now)
  const corpus = await retrieveCorpusStage(base)
  const ctx = constructedContext(base, now, {
    corpus,
    inboundDescribedMedia: [
      {
        word: 'photo',
        description: cleanDescription(described.data.description),
        nameableItems: [],
      },
    ],
  })
  const composed = composePrompt({
    category: DRAFT_CATEGORY,
    persona: ctx.venue.brandPersona,
    venueInfo: ctx.venue.venueInfo,
    ragChunks: toRagChunks(corpus),
    runtime: buildAiRuntime(ctx, coinFor('smoke')),
    channel: 'instagram',
  })
  const lastLines = composed.userPrompt
    .split('\n')
    .filter((l) => l.startsWith('['))
  console.log('[smoke] the line the model reads:\n  ' + lastLines.join('\n  '))
  const body = await generateDraft(composed, framed.frames)
  console.log(
    `[smoke] draft with an image part ok:\n  ${body.replace(/\n/g, '\n  ')}`,
  )
  console.log(
    '\nSMOKE ONLY. Two model calls on a test pattern. This is not the behavioural check and scores nothing.',
  )
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

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2))
  if (args.has('--smoke')) return smoke()

  const dir = process.env.MEDIA_DESCRIBE_DIR ?? DEFAULT_IMAGES_DIR
  const manifest = loadManifest()

  if (args.has('--hash')) {
    // No model call, no database. Reads the files and pins each label to one.
    let filled = 0
    for (const image of manifest.images) {
      const file = path.join(dir, image.file)
      if (!existsSync(file)) {
        console.log(`  ${image.id}: no file at ${file}`)
        continue
      }
      image.sha256 = sha256(file)
      filled += 1
    }
    const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Record<
      string,
      unknown
    >
    writeFileSync(
      MANIFEST_PATH,
      `${JSON.stringify({ ...raw, images: manifest.images }, null, 2)}\n`,
    )
    console.log(`hashed ${filled} of ${manifest.images.length} images`)
    return
  }

  const problems = manifestProblems(manifest, dir)
  if (problems.length > 0) {
    console.log(
      `NOT RUN. ${problems.length} problem(s) with the test images. No model was called.\n`,
    )
    for (const problem of problems) console.log(`  ${problem}`)
    process.exitCode = 1
    return
  }

  const dry = process.env.MEASURE_DRY === '1'
  const db = createAdminClient()
  const now = new Date()
  const { venue, guestId } = await venueAndGuest(db, manifest.venueSlug)
  const base = await baseContext(venue.id, guestId, now)
  const menuNames = base.venue.venueInfo.menu.items.map((item) => item.name)
  const { data: venueRow } = await db
    .from('venues')
    .select('name')
    .eq('id', venue.id)
    .maybeSingle()
  const venueName = venueRow?.name ?? null

  const loadedNotes = await loadAppearanceEntries(db, venue.id)
  if (!loadedNotes.ok) throw new Error(`appearance notes: ${loadedNotes.error}`)
  const notes = loadedNotes.data
  if (notes.length === 0) {
    console.log(
      `NOT RUN. ${manifest.venueSlug} has no appearance notes (knowledge rows tagged "appearance"). The main arm would be the no-notes control. No model was called.`,
    )
    process.exitCode = 1
    return
  }
  // Convention 9: say up front when an arm cannot differ from its control.
  const swappedNotes = swapNotes(notes, manifest.swapPair)
  if (JSON.stringify(swappedNotes) === JSON.stringify(notes)) {
    console.log(
      `NOT RUN. Swapping "${manifest.swapPair[0]}" and "${manifest.swapPair[1]}" changes nothing in the notes, so the swapped arm would be the main arm. No model was called.`,
    )
    process.exitCode = 1
    return
  }
  for (const image of manifest.images) {
    for (const name of image.truth.itemsPresent) {
      if (!menuNames.includes(name)) {
        throw new Error(
          `${image.id}: "${name}" is not on ${manifest.venueSlug}'s live menu. Labels use the menu's own spelling.`,
        )
      }
    }
  }

  const truths: ImageTruth[] = manifest.images.map((image) => ({
    id: image.id,
    set: image.set,
    ...image.truth,
    isVenue: image.truth.isVenue === true,
  }))
  const controlNoNotes = manifest.images.filter(
    (image) =>
      image.set === 'A' || image.set === 'B' || ['d2', 'd3'].includes(image.id),
  )
  const controlSwapped = manifest.images.filter(
    (image) => image.set === 'A' && image.truth.expectNamed.length === 1,
  )
  const describeCalls =
    manifest.images.length * MAIN_REPS +
    controlNoNotes.length * CONTROL_REPS +
    controlSwapped.length * CONTROL_REPS
  const draftCalls =
    manifest.images.length * DRAFT_REPS * 2 + HISTORY_IMAGES * HISTORY_REPS

  console.log(
    `[media-describe] venue=${manifest.venueSlug} prompt=${PROMPT_VERSION} describe=${DESCRIBE_ATTACHMENT_PROMPT_VERSION} notes=${notes.length} menu=${menuNames.length}`,
  )
  console.log(
    `[media-describe] planned: ${describeCalls} describe calls, ${draftCalls} generations${dry ? '  DRY (no model calls)' : ''}`,
  )
  if (dry) {
    console.log(
      'DRY: images present, labelled and hashed; notes loaded; the swapped arm differs from the main arm. No model was called.',
    )
    return
  }

  const log = createRunLog({
    name: 'media-describe',
    meta: {
      arm: 'describe:main+no_notes+swapped; drafts:image+description+history',
      promptVersion: PROMPT_VERSION,
      describePromptVersion: DESCRIBE_ATTACHMENT_PROMPT_VERSION,
      venue: manifest.venueSlug,
      appearanceNotes: notes.length,
      swapPair: manifest.swapPair,
      images: manifest.images.map((image) => `${image.id}:${image.sha256}`),
      reps: { MAIN_REPS, CONTROL_REPS, DRAFT_REPS, HISTORY_REPS },
      draftCategory: DRAFT_CATEGORY,
    },
  })
  console.log(`[media-describe] run log: ${log.path}`)

  // --- stage 1 ---------------------------------------------------------------
  const describes: DescribeUnit[] = []
  const frames = new Map<string, Frame[]>()
  const firstMain = new Map<string, DescribeAttachmentResult>()
  const arms: {
    arm: DescribeUnit['arm']
    images: ManifestImage[]
    notes: string[]
    reps: number
  }[] = [
    { arm: 'main', images: manifest.images, notes, reps: MAIN_REPS },
    { arm: 'no_notes', images: controlNoNotes, notes: [], reps: CONTROL_REPS },
    {
      arm: 'swapped',
      images: controlSwapped,
      notes: swappedNotes,
      reps: CONTROL_REPS,
    },
  ]
  for (const { arm, images, notes: armNotes, reps } of arms) {
    for (const image of images) {
      if (!frames.has(image.id)) {
        frames.set(image.id, await framesOf(path.join(dir, image.file)))
      }
      for (let rep = 1; rep <= reps; rep += 1) {
        const result = await describeAttachment({
          frames: frames.get(image.id) ?? [],
          kind: mediaKindOf(image),
          venueName,
          menuItemNames: menuNames,
          appearanceNotes: armNotes,
        })
        const unit: DescribeUnit = result.ok
          ? toDescribeUnit(image.id, arm, rep, result.data)
          : { image: image.id, arm, rep, error: result.error }
        if (result.ok && arm === 'main' && rep === 1) {
          firstMain.set(image.id, result.data)
        }
        describes.push(unit)
        log.appendUnit({ stage: 'describe', set: image.set, ...unit })
        console.log(
          `[describe ${image.id}/${arm}/${rep}] ${
            result.ok
              ? `${result.data.legibility} venue=${result.data.showsVenue} people=${result.data.peoplePresent} items=${JSON.stringify(result.data.items)}\n    ${result.data.description}`
              : `FAILED: ${result.error}`
          }`,
        )
      }
    }
  }

  // --- stage 2 ---------------------------------------------------------------
  const drafts: DraftUnit[] = []
  const corpus = await retrieveCorpusStage(base)
  const ragChunks = toRagChunks(corpus)
  for (const image of manifest.images) {
    const described = firstMain.get(image.id)
    // Its describe failed: already a void cell in stage 1.
    if (described === undefined) continue
    const clear = described.legibility === 'clear'
    const allowed = clear
      ? nameableItems(
          { items: described.items, legibility: described.legibility },
          menuNames,
        )
      : []
    const media: InboundDescribedMedia = {
      word: mediaKindOf(image),
      description: clear ? cleanDescription(described.description) : null,
      nameableItems: allowed,
    }
    const ctx = constructedContext(base, now, {
      corpus,
      inboundDescribedMedia: [media],
    })
    // What persistMediaOnlyDraft does: search on the named drinks, or not at
    // all.
    const knowledge =
      allowed.length > 0
        ? toKnowledgeChunks(
            await retrieveKnowledgeStage(
              ctx,
              DRAFT_CATEGORY,
              allowed.join(', '),
            ),
          )
        : undefined
    // ONE composed prompt for both arms, so they cannot differ in anything
    // but the picture. Convention 9 by construction, not by comparison.
    const composed = composePrompt({
      category: DRAFT_CATEGORY,
      persona: ctx.venue.brandPersona,
      venueInfo: ctx.venue.venueInfo,
      ragChunks,
      knowledgeChunks: knowledge,
      runtime: buildAiRuntime(ctx, coinFor(image.id)),
      channel: 'instagram',
    })
    // Production shows no picture for an unclear one, so the `image` arm of
    // an unclear image is the `description` arm. Said, not hidden.
    const shown = clear ? (frames.get(image.id) ?? []) : []
    for (const arm of ['image', 'description'] as const) {
      for (let rep = 1; rep <= DRAFT_REPS; rep += 1) {
        const unit: DraftUnit = {
          image: image.id,
          arm,
          rep,
          allowedItems: allowed,
          unclear: !clear,
        }
        try {
          unit.body = await generateDraft(
            composed,
            arm === 'image' ? shown : [],
          )
        } catch (e) {
          unit.error = e instanceof Error ? e.message : String(e)
        }
        drafts.push(unit)
        log.appendUnit({
          stage: 'draft',
          set: image.set,
          picturesShown: arm === 'image' ? shown.length : 0,
          ...unit,
        })
        console.log(
          `\n[draft ${image.id}/${arm}/${rep}] set ${image.set}${clear ? '' : ' (unclear)'} allowed=${JSON.stringify(allowed)}\n  ${(unit.body ?? `FAILED: ${unit.error}`).replace(/\n/g, '\n  ')}`,
        )
      }
    }
  }

  // The history arm: a described picture as an earlier line, then a question.
  const historyImages = manifest.images
    .filter((image) => firstMain.get(image.id)?.legibility === 'clear')
    .slice(0, HISTORY_IMAGES)
  for (const image of historyImages) {
    const described = firstMain.get(image.id)
    if (described === undefined) continue
    const photoAt = new Date(now.getTime() - 10 * 60_000)
    const media = buildMediaHistory(
      [
        {
          id: 'photo',
          created_at: photoAt.toISOString(),
          media_urls: [
            'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1',
          ],
          unsupported_content: null,
        },
      ],
      [
        {
          message_id: 'photo',
          kind: mediaKindOf(image) === 'video' ? 'video' : 'image',
          provider_type: 'image',
          title: null,
          description: described.description,
          description_meta: {
            version: 1,
            outcome: 'described',
            promptVersion: described.promptVersion,
            model: described.modelId ?? 'unknown',
            legibility: described.legibility,
            showsVenue: described.showsVenue,
            peoplePresent: described.peoplePresent,
            items: described.items,
            frames: 1,
            source: 'stored',
          },
        },
      ],
    )
    const ctx = constructedContext(base, now, {
      corpus,
      mediaOnlyInbounds: media.mediaOnlyInbounds,
      mediaContext: true,
    })
    ctx.currentMessage = {
      ...(ctx.currentMessage as NonNullable<RuntimeContext['currentMessage']>),
      body: HISTORY_INBOUND,
    }
    const category = (await classifyStage(ctx)).category
    const composed = composePrompt({
      category,
      persona: ctx.venue.brandPersona,
      venueInfo: ctx.venue.venueInfo,
      ragChunks,
      knowledgeChunks: toKnowledgeChunks(
        await retrieveKnowledgeWithContextStage(ctx, category, HISTORY_INBOUND),
      ),
      runtime: buildAiRuntime(ctx, coinFor(`${image.id}/history`)),
      channel: 'instagram',
    })
    // A harness that calls generateObject itself must send historyTurns, or
    // it measures a conversation with no history. This arm IS the history,
    // so its absence voids it.
    if (!JSON.stringify(composed.historyTurns).includes('[guest ')) {
      throw new Error(
        `VOID ${image.id}/history: the described line is not in the history turns`,
      )
    }
    for (let rep = 1; rep <= HISTORY_REPS; rep += 1) {
      // The history line names nothing, so the reply is free to name any menu
      // item it recommends: recommending a drink is not misnaming a picture.
      const unit: DraftUnit = {
        image: image.id,
        arm: 'history',
        rep,
        allowedItems: menuNames,
        unclear: false,
      }
      try {
        unit.body = await generateDraft(composed, [])
      } catch (e) {
        unit.error = e instanceof Error ? e.message : String(e)
      }
      drafts.push(unit)
      log.appendUnit({ stage: 'draft', set: image.set, category, ...unit })
      console.log(
        `\n[draft ${image.id}/history/${rep}] (${category}) "${HISTORY_INBOUND}"\n  ${(unit.body ?? `FAILED: ${unit.error}`).replace(/\n/g, '\n  ')}`,
      )
    }
  }

  // --- the verdict, in code --------------------------------------------------
  const result = evaluate({ truths, describes, drafts, menuNames })
  console.log('\n================ BARS (every ceiling is 0) ================')
  for (const bar of result.bars) {
    console.log(
      `${bar.met ? 'MET   ' : 'BREACH'} ${bar.id}. ${bar.name}: ${bar.breaches.length} of ${bar.countedOver}`,
    )
    for (const breach of bar.breaches) console.log(`         ${breach}`)
  }
  console.log('\n================ REPORTED, NOT A BAR ================')
  for (const line of result.report) console.log(line)
  log.appendUnit({ stage: 'verdict', ...result })

  if (result.voidCells.length > 0) {
    console.log(
      `\nVOID: ${result.voidCells.length} call(s) failed (${result.voidCells.slice(0, 8).join(', ')}${result.voidCells.length > 8 ? ', ...' : ''}). A failed call is not a result. Do not read a count from this run.`,
    )
    process.exitCode = 1
    return
  }
  const breached = result.bars.filter((bar) => !bar.met)
  console.log(
    breached.length > 0
      ? `\nNOT MET: ${breached.map((bar) => bar.id).join(', ')}.`
      : '\nNo breach found by the detectors. Bars 3, 5, 6 and 7 read free text: the bar is not met until every set E and set F body above has been read by hand.',
  )
  if (breached.length > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
