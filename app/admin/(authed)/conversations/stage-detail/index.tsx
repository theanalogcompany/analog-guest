'use client'

import type { TraceStage } from '../lib/select-trace-stages'
import { ClassifyDetail } from './classify'
import { ContextBuildDetail } from './context-build'
import { GenerateDetail } from './generate'
import { DetailBlock, HairlineDivider } from './_primitives'
import { RetrieveDetail } from './retrieve'
import { SendDetail } from './send'
import { UnknownStageDetail } from './unknown'

// Per-stage drill-down dispatcher. Switches on stage.name (underscore form,
// matching the agent-side identifier; UI shows dot notation per the PR-2
// display-rename). Falls through to UnknownStageDetail for any unrecognized
// stage so future stage names don't render blank.
//
// Wraps every stage's body in the shared DetailBlock chrome (clay left rule
// + white wash) and appends the trace-level "Open in Langfuse Cloud" link.

interface StageDetailProps {
  stage: TraceStage
  /**
   * Full URL to the trace in Langfuse Cloud. Same URL for every stage in a
   * given trace (Langfuse traces are at the parent level, not per-stage).
   * Pre-computed in TracePanel.
   */
  langfuseUrl: string | null
}

export function StageDetail({ stage, langfuseUrl }: StageDetailProps) {
  return (
    <DetailBlock>
      {selectStageBody(stage)}
      {langfuseUrl ? (
        <>
          <HairlineDivider />
          <a
            href={langfuseUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-ink-soft hover:text-clay underline self-start"
          >
            Open in Langfuse Cloud ↗
          </a>
        </>
      ) : null}
    </DetailBlock>
  )
}

function selectStageBody(stage: TraceStage): React.ReactNode {
  switch (stage.name) {
    case 'context_build':
      return <ContextBuildDetail stage={stage} />
    case 'classify':
      return <ClassifyDetail stage={stage} />
    case 'retrieve':
      return <RetrieveDetail stage={stage} />
    case 'generate':
      return <GenerateDetail stage={stage} />
    case 'send':
      return <SendDetail stage={stage} />
    default:
      return <UnknownStageDetail stage={stage} />
  }
}
