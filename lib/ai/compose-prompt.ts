import { categoryInstructionsFor } from './prompts/categories'
import {
  knowledgeChunksToProse,
  personaToProse,
  ragChunksToProse,
  runtimeToProse,
  venueInfoToProse,
} from './prompts/serializers'
import { systemTemplateFor } from './prompts/system-template'
import type { GenerateMessageInput } from './types'

/**
 * How many leading `sections` entries are venue-stable and therefore cacheable.
 *
 * Covers the system template, the persona and the venue info — the three
 * blocks whose bytes are a function of (venue, channel) and nothing else.
 * Everything after it (RAG chunks, knowledge chunks, category instructions)
 * varies per message, so it must stay OUTSIDE the cached prefix: Anthropic
 * caching is a prefix match, and a per-message byte inside the breakpoint
 * would write a fresh entry on every call and read none.
 */
const CACHEABLE_SECTION_COUNT = 3

/**
 * Compose the system + user prompts for a generation call.
 *
 * Pure function. The system prompt holds venue-stable content (template,
 * persona, venue info, RAG chunks, category instructions); the user prompt
 * holds per-call runtime context. This split is what enables Anthropic prompt
 * caching of the system prefix — runtime data is never interleaved into
 * the system prompt.
 *
 * `systemPrompt` stays the full joined string and is what the trace records.
 * `cacheableSystemPrefix` + `volatileSystemSuffix` are the SAME bytes, split
 * at the stability boundary so the caller can put a cache breakpoint between
 * them:
 *
 *   systemPrompt === `${cacheableSystemPrefix}\n\n${volatileSystemSuffix}`
 *
 * That identity is asserted in compose-prompt.test.ts. Callers that only need
 * the text keep destructuring `systemPrompt` and are unaffected.
 */
export function composePrompt(input: GenerateMessageInput): {
  systemPrompt: string
  cacheableSystemPrefix: string
  volatileSystemSuffix: string
  userPrompt: string
} {
  const { category, persona, venueInfo, ragChunks, knowledgeChunks, runtime } = input

  // TAC-495: the channel picks the channel copy in both prompts. The system
  // template's variant for 'text' is SYSTEM_TEMPLATE itself, unedited.
  //
  // The first CACHEABLE_SECTION_COUNT entries are the cacheable prefix. Adding
  // a venue-stable section means inserting it INSIDE that window and bumping
  // the count; adding a per-message section means appending it after.
  const sections: string[] = [
    systemTemplateFor(input.channel),
    personaToProse(persona, input.channel),
    venueInfoToProse(venueInfo),
  ]

  const ragBlock = ragChunksToProse(ragChunks)
  if (ragBlock.length > 0) sections.push(ragBlock)

  // Knowledge block sits beside voice examples — voice is style, knowledge is
  // content. undefined means retrieval was gated off entirely (e.g. day_*
  // cron) — block omitted. Empty array means retrieval ran but matched
  // nothing — render the explicit no-match block (TAC-242) so R9 fires
  // reliably instead of relying on the agent to detect absence of context.
  if (knowledgeChunks !== undefined) {
    sections.push(knowledgeChunksToProse(knowledgeChunks))
  }

  // TAC-536: the scan-arrival fact picks between the two greeting
  // instructions. Threaded from the runtime rather than folded into the
  // category, because ONE category is what the storage layer, the
  // approval-policy UI and the operator queue all want.
  sections.push(
    `## Category-specific instructions: ${category}\n${categoryInstructionsFor(category, input.channel, runtime.scanArrival ?? null)}`,
  )

  return {
    systemPrompt: sections.join('\n\n'),
    cacheableSystemPrefix: sections.slice(0, CACHEABLE_SECTION_COUNT).join('\n\n'),
    volatileSystemSuffix: sections.slice(CACHEABLE_SECTION_COUNT).join('\n\n'),
    userPrompt: runtimeToProse(runtime, category, undefined, input.channel),
  }
}
