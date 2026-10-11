// TAC-582: the words for a message that is only an attachment.
//
// Pure. One place for the conversations list's `previewLabel`, so the same
// attachment is never called two things on two screens.
//
// THE WORDING IS THE OWNER'S, approved verbatim on 2026-10-11 (TAC-582, plan
// section 4). It is operator-facing copy: no em dash, and no label here may
// be reworded without that approval. The values are also listed in the
// Contract, so the operator app can rely on the set.
//
// A LABEL NAMES THE FIRST ATTACHMENT. A guest who sends three photos gets
// "Photo", the same as one: a preview line is one glance, and the thread shows
// the rest.

import { type AttachmentKind, isReelProviderType } from './kind'

/** For a message Meta flagged `is_unsupported`. Also the operator card's opening words. */
export const UNSUPPORTED_PREVIEW_LABEL = "Sent something we can't show"

const SHARED_REEL_LABEL = 'Shared a reel'
const SHARED_POST_LABEL = 'Shared a post'

// `share` is absent on purpose: it is one kind and two labels, decided by
// Meta's own type for the row (previewLabelFor). A story reply is never the
// whole of a message (it rides on the guest's text), so it has no approved
// label of its own and reads as the general one if it is ever asked for.
const PREVIEW_LABELS = {
  image: 'Photo',
  gif: 'GIF',
  video: 'Video',
  audio: 'Voice note',
  file: 'File',
  story_mention: 'Story mention',
  story_reply: 'Attachment',
  unknown: 'Attachment',
} as const satisfies Record<Exclude<AttachmentKind, 'share'>, string>

export type PreviewLabelInput = {
  kind: AttachmentKind
  providerType: string | null
}

/** The preview line for a message whose first attachment is this one. */
export function previewLabelFor(attachment: PreviewLabelInput): string {
  if (attachment.kind === 'share') {
    return isReelProviderType(attachment.providerType)
      ? SHARED_REEL_LABEL
      : SHARED_POST_LABEL
  }
  return PREVIEW_LABELS[attachment.kind]
}
