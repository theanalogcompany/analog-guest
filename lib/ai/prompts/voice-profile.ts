// The prompt text for a venue's MEASURED voice profile.
//
// Ruled 2026-10-07: nothing about how a venue texts is written by us. When a
// venue has a profile (lib/schemas/brand-persona.ts, derived by
// scripts/derive-voice-profile.ts from the replies its team sent), these
// sections take the place of the hand-written `lengthGuide` and `emojiPolicy`
// in the persona, and one sentence of the no-questions block. A venue with no
// profile never reaches this file and its prompt is byte-identical to before.
//
// WHAT IS OURS HERE AND WHAT IS THEIRS. Every number is the team's. The
// sentences around the numbers are ours, and they only ever say "this is what
// the team does, do the same". Where a share is not decisive (between
// LEAN_LOW and LEAN_HIGH) the text reports it and asks for neither.
//
// NOT IN THE PROMPT, deliberately:
//   - how often the team splits an answer into several messages. Splitting is
//     decided in code (lib/agent/sentence-split.ts), which reads the same
//     profile; telling the model too is the two-authors defect.
//   - the team's most common first words. A list of openers is a list of
//     lines to reuse, and the real replies shown as examples already carry
//     how the team opens.
//
// No em dashes anywhere in this copy: the model echoes what it is shown.

import type { VoiceProfile } from '@/lib/schemas'

/** A share at or past this is "they do"; at or under LEAN_LOW, "they don't". */
const LEAN_HIGH = 0.7
const LEAN_LOW = 0.3
/** Under this a habit is rare enough to say "almost never". */
const RARE = 0.05

function pct(share: number): string {
  return `${Math.round(share * 100)}%`
}

function lengthSection(profile: VoiceProfile): string {
  const { median, p75, p90 } = profile.wordsPerReply
  return [
    '## Length',
    `Measured from ${profile.replies} replies this venue's own team sent to guests. Half of their replies are ${median} words or fewer, three in four are ${p75} or fewer, and only one in ten runs past ${p90}.`,
    `Write at that length: a reply here is usually about ${median} words and seldom more than ${p75}.`,
    'A guest who needs a fuller answer gets the whole of it, however long that is: they asked for more, asked how to do something, asked more than one thing, are following up on what you just told them, or are asking about an event, catering or wholesale. Leave out no step and no part of what they asked. A long answer is sent to them as several short messages, so write it as short plain sentences, one step or one point to a sentence.',
  ].join('\n')
}

function emojiSection(profile: VoiceProfile): string {
  const share = profile.emojiShareOfReplies
  // Both branches defer to the per-message block, because the same share
  // drives that block's coin (lib/ai/emoji-cadence.ts): "do not use one" here
  // would contradict the one message in twenty-five it allows.
  const follow =
    'Whether this message may carry one is already decided for you: follow the "## Emoji for this message" block in your runtime context.'
  const body =
    share < RARE
      ? `The team almost never uses an emoji when replying to a guest (${pct(share)} of their replies). ${follow}`
      : `The team uses an emoji in ${pct(share)} of their replies to guests. ${follow}`
  return `## Emojis\n${body}`
}

const ENDING_PHRASE = {
  nothing: 'with no punctuation at all',
  period: 'with a period',
  exclamation: 'with an exclamation mark',
  emoji: 'on an emoji',
} as const

function writingSection(profile: VoiceProfile): string {
  const lines: string[] = []

  const lower = profile.lowercaseStartShare
  if (lower >= LEAN_HIGH) {
    lines.push(
      `They start a message with a lowercase letter (${pct(lower)} of their messages). Do the same.`,
    )
  } else if (lower <= LEAN_LOW) {
    lines.push(
      `They start a message with a capital letter (${pct(1 - lower)} of their messages). Do the same.`,
    )
  } else {
    lines.push(
      `They start a message with a lowercase letter ${pct(lower)} of the time and a capital the rest. Either is right.`,
    )
  }

  // How a statement ends. A question mark is left out: whether a message is a
  // question is what it says, not how the team punctuates.
  const endings = (Object.keys(ENDING_PHRASE) as (keyof typeof ENDING_PHRASE)[])
    .map((key) => ({ key, share: profile.endings[key] }))
    .sort((a, b) => b.share - a.share)
  const [first, second] = endings
  if (first && first.share > 0) {
    lines.push(
      `Their messages most often end ${ENDING_PHRASE[first.key]} (${pct(first.share)})${second && second.share >= RARE ? `, then ${ENDING_PHRASE[second.key]} (${pct(second.share)})` : ''}. End yours the way they do.`,
    )
  }

  // Both of these have a per-message coin flipped from the same share
  // (lib/ai/emoji-cadence.ts), so the standing text reports the habit and
  // hands the call to the block, as the emoji section does.
  const bang = profile.marks.exclamation
  lines.push(
    bang < RARE
      ? `They almost never use an exclamation mark (${pct(bang)} of their messages).`
      : `${pct(bang)} of their messages have an exclamation mark, when they are glad about something. Whether this message may is decided for you in "## Marks for this message".`,
  )

  const smiley = profile.smileyShareOfBubbles
  if (smiley >= RARE) {
    lines.push(
      `${pct(smiley)} of their messages have a typed smiley, the two characters :) on the end of a line. That is theirs, and it is not an emoji. Whether this message may is decided in the same block.`,
    )
  }

  const brackets = profile.marks.parenthesis
  lines.push(
    brackets < RARE
      ? `They almost never put anything in brackets (${pct(brackets)} of their messages). Do not use brackets.`
      : `${pct(brackets)} of their messages have something in brackets, as a passing aside. Use them that rarely, and only that way.`,
  )

  return [
    '## How the team writes',
    "Measured from the same replies. This is this venue's own habit, and it beats any general idea of how a text should look.",
    ...lines.map((l) => `- ${l}`),
  ].join('\n')
}

/** The persona sections a measured profile replaces or adds. */
export function voiceProfileToProse(profile: VoiceProfile): {
  length: string
  emojis: string
  writing: string
} {
  return {
    length: lengthSection(profile),
    emojis: emojiSection(profile),
    writing: writingSection(profile),
  }
}

/**
 * The last sentence of `## No questions this turn`, for a venue with a
 * profile. The hand-written one asks for "a warm sentence or two", which is a
 * length of ours and would contradict the venue's own.
 */
export function fullAnswerSentence(typicalWords: number): string {
  return `Asking nothing is not the same as saying little: the reply is still a real answer at this venue's usual length, about ${typicalWords} words, never a bare link or a one-word answer.`
}

/**
 * The heading over the team's real replies in the voice examples, wording
 * approved 2026-10-07. Chosen for how they are written, not what they say.
 */
export const REAL_REPLIES_HEADING =
  'Real replies the team sent to guests. Take the length, the rhythm and the plainness from these. Never reuse a line from them: those words were for that guest, and yours are new each time.'

/**
 * The heading over the lines an operator approved, for a venue with a
 * profile (ruled 2026-10-07: "use only their wording and attitude;
 * capitalization and emoji follow the profile, not them").
 */
export const APPROVED_LINES_HEADING =
  'Lines the venue approved, kept for their attitude: the dry aside, the opinion said straight, the turn of phrase. Take that from them. Do not take how they are typed: they are in lowercase and end on an emoji, and this venue does neither. Capitals, punctuation and emoji follow "## How the team writes". Never reuse one of these lines as it stands.'
