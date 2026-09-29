// TAC-541: the pure detector behind the speaker-identity measurement.
//
// FOUR QUESTIONS, and they are deliberately different in kind. Two are the
// ticket's own metrics, one is a ceiling input, one is the R37 check.
//
//   namedSelfIntro     — does the reply present a PERSON as the speaker? This
//                        is the ticket. It cannot be "does the reply contain
//                        the word Himanshu", because ruling 1 keeps mentions
//                        of Himanshu and Milana AS PEOPLE explicitly allowed.
//                        "Himanshu roasts these himself" must not match and
//                        "I'm Himanshu" must.
//   bareNameAsk        — a name question with nothing softening it, which is
//                        the shape that drew the guest's "why?".
//   whatToCallYouReason — does the reply give R37's reason? R37's reason is
//                        "so you know what to call them", which is a claim
//                        about ADDRESSING the guest and nothing more. It is
//                        detected as a call/address phrase ("what to call
//                        you", "what you go by", "how to address you"), never
//                        as a general "we asked for a reason" judgement.
//   overPromisesRecognition — the reason R37 used to give and no longer may:
//                        remembering or recognising the guest next time. Cut
//                        on 2026-09-26 because nobody at the counter can
//                        actually do it. Counted, not barred, so a drift back
//                        to the over-promise is visible in a run rather than
//                        discovered on a device.
//   usesByTheWay       — reported, never barred: how literally the model
//                        copies the approved wording.
//
// BIASED TOWARD RECALL ON namedSelfIntro, deliberately and in the one
// direction that matters. A false positive costs a body I read and discard; a
// false negative reports the defect as fixed when it is not, which is the
// flattering direction and the one this repo keeps paying for. Every match
// reports its matched span so a run is auditable line by line rather than
// collapsed into a number nobody can check.
//
// WHAT IT CANNOT DO, stated rather than left to be discovered: it cannot know
// whether a name it has never heard of is a person. It is given the venue's
// own roster, so a name outside that roster is caught only by the
// frame-plus-capitalised-word patterns. That is the same floor the sibling
// harness's order detector has, and the mitigation is the same: read the
// bodies.

export interface SpeakerIdentityVerdict {
  /** The reply presents a person as the speaker. The ticket's primary metric. */
  namedSelfIntro: boolean
  /** The matched span, so a verdict can be read rather than trusted. */
  namedSelfIntroMatch: string | null
  /** The reply asks for the guest's name at all. */
  asksName: boolean
  /** It asks with nothing softening it. Only meaningful when asksName. */
  bareNameAsk: boolean
  nameAskSentence: string | null
  /** The approved wording, copied literally. Reported, never barred. */
  usesByTheWay: boolean
  /** R37's reason: knowing what to call the guest. */
  whatToCallYouReason: boolean
  whatToCallYouReasonMatch: string | null
  /** The CUT reason. True means the reply promised recognition the venue cannot deliver. */
  overPromisesRecognition: boolean
  overPromisesRecognitionMatch: string | null
  /** Ceiling input: more than one question in the reply (TAC-519's shape). */
  questionCount: number
  /** The reply names the venue, which is what "who they've reached" resolves to. */
  namesVenue: boolean
}

/**
 * Sentence split. Deliberately the same shape as the sibling harness's, rather
 * than imported: that one is tuned to the first-touch reply and this needs the
 * same behaviour on bodies that are not openers. Keeping them separate means a
 * change there cannot silently move a number here.
 */
export function sentencesOf(body: string): string[] {
  return body
    .split(/(?<=[.!?])\s+/)
    .flatMap((s) => s.split('\n'))
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim()
}

/**
 * Frames that make a following name a SELF-INTRODUCTION rather than a mention.
 *
 * `{N}` is filled with the name alternation. The distinction these encode is
 * the whole detector: a first-person or presentational frame immediately
 * before the name. "Himanshu roasts these himself" has no frame and does not
 * match; "I'm Himanshu" does.
 */
const SELF_INTRO_FRAMES = [
  String.raw`\b(?:i'?m|i am)\s+{N}\b`,
  String.raw`\bthis is\s+{N}\b`,
  String.raw`\bit'?s\s+{N}\s+(?:here|at)\b`,
  String.raw`\b{N}\s+here\b`,
  String.raw`\byou'?ve (?:reached|got)\s+{N}\b`,
  String.raw`\b(?:this is|it'?s)\s+{N}\s*[,.!]`,
]

/** A sign-off: a name alone on the last line, or after a dash at the very end. */
const SIGN_OFF = (names: string) =>
  new RegExp(String.raw`(?:^|\n)\s*[-–—]?\s*(?:${names})\s*[.!]?\s*$`, 'i')

/**
 * A person's name introduced with no roster entry: a frame followed by a
 * capitalised word that is not a sentence start. Lower precision by design,
 * which is why it reports its span.
 */
// CASE MATTERS ON THE NAME AND NOT ON THE FRAME, which is why this is not one
// case-sensitive regex: "I'm" would then never match its own lowercase
// alternation. The frame folds case, the captured word is checked for a
// capital in code. Apostrophes are folded first so a curly one still matches.
const UNKNOWN_NAME_INTRO =
  /\b(?:i'm|i am|this is|you've reached|you've got)\s+(\w{3,})\b/i

function foldApostrophes(s: string): string {
  return s.replace(/[\u2018\u2019]/g, "'")
}

const NAME_ASK_PATTERNS = [
  /\bwhat'?s your name\b/,
  /\bwhat is your name\b/,
  /\bwhat should (?:we|i) call you\b/,
  /\bwhat do (?:we|i) call you\b/,
  /\bwho am i (?:talking|speaking) (?:to|with)\b/,
  /\bcan (?:we|i) (?:get|grab|have) your name\b/,
  /\b(?:got|get) a name (?:for you|to go with)\b/,
  /\bname (?:for the )?(?:order|cup)\b/,
  /\byour name\?/,
  /\bwhat do you go by\b/,
]

/**
 * Softeners. A name question carrying one of these is not "bare".
 *
 * `by the way` and `btw` are the approved shape. The rest are the other ways a
 * person softens the same ask, and they are here so the metric measures
 * BARENESS rather than compliance with one phrase: a reply that softens the
 * ask differently is not the defect, and counting it as one would inflate the
 * number in the flattering direction for the approved wording.
 */
const SOFTENERS = [
  /\bby the way\b/,
  /\bbtw\b/,
  /\balso\b/,
  /\boh,? and\b/,
  /\band hey\b/,
  /\bquick (?:one|question)\b/,
  /\bwhile (?:you'?re|we'?re|i'?ve)\b/,
  /\bif you don'?t mind\b/,
  /\bout of curiosity\b/,
  /\bbefore (?:you|i) (?:go|forget)\b/,
  /\bremind me\b/,
  /\bso (?:we|i) (?:know|remember)\b/,
]

/**
 * R37's reason, as it stands after the 2026-09-26 correction: KNOWING WHAT TO
 * CALL THE GUEST.
 *
 * Every pattern is anchored on a call/address phrase, never on a bare "so" or
 * on the presence of any reason at all. A reply that gives some other reason
 * is a MISS here, which is the point: the metric is whether R37's own reason
 * came out, not whether the model said something reason-shaped.
 */
const WHAT_TO_CALL_PATTERNS = [
  /\bwhat to call (?:you|them)\b/,
  /\bwhat (?:we|i) (?:should |can )?call (?:you|them)\b/,
  /\bwhat you(?:'?d like to| want to| prefer to)? go by\b/,
  /\bwhat name you go by\b/,
  /\bhow to address you\b/,
  /\bso (?:we|i) (?:know|have) (?:what|something) to call\b/,
  /\bsomething to call you\b/,
]

/**
 * The reason R37 gave until 2026-09-26 and no longer may: remembering or
 * recognising the guest next time. Cut because nobody at the counter can
 * actually do it, so the agent would be promising something the venue cannot
 * deliver. Counted separately so a drift back shows up as a number.
 */
const OVER_PROMISE_PATTERNS = [
  /\b(?:remember|recognis|recogniz)\w*\s+(?:you|them)\b/,
  /\bnext time\b[^.?!]{0,40}\b(?:know who you are|know it'?s you)\b/,
  /\bso (?:we|i) know it'?s you\b/,
  /\bput a name to (?:the )?(?:face|you)\b/,
]

export function classifySpeakerIdentity(
  body: string,
  options: { personNames: readonly string[]; venueNames: readonly string[] },
): SpeakerIdentityVerdict {
  const normalized = normalize(body)
  const sentences = sentencesOf(body)

  const names = options.personNames
    .filter((n) => n.trim().length > 0)
    .map((n) => normalize(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')

  let namedSelfIntroMatch: string | null = null
  if (names.length > 0) {
    for (const frame of SELF_INTRO_FRAMES) {
      const re = new RegExp(frame.replace('{N}', `(?:${names})`), 'i')
      const m = re.exec(normalized)
      if (m) {
        namedSelfIntroMatch = m[0]
        break
      }
    }
    if (namedSelfIntroMatch === null) {
      const m = SIGN_OFF(names).exec(body)
      if (m) namedSelfIntroMatch = m[0].trim()
    }
  }
  if (namedSelfIntroMatch === null) {
    // The roster-free fallback. Runs against the ORIGINAL body, because it
    // keys on capitalisation, which normalize() destroys.
    const m = UNKNOWN_NAME_INTRO.exec(foldApostrophes(body))
    const captured = m?.[1]
    if (m && captured !== undefined && /^[A-Z][a-z]+$/.test(captured)) {
      namedSelfIntroMatch = m[0]
    }
  }

  const nameAskSentence =
    sentences.find((s) =>
      NAME_ASK_PATTERNS.some((re) => re.test(normalize(s))),
    ) ?? null
  const asksName = nameAskSentence !== null

  // Bareness is judged on the WHOLE reply, not the sentence alone: "oh and" or
  // "by the way" routinely lands in the sentence before the question.
  const softened = SOFTENERS.some((re) => re.test(normalized))

  const whatToCallYouReasonMatch =
    WHAT_TO_CALL_PATTERNS.map((re) => re.exec(normalized)?.[0] ?? null).find(
      (m): m is string => m !== null,
    ) ?? null

  const overPromisesRecognitionMatch =
    OVER_PROMISE_PATTERNS.map((re) => re.exec(normalized)?.[0] ?? null).find(
      (m): m is string => m !== null,
    ) ?? null

  const venuePattern = options.venueNames
    .filter((n) => n.trim().length > 0)
    .map((n) => normalize(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')

  return {
    namedSelfIntro: namedSelfIntroMatch !== null,
    namedSelfIntroMatch,
    asksName,
    bareNameAsk: asksName && !softened,
    nameAskSentence,
    usesByTheWay: /\bby the way\b/.test(normalized),
    whatToCallYouReason: whatToCallYouReasonMatch !== null,
    whatToCallYouReasonMatch,
    overPromisesRecognition: overPromisesRecognitionMatch !== null,
    overPromisesRecognitionMatch,
    questionCount: sentences.filter((s) => s.includes('?')).length,
    namesVenue:
      venuePattern.length > 0 && new RegExp(venuePattern, 'i').test(normalized),
  }
}
