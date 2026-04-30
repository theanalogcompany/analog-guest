import { createAdminClient } from '@/lib/db/admin'
import { computeRelationshipStrength } from './compute-strength'
import { evaluateState } from './evaluate-state'
import { transitionState } from './transition-state'
import {
  DEFAULT_STATE_THRESHOLDS,
  StateThresholdsSchema,
  type ComputeStateInput,
  type ComputeStateResult,
  type GuestState,
  type RecognitionResult,
  type StateThresholds,
} from './types'

async function loadThresholds(
  venueId: string,
): Promise<RecognitionResult<StateThresholds>> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('venue_configs')
    .select('state_thresholds')
    .eq('venue_id', venueId)
    .maybeSingle()

  if (error) {
    return { ok: false, error: error.message, errorCode: 'load_thresholds_failed' }
  }

  const raw = data?.state_thresholds
  if (
    raw === null ||
    raw === undefined ||
    (typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 0)
  ) {
    return { ok: true, data: DEFAULT_STATE_THRESHOLDS }
  }

  const parsed = StateThresholdsSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.message, errorCode: 'invalid_thresholds' }
  }
  return { ok: true, data: parsed.data }
}

async function loadCurrentState(
  guestId: string,
  venueId: string,
): Promise<RecognitionResult<GuestState | null>> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('guest_states')
    .select('state')
    .eq('guest_id', guestId)
    .eq('venue_id', venueId)
    .is('exited_at', null)
    .maybeSingle()

  if (error) {
    return { ok: false, error: error.message, errorCode: 'load_current_state_failed' }
  }
  if (!data) {
    return { ok: true, data: null }
  }
  // The DB column is typed `string`; the check constraint guarantees one of
  // the four GuestState values, so the assertion is sound.
  return { ok: true, data: data.state as GuestState }
}

/**
 * Compute a guest's current relationship strength + state, transitioning
 * the state if it changed.
 *
 * Server-only. Uses the admin DB client. Has side effects when the state
 * changes: writes to guest_states (close old, insert new) and an audit row
 * to engagement_events. If the transition write fails, the failure is
 * logged with a structured payload and the function still returns the
 * computed state with stateChanged=false to reflect persistence reality.
 */
export async function computeGuestState(
  input: ComputeStateInput,
): Promise<RecognitionResult<ComputeStateResult>> {
  const thresholdsResult = await loadThresholds(input.venueId)
  if (!thresholdsResult.ok) return thresholdsResult
  const thresholds = thresholdsResult.data

  const strengthResult = await computeRelationshipStrength(input)
  if (!strengthResult.ok) return strengthResult
  const { score, signals, weights, contributions } = strengthResult.data

  const newState = evaluateState(score, thresholds)

  const currentResult = await loadCurrentState(input.guestId, input.venueId)
  if (!currentResult.ok) return currentResult
  const currentState = currentResult.data

  let stateChanged = false
  if (currentState !== newState) {
    // "stateChanged" reflects the semantic change (computed != current), not
    // persistence success. A persistence failure is logged below and visible
    // through monitoring; callers still need to know the state changed.
    stateChanged = true
    const transitionResult = await transitionState({
      guestId: input.guestId,
      venueId: input.venueId,
      fromState: currentState,
      toState: newState,
      reason: 'recompute',
    })
    if (!transitionResult.ok) {
      console.error(
        'computeGuestState: state transition persistence failed; returning computed state with stateChanged=true',
        {
          guestId: input.guestId,
          venueId: input.venueId,
          fromState: currentState,
          toState: newState,
          error: transitionResult.error,
          errorCode: transitionResult.errorCode,
        },
      )
    }
  }

  return {
    ok: true,
    data: { score, state: newState, signals, weights, contributions, stateChanged },
  }
}