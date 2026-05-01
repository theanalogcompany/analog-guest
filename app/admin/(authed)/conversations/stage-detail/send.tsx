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

// send drill-down. Top-level: outbound message ID, provider message ID
// (Sendblue's), body length. CAPTURED CONTENT shows the body text Sonnet
// actually produced. INPUT carries any structured input the wrapper
// captured — usually empty for send since the human-feel timing happens
// after generate.

export function SendDetail({ stage }: { stage: TraceStage }) {
  const output = readRecord(stage.observation.output)
  const outboundMessageId = readString(output?.outboundMessageId)
  const providerMessageId = readString(output?.providerMessageId)
  const bodyLength = readNumber(output?.bodyLength)

  const content = readContent(stage.observation.output)
  const body = readString(content?.body)

  const input = stage.observation.input
  const hasInput = input !== undefined && input !== null

  return (
    <div className="flex flex-col gap-2.5">
      <KvList>
        {outboundMessageId !== null ? (
          <KvRow label="outboundMessageId" value={outboundMessageId} truncate />
        ) : null}
        {providerMessageId !== null ? (
          <KvRow label="providerMessageId" value={providerMessageId} truncate />
        ) : null}
        {bodyLength !== null ? <KvRow label="bodyLength" value={bodyLength} /> : null}
      </KvList>

      {body !== null ? (
        <SubSection title="Captured content" defaultOpen>
          <KvList>
            <KvRow label="body" value={<LongText text={body} />} />
          </KvList>
        </SubSection>
      ) : null}

      {hasInput ? (
        <SubSection title="Input" defaultOpen={false}>
          <pre className="font-mono text-xs whitespace-pre-wrap break-words bg-paper/70 border border-stone-light/60 rounded p-2 max-h-60 overflow-y-auto">
            {JSON.stringify(input, null, 2)}
          </pre>
        </SubSection>
      ) : null}
    </div>
  )
}
