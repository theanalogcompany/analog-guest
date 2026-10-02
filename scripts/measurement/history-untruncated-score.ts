// Pure scoring for history-untruncated-replay.ts. No `@/*` imports.
//
// THE DEFECT BEING MEASURED. The `## Recent conversation` block cut every body
// at 200 characters with a trailing "…". A 332-character recipe was shown to the
// model ending "(longer …"; the guest then said "Make it detailed" and the model
// wrote "continuing the numbered list from where the previous message cut off",
// replying with "5. ... 6. ..." - steps the guest had already received.
//
// TWO DETECTORS, each aimed at one half of that failure:
//
//   fragment        the reply is a numbered list that does NOT start at 1. The
//                   observed body began "5. mix 1/2 cup ...". Needs two numbered
//                   items so a lone "10. " in a sentence cannot trip it.
//   cutOffBelief    the model's own `reasoning` says the previous message was cut
//                   off or that it is continuing / picking up where it left off.
//                   This is the CAUSE stated in the model's words, so it can fire
//                   when the body does not look like a fragment, and it is the
//                   detector that says the truncation is what misled it.
//
// READ THE BODIES before believing a rate (scripts/CLAUDE.md rule 7). Both are
// regexes; neither can say whether a reply actually added the detail asked for.

const NUMBERED_ITEM = /(?:^|\s)(\d{1,2})[.)]\s/g

export function startsMidList(body: string): boolean {
  const numbers = [...body.matchAll(NUMBERED_ITEM)].map((m) => Number(m[1]))
  return numbers.length >= 2 && numbers[0] >= 2
}

export function claimsPriorCutOff(reasoning: string): boolean {
  return /cut off|cut-off|left off|pick(?:ing)? up where|continu(?:e|es|ing) (?:the|from|where)/i.test(
    reasoning,
  )
}

export interface UnitVerdict {
  fragment: boolean
  cutOffBelief: boolean
}

export function scoreReply(reply: {
  body: string
  reasoning: string
}): UnitVerdict {
  return {
    fragment: startsMidList(reply.body),
    cutOffBelief: claimsPriorCutOff(reply.reasoning),
  }
}

export interface ScoredUnit {
  failed: boolean
  verdict: UnitVerdict | null
}

export interface ArmSummary {
  n: number
  failures: number
  fragment: number
  cutOffBelief: number
  // Either detector. A reply counts once however many detectors fire.
  defective: number
}

export function summarizeArm(units: readonly ScoredUnit[]): ArmSummary {
  const ok = units.filter((u) => !u.failed && u.verdict !== null)
  return {
    n: units.length,
    failures: units.length - ok.length,
    fragment: ok.filter((u) => u.verdict!.fragment).length,
    cutOffBelief: ok.filter((u) => u.verdict!.cutOffBelief).length,
    defective: ok.filter((u) => u.verdict!.fragment || u.verdict!.cutOffBelief)
      .length,
  }
}

// PRE-REGISTERED, before any run. The control arm re-creates the old 200-char
// serialization, so it has to REPRODUCE the defect or the run says nothing:
// a treatment that comes back clean is also what a broken control produces.
export const MIN_CONTROL_DEFECTS = 2

export type RunVerdict =
  | { kind: 'void'; reason: string }
  | { kind: 'fail'; reason: string }
  | { kind: 'pass' }

export function evaluateRun(input: {
  control: ArmSummary
  treatment: ArmSummary
  controlHistoryCut: boolean
  treatmentHistoryFull: boolean
}): RunVerdict {
  const { control, treatment } = input
  if (!input.controlHistoryCut) {
    return {
      kind: 'void',
      reason:
        'control arm history was not cut, so the arms cannot differ and the run says nothing',
    }
  }
  if (!input.treatmentHistoryFull) {
    return {
      kind: 'void',
      reason: 'treatment arm history does not carry the full earlier message',
    }
  }
  // A failed call yields no verdict, and counting it as clean would let a
  // broken run report a pass.
  if (control.failures > 0 || treatment.failures > 0) {
    return {
      kind: 'void',
      reason: `${control.failures + treatment.failures} generation(s) failed; a failed unit is not a clean one`,
    }
  }
  if (control.defective < MIN_CONTROL_DEFECTS) {
    return {
      kind: 'void',
      reason: `control reproduced the defect in ${control.defective}/${control.n} (needs at least ${MIN_CONTROL_DEFECTS}); the replay does not reproduce production`,
    }
  }
  if (treatment.defective > 0) {
    return {
      kind: 'fail',
      reason: `treatment still shows the defect in ${treatment.defective}/${treatment.n}`,
    }
  }
  return { kind: 'pass' }
}
