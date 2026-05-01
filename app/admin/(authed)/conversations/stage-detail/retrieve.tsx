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

// retrieve drill-down. Top-level: how many chunks came back and how good
// the best match was. CAPTURED CONTENT lists the actual chunks with their
// similarity scores and text — this is where operator goes when "the agent
// said X but I expected Y" and they want to see what voice corpus drove it.
// INPUT carries the query that was embedded.

interface CorpusChunk {
  id: string
  voiceCorpusId: string
  text: string
  sourceType: string
  confidence: number
  similarity: number
}

export function RetrieveDetail({ stage }: { stage: TraceStage }) {
  const output = readRecord(stage.observation.output)
  const matchCount = readNumber(output?.matchCount)
  const topSimilarity = readNumber(output?.topSimilarity)

  const content = readContent(stage.observation.output)
  const chunks = parseChunks(content?.chunks)

  const input = readRecord(stage.observation.input)
  const inputContent = readRecord(input?.content)
  const query = readString(inputContent?.query)
  const queryLength = readNumber(input?.queryLength)

  const hasCaptured = chunks.length > 0
  const hasInput = query !== null || queryLength !== null

  return (
    <div className="flex flex-col gap-2.5">
      <KvList>
        {matchCount !== null ? <KvRow label="matchCount" value={matchCount} /> : null}
        {topSimilarity !== null ? (
          <KvRow label="topSimilarity" value={topSimilarity.toFixed(3)} />
        ) : null}
      </KvList>

      {hasCaptured ? (
        <SubSection title={`Captured content · ${chunks.length} chunk${chunks.length === 1 ? '' : 's'}`} defaultOpen>
          <div className="flex flex-col gap-2">
            {chunks.map((chunk) => (
              <ChunkRow key={chunk.id} chunk={chunk} />
            ))}
          </div>
        </SubSection>
      ) : null}

      {hasInput ? (
        <SubSection title="Input" defaultOpen={false}>
          <KvList>
            {queryLength !== null ? <KvRow label="queryLength" value={queryLength} /> : null}
            {query !== null ? <KvRow label="query" value={<LongText text={query} />} /> : null}
          </KvList>
        </SubSection>
      ) : null}
    </div>
  )
}

function ChunkRow({ chunk }: { chunk: CorpusChunk }) {
  return (
    <div className="border border-stone-light/60 rounded p-2 bg-paper/40 flex flex-col gap-1.5 text-sm">
      <div className="flex items-baseline justify-between gap-2 text-xs text-ink-faint">
        <span className="tabular-nums">sim {chunk.similarity.toFixed(3)}</span>
        <span className="truncate" title={`${chunk.sourceType} · ${chunk.voiceCorpusId}`}>
          {chunk.sourceType}
        </span>
      </div>
      <span className="text-ink whitespace-pre-wrap break-words">{chunk.text}</span>
    </div>
  )
}

function parseChunks(value: unknown): CorpusChunk[] {
  if (!Array.isArray(value)) return []
  const out: CorpusChunk[] = []
  for (const item of value) {
    const r = readRecord(item)
    if (!r) continue
    const id = readString(r.id)
    const voiceCorpusId = readString(r.voiceCorpusId)
    const text = readString(r.text)
    const sourceType = readString(r.sourceType)
    const confidence = readNumber(r.confidence)
    const similarity = readNumber(r.similarity)
    if (id === null || text === null || similarity === null) continue
    out.push({
      id,
      voiceCorpusId: voiceCorpusId ?? '',
      text,
      sourceType: sourceType ?? '',
      confidence: confidence ?? 0,
      similarity,
    })
  }
  return out
}
