import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { GeneratedMessageSchema } from './generate-message'

// TAC-300 CI guardrail.
//
// Anthropic's structured-output validator caps tool schemas at 24 optional
// parameters across the entire schema tree (the validator's reported message:
// "Schemas contains too many optional parameters (N), which would make
// grammar compilation inefficient. Reduce the number of optional parameters
// in your tool schemas (limit: 24).").
//
// This test walks GeneratedMessageSchema's JSON Schema representation
// counting fields that appear in `properties` but NOT in `required`. It
// fails CI if the count breaches OPTIONAL_FIELD_BUDGET. The budget is set
// below the 24 cap so a single near-term schema addition can land without
// a coordinated reshape — but a multi-field expansion will fail CI and
// force a budget conversation BEFORE production rejects the request.
//
// The counter is OUR reconstruction of Anthropic's counting rule. It matched
// the validator's reported 31 exactly on the pre-fix schema (confirming the
// algorithm against the SEV-1 input), and lands at 20 on the post-fix shape
// — under both the 24 cap and the 22 budget with 2 slots of headroom.
//
// IMPORTANT — the real proof of correctness is the prod smoke test on the
// shipped change (TAC-300 acceptance criterion #5: send a real inbound,
// confirm a draft generates). This guardrail is the recurrence backstop, not
// the proof. If Anthropic changes the counting rule, the unit test could
// pass while prod still rejects — diagnose by reading the validator's error
// message against the current schema rather than trusting this count alone.

const OPTIONAL_FIELD_BUDGET = 22

type JsonSchemaNode = {
  type?: string | string[]
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  items?: JsonSchemaNode | JsonSchemaNode[]
  anyOf?: JsonSchemaNode[]
  oneOf?: JsonSchemaNode[]
  allOf?: JsonSchemaNode[]
}

function countOptionalsInJsonSchema(node: JsonSchemaNode): number {
  let count = 0

  if (node.properties) {
    const required = new Set(node.required ?? [])
    for (const [name, child] of Object.entries(node.properties)) {
      if (!required.has(name)) count += 1
      count += countOptionalsInJsonSchema(child)
    }
  }

  if (node.items) {
    const items = Array.isArray(node.items) ? node.items : [node.items]
    for (const item of items) count += countOptionalsInJsonSchema(item)
  }

  // Union-shaped (oneOf / anyOf): Anthropic's validator inspects every branch;
  // worst-case branch is what trips the limit. Take the max across branches.
  const unionBranches = node.anyOf ?? node.oneOf
  if (unionBranches && unionBranches.length > 0) {
    count += Math.max(...unionBranches.map(countOptionalsInJsonSchema))
  }

  // Intersection-shaped: sum across composed branches.
  if (node.allOf) {
    for (const branch of node.allOf) count += countOptionalsInJsonSchema(branch)
  }

  return count
}

describe('GeneratedMessageSchema optional-field budget (TAC-300)', () => {
  it(`stays at or below ${OPTIONAL_FIELD_BUDGET} optional fields (Anthropic cap is 24)`, () => {
    const jsonSchema = z.toJSONSchema(GeneratedMessageSchema) as JsonSchemaNode
    const count = countOptionalsInJsonSchema(jsonSchema)
    expect(count).toBeLessThanOrEqual(OPTIONAL_FIELD_BUDGET)
  })
})
