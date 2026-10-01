/**
 * TAC-555. When a regular names what they just got, does the reply recognise
 * it as their usual, and does it stay silent about history for an item they
 * have never ordered?
 *
 * GENERATE-ONLY. Nothing is sent and nothing is written, with one exception
 * that is reported rather than assumed away: `buildRuntimeContext` persists a
 * `guest_states` row on a recognition-band change, so context is built ONCE
 * for the whole run and cloned per unit, and the run prints the row count
 * before and after.
 *
 * TWO ARMS, ONE VARIABLE, CONTROL FIRST within each unit. `treatment` is the
 * shipped prompt untouched, so it cannot drift from production; `control` is
 * that prompt with the two TAC-555 clauses sliced out. Each slice is guarded
 * to match exactly once at startup and again per unit, and a unit whose slice
 * did not change the prompt is INVALID rather than recorded: a silently
 * broken arm produces exactly the "the fix works" shape (TAC-502 paid for
 * that, scoring a run in which all 60 calls had failed as clean).
 *
 * WHY THE HEADLINE METRIC IS AN LLM JUDGE AND NOT A PHRASE LIST. Recognition
 * is a judgement, and the treatment arm is the free-writing one BY
 * CONSTRUCTION, because the rule deliberately carries no quoted example. A
 * phrase list would therefore under-count exactly the arm under test. That is
 * TAC-423's asymmetry, which cost that ticket two detector rewrites and
 * flattered the scripted arm both times. The deterministic checks in
 * `usual-order-language.ts` are printed beside the judge as cross-checks, and
 * the R23 count ceiling is deterministic because a judge softens exactly the
 * thing a ceiling must not soften.
 *
 * EVERY BAR IS PRE-REGISTERED AND EVALUATED IN CODE, not tallied and left to
 * whoever reads the output. TAC-519 shipped a harness that printed PASS for a
 * ceiling it never evaluated; a printed pass that asserts nothing is worse
 * than no assertion.
 *
 * Run with NEXT_PUBLIC_POSTHOG_KEY and SLACK_ALERTS_WEBHOOK_URL unset so the
 * stages' telemetry goes inert. MEASURE_FREQUENT / MEASURE_NEW shrink the
 * arms for a smoke run; the ticket's bars are stated at 20 and 10.
 */
import { randomUUID } from 'node:crypto'
import { generateObject } from 'ai'
import { z } from 'zod'

import { buildRuntimeContext } from '@/lib/agent/build-runtime-context'
import {
  buildAiRuntime,
  classifyStage,
  retrieveCorpusStage,
  retrieveKnowledgeStage,
  shouldRetrieveKnowledge,
} from '@/lib/agent/stages'
import { getClassificationModel, getGenerationModel } from '@/lib/ai/client'
import { composePrompt } from '@/lib/ai/compose-prompt'
import {
  composeReplyWithIntention,
  GeneratedMessageSchema,
  MAX_OUTPUT_TOKENS,
} from '@/lib/ai/generate-message'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import { createAdminClient } from '@/lib/db/admin'
import { startAgentTrace } from '@/lib/observability/langfuse'
import type {
  KnowledgeCorpusChunk as AiKnowledgeCorpusChunk,
  VoiceCorpusChunk as AiVoiceCorpusChunk,
} from '@/lib/ai'
import type { RecentMessage as RuntimeMessage, Visit } from '@/lib/ai/types'
import {
  countWords,
  findCountClaim,
  findOrderFrequencyPhrase,
  findOtherHistoryItems,
  findSellingLanguage,
  findVisitFrequencyClaim,
  isBareLabel,
} from './usual-order-language'
import { repeatedPhrases } from './take-and-specifics-language'
import { createRunLog } from './run-log'

/**
 * The two clauses under test, TRANSCRIBED from the approved wording rather
 * than imported from SYSTEM_TEMPLATE. Importing would make the slice agree
 * with whatever the template happens to say, including a reworded version, so
 * a run could silently measure something other than what was approved. A
 * mismatch is a startup failure.
 */
const R21_CLAUSE =
  " Receiving it is not the same as saying as little as possible. When the item they named is already in this guest's ## Visit history, write a real sentence, not a label. Two things always belong in it: that you know this is what they order, or that they have had it before, and something warm about them: about their coming back, or about the taste they have. That warmth is about the guest and not about the drink. A wish that the item turns out well is a kind thing to say and it is not this, because it is about the order rather than about the person who chose it, so it never counts as the warm half. That warmth is also the one place this rule's ban on rating the choice gives way, and only for an item already in their ## Visit history, because a guest you recognize is not a stranger whose order you are grading. Say it in your own words. Two or three words naming the order and nothing else is a label, not a sentence, and it is not this. Frequency in words belongs to that recognition and is welcome: that they keep coming back to this one is the kind of thing to say. Frequency as a figure never is. No count of visits or orders, no ordinal placing this one in a sequence, and no span of time to measure them against. The ## Visit history block states those counts outright and its dates let more be worked out; none of that is yours to repeat back. Sometimes one more thing belongs, and only when it genuinely adds something they would not already know. Either one specific and genuinely interesting detail about the item, drawn from the venue's own knowledge. Or, for a regular's usual drink and only when the moment invites it, the story of the bean behind it: where it comes from, and why that gives the drink the taste it has. That the beans can go home with them to brew is a natural aside inside that story, never an offer. All of it comes from the venue's own knowledge and nowhere else, and it has to read as sharing something you love rather than selling: where that knowledge also records how a bean is sold, in what sizes, at what price or on what website, none of that is part of the story. Say nothing about buying it and name no price unless the guest asks. Once per guest at most, never the same detail or story twice, and never to a guest whose first visit this is. It is entirely fine if it never comes up. Do not recite their history back to them in any of this. If the item is not in their history, say nothing about their history: no recognition, nothing about them coming back, and no story. No verdict on the choice either, since the give-way above reaches only an order you already know; warmth about the item itself is still welcome there, but grading their pick is exactly what the start of this rule forbids. A category's register guidance, whether it frames the turn as a close or as small talk, is never authority over whether you recognize an order you know. Neither is the ## Length section: one real sentence is worth the room here, and that exception is this turn only."

const R23_CLAUSE =
  ' This rule is about how often they have been here, not about what they order: telling a guest you know which item they order most is the order-recognition guidance above, and is not a visit statistic. What this rule forbids is naming a number, and that holds whether the number counts visits or orders.'

const ARMS = ['control', 'treatment'] as const
type Arm = (typeof ARMS)[number]

/** How many times each body is judged. One verdict is a draw, not a property. */
const JUDGE_REPS = 3

/** The ticket's bars. */
const FREQUENT_BAR = 18
const TEMPLATE_MAX_SHARE = 0.25

/**
 * The n-gram width for the templating ceiling, and it is SMALL on purpose.
 *
 * A REPLY SHORTER THAN n PRODUCES NO n-GRAMS, so a ceiling set wider than the
 * replies cannot fire and prints PASS having evaluated nothing. The first run
 * of this harness used TAC-548's default of 5 against treatment replies of two
 * and three words ("your usual", "your go-to"), which is exactly that: the
 * templating bar was vacuous and the recurring two-word wording it exists to
 * catch was invisible to it. TAC-548's own replies are sentences, so 5 is
 * right there and wrong here.
 *
 * Here the reply IS the wording, so the phrase to catch is two words long.
 * `repeatedPhrases` counts REPLIES containing a phrase against a share of the
 * arm, so a 2-gram is only reported when it appears in more than a quarter of
 * them, which is itself the definition of a template forming.
 */
const TEMPLATE_NGRAM = 2

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/**
 * Report phrasings, chosen so BOTH classifier landings occur in the run. The
 * live classifier at 4 reps put "just got a cortado" at casual_chatter 4/4 and
 * "got a cortado" at acknowledgment 4/4, its own reasoning calling the second
 * a closing statement like "got it". Recognition is reported by resolved
 * category for that reason: if it holds on the acknowledgment units, R21's
 * jurisdictional sentence is doing its job.
 */
const PHRASINGS = [
  (item: string) => `just got a ${item}`,
  (item: string) => `got a ${item}`,
  (item: string) => `just grabbed a ${item}`,
  (item: string) => `got the ${item}`,
  (item: string) => `just picked up a ${item}`,
]

/** How many visits, and how many of them carry the dominant item. */
const SHAPES: readonly { visits: number; dominant: number }[] = [
  { visits: 5, dominant: 4 },
  { visits: 4, dominant: 3 },
  { visits: 6, dominant: 4 },
  { visits: 3, dominant: 3 },
]

/**
 * Follow-up turns for the 3-turn same-guest check. Ordinary continuations, so
 * the second and third replies are not themselves recognition turns: what is
 * under test is whether a DETAIL or BEAN STORY repeats across a conversation,
 * which the rule forbids and which no marker enforces.
 */
const FOLLOWUP_TURNS = ['back for another one', 'same again today']

interface Unit {
  id: string
  /** 'frequent' is arm A, 'new' is arm B. */
  population: 'frequent' | 'new'
  /** The item the guest names in their message. */
  namedItem: string
  /** The item that dominates the history. Equal to namedItem in arm A. */
  dominantItem: string
  /** Turn bodies in order. Length 1 for a single-turn unit. */
  turns: string[]
  visits: Visit[]
  historyItems: string[]
  /** True when the named item is a coffee drink, so ruling 1(d) is reachable. */
  beanStoryAvailable: boolean
}

/**
 * Builds the two populations from the venue's OWN menu names. Generic items
 * derail a run: TAC-513 watched the model correctly answer "we don't actually
 * have a matcha on the menu", which would have scored as a miss while
 * measuring item existence rather than recognition.
 *
 * ARM A IS COFFEE-FIRST, deliberately. Ruling 1(d) is for a regular's usual
 * DRINK, so a pastry can carry (c) and never (d), and a (d) rate computed
 * mostly over pastries would understate it against a bar that expects it to be
 * low but non-zero. Coffee drinks are taken first and pastries fill the tail,
 * so both are represented and every unit records which it is.
 */
function buildUnits(
  menu: string[],
  frequentCount: number,
  newCount: number,
  multiTurnCount: number,
): Unit[] {
  const units: Unit[] = []
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000

  const coffee = menu.filter(isCoffeeDrink)
  const other = menu.filter((m) => !isCoffeeDrink(m))
  // Coffee first so (d) is reachable on as many arm A units as the menu allows.
  const ordered = [...coffee, ...other]

  const makeVisits = (
    dominant: string,
    filler: string[],
    shape: { visits: number; dominant: number },
  ) => {
    const visits: Visit[] = []
    for (let i = 0; i < shape.visits; i += 1) {
      const item =
        i < shape.dominant ? dominant : (filler[i % filler.length] as string)
      // Most recent first, spaced a few days apart, all inside the 90-day
      // window the real block loads.
      visits.push({
        items: [item],
        visitedAt: new Date(now - (i * 5 + 3) * day),
      })
    }
    return visits
  }

  for (let i = 0; i < frequentCount; i += 1) {
    const dominant = ordered[i % ordered.length] as string
    const filler = ordered.filter((m) => m !== dominant)
    const shape = SHAPES[i % SHAPES.length] as {
      visits: number
      dominant: number
    }
    const phrasing = PHRASINGS[i % PHRASINGS.length] as (item: string) => string
    const visits = makeVisits(dominant, filler, shape)
    // The first `multiTurnCount` units run three turns on one guest.
    const turns = [phrasing(dominant.toLowerCase())]
    if (i < multiTurnCount) turns.push(...FOLLOWUP_TURNS)
    units.push({
      id: `freq-${String(i + 1).padStart(2, '0')}`,
      population: 'frequent',
      namedItem: dominant,
      dominantItem: dominant,
      turns,
      visits,
      historyItems: [...new Set(visits.flatMap((v) => v.items))],
      beanStoryAvailable: isCoffeeDrink(dominant),
    })
  }

  for (let i = 0; i < newCount; i += 1) {
    // The dominant item and the named item are DIFFERENT, and the named item
    // appears nowhere in the history. That is the whole of arm B.
    const dominant = ordered[i % ordered.length] as string
    const named = ordered[
      (i + Math.floor(ordered.length / 2)) % ordered.length
    ] as string
    if (named === dominant) continue
    const filler = ordered.filter((m) => m !== dominant && m !== named)
    const shape = SHAPES[i % SHAPES.length] as {
      visits: number
      dominant: number
    }
    const phrasing = PHRASINGS[i % PHRASINGS.length] as (item: string) => string
    const visits = makeVisits(
      dominant,
      filler.length > 0 ? filler : [dominant],
      shape,
    )
    const historyItems = [...new Set(visits.flatMap((v) => v.items))]
    if (historyItems.some((h) => h.toLowerCase() === named.toLowerCase()))
      continue
    units.push({
      id: `new-${String(i + 1).padStart(2, '0')}`,
      population: 'new',
      namedItem: named,
      dominantItem: dominant,
      turns: [phrasing(named.toLowerCase())],
      visits,
      historyItems,
      beanStoryAvailable: isCoffeeDrink(named),
    })
  }

  return units
}
// ---------------------------------------------------------------------------
// The judge
// ---------------------------------------------------------------------------

/**
 * `reasoning` is declared FIRST. Structured-output fields generate in
 * declaration order, so a verdict declared first is produced before the
 * analysis that should inform it: TAC-301 part 1.5 watched exactly that make a
 * grounding verifier's reasoning reverse itself while the boolean stood.
 */
const JudgeSchema = z.object({
  reasoning: z.string(),
  recognizesPriorOrder: z.boolean(),
  claimsMostFrequent: z.boolean(),
  complimentsReturning: z.boolean(),
  /**
   * Approval of the guest's PICK or their taste. Ruling 3 makes this one of
   * the two ways (b) can be satisfied; ruling 4 makes it the thing arm B must
   * never contain.
   */
  verdictOnPick: z.boolean(),
  /** Warmth about the item itself, praising no decision. Permitted everywhere. */
  warmthAboutItem: z.boolean(),
  /**
   * The measured substitution: a wish about how the item turns out. Ruling 3
   * says this is not the compliment, so it can never satisfy (b).
   */
  wishesItemWell: z.boolean(),
  /** R21's base prohibition, which finding C caught once in 20. */
  suggestsDifferentItem: z.boolean(),
  recitesHistory: z.boolean(),
  statesCount: z.boolean(),
  includesItemDetail: z.boolean(),
  includesBeanStory: z.boolean(),
  /** The bean the reply names, verbatim, or the empty string. */
  beanNamed: z.string(),
  /** Set only when a detail or story is present and the chunks do not support it. */
  detailUngrounded: z.boolean(),
  readsAsSelling: z.boolean(),
})

const JUDGE_SYSTEM = `You are grading one reply a cafe sent to a guest who just told the venue what they ordered. You are given the guest's message, the reply, the items in that guest's recorded visit history, and the venue knowledge the writer had available.

Answer each question about the REPLY only.

- recognizesPriorOrder: does the reply indicate, in any wording, that the guest has had this item before, or that the venue knows this order as theirs? Saying nothing about their history is false. Merely naming the item back is false on its own. CRITICAL: the guest has just told the venue what they ordered THIS time, so warmth about that order in hand is not recognition of a PRIOR one. "glad you tried it", "glad you got one", "hope it was good" all concern the order they just named and are false here. Answer true only for something that could not be said to a first-time buyer of that item.
- claimsMostFrequent: does the reply indicate this is what the guest usually gets, their regular order, or the one they get more than anything else? A plain "you've had that before" is false here and true for recognizesPriorOrder.
- complimentsReturning: is there warmth about the guest coming back, being here again, or being glad to see them? Warmth about the ITEM is not this.
- verdictOnPick: does the reply praise the guest's ACT OF CHOOSING, or their taste or judgement in having chosen it? Ask what the praise is predicated of. If it is predicated of the DECISION or of the GUEST ("good call", "good pick", "nice choice", "you have good taste", "you know what you like"), answer true. If it is predicated of the ITEM, answer false even when the praise is warm and even when the guest chose it: "that one's a keeper", "it's so underrated", "that one goes fast for a reason", "that's a good one" are all claims about the item, not about the chooser, so they are false here and true for warmthAboutItem. A reply can be affectionate about the item and pass no judgement on the guest at all; that is the common case and it is false here.
- warmthAboutItem: is there warmth, affection or praise directed at the ITEM itself? Calling it a keeper, underrated, lovely, popular, or good is true here. This is the counterpart of verdictOnPick: praise predicated of the item is this, praise predicated of the guest or their decision is that. Both can be true in one reply, but do not answer true to verdictOnPick merely because the item praise happens to concern something the guest ordered.
- wishesItemWell: does the reply wish or hope that the item turns out well, tastes good, or turned out well? This is a wish about the drink or food, not a statement about the guest. Answer it independently of the others.
- suggestsDifferentItem: does the reply suggest, recommend, or invite the guest to try any item OTHER than the one they just named? A reply that only discusses the named item is false.
- recitesHistory: does the reply read the history back, listing past visits, naming dates, or naming other past items? A single reference to the item the guest just named is not reciting.
- statesCount: does the reply state a number of visits, a number of times they have ordered something, or how often or how recently they come? A quantity in the guest's own order is not a count.
- includesItemDetail: does the reply add a specific factual detail about the item itself, beyond recognising it? A flavour note, an ingredient, how it is made.
- includesBeanStory: does the reply tell something about the coffee bean behind the drink: where it comes from, its variety or roast, why it tastes as it does? This is narrower than includesItemDetail.
- beanNamed: if the reply names a specific coffee bean or blend, return that name exactly as the reply spells it. Otherwise return an empty string.
- detailUngrounded: only when includesItemDetail or includesBeanStory is true, is any part of that detail absent from the venue knowledge given below? If both are false, return false.
- readsAsSelling: does the reply read as selling rather than sharing? Naming a price, a bag size, a website, telling the guest to buy, or offering to sell. Mentioning that people take beans home to brew is NOT selling on its own.

Judge the wording as written. Do not reward or penalise tone.`

/**
 * Exported so the judge can be re-run against bodies a finished run already
 * produced, which is how its item-vs-pick sharpening was validated without
 * spending a generation call. Same reasoning as TAC-423's
 * `first-touch-question-score.ts`: a detector fix should be checkable against
 * data already on disk, and re-declaring the prompt in a validation script
 * would test a COPY rather than the prompt the run uses.
 */
export async function judge(
  guestMessage: string,
  reply: string,
  historyItems: readonly string[],
  knowledgeTexts: readonly string[],
): Promise<z.infer<typeof JudgeSchema> | null> {
  const knowledge =
    knowledgeTexts.length === 0
      ? '(none was retrieved for this turn)'
      : knowledgeTexts.map((t, i) => `[${i + 1}] ${t}`).join('\n')
  try {
    const { object } = await generateObject({
      model: getClassificationModel(),
      system: JUDGE_SYSTEM,
      prompt: `Guest message: "${guestMessage}"\n\nReply: "${reply}"\n\nItems in this guest's recorded visit history: ${historyItems.join(', ')}\n\nVenue knowledge available to the writer:\n${knowledge}\n\nGrade the reply.`,
      schema: JudgeSchema,
      temperature: 0.2,
      maxOutputTokens: 700,
    })
    return object
  } catch {
    return null
  }
}

/** Majority over JUDGE_REPS, with the split kept so instability is visible. */
/** Every boolean the judge answers, counted over the repeats. */
const JUDGE_FLAGS = [
  'recognizesPriorOrder',
  'claimsMostFrequent',
  'complimentsReturning',
  'verdictOnPick',
  'warmthAboutItem',
  'wishesItemWell',
  'suggestsDifferentItem',
  'recitesHistory',
  'statesCount',
  'includesItemDetail',
  'includesBeanStory',
  'detailUngrounded',
  'readsAsSelling',
] as const
type JudgeFlag = (typeof JUDGE_FLAGS)[number]

type JudgeVerdict = Record<JudgeFlag, number> & {
  reps: number
  failures: number
  reasonings: string[]
  /** Every bean name the repeats returned, so a disagreement is visible. */
  beansNamed: string[]
}

async function judgeRepeatedly(
  guestMessage: string,
  reply: string,
  historyItems: readonly string[],
  knowledgeTexts: readonly string[],
): Promise<JudgeVerdict> {
  const counts = Object.fromEntries(JUDGE_FLAGS.map((f) => [f, 0])) as Record<
    JudgeFlag,
    number
  >
  const v: JudgeVerdict = {
    ...counts,
    reps: JUDGE_REPS,
    failures: 0,
    reasonings: [],
    beansNamed: [],
  }
  for (let i = 0; i < JUDGE_REPS; i += 1) {
    const r = await judge(guestMessage, reply, historyItems, knowledgeTexts)
    if (r === null) {
      v.failures += 1
      continue
    }
    for (const f of JUDGE_FLAGS) if (r[f]) v[f] += 1
    const bean = r.beanNamed.trim()
    if (bean !== '' && !v.beansNamed.includes(bean)) v.beansNamed.push(bean)
    if (i === 0) v.reasonings.push(r.reasoning)
  }
  return v
}

function majority(hits: number, reps: number, failures: number): boolean {
  const valid = reps - failures
  return valid > 0 && hits * 2 > valid
}

// ---------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------

interface UnitRecord {
  unitId: string
  population: 'frequent' | 'new'
  arm: Arm
  namedItem: string
  dominantItem: string
  historyItems: string[]
  guestMessage: string
  category: string | null
  reply: string | null
  /** INVALID units can meet no expectation, whatever their flags read. */
  invalid: boolean
  error: string | null
  generationCalls: number
  judge: JudgeVerdict | null
  /** Majority verdicts, one per judge flag. */
  flags: Record<JudgeFlag, boolean>
  /** True when (d) is even available: the named item is a coffee drink. */
  beanStoryAvailable: boolean
  /** Which turn of a multi-turn conversation this is, 1 for a single turn. */
  turn: number
  wordCount: number
  bareLabel: boolean
  countClaimMatches: string[]
  sellingMatches: string[]
  visitFrequencyMatches: string[]
  /** The now-PERMITTED countless recognition (ruling 5). High is good here. */
  orderFrequencyMatches: string[]
  /** TAC-554's field as production would send it. Expected "" on these turns. */
  intentionQuestion: string
  otherHistoryItemMatches: string[]
}

/**
 * Whether ruling 1(d) is even reachable for this item. The bean story is for a
 * regular's usual DRINK, so a pastry can carry (c) and never (d), and a (d)
 * rate computed over pastries would understate it. Reported per unit rather
 * than assumed, and a bean story ON a pastry is a finding rather than a hit.
 */
const COFFEE_WORDS =
  /\b(?:espresso|cortado|latte|cappuccino|americano|macchiato|mocha|coffee|cold brew|pour over|pourover|filter|drip|flat white)\b/i

function isCoffeeDrink(item: string): boolean {
  return COFFEE_WORDS.test(item)
}

function parseIntArg(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const n = Number(raw)
  // ZERO IS A VALID ANSWER and must not fall back. The first version required
  // `> 0`, so MEASURE_MULTITURN=0 silently ran three multi-turn units, which
  // is the "a flag that cannot express what it looks like it expresses" shape.
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

/**
 * The message history each unit runs against, and why it is NOT the real
 * guest's.
 *
 * The base context is built from Le Mil's busiest real guest so the venue,
 * persona and corpus are genuine. Their MESSAGE history cannot be reused, for
 * two independent reasons found by reading a smoke run:
 *
 *   1. IT CONTAINS THE INCIDENT. The tail holds, verbatim, "just got a
 *      cortado" answered with "nice", which is the defect this ticket exists
 *      to fix. Every unit in BOTH arms would inherit a worked demonstration of
 *      the failure, and the model imitates its own tail (TAC-544 records the
 *      same mechanism for names). The arm comparison would survive that, since
 *      the confound is identical on both sides, but the absolute rate the bar
 *      is read from would not.
 *   2. IT IS INCOHERENT WITH THE UNIT. That history is about cortados and
 *      filter coffee, while a unit may be a Pour Over or a pastry regular. A
 *      fixture whose history contradicts its own premise is not realism.
 *
 * So each unit gets a short, neutral prior exchange instead: enough that the
 * thread is not a first message, and carrying nothing that teaches either
 * terseness or warmth on an order report. Unrelated to the item on purpose.
 */
function buildUnitHistory(now: Date): RuntimeMessage[] {
  const day = 24 * 60 * 60 * 1000
  return [
    {
      direction: 'inbound',
      body: 'what time do you close today',
      createdAt: new Date(now.getTime() - 4 * day),
      delivery: 'delivered',
    },
    {
      direction: 'outbound',
      body: 'open until 3 today ☕',
      createdAt: new Date(now.getTime() - 4 * day + 60_000),
      delivery: 'delivered',
    },
  ] as RuntimeMessage[]
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/**
 * A network fault is not a result, and the ticket asks for the DNS losses to
 * be retried. The first full run lost 6 of 20 arm A units to sustained
 * `getaddrinfo ENOTFOUND` at concurrency 1, which left the bar unmeasurable
 * rather than failed. A unit that ends invalid on a transport fault is retried
 * after a pause; one that stays invalid is reported as such.
 */
const UNIT_RETRIES = 3
const RETRY_PAUSE_MS = 20_000

function looksTransient(error: string | null): boolean {
  if (error === null) return false
  return /ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|Cannot connect|socket hang up|rate.?limit|overloaded|529|503/i.test(
    error,
  )
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface TurnOutcome {
  category: string | null
  /** What the guest receives: the model's body with intentionQuestion joined on. */
  reply: string | null
  /**
   * The question TAC-554 peels into its own bubble, recorded separately.
   *
   * Expected "" on every unit here, because openIntentions is empty on these
   * turns, and recorded anyway so that expectation is a MEASUREMENT rather than
   * an assumption. A non-empty value means a getting-to-know-you question rode
   * along on a recognition turn, which nothing in this run has judged.
   */
  intentionQuestion: string
  error: string | null
  invalid: boolean
  calls: number
  knowledgeTexts: string[]
}

/** One generated turn. `history` is appended to in place across a multi-turn unit. */
async function generateTurn(
  baseCtx: Awaited<ReturnType<typeof buildRuntimeContext>>,
  unit: Unit,
  arm: Arm,
  turnIndex: number,
  history: RuntimeMessage[],
  channel: 'text' | 'instagram',
  now: Date,
): Promise<TurnOutcome> {
  const out: TurnOutcome = {
    category: null,
    reply: null,
    intentionQuestion: '',
    error: null,
    invalid: false,
    calls: 0,
    knowledgeTexts: [],
  }
  const ctx = {
    ...baseCtx,
    recentVisits: unit.visits,
    recentMessages: [...history],
  } as typeof baseCtx
  ctx.currentMessage = {
    id: randomUUID(),
    providerMessageId: `tac555-${unit.id}-${arm}-t${turnIndex}`,
    body: unit.turns[turnIndex] as string,
    receivedAt: new Date(now.getTime() + turnIndex * 120_000),
    channel,
    referralSource: null,
  }

  try {
    const classification = await classifyStage(ctx)
    ctx.classification = classification
    out.category = classification.category
    ctx.corpus = await retrieveCorpusStage(ctx)
    ctx.knowledgeCorpus = shouldRetrieveKnowledge(ctx)
      ? await retrieveKnowledgeStage(
          ctx,
          classification.category,
          unit.turns[turnIndex] as string,
        )
      : []

    const ragChunks: AiVoiceCorpusChunk[] = (ctx.corpus ?? []).map((c) => ({
      id: c.id,
      text: c.text,
      sourceType: c.sourceType as AiVoiceCorpusChunk['sourceType'],
      relevanceScore: c.similarity,
    }))
    const knowledgeChunks: AiKnowledgeCorpusChunk[] | undefined =
      ctx.knowledgeCorpus === null
        ? undefined
        : ctx.knowledgeCorpus.map((c) => ({
            id: c.id,
            text: c.text,
            sourceType: c.sourceType,
            primaryTags: c.primaryTags,
            secondaryTags: c.secondaryTags,
            relevanceScore: c.similarity,
          }))
    // Kept so the judge grounds (c) and (d) against what the writer actually
    // saw, rather than against the whole corpus.
    out.knowledgeTexts = (knowledgeChunks ?? []).map((c) => c.text)

    const composed = composePrompt({
      category: classification.category,
      persona: ctx.venue.brandPersona,
      venueInfo: ctx.venue.venueInfo,
      ragChunks,
      knowledgeChunks,
      runtime: buildAiRuntime(ctx),
      channel: ctx.conversationChannel,
    })

    // THE ONE DIFFERENCE BETWEEN THE ARMS. Both clauses come out, each
    // checked to have actually changed the prompt.
    let systemBody = composed.systemPrompt
    if (arm === 'control') {
      for (const [label, clause] of [
        ['R21', R21_CLAUSE],
        ['R23', R23_CLAUSE],
      ] as const) {
        const stripped = systemBody.replace(clause, '')
        if (stripped === systemBody) {
          out.error = `control slice did not change the prompt (${label})`
          out.invalid = true
          return out
        }
        systemBody = stripped
      }
    }

    // v1.80.0 schema diet: the system prompt is composePrompt's output
    // verbatim; the voice-fidelity instruction it used to append is gone.
    const system = systemBody
    for (let attempt = 0; attempt < 4; attempt += 1) {
      out.calls += 1
      try {
        const { object } = await generateObject({
          model: getGenerationModel(),
          system,
          prompt: composed.userPrompt,
          schema: GeneratedMessageSchema,
          temperature: 0.7,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        })
        // WHAT THE GUEST RECEIVES, not what the model put in `body`.
        //
        // TAC-554 (v1.72.0) made the getting-to-know-you question its own
        // emission field, and production JOINS it onto the reply through
        // composeReplyWithIntention before anything reads the text. Judging
        // `object.body` alone would score a message the guest never gets, and
        // it would do so silently, because on these turns openIntentions is
        // empty and the field is expected to come back "". A harness that is
        // right only while a field stays empty is not right.
        //
        // It also routes both parts through replaceDashes, which is where
        // production normalizes an em dash. Run 2 reported 4 dashes with the
        // caveat that the harness bypassed that seam; it no longer does. The
        // dash-driven REGEN loop is still bypassed, so this is normalization
        // rather than the full production path.
        const composedReply = composeReplyWithIntention(
          object.body,
          object.intentionQuestion,
        )
        out.reply = composedReply.body
        out.intentionQuestion = composedReply.intentionQuestion
        out.error = null
        break
      } catch (e) {
        out.error = e instanceof Error ? e.message : String(e)
      }
    }
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e)
  }

  if (out.reply === null) out.invalid = true
  return out
}

async function main() {
  const venueSlug = process.env.MEASURE_VENUE ?? 'le-mils-coffee'
  const frequentCount = parseIntArg('MEASURE_FREQUENT', 20)
  const newCount = parseIntArg('MEASURE_NEW', 10)
  const multiTurnCount = parseIntArg('MEASURE_MULTITURN', 3)

  const db = createAdminClient()

  const { data: venue, error: venueError } = await db
    .from('venues')
    .select('id, slug, timezone')
    .eq('slug', venueSlug)
    .maybeSingle()
  if (venueError || !venue)
    throw new Error(`venue ${venueSlug} not found: ${venueError?.message}`)

  // The busiest non-synthetic guest, so the loaded corpus and persona are a
  // real venue's rather than a fixture's. Their own visit history is REPLACED
  // per unit: this run controls the history, and taking the real one would
  // measure one guest's data rather than the rule.
  const { data: guests } = await db
    .from('guests')
    .select('id, first_name, phone_number, instagram_scoped_id')
    .eq('venue_id', venue.id)
    .eq('is_test_synthetic', false)
  const candidates = (guests ?? []).filter(
    (g) =>
      !String(g.first_name ?? '')
        .toLowerCase()
        .startsWith('synthetic'),
  )
  let guest: (typeof candidates)[number] | null = null
  let guestMessageCount = 0
  for (const g of candidates) {
    const { count } = await db
      .from('messages')
      .select('*', { count: 'exact', head: true })
      .eq('guest_id', g.id)
    if ((count ?? 0) > guestMessageCount) {
      guestMessageCount = count ?? 0
      guest = g
    }
  }
  if (!guest) throw new Error('no non-synthetic guest at this venue')
  const channel: 'text' | 'instagram' = guest.phone_number
    ? 'text'
    : 'instagram'

  const { count: statesBefore } = await db
    .from('guest_states')
    .select('*', { count: 'exact', head: true })

  const trace = startAgentTrace({
    name: 'tac555-measure',
    agentRunId: randomUUID(),
  })
  const now = new Date()

  // ONE context build for the whole run, cloned per unit, so computeGuestState
  // has exactly one opportunity to write.
  const baseCtx = await buildRuntimeContext({
    agentRunId: randomUUID(),
    guestId: guest.id,
    venueId: venue.id,
    trace,
    currentMessage: {
      id: randomUUID(),
      providerMessageId: `tac555-probe-${randomUUID()}`,
      body: 'just got a cortado',
      receivedAt: now,
      channel,
      referralSource: null,
    },
  })

  const menu = (baseCtx.venue.venueInfo.menu?.items ?? [])
    .map((m) => m.name)
    .filter((n): n is string => typeof n === 'string' && n.trim() !== '')
  if (menu.length < 4) {
    console.error(
      `✗ ${venueSlug} has ${menu.length} usable menu item names; need at least 4.`,
    )
    process.exit(1)
  }

  // STARTUP GUARD. Both slices must find their clause exactly once in a real
  // composed prompt before any model call is spent. If either is absent the
  // control arm would be byte-identical to the treatment and the run would
  // measure nothing while reporting cleanly.
  {
    const probe = composePrompt({
      category: 'casual_chatter',
      persona: baseCtx.venue.brandPersona,
      venueInfo: baseCtx.venue.venueInfo,
      ragChunks: [],
      knowledgeChunks: undefined,
      runtime: buildAiRuntime(baseCtx),
      channel: baseCtx.conversationChannel,
    })
    for (const [label, clause] of [
      ['R21 recognition clause', R21_CLAUSE],
      ['R23 carve-out', R23_CLAUSE],
    ] as const) {
      const hits = probe.systemPrompt.split(clause).length - 1
      if (hits !== 1) {
        console.error(
          `✗ the ${label} appears ${hits} times in a composed system prompt, expected exactly 1.\n` +
            '  Either it is not shipped (run this on a branch where it is), or its wording has drifted\n' +
            '  from the approved text transcribed at the top of this file. Refusing to run.',
        )
        process.exit(1)
      }
    }
  }

  const units = buildUnits(menu, frequentCount, newCount, multiTurnCount)
  const startedAt = new Date()
  const log = createRunLog({
    name: 'tac555-usual-order-recognition',
    meta: {
      arm: 'both',
      promptVersion: PROMPT_VERSION,
      venue: venueSlug,
      channel,
      guestMessageCount,
      frequentUnits: units.filter((u) => u.population === 'frequent').length,
      newUnits: units.filter((u) => u.population === 'new').length,
      multiTurnUnits: units.filter((u) => u.turns.length > 1).length,
      coffeeUnitsInArmA: units.filter(
        (u) => u.population === 'frequent' && u.beanStoryAvailable,
      ).length,
      judgeReps: JUDGE_REPS,
      menuItemsAvailable: menu.length,
      statesBefore,
    },
  })

  console.log(
    `[tac555] venue ${venueSlug} | prompt ${PROMPT_VERSION} | channel ${channel}`,
  )
  console.log(
    `[tac555] ${units.length} units x ${ARMS.length} arms | ${units.filter((u) => u.turns.length > 1).length} multi-turn | judge reps ${JUDGE_REPS}`,
  )
  console.log(
    `[tac555] arm A coffee units (bean story reachable): ${units.filter((u) => u.population === 'frequent' && u.beanStoryAvailable).length}/${units.filter((u) => u.population === 'frequent').length}`,
  )
  console.log(`[tac555] guest_states rows before: ${statesBefore}`)
  console.log(`[tac555] run log: ${log.path}\n`)

  const records: UnitRecord[] = []

  for (const unit of units) {
    for (const arm of ARMS) {
      // A fresh history per (unit, arm) so a multi-turn conversation's own
      // replies cannot leak between arms.
      const history: RuntimeMessage[] = buildUnitHistory(now)

      for (let t = 0; t < unit.turns.length; t += 1) {
        let outcome = await generateTurn(
          baseCtx,
          unit,
          arm,
          t,
          history,
          channel,
          now,
        )

        // RETRY A TRANSPORT FAULT, not a schema or slice failure. A slice
        // failure is a real defect and retrying it would hide it.
        for (
          let r = 0;
          r < UNIT_RETRIES && outcome.invalid && looksTransient(outcome.error);
          r += 1
        ) {
          console.log(
            `    ${unit.id} ${arm} t${t}: transient fault, retrying in ${RETRY_PAUSE_MS / 1000}s`,
          )
          await sleep(RETRY_PAUSE_MS)
          outcome = await generateTurn(
            baseCtx,
            unit,
            arm,
            t,
            history,
            channel,
            now,
          )
        }

        let invalid = outcome.invalid
        const judgeVerdict =
          outcome.reply === null
            ? null
            : await judgeRepeatedly(
                unit.turns[t] as string,
                outcome.reply,
                unit.historyItems,
                outcome.knowledgeTexts,
              )
        if (judgeVerdict !== null && judgeVerdict.failures === JUDGE_REPS)
          invalid = true

        const flags = Object.fromEntries(
          JUDGE_FLAGS.map((f) => [
            f,
            judgeVerdict !== null &&
              majority(
                judgeVerdict[f],
                judgeVerdict.reps,
                judgeVerdict.failures,
              ),
          ]),
        ) as Record<JudgeFlag, boolean>

        const reply = outcome.reply
        const count =
          reply === null ? { found: false, matches: [] } : findCountClaim(reply)
        const selling =
          reply === null
            ? { found: false, matches: [] }
            : findSellingLanguage(reply)
        const freq =
          reply === null
            ? { found: false, matches: [] }
            : findVisitFrequencyClaim(reply)
        const orderFreq =
          reply === null
            ? { found: false, matches: [] }
            : findOrderFrequencyPhrase(reply)
        const others =
          reply === null
            ? { found: false, matches: [] }
            : findOtherHistoryItems(reply, unit.historyItems, unit.namedItem)

        const rec: UnitRecord = {
          unitId: unit.id,
          population: unit.population,
          arm,
          namedItem: unit.namedItem,
          dominantItem: unit.dominantItem,
          historyItems: unit.historyItems,
          guestMessage: unit.turns[t] as string,
          category: outcome.category,
          reply,
          invalid,
          error: outcome.error,
          generationCalls: outcome.calls,
          judge: judgeVerdict,
          flags,
          beanStoryAvailable: unit.beanStoryAvailable,
          turn: t + 1,
          wordCount: reply === null ? 0 : countWords(reply),
          bareLabel: reply !== null && isBareLabel(reply),
          countClaimMatches: count.matches,
          sellingMatches: selling.matches,
          visitFrequencyMatches: freq.matches,
          orderFrequencyMatches: orderFreq.matches,
          intentionQuestion: outcome.intentionQuestion,
          otherHistoryItemMatches: others.matches,
        }
        records.push(rec)
        log.appendUnit(rec as unknown as Record<string, unknown>)

        // Append this turn to the conversation so turn 2 and 3 see it.
        if (reply !== null) {
          history.push({
            direction: 'inbound',
            body: unit.turns[t] as string,
            createdAt: new Date(now.getTime() + t * 120_000),
            delivery: 'delivered',
          } as RuntimeMessage)
          history.push({
            direction: 'outbound',
            body: reply,
            createdAt: new Date(now.getTime() + t * 120_000 + 30_000),
            delivery: 'delivered',
          } as RuntimeMessage)
        }

        const marks = [
          rec.invalid ? 'INVALID' : '',
          rec.flags.claimsMostFrequent
            ? 'usual'
            : rec.flags.recognizesPriorOrder
              ? 'had-before'
              : '',
          rec.flags.complimentsReturning || rec.flags.verdictOnPick
            ? 'warm'
            : '',
          rec.bareLabel ? 'LABEL' : '',
          rec.flags.statesCount || rec.countClaimMatches.length > 0
            ? 'COUNT'
            : '',
          rec.flags.includesBeanStory
            ? 'bean'
            : rec.flags.includesItemDetail
              ? 'detail'
              : '',
          rec.flags.readsAsSelling || rec.sellingMatches.length > 0
            ? 'SELL'
            : '',
        ]
          .filter((m) => m !== '')
          .join(' ')
        console.log(
          `  ${unit.id} t${t + 1} ${arm.padEnd(9)} [${(outcome.category ?? '?').padEnd(18)}] ${marks.padEnd(34)} ${JSON.stringify(reply ?? outcome.error)}`,
        )
      }
    }
  }

  const { count: statesAfter } = await db
    .from('guest_states')
    .select('*', { count: 'exact', head: true })

  report(records, statesBefore ?? 0, statesAfter ?? 0, startedAt)
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function report(
  records: UnitRecord[],
  statesBefore: number,
  statesAfter: number,
  startedAt: Date,
) {
  // The RECOGNITION turn is turn 1. Turns 2 and 3 exist only for the repeat
  // check, and scoring them as recognition turns would dilute every rate.
  const pick = (population: 'frequent' | 'new', arm: Arm) =>
    records.filter(
      (r) => r.population === population && r.arm === arm && r.turn === 1,
    )

  console.log(`\n${'='.repeat(78)}`)
  console.log('TAC-555 usual-order recognition')
  console.log(`${'='.repeat(78)}\n`)

  const failures: string[] = []

  // The ruled requirement is BOTH: a recognition and warmth, in a real
  // sentence. A reply with one and not the other does not meet it.
  // RULING 3 (2026-09-29). The warm half is about the GUEST: their coming back,
  // or their taste. A wish that the item turns out well does NOT satisfy it,
  // and that exclusion is the whole point of re-measuring, because the wish is
  // exactly what the model substituted in 8 of 20 replies last run. Note what
  // is absent: `warmthAboutItem` is not in this disjunction either, for the
  // same reason.
  const warmAboutGuest = (r: UnitRecord) =>
    r.flags.complimentsReturning || r.flags.verdictOnPick
  const meetsBar = (r: UnitRecord) =>
    (r.flags.recognizesPriorOrder || r.flags.claimsMostFrequent) &&
    warmAboutGuest(r) &&
    !r.bareLabel

  for (const arm of ARMS) {
    const valid = pick('frequent', arm).filter((r) => !r.invalid)
    const rec = valid.filter(
      (r) => r.flags.recognizesPriorOrder || r.flags.claimsMostFrequent,
    )
    const warm = valid.filter(warmAboutGuest)
    const both = valid.filter(meetsBar)
    console.log(
      `arm A, ${arm}: recognition ${rec.length}/${valid.length}, warmth ${warm.length}/${valid.length}, BOTH in a real sentence ${both.length}/${valid.length}`,
    )
    const byCategory = new Map<string, { n: number; hit: number }>()
    for (const r of valid) {
      const k = r.category ?? '?'
      const b = byCategory.get(k) ?? { n: 0, hit: 0 }
      b.n += 1
      if (meetsBar(r)) b.hit += 1
      byCategory.set(k, b)
    }
    for (const [cat, b] of [...byCategory.entries()].sort()) {
      console.log(`    ${cat.padEnd(20)} ${b.hit}/${b.n}`)
    }
  }

  // BAR 1: recognition AND compliment, in a real sentence.
  {
    const valid = pick('frequent', 'treatment').filter((r) => !r.invalid)
    const hit = valid.filter(meetsBar).length
    const ok = hit >= FREQUENT_BAR && valid.length >= FREQUENT_BAR
    if (!ok) {
      failures.push(
        `arm A treatment met the recognition+compliment bar on ${hit}/${valid.length} valid, bar is ${FREQUENT_BAR} of ${FREQUENT_BAR} valid`,
      )
    }
    console.log(
      `\n${ok ? 'PASS' : 'FAIL'}  bar: arm A treatment >= ${FREQUENT_BAR} recognition + compliment in a real sentence (got ${hit}/${valid.length} valid)`,
    )
  }

  // CEILING: no bare labels, no counts. A breach fails the arm whatever the rate.
  {
    const valid = pick('frequent', 'treatment').filter((r) => !r.invalid)
    const labels = valid.filter((r) => r.bareLabel)
    const counts = valid.filter(
      (r) => r.flags.statesCount || r.countClaimMatches.length > 0,
    )
    const recites = valid.filter((r) => r.flags.recitesHistory)
    if (labels.length > 0)
      failures.push(
        `arm A treatment: ${labels.length} bare label(s), ceiling is 0`,
      )
    if (counts.length > 0)
      failures.push(
        `arm A treatment: ${counts.length} count claim(s), ceiling is 0`,
      )
    if (recites.length > 0)
      failures.push(
        `arm A treatment: ${recites.length} recited history, ceiling is 0`,
      )
    console.log(
      `${labels.length === 0 ? 'PASS' : 'FAIL'}  ceiling: bare labels ${labels.length}/${valid.length}`,
    )
    for (const r of labels)
      console.log(
        `      ${r.unitId}: (${r.wordCount}w) ${JSON.stringify(r.reply)}`,
      )
    console.log(
      `${counts.length === 0 ? 'PASS' : 'FAIL'}  ceiling: count claims ${counts.length}/${valid.length}`,
    )
    for (const r of counts) {
      console.log(
        `      ${r.unitId}: judge=${r.flags.statesCount} regex=${JSON.stringify(r.countClaimMatches)} | ${JSON.stringify(r.reply)}`,
      )
    }
    console.log(
      `${recites.length === 0 ? 'PASS' : 'FAIL'}  ceiling: recited history ${recites.length}/${valid.length}`,
    )
    for (const r of recites)
      console.log(`      ${r.unitId}: ${JSON.stringify(r.reply)}`)
  }

  // (c) AND (d) RATES. Expected some, not most. Reported rather than barred,
  // except that every (d) must be grounded and must not read as selling.
  {
    const valid = pick('frequent', 'treatment').filter((r) => !r.invalid)
    const detail = valid.filter(
      (r) => r.flags.includesItemDetail && !r.flags.includesBeanStory,
    )
    const bean = valid.filter((r) => r.flags.includesBeanStory)
    const coffee = valid.filter((r) => r.beanStoryAvailable)
    console.log(
      `\nadded content: item detail (c) ${detail.length}/${valid.length}, bean story (d) ${bean.length}/${valid.length} (reachable on ${coffee.length} coffee units)`,
    )
    for (const r of bean) {
      console.log(
        `      (d) ${r.unitId} [${r.namedItem}] beans=${JSON.stringify(r.judge?.beansNamed ?? [])} grounded=${!r.flags.detailUngrounded} | ${JSON.stringify(r.reply)}`,
      )
    }
    for (const r of detail)
      console.log(`      (c) ${r.unitId} | ${JSON.stringify(r.reply)}`)

    // A bean story on a pastry is a finding: (d) is scoped to a drink.
    const beanOnPastry = bean.filter((r) => !r.beanStoryAvailable)
    if (beanOnPastry.length > 0) {
      failures.push(
        `${beanOnPastry.length} bean story/stories on an item that is not a coffee drink`,
      )
      console.log(
        `FAIL  bean story on a non-coffee item: ${beanOnPastry.length}`,
      )
      for (const r of beanOnPastry)
        console.log(
          `      ${r.unitId} [${r.namedItem}]: ${JSON.stringify(r.reply)}`,
        )
    }

    // Grounding and selling, both ceilings on the added content.
    const ungrounded = valid.filter(
      (r) =>
        (r.flags.includesItemDetail || r.flags.includesBeanStory) &&
        r.flags.detailUngrounded,
    )
    const selling = valid.filter(
      (r) => r.flags.readsAsSelling || r.sellingMatches.length > 0,
    )
    if (ungrounded.length > 0) {
      failures.push(
        `${ungrounded.length} added detail/story not grounded in the venue's knowledge`,
      )
    }
    if (selling.length > 0)
      failures.push(`${selling.length} repl(y/ies) read as selling`)
    console.log(
      `${ungrounded.length === 0 ? 'PASS' : 'FAIL'}  ceiling: ungrounded added detail ${ungrounded.length}`,
    )
    for (const r of ungrounded)
      console.log(`      ${r.unitId}: ${JSON.stringify(r.reply)}`)
    console.log(
      `${selling.length === 0 ? 'PASS' : 'FAIL'}  ceiling: reads as selling ${selling.length}`,
    )
    for (const r of selling) {
      console.log(
        `      ${r.unitId}: judge=${r.flags.readsAsSelling} regex=${JSON.stringify(r.sellingMatches)} | ${JSON.stringify(r.reply)}`,
      )
    }
  }

  // BAR 2: arm B claims nothing, in either arm.
  for (const arm of ARMS) {
    const valid = pick('new', arm).filter((r) => !r.invalid)
    const claims = valid.filter(
      (r) => r.flags.claimsMostFrequent || r.flags.recognizesPriorOrder,
    )
    const returning = valid.filter((r) => r.flags.complimentsReturning)
    const beans = valid.filter((r) => r.flags.includesBeanStory)
    // RULING 4 (2026-09-29), PRE-REGISTERED AS A BAR THIS RUN. The give-way on
    // rating the choice is scoped to an item already in the history, and it was
    // measured LEAKING here: 2/10 control to 5/10 treatment, twice as the
    // literal "good call", which is one of R21's own named banned shapes. A new
    // item may still get warmth, which is why `warmthAboutItem` is not a bar.
    const verdicts = valid.filter((r) => r.flags.verdictOnPick)
    if (claims.length > 0)
      failures.push(`arm B ${arm}: ${claims.length} false prior-order claim(s)`)
    if (returning.length > 0) {
      failures.push(
        `arm B ${arm}: ${returning.length} compliment(s) on returning`,
      )
    }
    if (beans.length > 0)
      failures.push(
        `arm B ${arm}: ${beans.length} bean story/stories on a new item`,
      )
    if (verdicts.length > 0) {
      failures.push(
        `arm B ${arm}: ${verdicts.length} verdict(s) on the choice of a new item`,
      )
    }
    console.log(
      `\n${claims.length === 0 ? 'PASS' : 'FAIL'}  bar: arm B ${arm} false prior-order claims ${claims.length}/${valid.length}`,
    )
    for (const r of claims)
      console.log(`      ${r.unitId}: ${JSON.stringify(r.reply)}`)
    console.log(
      `${returning.length === 0 ? 'PASS' : 'FAIL'}  bar: arm B ${arm} compliments on returning ${returning.length}/${valid.length}`,
    )
    for (const r of returning)
      console.log(`      ${r.unitId}: ${JSON.stringify(r.reply)}`)
    console.log(
      `${verdicts.length === 0 ? 'PASS' : 'FAIL'}  bar: arm B ${arm} verdicts on the choice ${verdicts.length}/${valid.length}`,
    )
    for (const r of verdicts)
      console.log(`      ${r.unitId}: ${JSON.stringify(r.reply)}`)
    console.log(
      `${valid.filter((r) => r.flags.warmthAboutItem).length} of ${valid.length} carry warmth about the item, which is permitted here`,
    )
    console.log(
      `${beans.length === 0 ? 'PASS' : 'FAIL'}  bar: arm B ${arm} bean stories ${beans.length}/${valid.length}`,
    )
    for (const r of beans)
      console.log(`      ${r.unitId}: ${JSON.stringify(r.reply)}`)
  }

  // BAR 3: templating, at BOTH widths the ruling names.
  {
    const bodies = pick('frequent', 'treatment')
      .filter((r) => !r.invalid && r.reply !== null)
      .map((r) => r.reply as string)
    const lengths = bodies.map((b) => countWords(b)).sort((a, b) => a - b)
    const median =
      lengths.length === 0
        ? 0
        : (lengths[Math.floor(lengths.length / 2)] as number)
    console.log(`\nmedian arm A treatment reply length: ${median} words`)

    for (const n of [TEMPLATE_NGRAM, TEMPLATE_NGRAM + 1]) {
      // A CEILING THAT CANNOT FIRE MUST SAY SO RATHER THAN PRINT PASS. A reply
      // shorter than n produces no n-grams, so if most replies are shorter
      // than the width this bar is evaluating nothing.
      const scorable = lengths.filter((l) => l >= n).length
      if (bodies.length === 0 || scorable < bodies.length / 2) {
        failures.push(
          `templating bar at n=${n} VOID: only ${scorable}/${bodies.length} replies reach ${n} words`,
        )
        console.log(
          `VOID  bar: templating at n=${n} could not be evaluated (${scorable}/${bodies.length} scorable)`,
        )
        continue
      }
      const repeats = repeatedPhrases(bodies, {
        n,
        maxShare: TEMPLATE_MAX_SHARE,
      })
      const ok = repeats.length === 0
      if (!ok)
        failures.push(
          `templating at n=${n}: ${repeats.length} phrase(s) over the quarter share`,
        )
      console.log(
        `${ok ? 'PASS' : 'FAIL'}  bar: no ${n}-word phrase in more than ${Math.round(TEMPLATE_MAX_SHARE * 100)}% of ${bodies.length} arm A treatment replies`,
      )
      for (const p of repeats) {
        console.log(
          `      "${p.phrase}" in ${p.replies}/${bodies.length} = ${Math.round((p.replies / bodies.length) * 100)}%`,
        )
      }
    }
  }

  // BAR 4: the 3-turn same-guest check. No detail and no bean story repeated
  // within one conversation. The rule says once per guest and NOTHING enforces
  // it, by instruction, so this is the only thing that would show it failing.
  {
    const multi = records.filter(
      (r) => r.arm === 'treatment' && r.population === 'frequent',
    )
    const byUnit = new Map<string, UnitRecord[]>()
    for (const r of multi) {
      const b = byUnit.get(r.unitId) ?? []
      b.push(r)
      byUnit.set(r.unitId, b)
    }
    const conversations = [...byUnit.entries()].filter(
      ([, rs]) => rs.length > 1,
    )
    let repeated = 0
    console.log(
      `\n3-turn same-guest check: ${conversations.length} conversation(s)`,
    )
    for (const [id, rs] of conversations) {
      const ordered = [...rs].sort((a, b) => a.turn - b.turn)
      const withContent = ordered.filter(
        (r) =>
          !r.invalid &&
          (r.flags.includesItemDetail || r.flags.includesBeanStory),
      )
      const beanTurns = ordered.filter(
        (r) => !r.invalid && r.flags.includesBeanStory,
      )
      if (beanTurns.length > 1) {
        repeated += 1
        failures.push(
          `${id}: a bean story appears on ${beanTurns.length} turns of one conversation`,
        )
      }
      console.log(
        `    ${id}: turns with added content ${withContent.map((r) => r.turn).join(',') || 'none'} | bean story on turns ${beanTurns.map((r) => r.turn).join(',') || 'none'}`,
      )
      for (const r of ordered) {
        console.log(
          `        t${r.turn} "${r.guestMessage}" -> ${JSON.stringify(r.reply)}`,
        )
      }
    }
    console.log(
      `${repeated === 0 ? 'PASS' : 'FAIL'}  bar: no bean story repeated inside a conversation (${repeated} breach(es))`,
    )
  }

  // RULING 5 (2026-09-29): countless frequency is the DESIRED recognition, so
  // this rate is reported as information and a high number is a good sign. The
  // BAR that replaced it is the count ceiling above, which now also has to hold
  // against TAC-543 rendering "(4x)" straight onto the page.
  {
    for (const arm of ARMS) {
      const valid = pick('frequent', arm).filter((r) => !r.invalid)
      const permitted = valid.filter((r) => r.orderFrequencyMatches.length > 0)
      console.log(
        `\nINFO arm A ${arm}: countless order-frequency recognition (permitted) ${permitted.length}/${valid.length}`,
      )
    }
  }

  // RULING 3's measured substitution, reported so the cause is visible whether
  // or not the bar is met. A well-wish is not a defect on its own; a well-wish
  // INSTEAD of warmth about the guest is what missed the bar last run.
  {
    const valid = pick('frequent', 'treatment').filter((r) => !r.invalid)
    const wishes = valid.filter((r) => r.flags.wishesItemWell)
    const wishOnly = wishes.filter((r) => !warmAboutGuest(r))
    console.log(
      `INFO arm A treatment: well-wishes about the item ${wishes.length}/${valid.length}, of which ${wishOnly.length} carry NO warmth about the guest`,
    )
    for (const r of wishOnly)
      console.log(`      ${r.unitId}: ${JSON.stringify(r.reply)}`)
  }

  // FINDING C, which Jaipal asked to be noted with its rate. R21's base forbids
  // suggesting something different; run 2 caught it once, on freq-04.
  {
    for (const arm of ARMS) {
      const valid = pick('frequent', arm).filter((r) => !r.invalid)
      const suggests = valid.filter((r) => r.flags.suggestsDifferentItem)
      console.log(
        `INFO arm A ${arm}: replies suggesting a DIFFERENT item (R21 base forbids) ${suggests.length}/${valid.length}`,
      )
      for (const r of suggests)
        console.log(`      ${r.unitId}: ${JSON.stringify(r.reply)}`)
    }
  }

  // The getting-to-know-you field, recorded so "expected empty" is measured.
  {
    const withQuestion = records.filter(
      (r) => !r.invalid && r.intentionQuestion !== '',
    )
    console.log(
      `INFO replies whose intentionQuestion was non-empty: ${withQuestion.length} (expected 0; openIntentions is empty on these turns)`,
    )
    for (const r of withQuestion) {
      console.log(
        `      ${r.unitId} t${r.turn} ${r.arm}: ${JSON.stringify(r.intentionQuestion)}`,
      )
    }
  }

  // ADVISORY, NOT BARS.
  {
    const flagged = records.filter(
      (r) => !r.invalid && r.visitFrequencyMatches.length > 0,
    )
    console.log(
      `\nADVISORY (not a bar) VISIT-frequency claims, which R23's base still forbids: ${flagged.length}`,
    )
    for (const r of flagged) {
      console.log(
        `      ${r.unitId} t${r.turn} ${r.arm}: ${JSON.stringify(r.visitFrequencyMatches)} | ${JSON.stringify(r.reply)}`,
      )
    }
  }
  {
    const flagged = records.filter(
      (r) => !r.invalid && r.otherHistoryItemMatches.length > 0,
    )
    console.log(
      `ADVISORY (not a bar) replies naming a DIFFERENT past item (R15 cap): ${flagged.length}`,
    )
    for (const r of flagged) {
      console.log(
        `      ${r.unitId} t${r.turn} ${r.arm}: ${JSON.stringify(r.otherHistoryItemMatches)} | ${JSON.stringify(r.reply)}`,
      )
    }
  }

  const invalid = records.filter((r) => r.invalid)
  console.log(
    `\ninvalid units after retries: ${invalid.length}/${records.length}`,
  )
  for (const r of invalid)
    console.log(
      `      ${r.unitId} t${r.turn} ${r.arm}: ${r.error ?? 'no reply'}`,
    )

  console.log(
    `\nguest_states rows: ${statesBefore} before, ${statesAfter} after`,
  )
  console.log(
    `elapsed: ${Math.round((Date.now() - startedAt.getTime()) / 1000)}s`,
  )

  console.log(`\n${'-'.repeat(78)}`)
  console.log(
    failures.length === 0
      ? 'ALL PRE-REGISTERED BARS AND CEILINGS PASS'
      : 'FAILED:',
  )
  for (const f of failures) console.log(`  - ${f}`)
  console.log(`${'-'.repeat(78)}`)
  console.log(
    '\nThe recognition+compliment bar and every (d) are HAND-READ before',
  )
  console.log('anything ships. A rate cannot tell warmth from a formula, nor a')
  console.log('grounded bean story from a pitch.\n')
}

void main()
