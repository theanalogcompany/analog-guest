# 0010 - How a venue texts is measured from its team's replies, not written by us

**Date:** 2026-10-07
**Status:** accepted

## Decision

Everything about HOW a venue texts comes from the replies its own team sent: length, how
often an answer goes out as several messages, emoji, capitals, punctuation. The Instagram
history import supplies the replies, `npm run derive-voice-profile -- --venue <slug>`
measures them, and the result is stored on the venue as `brand_persona.voiceProfile`.

When a venue has a profile:

- `## Length` and `## Emojis` render its numbers in place of the hand-written `lengthGuide`
  and `emojiPolicy`, and a `## How the team writes` section follows them.
- The emoji coin, the split coin, the per-message word limit and the length check's ceiling
  all read the same profile.
- A set of the team's real replies, approved line by line, sits under its own heading in the
  voice examples.

A venue with no profile behaves exactly as before. We still write CONTENT rules for every
venue (answer first, one point, nothing that sells, never invent a fact); those are not style.

## Why

The pilot venue's owner would not go live on replies that read as AI. A leave-one-out run
removed five suspected causes one at a time and none shortened the answers: the prompt had
our idea of the venue's voice in it, and our idea was wrong in ways nobody had checked. The
agent wrote lowercase with an emoji on the end; the team writes in sentence case 98% of the
time and uses an emoji in 4% of replies.

## What breaks if reversed

- Authoring a length or style line for a venue that has a profile puts two authors on one
  question, and the later one in the prompt wins. `lengthGuide` is not rendered for such a
  venue for exactly that reason.
- Setting the length check below the team's own long replies makes it the thing that
  shortens. At their p75 it fired on a third of question turns and one retry dropped a step
  from brewing instructions. It is a backstop at their p90, never fires when the guest
  needs a fuller answer, and never ships a retry that lost a fact.
- Reading the split share as the share of replies that will go out split: it is only the
  coin for a short reply. Long replies are always split.

## Where it lives

`lib/schemas/brand-persona.ts` (the profile) · `scripts/lib/voice-profile.ts` (what counts as
a reply, what is dropped as canned) · `lib/ai/prompts/voice-profile.ts` (the prompt text) ·
`lib/ai/reply-length.ts` (the length check) · `lib/agent/sentence-split.ts` (`bubbleStyleFor`)
· `lib/ai/emoji-cadence.ts` · `lib/rag/voice-pack.ts` (the `inactive` tag).
