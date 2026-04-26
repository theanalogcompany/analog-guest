export { computeGuestState } from './compute-state'
export { computeRelationshipStrength } from './compute-strength'
export { evaluateState } from './evaluate-state'
export { transitionState } from './transition-state'

export {
  DEFAULT_FORMULA,
  DEFAULT_STATE_THRESHOLDS,
  ENGAGEMENT_EVENT_WEIGHTS,
  RelationshipStrengthFormulaSchema,
  StateThresholdsSchema,
} from './types'

export type {
  ComputeStateInput,
  ComputeStateResult,
  GuestState,
  RecognitionResult,
  RelationshipSignals,
  RelationshipStrengthFormula,
  StateThresholds,
} from './types'