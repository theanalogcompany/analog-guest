import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// TAC-495: the harness builds a synthetic inbound for every scenario, and its
// channel picks the prompt copy the scenario is graded on. Synthetic guests all
// have phone numbers, so every scenario is an SMS conversation and must get the
// SMS copy. Nothing runs runScenario under test (it needs Drive, the database
// and the model), so the channel is pinned at the source, where a change to
// null or 'instagram' would otherwise grade every scenario on the Instagram
// copy with no test failing.
describe('run-test-scenarios: the synthetic inbound is an SMS message (TAC-495)', () => {
  it("builds the scenario's current message with channel 'text'", () => {
    const src = readFileSync(join(__dirname, 'run-test-scenarios.ts'), 'utf8')
    const start = src.indexOf('providerMessageId: `synthetic-${scenario.sample_id}`,')
    expect(start).toBeGreaterThan(-1)
    const message = src.slice(start, src.indexOf('},', start))
    expect(message).toContain("channel: 'text',")
  })
})
