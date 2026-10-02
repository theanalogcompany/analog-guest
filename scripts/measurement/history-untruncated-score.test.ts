import { describe, expect, it } from 'vitest'
import {
  claimsPriorCutOff,
  evaluateRun,
  scoreReply,
  startsMidList,
  summarizeArm,
  type ArmSummary,
} from './history-untruncated-score'

// Verbatim from the production turn this harness replays.
const PRODUCTION_BODY =
  "5. mix 1/2 cup of the decoction with 1/2 cup of hot full-fat milk. 6. sweeten with sugar or jaggery to taste. that's it! ratio-wise, you can adjust the decoction-to-milk split to taste, more decoction if you want it stronger, more milk if you want it milder."
const PRODUCTION_REASONING =
  'Guest wants the full recipe spelled out step by step; continuing the numbered list from where the previous message cut off and adding the milk/sweetener steps. No new commitment or arrival signal.'

describe('startsMidList', () => {
  it('flags the production fragment', () => {
    expect(startsMidList(PRODUCTION_BODY)).toBe(true)
  })

  it('does not flag a list that starts at 1', () => {
    expect(
      startsMidList('1. put the grounds in. 2. pour the water. 3. wait.'),
    ).toBe(false)
  })

  it('does not flag prose, or a lone number in a sentence', () => {
    expect(startsMidList('7am to 3pm, both days.')).toBe(false)
    expect(startsMidList('we open at 10. weekends get busy.')).toBe(false)
  })
})

describe('claimsPriorCutOff', () => {
  it("flags the model's own words from the production turn", () => {
    expect(claimsPriorCutOff(PRODUCTION_REASONING)).toBe(true)
  })

  it('does not flag an ordinary reasoning note', () => {
    expect(
      claimsPriorCutOff(
        'Guest asked for more detail on the recipe; expanding each step with timings.',
      ),
    ).toBe(false)
  })
})

describe('evaluateRun', () => {
  const arm = (over: Partial<ArmSummary> = {}): ArmSummary => ({
    n: 8,
    failures: 0,
    fragment: 0,
    cutOffBelief: 0,
    defective: 0,
    ...over,
  })
  const base = {
    controlHistoryCut: true,
    treatmentHistoryFull: true,
  }

  it('passes only when the control reproduces and the treatment is clean', () => {
    expect(
      evaluateRun({
        ...base,
        control: arm({ defective: 4 }),
        treatment: arm(),
      }),
    ).toEqual({ kind: 'pass' })
  })

  it('fails when the treatment still shows the defect', () => {
    expect(
      evaluateRun({
        ...base,
        control: arm({ defective: 4 }),
        treatment: arm({ defective: 1 }),
      }).kind,
    ).toBe('fail')
  })

  it('voids a run whose control did not reproduce, however clean the treatment', () => {
    expect(
      evaluateRun({
        ...base,
        control: arm({ defective: 1 }),
        treatment: arm(),
      }).kind,
    ).toBe('void')
  })

  it('voids a run with a failed generation rather than counting it clean', () => {
    expect(
      evaluateRun({
        ...base,
        control: arm({ defective: 4 }),
        treatment: arm({ failures: 1 }),
      }).kind,
    ).toBe('void')
  })

  it('voids when the arms did not actually differ in history', () => {
    expect(
      evaluateRun({
        control: arm({ defective: 4 }),
        treatment: arm(),
        controlHistoryCut: false,
        treatmentHistoryFull: true,
      }).kind,
    ).toBe('void')
  })
})

describe('summarizeArm', () => {
  it('counts a reply once however many detectors fire, and excludes failures', () => {
    const both = scoreReply({
      body: PRODUCTION_BODY,
      reasoning: PRODUCTION_REASONING,
    })
    const clean = scoreReply({ body: 'sure, here is more.', reasoning: 'ok' })
    expect(
      summarizeArm([
        { failed: false, verdict: both },
        { failed: false, verdict: clean },
        { failed: true, verdict: null },
      ]),
    ).toEqual({
      n: 3,
      failures: 1,
      fragment: 1,
      cutOffBelief: 1,
      defective: 1,
    })
  })
})
