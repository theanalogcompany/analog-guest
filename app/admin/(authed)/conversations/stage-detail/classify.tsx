'use client'

import type { TraceStage } from '../lib/select-trace-stages'
import {
  KvList,
  KvRow,
  LongText,
  SubSection,
  readContent,
  readNumber,
  readRecord,
  readString,
} from './_primitives'

// classify drill-down. Top-level KVs cover the agent-facing decision
// (category, confidence). CAPTURED CONTENT carries the model's reasoning
// (free text, possibly a paragraph) and the inbound body it was reasoning
// about. INPUT carries the inbound body again at input boundary.

export function ClassifyDetail({ stage }: { stage: TraceStage }) {
  const output = readRecord(stage.observation.output)
  const category = readString(output?.category)
  const classifierConfidence = readNumber(output?.classifierConfidence)

  const content = readContent(stage.observation.output)
  const reasoning = readString(content?.reasoning)

  // Input mirrors the wrapper's input/output split: input = {inboundLength, content: {inboundBody}}.
  const input = readRecord(stage.observation.input)
  const inputContent = readRecord(input?.content)
  const inboundBody = readString(inputContent?.inboundBody)
  const inboundLength = readNumber(input?.inboundLength)

  const hasCaptured = reasoning !== null
  const hasInput = inboundBody !== null || inboundLength !== null

  return (
    <div className="flex flex-col gap-2.5">
      <KvList>
        {category !== null ? <KvRow label="category" value={category} /> : null}
        {classifierConfidence !== null ? (
          <KvRow label="classifierConfidence" value={classifierConfidence.toFixed(2)} />
        ) : null}
      </KvList>

      {hasCaptured ? (
        <SubSection title="Captured content" defaultOpen>
          {reasoning !== null ? (
            <KvList>
              <KvRow label="reasoning" value={<LongText text={reasoning} />} />
            </KvList>
          ) : null}
        </SubSection>
      ) : null}

      {hasInput ? (
        <SubSection title="Input" defaultOpen={false}>
          <KvList>
            {inboundLength !== null ? (
              <KvRow label="inboundLength" value={inboundLength} />
            ) : null}
            {inboundBody !== null ? (
              <KvRow label="inboundBody" value={<LongText text={inboundBody} />} />
            ) : null}
          </KvList>
        </SubSection>
      ) : null}
    </div>
  )
}
