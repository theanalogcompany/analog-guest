'use client'

import { useState } from 'react'
import type { BrandPersona } from '@/lib/schemas'
import { RailCorpus } from './rail-corpus'
import { RailPersona } from './rail-persona'
import { RailRules } from './rail-rules'
import type { VoicePageCorpusRow } from '../_lib/load-voice-page'

// Right-rail tab strip + tab routing. Three panes — Rules, Corpus,
// Persona — all editable. Active-tab clay underline matches the mockup.

interface RailProps {
  venueId: string
  persona: BrandPersona
  corpus: VoicePageCorpusRow[]
  counts: { corpus: number; rules: number }
  onMutate: () => void
}

type TabKey = 'rules' | 'corpus' | 'persona'

export function Rail({ venueId, persona, corpus, counts, onMutate }: RailProps) {
  const [tab, setTab] = useState<TabKey>('rules')

  return (
    <div className="flex flex-col min-h-0 bg-paper">
      <div className="flex border-b border-stone-light/60 shrink-0">
        <TabButton active={tab === 'rules'} onClick={() => setTab('rules')}>
          Rules <span className="text-ink-faint font-normal">· {counts.rules}</span>
        </TabButton>
        <TabButton active={tab === 'corpus'} onClick={() => setTab('corpus')}>
          Corpus <span className="text-ink-faint font-normal">· {counts.corpus}</span>
        </TabButton>
        <TabButton active={tab === 'persona'} onClick={() => setTab('persona')}>
          Persona
        </TabButton>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5">
        {tab === 'rules' && (
          <RailRules
            venueId={venueId}
            persona={persona}
            onMutate={onMutate}
          />
        )}
        {tab === 'corpus' && (
          <RailCorpus
            venueId={venueId}
            corpus={corpus}
            onMutate={onMutate}
          />
        )}
        {tab === 'persona' && (
          <RailPersona
            venueId={venueId}
            persona={persona}
            onMutate={onMutate}
          />
        )}
      </div>
    </div>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 py-3 text-[10.5px] uppercase font-semibold tracking-eyebrow text-center transition-colors border-b-2 ${
        active
          ? 'text-ink border-clay'
          : 'text-ink-faint border-transparent hover:text-ink-soft'
      }`}
    >
      {children}
    </button>
  )
}
