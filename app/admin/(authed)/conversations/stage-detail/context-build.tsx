'use client'

import type { TraceStage } from '../lib/select-trace-stages'
import { KvList, KvRow, readNumber, readRecord, readString } from './_primitives'

// context_build drill-down. Recognition signals are intentionally NOT here —
// PR-1 hoisted them to the top-of-panel RecognitionCard. Drill-down shows
// the metadata that informed the rest of the pipeline: which state Sonnet
// thought we were in, how many mechanics were eligible, how many recent
// messages got loaded into context.

export function ContextBuildDetail({ stage }: { stage: TraceStage }) {
  const output = readRecord(stage.observation.output)
  const recognitionState = readString(output?.recognitionState)
  const recognitionScore = readNumber(output?.recognitionScore)
  const mechanicCount = readNumber(output?.mechanicCount)
  const recentMessageCount = readNumber(output?.recentMessageCount)

  return (
    <KvList>
      {recognitionState !== null ? <KvRow label="recognitionState" value={recognitionState} /> : null}
      {recognitionScore !== null ? <KvRow label="recognitionScore" value={recognitionScore} /> : null}
      {mechanicCount !== null ? <KvRow label="mechanicCount" value={mechanicCount} /> : null}
      {recentMessageCount !== null ? (
        <KvRow label="recentMessageCount" value={recentMessageCount} />
      ) : null}
    </KvList>
  )
}
