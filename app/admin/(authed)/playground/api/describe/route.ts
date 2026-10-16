import { NextResponse } from 'next/server'
import { requireVenueAdmin } from '@/lib/auth'
import {
  describeAttachment,
  DESCRIBE_ATTACHMENT_TRUNCATED_ERROR_CODE,
} from '@/lib/ai/describe-attachment'
import { venueMenuItemNames } from '@/lib/ai/v2/venue-profile'
import { createAdminClient } from '@/lib/db/admin'
import { imageToFrame } from '@/lib/messaging/attachments/frames'
import { loadAppearanceEntries } from '@/lib/rag/appearance-entries'
import {
  cleanDescription,
  nameableItems,
} from '@/lib/schemas/attachment-description'
import type { DescribeResponseBody } from '../../_lib/types'

// POST /admin/playground/api/describe - look at ONE uploaded photo and return
// what the agent would have been told about it.
//
// WHY THIS EXISTS. The generator is never shown a picture (owner-ruled
// 2026-10-11): a guest's photo reaches a prompt as one sentence the describe
// step wrote. So a playground that accepts an upload but skips describing
// would be testing a photo the agent cannot see in a way production never
// produces - the operator would be writing the description themselves and
// then judging a reply to their own words.
//
// IT WRITES NOTHING, same posture as the run route beside it. Production's
// describe path is row-based: it downloads from storage, saves the sentence
// onto `message_attachments` and settles the row once. A sandbox guest has no
// rows and the operator wants to try six photos in a minute, so this is the
// pure half - bytes in, description out - and the bytes are dropped when the
// request ends. The image never touches storage and is in no trace: Meta
// forbids keeping a story's image, and a surface that keeps uploads would be
// the one place in this repo that does.
//
// SAME INPUTS AS PRODUCTION, which is what makes the answer transferable: the
// venue's name, its menu in its own spelling, and its appearance notes, and
// nothing about the guest. The two post-call rules are production's too -
// `cleanDescription` cuts and flattens, `nameableItems` keeps only what is
// unmistakable AND on the menu.
//
// A PHOTO THE MODEL CANNOT MAKE OUT IS NOT AN ERROR, and the response says so
// in its own field. That turn is a real production shape with its own
// approved wording ("a photo arrived and you cannot see it"), and reporting it
// as a failure would hide the case the operator most wants to try.

export const maxDuration = 60
export const dynamic = 'force-dynamic'

/**
 * Ample for a phone photo, and UNDER THE PLATFORM'S OWN 10MB BODY LIMIT,
 * which is the number that actually binds.
 *
 * Measured here first: a 12MB limit let a 12MB JPEG through to a body Next
 * had already truncated at 10MB, so `formData()` threw on a half-read
 * multipart and the operator was told their form was malformed. The honest
 * failure is "that file is too big", and it can only be given by a ceiling
 * below the one that silently cuts.
 */
const MAX_UPLOAD_BYTES = 8_000_000

export async function POST(request: Request): Promise<NextResponse> {
  // BEFORE the parse, because a truncated body cannot be parsed to find out
  // why it was truncated. Content-length is the client's claim, so the real
  // check on the file is still below; this one exists to name the cause.
  const declaredLength = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES)
    return NextResponse.json(
      {
        error: `that upload is ${(declaredLength / 1_000_000).toFixed(1)}MB; the limit is ${MAX_UPLOAD_BYTES / 1_000_000}MB`,
      },
      { status: 413 },
    )

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return NextResponse.json(
      { error: 'expected a multipart form with venueId and file' },
      { status: 400 },
    )
  }

  const venueId = form.get('venueId')
  const file = form.get('file')
  if (typeof venueId !== 'string')
    return NextResponse.json({ error: 'venueId is required' }, { status: 400 })
  if (!(file instanceof File) || file.size === 0)
    return NextResponse.json(
      { error: 'file is required and must not be empty' },
      { status: 400 },
    )
  if (file.size > MAX_UPLOAD_BYTES)
    return NextResponse.json(
      {
        error: `that file is ${(file.size / 1_000_000).toFixed(1)}MB; the limit is ${MAX_UPLOAD_BYTES / 1_000_000}MB`,
      },
      { status: 400 },
    )

  const auth = await requireVenueAdmin(venueId)
  if (!auth.ok) return auth.response

  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const frames = await imageToFrame(bytes, file.type || null)
    if (!frames.ok)
      return NextResponse.json(
        {
          error:
            frames.error === 'unsupported_type'
              ? `${file.type || 'that file'} is not an image this can read - try a JPEG, PNG, WebP or GIF`
              : `the image could not be prepared (${frames.error})`,
        },
        { status: 400 },
      )

    const supabase = createAdminClient()
    const [venueRow, configRow, notes] = await Promise.all([
      supabase.from('venues').select('name').eq('id', venueId).maybeSingle(),
      supabase
        .from('venue_configs')
        .select('venue_info')
        .eq('venue_id', venueId)
        .maybeSingle(),
      loadAppearanceEntries(supabase, venueId),
    ])
    const menuItemNames = venueMenuItemNames(configRow.data?.venue_info)
    // Unreadable notes mean NO drink may be named, which is `describe.ts`'s
    // own posture and the stricter direction: a name is something a guest is
    // told they ordered.
    const appearanceNotes = notes.ok ? notes.data : []

    const described = await describeAttachment({
      frames: frames.frames,
      kind: 'photo',
      venueName: venueRow.data?.name ?? null,
      menuItemNames,
      appearanceNotes,
    })
    if (!described.ok)
      return NextResponse.json(
        {
          error:
            described.errorCode === DESCRIBE_ATTACHMENT_TRUNCATED_ERROR_CODE
              ? 'the describe call was cut off before it answered'
              : `describe failed: ${described.error}`,
        },
        { status: 502 },
      )

    const result = described.data
    // `usableDescription`'s two rules, applied to a result that has no row to
    // read them off: an illegible photo carries no description into a prompt,
    // and neither does one whose sentence cleans down to nothing.
    const legible = result.legibility === 'clear'
    const description = legible ? cleanDescription(result.description) : null
    const body: DescribeResponseBody = {
      description,
      nameableItems: nameableItems(
        { items: result.items, legibility: result.legibility },
        menuItemNames,
      ),
      legibility: result.legibility,
      showsVenue: result.showsVenue,
      peoplePresent: result.peoplePresent,
      // What the operator needs to read a surprising description: with no
      // notes on file nothing can be named, and that is a venue-data fact
      // rather than anything about their photo.
      appearanceNotesOnFile: appearanceNotes.length,
      promptVersion: result.promptVersion,
    }
    return NextResponse.json(body)
  } catch (e) {
    console.error('[playground/describe] failed', e)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'describe failed' },
      { status: 500 },
    )
  }
}
