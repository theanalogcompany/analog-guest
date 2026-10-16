'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { DescribeResponseBody, PlaygroundTurn } from '../_lib/types'
import type { DeclaredMediaInput } from '@/lib/schemas/playground'
import {
  GuestBubbles,
  GuestMediaMarker,
  OutreachMarker,
  TurnReply,
  V1ActualReply,
  V1ComparisonCaveat,
  V1V2Columns,
} from './bubbles'

// Sandbox chat: the operator plays the guest, each send runs one full v2
// turn. Also renders replay results (same turn shape, plus the v1
// comparison), so the left pane reads as one conversation either way.

function RewindButton({
  label,
  title,
  disabled,
  onClick,
}: {
  label: string
  title: string
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="cursor-pointer whitespace-nowrap text-[11px] text-ink-faint underline decoration-dotted underline-offset-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
    >
      {label}
    </button>
  )
}

/**
 * The attached photo, above the composer: the thumbnail, what the describe
 * step said about it, and the two things the operator can change.
 *
 * THE DESCRIPTION IS SHOWN, not hidden behind the inspector, because it is
 * what the agent actually reads - the picture reaches no prompt. An operator
 * who cannot see the sentence cannot tell a bad reply from a bad description,
 * which is the first question every surprising media reply raises.
 */
function PendingPhotoChip({
  photo,
  busy,
  onDescription,
  onUndescribed,
  onRemove,
}: {
  photo: PendingPhoto
  busy: boolean
  onDescription: (text: string) => void
  onUndescribed: (value: boolean) => void
  onRemove: () => void
}) {
  const named = photo.result?.nameableItems ?? []
  return (
    <div className="flex shrink-0 items-start gap-3 border-t border-stone-light/60 bg-parchment/40 px-4 py-2">
      {/* The operator's own file, rendered from an object URL in their tab.
          next/image would want a loader and a remote pattern for a blob that
          lives for one send. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={photo.previewUrl}
        alt={photo.name}
        className="h-14 w-14 shrink-0 rounded-[2px] border border-stone-light object-cover"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {photo.status === 'describing' && (
          <span className="text-[11px] uppercase tracking-wider text-ink-faint">
            looking at it
          </span>
        )}
        {photo.status === 'failed' && (
          <span
            className="text-[11px] font-bold uppercase tracking-wider text-red-700"
            role="alert"
          >
            describe failed: {photo.error} · sending as a photo nobody looked at
          </span>
        )}
        {photo.status === 'done' && (
          <span className="text-[11px] uppercase tracking-wider text-ink-faint">
            {photo.result?.legibility === 'unclear'
              ? 'the model could not make it out'
              : `described${named.length > 0 ? ` · may name ${named.join(', ')}` : ' · names nothing'}`}
            {/* WHY it names nothing, when the reason is the venue's data
                rather than the photo: with no notes on file every item is
                dropped, so a correct "names nothing" would otherwise read as
                a weak describe. */}
            {photo.result?.appearanceNotesOnFile === 0 && ' · no venue notes'}
          </span>
        )}
        {photo.status !== 'describing' && (
          <Textarea
            value={photo.description}
            onChange={(e) => onDescription(e.target.value)}
            disabled={busy || photo.undescribed}
            placeholder="what the agent is told is in the photo"
            className="max-h-20 min-h-8 text-xs"
            rows={1}
          />
        )}
        <label className="flex items-center gap-1.5 text-[11px] text-ink-faint">
          <input
            type="checkbox"
            checked={photo.undescribed}
            disabled={busy}
            onChange={(e) => onUndescribed(e.target.checked)}
          />
          nobody looked at it (the agent is told a photo arrived and it cannot
          see it)
        </label>
      </div>
      <button
        type="button"
        onClick={onRemove}
        disabled={busy}
        className="shrink-0 cursor-pointer text-[11px] text-ink-faint underline decoration-dotted underline-offset-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
      >
        remove
      </button>
    </div>
  )
}

/** Default save name: the opening guest message, trimmed to something readable. */
const NAME_FROM_FIRST_MESSAGE_CHARS = 60

/**
 * Default hours-quiet for an outreach turn: roughly "yesterday afternoon",
 * the same ~21 the golden harness authors (run-turn.ts outreach doc).
 */
const DEFAULT_HOURS_QUIET = '21'

/** Bounds mirror the run route's schema; out of range would 400 there. */
const HOURS_QUIET_MIN = 1
const HOURS_QUIET_MAX = 336

/**
 * Does this drag carry a file at all?
 *
 * DURING a drag the browser hides what is being dragged - `files` is empty
 * and `items` expose only `kind` and `type` - so this is the most that can be
 * known before the drop. Dragging selected text must NOT light up the drop
 * zone, which is what `kind === 'file'` answers.
 */
function firstImageDragged(transfer: DataTransfer): boolean {
  return Array.from(transfer.items ?? []).some((item) => item.kind === 'file')
}

/**
 * A photo the operator attached to the next send.
 *
 * THE FILE IS NEVER SENT WITH THE TURN - only to the describe endpoint, which
 * keeps nothing. What rides the turn is `description` and `nameableItems`,
 * because that is the whole of what any prompt ever learns about a picture
 * (the generator is never shown one). The preview URL is an object URL for
 * this tab and dies with it, which is what "session only" means here.
 *
 * `description` stays EDITABLE after the model writes it: the sentence is
 * usually the thing under test, and typing a different one is the cheapest
 * ablation on this surface. `undescribed` is the other real shape - a photo
 * nobody looked at, which is what every attachment at the pilot venue is
 * until the describe step runs, and it has its own approved wording.
 */
interface PendingPhoto {
  name: string
  previewUrl: string
  status: 'describing' | 'done' | 'failed'
  error: string | null
  result: DescribeResponseBody | null
  description: string
  undescribed: boolean
}

export function ChatPane({
  turns,
  selectedTurnId,
  canSend,
  busy,
  emptyHint,
  showComposer,
  prefill,
  onSend,
  onSelectTurn,
  onRewind,
  savableTurnCount,
  saving,
  onSaveConversation,
  outreachDisabledReason,
  onOutreach,
  onDescribePhoto,
}: {
  turns: PlaygroundTurn[]
  selectedTurnId: string | null
  canSend: boolean
  busy: boolean
  emptyHint: string
  /** Replay mode hides the composer - sends come from the timeline. */
  showComposer: boolean
  /** Rewind-to-edit hands the rewound inbound back via seq bump. */
  prefill: { seq: number; text: string } | null
  /**
   * `media` rides the same send, because a photo and its caption are ONE
   * message - the two-call alternative would be two turns, which is not what
   * a guest did. Text may be empty when media is present: that is the
   * media-only turn, the shape every attachment at the pilot venue arrives in.
   */
  onSend: (text: string, media?: DeclaredMediaInput) => void
  onSelectTurn: (id: string) => void
  /** Discards this turn and everything after; 'rerun' re-sends it as-is. */
  onRewind: (turnId: string, mode: 'rerun' | 'edit') => void
  /** How many turns a save would actually carry; 0 hides the control. */
  savableTurnCount: number
  saving: boolean
  onSaveConversation: (name: string) => void
  /** Why "Venue writes first" cannot fire right now, or null when it can. */
  outreachDisabledReason: string | null
  onOutreach: (hoursQuiet: number) => void
  /** Look at one photo and report what the describe step would have written. */
  onDescribePhoto: (file: File) => Promise<DescribeResponseBody>
}) {
  const [draft, setDraft] = useState('')
  const [savingOpen, setSavingOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [hoursQuietDraft, setHoursQuietDraft] = useState(DEFAULT_HOURS_QUIET)
  const [photo, setPhoto] = useState<PendingPhoto | null>(null)
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  /**
   * Depth, not a boolean. `dragleave` fires every time the pointer crosses
   * into a CHILD element, so a boolean flickers the drop zone off while the
   * file is still over the pane - counting enter/leave pairs is what makes it
   * steady over a tree with bubbles and buttons in it.
   */
  const dragDepth = useRef(0)

  // Revoking is not tidiness: an object URL pins its blob for the life of the
  // document, and an operator trying ten photos would hold ten of them.
  const clearPhoto = () => {
    setPhoto((current) => {
      if (current !== null) URL.revokeObjectURL(current.previewUrl)
      return null
    })
    if (fileRef.current !== null) fileRef.current.value = ''
  }

  /**
   * The first image in a drop or a paste, or null.
   *
   * A pasted screenshot arrives as an `image/png` file with a generated name,
   * which is the same thing a picked file is - so there is one attach path
   * and not three. Anything that is not an image falls through to the
   * browser's own behaviour: pasting text must still paste text.
   */
  const firstImage = (list: FileList | null | undefined): File | null => {
    for (const file of Array.from(list ?? [])) {
      if (file.type.startsWith('image/')) return file
    }
    return null
  }

  const canAttach = canSend && !busy

  const attachPhoto = async (file: File) => {
    const previewUrl = URL.createObjectURL(file)
    setPhoto((current) => {
      if (current !== null) URL.revokeObjectURL(current.previewUrl)
      return {
        name: file.name,
        previewUrl,
        status: 'describing',
        error: null,
        result: null,
        description: '',
        undescribed: false,
      }
    })
    try {
      const result = await onDescribePhoto(file)
      setPhoto((current) =>
        // The operator can clear or replace a photo while its call is in
        // flight; a late answer must not resurrect it or overwrite the newer
        // one. Identity by preview URL, which is unique per attach.
        current === null || current.previewUrl !== previewUrl
          ? current
          : {
              ...current,
              status: 'done',
              result,
              description: result.description ?? '',
              // A photo the model could not make out IS the undescribed turn,
              // pre-ticked rather than left looking like a describe that
              // simply returned nothing.
              undescribed: result.description === null,
            },
      )
    } catch (e) {
      const message = e instanceof Error ? e.message : 'describe failed'
      setPhoto((current) =>
        current === null || current.previewUrl !== previewUrl
          ? current
          : { ...current, status: 'failed', error: message, undescribed: true },
      )
    }
  }

  // Stable identity: TurnReply calls this from an effect on every bubble
  // reveal, so a fresh closure each render would re-fire it on every paint.
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [turns, scrollToBottom])

  // Adopt a rewound inbound exactly once per seq bump - the documented
  // adjust-state-during-render pattern, not an effect, so the composer
  // repaints with the text in the same pass.
  const [seenPrefillSeq, setSeenPrefillSeq] = useState(0)
  if (prefill !== null && prefill.seq !== seenPrefillSeq) {
    setSeenPrefillSeq(prefill.seq)
    setDraft(prefill.text)
  }

  /**
   * The media this send carries, or undefined. An UNDESCRIBED photo still
   * declares its kind: the turn is "a photo arrived and nobody looked at it",
   * which is a different prompt from no photo at all.
   */
  const mediaForSend = (): DeclaredMediaInput | undefined => {
    if (photo === null || photo.status === 'describing') return undefined
    const described = !photo.undescribed && photo.description.trim().length > 0
    return {
      kind: 'photo',
      ...(described
        ? {
            description: photo.description.trim(),
            nameableItems: photo.result?.nameableItems ?? [],
          }
        : {}),
    }
  }

  const send = () => {
    const text = draft.trim()
    const media = mediaForSend()
    // Empty text is legal ONLY with media - that is the media-only turn. A
    // send with neither is what the route refuses, so it never leaves here.
    if ((text.length === 0 && media === undefined) || !canSend || busy) return
    setDraft('')
    clearPhoto()
    onSend(text, media)
  }

  const hoursQuiet = Number(hoursQuietDraft)
  const hoursQuietValid =
    Number.isFinite(hoursQuiet) &&
    hoursQuiet >= HOURS_QUIET_MIN &&
    hoursQuiet <= HOURS_QUIET_MAX

  const fireOutreach = () => {
    if (outreachDisabledReason !== null || !hoursQuietValid) return
    onOutreach(hoursQuiet)
  }

  const openSave = () => {
    const first = turns.find((t) => t.mode === 'sandbox')?.request.inbound[0]
    setSaveName((first ?? '').slice(0, NAME_FROM_FIRST_MESSAGE_CHARS))
    setSavingOpen(true)
  }

  const commitSave = () => {
    const name = saveName.trim()
    if (name.length === 0 || saving) return
    onSaveConversation(name)
    setSavingOpen(false)
  }

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      // THE WHOLE PANE IS THE DROP TARGET, not just the composer. A file
      // dragged at a chat lands on the conversation, and a 40px strip at the
      // bottom is a target you have to aim at.
      onDragEnter={(e) => {
        if (!showComposer || !firstImageDragged(e.dataTransfer)) return
        e.preventDefault()
        dragDepth.current += 1
        setDragging(true)
      }}
      onDragOver={(e) => {
        // Without preventDefault here the browser refuses the drop and opens
        // the file in a new tab instead, losing the conversation.
        if (dragging) e.preventDefault()
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragging(false)
      }}
      onDrop={(e) => {
        if (!dragging) return
        e.preventDefault()
        dragDepth.current = 0
        setDragging(false)
        const file = firstImage(e.dataTransfer.files)
        if (file !== null && canAttach) void attachPhoto(file)
      }}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-[4px] border-2 border-dashed border-clay/60 bg-paper/80">
          <span className="text-xs uppercase tracking-wider text-ink-soft">
            {canAttach
              ? 'drop a photo to send it as the guest'
              : 'pick a venue first'}
          </span>
        </div>
      )}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {turns.length === 0 ? (
          <p className="pt-8 text-center text-sm italic text-ink-faint">
            {emptyHint}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {turns.map((turn) => (
              <div key={turn.id} className="group flex flex-col gap-1.5">
                {/* Stacked, never a flex row: a row wrapper makes GuestBubbles
                    content-sized, and the bubble's max-w-[75%] then resolves
                    against a collapsing parent - one character per line. */}
                {turn.request.outreach !== undefined ? (
                  <OutreachMarker
                    hoursQuiet={turn.request.outreach.hoursQuiet}
                  />
                ) : (
                  <>
                    {turn.request.media !== undefined && (
                      <GuestMediaMarker
                        described={
                          (turn.request.media.description ?? '').length > 0
                        }
                      />
                    )}
                    <GuestBubbles texts={turn.request.inbound} />
                  </>
                )}
                {turn.mode === 'sandbox' && (
                  <span className="flex gap-3 opacity-0 transition-opacity group-hover:opacity-100">
                    <RewindButton
                      label="rerun from here"
                      title="Discard everything after this message and run it again fresh"
                      disabled={busy}
                      onClick={() => onRewind(turn.id, 'rerun')}
                    />
                    {/* No edit on an outreach turn: there is no inbound to put
                        back in the composer, and prefilling it empty would
                        leave the pane in a state Send cannot leave.
                        No edit on a MEDIA turn either, for the opposite
                        reason: the text would come back and the photo would
                        not, so the resend would be a different turn wearing
                        the old one's place in the thread. Rerun keeps it
                        whole. */}
                    {turn.request.outreach === undefined &&
                      turn.request.media === undefined && (
                        <RewindButton
                          label="edit from here"
                          title="Discard everything from this message on and put it back in the composer"
                          disabled={busy}
                          onClick={() => onRewind(turn.id, 'edit')}
                        />
                      )}
                  </span>
                )}
                {/* One or the other, never both: the comparison block carries
                    v2's reply in its own column, so rendering TurnReply above
                    it would print the same reply twice. TurnReply still owns
                    the running / failed / restored states, which the
                    comparison has nothing to show for - and it keeps the
                    staggered reveal, which the comparison deliberately does
                    not take (see V1V2Columns). */}
                {turn.status === 'done' && turn.response?.v1 != null ? (
                  <>
                    <V1V2Columns
                      turn={turn}
                      selected={turn.id === selectedTurnId}
                      onSelect={() => onSelectTurn(turn.id)}
                    />
                    <V1ComparisonCaveat />
                  </>
                ) : (
                  <TurnReply
                    turn={turn}
                    selected={turn.id === selectedTurnId}
                    onSelect={() => onSelectTurn(turn.id)}
                    onReveal={scrollToBottom}
                  />
                )}
                {turn.mode === 'replay' && turn.status === 'done' && (
                  <>
                    <V1ActualReply bubbles={turn.v1Reply ?? null} />
                    <p className="text-[11px] italic text-ink-faint">
                      Replay uses transcript-only context for v2: profile,
                      memory and state start empty at the replay point. v1
                      builds its own context from the guest&apos;s real row, so
                      it sees their recognition band and visits.
                    </p>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {showComposer && turns.some((t) => t.mode === 'sandbox') && (
        <div className="flex shrink-0 items-center justify-between gap-3 px-4 pb-1">
          <p className="text-[11px] italic text-ink-faint">
            Hover a guest message to rerun or edit from that point - later turns
            are discarded, and the session rewinds with them.
          </p>
          {savableTurnCount > 0 && !savingOpen && (
            <button
              type="button"
              onClick={openSave}
              disabled={busy || saving}
              className="shrink-0 cursor-pointer whitespace-nowrap text-[11px] text-ink-faint underline decoration-dotted underline-offset-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving
                ? 'saving'
                : `save conversation (${savableTurnCount} turn${savableTurnCount === 1 ? '' : 's'})`}
            </button>
          )}
        </div>
      )}

      {showComposer && savingOpen && (
        <div className="flex shrink-0 items-center gap-2 border-t border-stone-light/60 bg-parchment/40 px-4 py-2">
          <input
            type="text"
            value={saveName}
            autoFocus
            maxLength={120}
            onChange={(e) => setSaveName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitSave()
              }
              if (e.key === 'Escape') setSavingOpen(false)
            }}
            placeholder="Name this conversation"
            className="h-8 flex-1 rounded-[2px] border border-stone-light bg-paper px-2 text-xs text-ink outline-none focus:border-clay/60"
          />
          <Button
            type="button"
            size="sm"
            onClick={commitSave}
            disabled={saveName.trim().length === 0 || saving}
          >
            Save
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setSavingOpen(false)}
          >
            Cancel
          </Button>
        </div>
      )}

      {showComposer && photo !== null && (
        <PendingPhotoChip
          photo={photo}
          busy={busy}
          onDescription={(text) =>
            setPhoto((current) =>
              current === null ? current : { ...current, description: text },
            )
          }
          onUndescribed={(value) =>
            setPhoto((current) =>
              current === null ? current : { ...current, undescribed: value },
            )
          }
          onRemove={clearPhoto}
        />
      )}

      {/* TWO ROWS, and the split is not decoration. Everything used to sit on
          one line; adding the attach control put four fixed-width items beside
          a `flex-1` textarea in a pane this narrow, and the textarea collapsed
          to its min-content width - one word per line, measured on screen.
          The message box now shares a row with Send and nothing else, and the
          turn-shaping controls sit under it. */}
      {showComposer && (
        <div className="flex shrink-0 items-end gap-2 border-t border-stone-light/60 bg-paper px-4 pb-2 pt-3">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            // A screenshot pasted straight into the box, which is how a photo
            // most often reaches this surface - Cmd+Shift+4 then Cmd+V, with
            // no file on disk to pick. preventDefault ONLY for an image:
            // pasting text has to keep pasting text, and a clipboard with
            // both (a copied image from a web page carries its HTML too)
            // takes the image, because that is the half this box cannot
            // otherwise receive.
            onPaste={(e) => {
              const file = firstImage(e.clipboardData.files)
              if (file === null || !canAttach) return
              e.preventDefault()
              void attachPhoto(file)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            placeholder={
              !canSend
                ? 'Pick a venue first'
                : photo !== null
                  ? 'Caption, or send the photo on its own'
                  : 'Message as the guest, or paste a photo'
            }
            disabled={!canSend || busy}
            // `min-w-0` is what stops a flex child from refusing to shrink
            // below its content width - the defect this row was rebuilt for.
            className="min-h-9 max-h-32 min-w-0 flex-1 resize-none"
            rows={1}
          />
          <Button
            type="button"
            size="sm"
            onClick={send}
            disabled={
              !canSend ||
              busy ||
              // A photo still being looked at is not ready to send: the turn
              // would go as undescribed and the description would land after
              // it, which reads as the describe having found nothing.
              photo?.status === 'describing' ||
              (draft.trim().length === 0 && photo === null)
            }
          >
            {busy ? 'Running' : 'Send'}
          </Button>
        </div>
      )}

      {showComposer && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 bg-paper px-4 pb-3">
          {/* Hidden input, clicked by the button: the native file control
              cannot be styled to sit in this row. */}
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file !== undefined) void attachPhoto(file)
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={!canAttach}
            title="Send a photo as the guest - upload, drop one on the chat, or paste a screenshot. It is described by the same vision call production runs, and that description is what the agent reads."
            className="h-8 shrink-0 cursor-pointer rounded-[2px] border border-stone-light bg-paper px-2.5 text-xs text-ink-soft hover:bg-parchment disabled:cursor-not-allowed disabled:opacity-50"
          >
            Upload photo
          </button>
          {/* Short on purpose: the full sentence pushed the outreach controls
              onto a third line in a pane this width. The button's title
              carries the long version. */}
          <span className="text-[11px] italic text-ink-faint">
            drop or paste one
          </span>
          {/* The outreach control: fire a turn with NO guest message. A plain
              <button> rather than <Button> because shadcn's disabled
              pointer-events-none swallows hover, and the title explaining WHY
              it is disabled is the whole point of disabling instead of
              hiding. */}
          <div className="ml-auto flex shrink-0 items-center gap-1.5 border-l border-stone-light/60 pl-3">
            <label className="flex items-center gap-1 whitespace-nowrap text-[11px] text-ink-faint">
              <input
                type="number"
                min={HOURS_QUIET_MIN}
                max={HOURS_QUIET_MAX}
                value={hoursQuietDraft}
                onChange={(e) => setHoursQuietDraft(e.target.value)}
                disabled={outreachDisabledReason !== null}
                aria-label="hours quiet"
                className="h-8 w-14 rounded-[2px] border border-stone-light bg-paper px-1.5 text-xs text-ink outline-none focus:border-clay/60 disabled:cursor-not-allowed disabled:opacity-50"
              />
              hours quiet
            </label>
            <button
              type="button"
              onClick={fireOutreach}
              disabled={outreachDisabledReason !== null || !hoursQuietValid}
              title={
                outreachDisabledReason ??
                (hoursQuietValid
                  ? 'Run an outreach turn: the venue writes first after this many quiet hours'
                  : `hours quiet must be ${HOURS_QUIET_MIN}-${HOURS_QUIET_MAX}`)
              }
              className="cursor-pointer whitespace-nowrap rounded-[2px] border border-stone-light/60 bg-paper px-3 py-1.5 text-xs font-medium text-ink-soft hover:bg-parchment disabled:cursor-not-allowed disabled:opacity-50"
            >
              Venue writes first
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
