// TAC-495: channel variants of prompt copy, by phrase substitution.
//
// The SMS copy is written out in full where it has always lived and is never
// edited by this mechanism: its variant is the text itself, with no
// substitutions. Each other channel's variant is that text with a short list of
// named phrases swapped. So the SMS copy stays byte-identical by construction,
// and a channel variant can differ only where a substitution says it does.
//
// Every substitution's `from` must occur exactly once in the text it applies
// to, or applyChannelSubstitutions throws. The callers apply their tables at
// module load, so a miss fails every test that imports the module. That is the
// point: edit an SMS phrase that has an Instagram twin and the import breaks at
// the exact phrase, forcing a decision about the other channel rather than
// letting the two drift apart silently. It is safe to throw at load here, where
// it would not be for an environment variable, because the inputs are string
// constants: identical in CI and in production, so if CI passes, production
// does too.
//
// Scope is deliberately narrow. Adding a substitution anywhere means the scope
// guards in system-template.test.ts and serializers.test.ts fail until someone
// updates them on purpose. Those guards are the brake on "everything could now
// vary by channel".
import type { MessageChannel } from '@/lib/schemas/message-channel'

export type ChannelSubstitution = {
  readonly from: string
  readonly to: string
}

function countOccurrences(text: string, phrase: string): number {
  if (phrase.length === 0) return 0
  let count = 0
  let at = text.indexOf(phrase)
  while (at !== -1) {
    count++
    at = text.indexOf(phrase, at + phrase.length)
  }
  return count
}

export function applyChannelSubstitutions(
  text: string,
  substitutions: readonly ChannelSubstitution[],
  label: string,
): string {
  let out = text
  for (const { from, to } of substitutions) {
    const count = countOccurrences(out, from)
    if (count !== 1) {
      throw new Error(
        `[channel-variants] ${label}: expected the phrase to appear exactly once, found ${count}: ${JSON.stringify(from)}`,
      )
    }
    // Split and join rather than String.replace: a `to` containing `$&` or
    // `$'` would otherwise be read as a replacement pattern.
    out = out.split(from).join(to)
  }
  return out
}

/**
 * Which channel's copy to use. An unknown channel (null) gets the Instagram
 * copy because that copy asserts nothing false on either channel: a text is
 * also a message, while the SMS copy tells an Instagram guest they texted a
 * phone number. This is a property of the copy, not a claim that the guest is
 * on Instagram, so nothing may route a send on it.
 */
export function copyVariantFor(channel: MessageChannel | null): MessageChannel {
  return channel ?? 'instagram'
}
