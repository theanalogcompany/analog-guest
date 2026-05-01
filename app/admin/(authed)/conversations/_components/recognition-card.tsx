import { Eyebrow, SignalBar, StatePill } from '@/lib/ui'
import type { RecognitionData } from '../lib/extract-recognition'

// Hero summary at the top of the trace panel: one row per recognition signal,
// each rendered as a SignalBar showing allocated weight (faint clay) vs.
// realized contribution (solid clay). Replaces the buried-in-context_build
// signals breakdown with a glanceable view.
//
// Header: "Recognition" eyebrow + state pill on the left; score "XX /100" on
// the right with the "/100" muted in ink-faint to keep the actual number
// visually dominant.
//
// Surface: parchment with rounded corners and a hairline border. Sits inside
// the trace panel above the pipeline / stage cards.

interface RecognitionCardProps {
  data: RecognitionData
}

export function RecognitionCard({ data }: RecognitionCardProps) {
  return (
    <section className="bg-parchment border border-stone-light/60 rounded-md p-3 flex flex-col gap-3">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Eyebrow>Recognition</Eyebrow>
          <StatePill state={data.state} />
        </div>
        <div className="text-sm tabular-nums">
          <span className="text-ink font-medium">{data.score}</span>
          <span className="text-ink-faint"> /100</span>
        </div>
      </header>

      <div className="flex flex-col gap-2">
        {data.signals.map((s) => (
          <SignalBar
            key={s.signal}
            name={s.signal}
            weight={s.weight}
            contribution={s.contribution}
          />
        ))}
      </div>
    </section>
  )
}
