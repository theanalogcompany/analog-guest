import { z } from 'zod'
import { JUDGE_MODEL_ID } from '@/lib/ai/client'
import { generateKimiObject } from '@/lib/ai/kimi-client'
import type { AIResult } from '@/lib/ai/types'

// The maitre d' judge: scores EVERY generated response - production (post-
// send, async), playground (inline), harness - on six axes, each with the
// explanation and evidence quotes declared BEFORE the score (the verifier
// declaration-order lesson). It observes and records; it never blocks or
// holds a message - that is the policy gate's job.
//
// The six axes decompose "was this a real maitre d'?" - ruled 2026-10-03,
// reshaped 2026-10-04 (pre-production, zero stored rows, so the axes
// contract could still move). Axis keys are the eval_judgments.axes JSONB
// contract; renaming one is a breaking change to every stored row and the
// Command Center reader.
//
// TRUST DISCIPLINE: scores mean nothing until the judge is calibrated
// against the frozen human-scored set (phase 4), which includes the v1
// failure transcripts. Pairwise comparison for variant decisions; these
// absolute scores are for monitoring and for the playground's inline read.

// v1.1.0: initiative axis added (owner-ruled 2026-10-04). Without it the
// rubric was asymmetric - tact and economy punish asking, nothing rewarded
// advancing the relationship, so eval-driven iteration would optimize toward
// pure restraint.
// v1.2.0 (owner-ruled 2026-10-04): tact + initiative merged into
// working_the_room - they scored one judgment (was this the moment for a
// question?) from opposite failure directions, contradicted each other's
// facts on a single reply (tact 4 "nothing premature" vs initiative 2 "the
// moment was not taken"), and the same greeting shape drew initiative 4/3/2
// across runs. Per-axis required `tested` added - a forced score on an
// untested axis wobbled 3-vs-4 for identical "no problem arose" reasoning,
// and 3-as-neutral reads as chronic mediocrity in any aggregate. Economy no
// longer judges whether a question belonged (working_the_room owns that);
// it keeps count and placement. Variance gate:
// scripts/measurement/judge-variance.ts.
// v1.2.1: recognition rubric gained "claims about the house, its people, or
// its drinks are not guest claims" - the variance gate caught a 7-1 tested
// split on a reply naming the OWNER's favorite drink (run of 19:04).
// v1.2.2: working_the_room anchored on the first exchange and economy told
// a standalone-emoji bubble is rhythm, after the owner-ruled v1 opener drew
// 2/3/5 bimodal (spread 3, run of 19:16) - the rubric had no stance on
// turn-1 forwardness, so the judge sampled both.
// v1.2.3: the first-exchange anchor REVERTED same day (owner-ruled): it
// encoded one venue's opening strategy into the global instrument - the
// variance was real ambiguity, and the fix belongs in axis decomposition,
// not in a taste rule. The economy rhythm clause stays (mechanics, not
// strategy). working_the_room's known bimodality on turn-1 shapes stands
// as an open defect until the axes are re-cut.
// v1.3.0 (owner-ruled 2026-10-06): the judge moves off the generation model
// onto Kimi (lib/ai/client.ts, getJudgeModel). No rubric text changed in this
// bump - the MODEL changed, and that is a bigger break than any wording edit,
// which is why it takes a minor rather than a patch. Until now generation and
// judgment were both claude-sonnet-4-6, so every score was a model grading its
// own output; today's n=6 run is the last one produced that way.
// SCORES ACROSS THIS BOUNDARY ARE NOT COMPARABLE. The version is part of the
// eval_judgments key for exactly this reason, and any --compare spanning it is
// reading two different instruments. The pre-Kimi baseline
// (template-regression 2026-10-06T23-17-45Z, judge-v1.2.3) stays the reference
// for Anthropic-judged runs and must not be diffed against a v1.3.0 run.
// scripts/measurement/judge-variance.ts is the required gate before these
// numbers are trusted, and the phase-4 calibration set is still pending, so
// the trust discipline below applies at least as strongly as before.
export const JUDGE_PROMPT_VERSION = 'judge-v1.3.0'
// Raised from 2000 with the Kimi swap, same reason as the assessor's budget:
// kimi-k3 spends output tokens on reasoning before the JSON. The judge is the
// more exposed of the two, because explanation and evidence are declared
// BEFORE each score - a truncation here loses exactly the numbers and keeps
// the prose.
export const JUDGE_MAX_OUTPUT_TOKENS = 4_000

export const JUDGE_AXES = [
  'recognition',
  'reading_the_guest',
  'economy',
  'quiet_authority',
  'working_the_room',
  'host_ownership',
] as const
export type JudgeAxis = (typeof JUDGE_AXES)[number]

const AXIS_RUBRIC: Record<JudgeAxis, string> = {
  recognition:
    'Uses memory of THIS guest naturally - name, preferences, history - when the notes carry it. Generic treatment of a known guest scores low. Any claim about the guest the notes do NOT confirm (invented visit, order, preference) is an automatic tested 1: false recognition is the cardinal sin. Untested ONLY when the notes are empty AND the reply claims nothing about the guest. Claims about the house, its people, or its drinks are not guest claims.',
  reading_the_guest:
    "Matches the guest's register, energy, and the stage of the relationship given in the notes. Over-familiarity early and stiffness late both fail. Mirrors brevity with brevity. Always tested.",
  economy:
    "Never wastes the guest's time. Short, no filler, no over-explaining, texts like a person. Bubble splits feel like natural texting rhythm - a standalone emoji or a quick burst of small bubbles IS that rhythm, not waste. A question buried mid-message instead of ending it, or two questions in one reply, fails here. Whether a question belonged at all is working_the_room's business, not this axis. Always tested.",
  quiet_authority:
    'Knows the house cold and leads with confidence: specific, opinionated recommendations, never hedging, never salesy, no menu-dump. Untested when the exchange called for no house knowledge.',
  working_the_room:
    'Reads the moment for advancing the relationship. The one right question at the right time scores 5 - and so does restraint when the moment was wrong (a complaint, a hurry, a prior deflection). Misreading either direction fails: a warm exchange with an open door that ends in no question, or nagging, interviewing, re-asking what the notes show was already asked and left unanswered. Graceful when the guest deflects. State in the explanation which direction the reply leaned. Always tested.',
  host_ownership:
    'Problems are handled personally and directly: a real apology, a concrete next step, no deflection to "the team", no policy-speak. Untested unless something went wrong for the guest.',
}

const AxisJudgmentSchema = z.object({
  explanation: z.string(),
  /** Verbatim quotes from the reply or notes grounding the score. */
  evidence: z.array(z.string()),
  /**
   * False ONLY when the turn gave the axis nothing to exercise (the rubric
   * says which axes may be untested, and on what). The score is then
   * ignored everywhere - an untested axis forced to a number wobbled 3-vs-4
   * for identical reasoning, and a stored 3 reads as mediocrity in any
   * aggregate. Required boolean: free against the 24-optional cap, and
   * declared before score so the applicability call precedes the number.
   */
  tested: z.boolean(),
  /**
   * 1-5. No .min/.max (LLM schema rule) - and no .int() either: Zod 4
   * renders .int() as `integer` plus safe-integer minimum/maximum bounds,
   * which Anthropic rejects identically (caught live, 2026-10-04). Rounded
   * and clamped after the call.
   */
  score: z.number(),
})

const JudgeOutputSchema = z.object({
  recognition: AxisJudgmentSchema,
  reading_the_guest: AxisJudgmentSchema,
  economy: AxisJudgmentSchema,
  quiet_authority: AxisJudgmentSchema,
  working_the_room: AxisJudgmentSchema,
  host_ownership: AxisJudgmentSchema,
})
export type JudgeOutput = z.infer<typeof JudgeOutputSchema>

export interface JudgeInput {
  /** The reply under judgment, as its bubbles. */
  replyMessages: string[]
  /** Recent conversation, oldest first, labelled GUEST:/VENUE:. */
  transcript: string
  /** The situation brief the generation saw - state, mission, profile, memory, moves. */
  situationBrief: string
  venueName: string
}

export interface JudgeResult {
  axes: JudgeOutput
  judgeVersion: string
}

export async function judgeResponse(
  input: JudgeInput,
): Promise<AIResult<JudgeResult>> {
  const rubric = JUDGE_AXES.map(
    (axis) => `## ${axis}\n${AXIS_RUBRIC[axis]}`,
  ).join('\n\n')

  const system =
    `You are judging one text-message reply sent by ${input.venueName} to a guest, ` +
    `against the standard of a great maitre d' - the venue's own memory, taste and hospitality in text form. ` +
    `Score each axis 1-5: 1 = a real maitre d' would never have sent this; 3 = adequate but unremarkable; 5 = exactly what the best host would do. ` +
    `Each axis carries \`tested\`: set it false ONLY when the turn gives that axis nothing to exercise, per its rubric, and say why in the explanation - the score is then ignored. ` +
    `Never use tested=false to dodge a hard call on an axis the rubric marks always tested. ` +
    `Quote evidence verbatim. Judge ONLY against what the house notes and conversation actually contain - ` +
    `the reply declining to use information the notes do not hold is correct behaviour, not a miss.\n\n${rubric}`

  const user =
    `# House notes the reply was written from\n${input.situationBrief}\n\n` +
    `# Conversation\n${input.transcript}\n\n` +
    `# The reply under judgment\n${input.replyMessages.map((m, i) => `(bubble ${i + 1}) ${m}`).join('\n')}`

  const result = await generateKimiObject({
    model: JUDGE_MODEL_ID,
    system,
    user,
    schema: JudgeOutputSchema,
    schemaName: 'judgment',
    maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
    // NO TEMPERATURE, and not by choice: kimi-k3 rejects anything but 1
    // ("invalid temperature: only 1 is allowed for this model"). The judge
    // ran at 0.2 on Anthropic for idempotency, so this swap raises judge
    // variance by construction - the one thing that cannot be tuned away
    // here. scripts/measurement/judge-variance.ts is the instrument that has
    // to quantify it before any v1.3.0 score is read as a signal, and a
    // per-axis spread that was acceptable at 0.2 may not be at 1.
  })
  if (!result.ok)
    return {
      ok: false,
      error: `judge failed: ${result.error}`,
      errorCode: result.errorCode ?? 'judge_failed',
    }

  const object = result.data
  const clamped = Object.fromEntries(
    JUDGE_AXES.map((axis) => {
      const a = object[axis]
      return [
        axis,
        { ...a, score: Math.min(5, Math.max(1, Math.round(a.score))) },
      ]
    }),
  ) as JudgeOutput

  return {
    ok: true,
    data: { axes: clamped, judgeVersion: JUDGE_PROMPT_VERSION },
  }
}
