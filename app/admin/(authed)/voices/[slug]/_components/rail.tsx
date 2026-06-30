'use client'

import { useState } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { BrandPersona } from '@/lib/schemas'
import { RailCorpus } from './rail-corpus'
import { RailPersona } from './rail-persona'
import { RailRules } from './rail-rules'
import type { VoicePageCorpusRow } from '../_lib/load-voice-page'

// Right-rail tab strip + tab routing. Three panes — Rules, Corpus,
// Persona — all editable. Built on shadcn Tabs (TAC-306) but styled as the
// full-width underline strip from the mockup: TabsList is a flush hairline
// row, TabsTrigger reproduces the clay-underline active state.

interface RailProps {
  venueId: string
  persona: BrandPersona
  corpus: VoicePageCorpusRow[]
  counts: { corpus: number; rules: number }
  onMutate: () => void
}

type TabKey = 'rules' | 'corpus' | 'persona'

// Reproduce the prior underline-strip trigger: full-width, flush, clay
// bottom-border on active, no pill background/shadow.
const TRIGGER_CLASS =
  'flex-1 rounded-none border-b-2 border-transparent bg-transparent px-0 py-3 text-[10.5px] uppercase font-semibold tracking-eyebrow text-ink-faint shadow-none transition-colors hover:text-ink-soft data-[state=active]:border-clay data-[state=active]:bg-transparent data-[state=active]:text-ink data-[state=active]:shadow-none'

export function Rail({ venueId, persona, corpus, counts, onMutate }: RailProps) {
  const [tab, setTab] = useState<TabKey>('rules')

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v as TabKey)}
      className="flex flex-col min-h-0 gap-0 bg-paper"
    >
      <TabsList className="h-auto w-full justify-stretch rounded-none border-b border-stone-light/60 bg-transparent p-0 shrink-0">
        <TabsTrigger value="rules" className={TRIGGER_CLASS}>
          Rules <span className="text-ink-faint font-normal">· {counts.rules}</span>
        </TabsTrigger>
        <TabsTrigger value="corpus" className={TRIGGER_CLASS}>
          Corpus <span className="text-ink-faint font-normal">· {counts.corpus}</span>
        </TabsTrigger>
        <TabsTrigger value="persona" className={TRIGGER_CLASS}>
          Persona
        </TabsTrigger>
      </TabsList>

      <TabsContent value="rules" className="flex-1 overflow-y-auto px-5 py-5 mt-0">
        <RailRules venueId={venueId} persona={persona} onMutate={onMutate} />
      </TabsContent>
      <TabsContent value="corpus" className="flex-1 overflow-y-auto px-5 py-5 mt-0">
        <RailCorpus venueId={venueId} corpus={corpus} onMutate={onMutate} />
      </TabsContent>
      <TabsContent value="persona" className="flex-1 overflow-y-auto px-5 py-5 mt-0">
        <RailPersona venueId={venueId} persona={persona} onMutate={onMutate} />
      </TabsContent>
    </Tabs>
  )
}
