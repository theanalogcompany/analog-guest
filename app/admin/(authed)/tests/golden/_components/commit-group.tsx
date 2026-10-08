import type { CommitGroup as CommitGroupData } from '../_lib/load-golden'
import { RunCard } from './run-card'

// Runs grouped under the commit they were made at. The header links out to
// GitHub and carries the stored commit subject, so the page reads without a
// round trip - and so a run stays attributable after the branch is gone.

const REPO_URL = 'https://github.com/theanalogcompany/analog-guest'

export function CommitGroup({ group }: { group: CommitGroupData }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {group.gitSha ? (
          <a
            href={`${REPO_URL}/commit/${group.gitSha}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-sm underline"
          >
            {group.gitSha.slice(0, 7)}
          </a>
        ) : (
          <span className="font-mono text-sm text-muted-foreground">
            (no commit recorded)
          </span>
        )}
        <span className="text-sm">{group.gitSubject ?? ''}</span>
        <span className="text-xs text-muted-foreground">
          {group.runs.length} run{group.runs.length === 1 ? '' : 's'}
        </span>
      </div>

      {/* A run made over uncommitted edits is NOT this commit's behaviour.
          Without this label the page would file it under the commit anyway,
          which is a claim nothing enforces - the exact defect class this repo
          keeps paying for. */}
      {group.anyDirty ? (
        <p className="text-xs text-destructive">
          DIRTY TREE - at least one run here was made over uncommitted changes,
          so its replies are not this commit&apos;s behaviour.
        </p>
      ) : null}

      <div className="flex flex-col gap-3">
        {group.runs.map((run) => (
          <RunCard key={run.id} run={run} />
        ))}
      </div>
    </section>
  )
}
