import {
  type CommitmentEmission,
  isEmptyCommitmentEmission,
} from '@/lib/schemas/guest-commitment'
import { extractUrls } from './url-detector'

/**
 * Is this drafted reply doing a job for the guest?
 *
 * Ruled 2026-10-07: a getting-to-know-you question never rides on a reply that
 * sends a link or makes a recommendation. A link in the answer, or an emitted
 * commitment (a recommendation, a hold, a comp), is how a draft shows that,
 * and both are read off the generation with no further model call.
 * generateMessage drops the question on such a reply; the rule and its other
 * half (the turn's category) are in lib/agent/intentions/pacing.ts.
 *
 * Its own file so the no-model harness can drive it without importing the
 * generation module.
 *
 * NOT COVERED: a reply that gives instructions in plain prose with no link.
 * Nothing in a draft marks that, so it rests on the category alone. A bare
 * domain with no path is not a link to extractUrls either.
 */
export function isTaskDraft(
  answer: string,
  commitment: CommitmentEmission,
): boolean {
  return (
    extractUrls(answer).length > 0 || !isEmptyCommitmentEmission(commitment)
  )
}
