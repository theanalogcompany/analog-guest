import type { CommitGroup as CommitGroupData } from '../_lib/load-golden'
import { RunCard } from './run-card'

// Runs grouped under the commit they were made at. The header carries the
// stored commit subject and branch, so the page reads without a round trip -
// and so a run stays attributable after the branch is gone.
//
// THE SHA IS ONLY A LINK WHEN THE COMMIT IS ON A REMOTE. This surface linked
// every sha to GitHub unconditionally until migration 083, and the harness
// runs from an operator shell, so the sha is whatever the local HEAD was -
// routinely a commit that exists on one machine. The link 404ed and nothing on
// the page said why, so a local sha read as reviewable, deployed code. That is
// the defect: not a wrong value, a claim the UI made that the data never
// supported.
//
// Three states, rendered three ways, because `null` is not `false` here: a run
// nobody could check is different evidence from a run known to be local-only,
// and folding them would re-introduce the same false confidence one level down.

const REPO_URL = 'https://github.com/theanalogcompany/analog-guest'

function ShaLabel({ group }: { group: CommitGroupData }) {
  if (group.gitSha === null)
    return (
      <span className="font-mono text-sm text-muted-foreground">
        (no commit recorded)
      </span>
    )

  const short = group.gitSha.slice(0, 7)

  // On a remote: the link resolves, so render it.
  if (group.gitOnRemote === true)
    return (
      <a
        href={`${REPO_URL}/commit/${group.gitSha}`}
        target="_blank"
        rel="noreferrer"
        className="font-mono text-sm underline"
      >
        {short}
      </a>
    )

  // Known local-only, or never determined. Either way there is no link worth
  // offering, and the distinction is carried in the note under the header.
  return <span className="font-mono text-sm">{short}</span>
}

export function CommitGroup({ group }: { group: CommitGroupData }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <ShaLabel group={group} />
        <span className="text-sm">{group.gitSubject ?? ''}</span>
        {group.gitBranch ? (
          <span className="font-mono text-xs text-muted-foreground">
            {group.gitBranch}
          </span>
        ) : null}
        <span className="text-xs text-muted-foreground">
          {group.runs.length} run{group.runs.length === 1 ? '' : 's'}
        </span>
      </div>

      {group.gitSha !== null && group.gitOnRemote === false ? (
        <p className="text-xs text-destructive">
          LOCAL COMMIT - this sha was not on any remote when the run was made,
          so it is not on GitHub and nobody else can reproduce this run from it.
        </p>
      ) : null}

      {group.gitSha !== null && group.gitOnRemote === null ? (
        <p className="text-xs text-muted-foreground">
          Not known whether this commit was pushed - the run predates the check,
          or it could not be run. Treat the sha as unverified rather than as
          deployed code.
        </p>
      ) : null}

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
