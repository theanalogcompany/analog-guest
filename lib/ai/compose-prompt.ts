import { getCategoryInstructions } from './prompts/categories'
import {
  knowledgeChunksToProse,
  personaToProse,
  ragChunksToProse,
  runtimeToProse,
  venueInfoToProse,
} from './prompts/serializers'
import { SYSTEM_TEMPLATE } from './prompts/system-template'
import type { GenerateMessageInput } from './types'

/**
 * Compose the system + user prompts for a generation call.
 *
 * Pure function. The system prompt holds venue-stable content (template,
 * persona, venue info, RAG chunks, category instructions); the user prompt
 * holds per-call runtime context. This split is what enables Anthropic prompt
 * caching of the system prefix later — runtime data is never interleaved into
 * the system prompt.
 */
export function composePrompt(input: GenerateMessageInput): {
  systemPrompt: string
  userPrompt: string
} {
  const { category, persona, venueInfo, ragChunks, knowledgeChunks, runtime } = input

  const sections: string[] = [
    SYSTEM_TEMPLATE,
    personaToProse(persona),
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

  sections.push(`## Category-specific instructions: ${category}\n${getCategoryInstructions(category)}`)

  return {
    systemPrompt: sections.join('\n\n'),
    userPrompt: runtimeToProse(runtime, category),
  }
}
