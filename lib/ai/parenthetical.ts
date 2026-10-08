/**
 * Phone test 2026-10-08: no list and no definition in brackets.
 *
 * The replies read like a menu card: "the Pink Panther is vegan (cascara,
 * kokum syrup, butterfly pea foam over tonic)", "espresso drinks (latte,
 * cortado, cappuccino, ...)", "cascara (the dried fruit skin of the coffee
 * plant)". The detail in the brackets is the thing not wanted, not the
 * brackets (ruled 2026-10-08).
 *
 * WHAT IT DOES. A reply to a guest with such a bracket is asked for once more
 * (generateMessage), with PARENTHETICAL_CONSTRAINT. If what ships still has
 * one, the bracket and everything in it is taken out.
 *
 * THIS REMOVES GUEST-FACING TEXT, AND IS THE ONE CHECK THAT DOES. Every other
 * check in the generation loop ships what the model wrote and reports it
 * (lib/ai/CLAUDE.md). The removal was ruled on knowing that it drops facts,
 * so it is reported every time on `parentheticalRetry`, with the text as it
 * was before, and never silent.
 *
 * WHAT COUNTS. A bracket whose contents carry a comma (a list), or run past
 * DEFINITION_WORDS words (a definition or an explanation). A short aside is
 * left alone: "(hot or iced)", "(415) 613-0000", "(GF)". A typed smiley or
 * sad face is not a bracket (":(" and a later ":)" would otherwise pair up
 * and take everything between them), and neither is anything inside a web
 * address or holding one.
 *
 * Pure, no I/O. Imported by path, like reply-length.ts.
 */

/** Past this many words, what is in a bracket is an explanation, not an aside. */
const DEFINITION_WORDS = 3

/**
 * One bracket pair with nothing nested in it, and the space in front of it.
 * Not a typed face on either end, and not part of a web address.
 */
const BRACKET = /\s*(?<![:;=]|https?:\/\/\S*)\((?![:;])([^()]*)(?<![:;=-])\)/g

function isListOrDefinition(inside: string): boolean {
  if (inside.includes('://')) return false
  if (inside.includes(',')) return true
  return inside.split(/\s+/).filter((w) => w !== '').length > DEFINITION_WORDS
}

/** Every bracket in the text that holds a list or a definition, as written. */
export function findListParentheticals(text: string): string[] {
  return [...text.matchAll(BRACKET)]
    .filter((m) => isListOrDefinition(m[1] ?? ''))
    .map((m) => m[0].trim())
}

export function hasListParenthetical(text: string): boolean {
  return findListParentheticals(text).length > 0
}

/** Sticky for the rest of the call, so worded as a standing rule. Wording approved 2026-10-08. */
export const PARENTHETICAL_CONSTRAINT =
  'Constraint: this reply has nothing in brackets. Say it in plain words as part of the sentence. Where you would list things, name two or three at most.'

/**
 * The text with every list or definition bracket taken out, along with the
 * space in front of it. Punctuation that followed the bracket closes up to
 * the word before it.
 *
 * Repeated until nothing is left to take, so a bracket that held another
 * goes too. Text with nothing to remove comes back exactly as given.
 *
 * REFUSES TO EMPTY A REPLY, as replaceDashes does: text that would have no
 * letter or digit left comes back unchanged.
 */
export function removeListParentheticals(text: string): string {
  if (!hasListParenthetical(text)) return text
  let removed = text
  while (hasListParenthetical(removed)) {
    removed = removed.replace(BRACKET, (whole, inside: string) =>
      isListOrDefinition(inside) ? '' : whole,
    )
  }
  removed = removed.replace(/[ \t]{2,}/g, ' ').trim()
  return /[\p{L}\p{N}]/u.test(removed) ? removed : text
}

/**
 * What the check did on one generation.
 *
 *   none         nothing in brackets that counts, on any attempt
 *   retry_clean  asked again, and the answer came back without one
 *   removed      what was going to ship still had one, and it was taken out
 */
export type ParentheticalRetry = 'none' | 'retry_clean' | 'removed'
