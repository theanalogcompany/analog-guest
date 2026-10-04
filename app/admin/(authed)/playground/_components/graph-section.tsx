'use client'

import type { TurnTrace } from '@/lib/relationship/run-turn'
import { KeyValue } from './inspector-section'

// The graph visual: the state chain as a vertical rail of nodes, the edge
// into each node labelled with its hard requirements, and each state's moves
// attached as chips. Everything renders relative to THIS guest's turn:
// - the current state is filled and ringed;
// - frontier states (hard predicates hold) are solid; the rest are dimmed -
//   the guest cannot be there yet;
// - assessor-gated states say so: hard facts alone never enter them;
// - a closed move (its profile field is filled) renders struck through.
//
// The seed graph is a linear rank chain, so a rail IS the graph today. If a
// venue graph ever branches, rank order still gives a readable spine; a true
// layout engine is not worth its weight at six nodes.

export function GraphSection({
  graph,
  currentKey,
  facts,
}: {
  graph: TurnTrace['graph']
  currentKey: string
  facts: TurnTrace['facts']
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <KeyValue label="source">{graph.source}</KeyValue>
        <KeyValue label="version">{graph.version ?? 'default (code)'}</KeyValue>
        {graph.error !== undefined && (
          <p className="text-xs text-destructive">
            graph read failed: {graph.error} (ran on the default)
          </p>
        )}
        {graph.fellBack && (
          <p className="text-xs text-destructive">
            The stored graph was malformed; the run used the default.
          </p>
        )}
        <KeyValue label="facts">
          visits {facts.visitCount} · replies {facts.replyCount} · days since
          contact {facts.daysSinceLastContact ?? 'never'}
        </KeyValue>
      </div>

      <div className="flex flex-col">
        {graph.states.map((state, i) => {
          const isCurrent = state.key === currentKey
          const moves = graph.moves.filter((m) => m.homeState === state.key)
          return (
            <div key={state.key} className="flex flex-col">
              {i > 0 && <EdgeConnector requires={state.requires} />}
              <StateNode state={state} isCurrent={isCurrent} moves={moves} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** The edge INTO the node below it: a vertical line plus the hard requirements. */
function EdgeConnector({ requires }: { requires: string[] }) {
  return (
    <div className="flex items-center gap-2 py-0.5 pl-[5px]">
      <span className="h-6 w-px shrink-0 bg-stone-light" aria-hidden />
      <span className="text-[11px] text-ink-faint">
        {requires.length > 0 ? requires.join(' · ') : 'no hard requirement'}
      </span>
    </div>
  )
}

function StateNode({
  state,
  isCurrent,
  moves,
}: {
  state: TurnTrace['graph']['states'][number]
  isCurrent: boolean
  moves: TurnTrace['graph']['moves']
}) {
  const reachable = state.inFrontier
  return (
    <div
      className={`flex flex-col gap-1 ${reachable ? '' : 'opacity-45'}`}
      title={state.mission}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={`h-[11px] w-[11px] shrink-0 rounded-full border ${
            isCurrent
              ? 'border-clay-deep bg-clay-deep ring-2 ring-clay-soft'
              : reachable
                ? 'border-ink bg-paper'
                : 'border-stone-light bg-paper'
          }`}
        />
        <span className="text-xs font-medium text-ink">{state.label}</span>
        <span className="text-[11px] text-ink-faint">
          {state.key} · rank {state.rank}
        </span>
        {isCurrent && (
          <span className="rounded-[2px] bg-clay-soft/50 px-1.5 py-0.5 text-[11px] font-medium text-clay-deep">
            current
          </span>
        )}
        {state.assessorGated && (
          <span className="text-[11px] text-ink-faint">assessor-gated</span>
        )}
      </div>
      <p className="pl-[19px] text-[11px] text-ink-faint">{state.objective}</p>
      {moves.length > 0 && (
        <div className="flex flex-wrap gap-1 pl-[19px]">
          {moves.map((m) => (
            <span
              key={m.key}
              title={`${m.goal}${m.closedWhen.length > 0 ? ` (closes when ${m.closedWhen.join(', ')} is known)` : ''}`}
              className={`inline-flex items-center rounded-[2px] border px-1.5 py-0.5 text-[11px] ${
                m.closed
                  ? 'border-stone-light/60 text-ink-faint line-through'
                  : 'border-stone-light text-ink'
              }`}
            >
              {m.key}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
