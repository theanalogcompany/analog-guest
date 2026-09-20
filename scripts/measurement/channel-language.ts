// TAC-469 pre-flight: does a reply generated for an Instagram conversation
// still talk like SMS?
//
// TAC-495 gave Instagram its own prompt copy — R1, R5, R32, the opener, the
// opening line, the register line, the plain-text rule, the heads-up examples,
// the named-speaker persona line, the casual formality line and the `unknown`
// close all swap "text"/"number" for "message". `compose-prompt.test.ts`
// already proves those swaps are IN THE PROMPT, and scans every Instagram
// prompt for channel claims. What no test can show is whether the MODEL obeys
// them: the prompt is an instruction, and the only way to know what comes out
// is to generate and read.
//
// So this is the detector for the output side, and it is deliberately blunt.
// It reports matches with the phrase and its surrounding text rather than a
// score, because the verdict on a borderline line ("give us a call") is a
// judgement someone has to make by reading it.
//
// TWO KINDS, and they are not equally bad:
//
//   phone_claim — FALSE on Instagram. "text us", "this number", "SMS". The
//     guest has no number for the venue and never will. This is the failure
//     the pre-flight exists to catch.
//
//   instagram_idiom — true but off-copy. "DM us", "check our stories". The
//     Instagram copy deliberately says "message", never "DM": naming the
//     platform in the system prompt's opening line was TAC-495's accepted
//     cost, and this is the thing it was expected to invite. Worth counting
//     separately so a run cannot report it as a false claim, or hide it.
//
// Ordinary words containing "text" (context, texture) and "number" ("a number
// of things") are exactly why every pattern is word-bounded and most require a
// second word. A false positive here costs a human reading one line; a false
// negative is the defect shipping.

export type ChannelLanguageKind = 'phone_claim' | 'instagram_idiom'

export interface ChannelLanguageMatch {
  kind: ChannelLanguageKind
  /** The phrase as it appeared, lowercased. */
  phrase: string
  /** Enough of the body around it to judge the line by reading. */
  context: string
}

interface Pattern {
  kind: ChannelLanguageKind
  /** Must carry the global flag; each is matched against the whole body. */
  re: RegExp
}

const PATTERNS: readonly Pattern[] = [
  // --- phone_claim: false on Instagram -------------------------------------
  // The transport, named outright.
  { kind: 'phone_claim', re: /\b(?:sms|imessage|text message|text messages)\b/gi },
  // "text" as the verb for reaching the venue, or being reached. Requires a
  // following word so "context" and "textured" cannot match (the \b before
  // already rules those out, but the object is what makes it a claim).
  {
    kind: 'phone_claim',
    re: /\btext(?:s|ed|ing)?\s+(?:me|us|them|him|her|back|again|the\s+\w+|a\s+\w+|us\s+\w+)\b/gi,
  },
  // "texting" is never innocent: unlike the noun "text" there is no
  // non-SMS reading of it. MISSED BY THE FIRST RUN — "first time texting
  // in?" went unflagged in the control arm, which under-counted the very
  // number the control bar is read against.
  { kind: 'phone_claim', re: /\btext(?:ing|ed)\b/gi },
  // "text in", "texted in".
  { kind: 'phone_claim', re: /\btext(?:s|ed|ing)?\s+in\b/gi },
  // "shoot/send us a text", "give us a text".
  { kind: 'phone_claim', re: /\b(?:send|shoot|drop|give)\s+(?:me|us|them)?\s*a\s+text\b/gi },
  // The number itself: "this number", "our number", "save the number".
  { kind: 'phone_claim', re: /\b(?:this|that|our|my|the)\s+(?:phone\s+)?number\b/gi },
  { kind: 'phone_claim', re: /\bphone\s+number\b/gi },
  // Calling is a phone claim too: an Instagram guest has nothing to call.
  { kind: 'phone_claim', re: /\b(?:give\s+(?:me|us|them)\s+a\s+call|call\s+(?:me|us)\b|ring\s+us\b)/gi },

  // --- instagram_idiom: true, but not the copy we wrote ---------------------
  { kind: 'instagram_idiom', re: /\bdm(?:s|ed|ing)?\b/gi },
  { kind: 'instagram_idiom', re: /\b(?:our|the|my)\s+stor(?:y|ies)\b/gi },
  { kind: 'instagram_idiom', re: /\bdirect\s+message\b/gi },
]

const CONTEXT_CHARS = 40

/**
 * A claim that is DENIED is not a claim. "We don't have a phone number" is the
 * correct answer on Instagram and the first version of this detector flagged it
 * as a false claim — twice in one run, which would have read as a failure when
 * the model had done exactly the right thing.
 *
 * Deliberately narrow: a negation must appear within this many characters
 * BEFORE the match, in the same sentence. Widening it would start swallowing
 * real claims that happen to follow an unrelated negative ("we don't do holds,
 * but text us"), which is the failure that matters. The window is short enough
 * that the two cases above are separated by their own commas and full stops.
 */
const NEGATION_WINDOW = 28
const NEGATION = /\b(?:no|not|don'?t|doesn'?t|dont|never|without|haven'?t|hasn'?t)\b/i

function isDenied(body: string, matchIndex: number): boolean {
  const from = Math.max(0, matchIndex - NEGATION_WINDOW)
  const before = body.slice(from, matchIndex)
  // Only the current clause counts. A full stop resets the scope, and so does
  // a contrastive conjunction: in "we don't do holds, but text us when you're
  // close" the negation governs the holds, not the texting, and suppressing
  // that would hide a real claim behind an unrelated negative. Found by the
  // test written for exactly that case.
  const clause = before.split(/[.!?]|\b(?:but|though|however|otherwise)\b/i).pop() ?? before
  return NEGATION.test(clause)
}

/**
 * Every channel-language match in a generated body, in the order they appear.
 * Overlapping patterns can both match the same span; that is deliberate, since
 * each is reported with its own phrase and a human reads the line once.
 */
export function findChannelLanguage(body: string): ChannelLanguageMatch[] {
  const matches: ChannelLanguageMatch[] = []
  for (const { kind, re } of PATTERNS) {
    // Fresh lastIndex per body: these regexes are module-level and global.
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(body)) !== null) {
      // A denied claim is not a claim — see isDenied.
      if (kind === 'phone_claim' && isDenied(body, m.index)) {
        if (m[0].length === 0) re.lastIndex += 1
        continue
      }
      const start = Math.max(0, m.index - CONTEXT_CHARS)
      const end = Math.min(body.length, m.index + m[0].length + CONTEXT_CHARS)
      matches.push({
        kind,
        phrase: m[0].toLowerCase().replace(/\s+/g, ' ').trim(),
        context: `${start > 0 ? '…' : ''}${body.slice(start, end).replace(/\s+/g, ' ')}${end < body.length ? '…' : ''}`,
      })
      // A zero-length match would loop forever; none of the patterns can
      // produce one, and this costs nothing to guarantee.
      if (m[0].length === 0) re.lastIndex += 1
    }
  }
  return matches
}

/** True when the body makes a claim that is false on Instagram. */
export function claimsPhoneChannel(body: string): boolean {
  return findChannelLanguage(body).some((m) => m.kind === 'phone_claim')
}
