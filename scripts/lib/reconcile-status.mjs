/**
 * reconcile-status.mjs — writes analog-guest's ticket status from public
 * GitHub state, reconciled on every build run (TAC-466).
 *
 * Nothing in this repo's own GitHub-Linear integration attaches an
 * analog-guest PR to its ticket (confirmed 2026-09-18, TAC-466's ruling
 * comment — TAC-467 merged a PR after the integration setting was fixed and
 * still got no attachment), so "In Progress on PR open, Ready For QA on
 * merge" — what work-ticket.md and .claude/process.md used to claim happens
 * automatically — never happened for this repo. This module is what makes
 * it true instead:
 *
 * - a branch `jaipal/tac-xxx-...` exists on GitHub -> In Progress
 * - the ticket's PR has merged -> Ready For QA
 *
 * derived fresh every run, never invented outside those two targets, never
 * moved backward.
 *
 * Deliberately a PROJECTION of public state, not a claim: claims.mjs's
 * claims are safety-critical (a false negative lets two sessions work one
 * ticket) and fail CLOSED; this has no equivalent safety property, so it
 * fails SOFT. A read it cannot make just leaves the status stale until the
 * next run — which is "reconciled every run" doing its job, not a defect.
 * For the same reason it is safe to run over every Ready/In Progress
 * candidate, including one another session has claimed: a derived status
 * carries no information a claim doesn't already carry more precisely, so
 * it cannot function as a second claim signal (TAC-466's own acceptance
 * criterion).
 *
 * Reuses isTicketBranch / parseRefs / REF_FORMAT from claims.mjs so branch
 * matching cannot drift between the claim check and this.
 *
 * No I/O at module load, and none outside run's injected dependencies.
 */

import { isTicketBranch, parseRefs, REF_FORMAT } from './claims.mjs';

export const EXIT = { OK: 0, USAGE: 2 };

// Forward order only. 'Ready' is never a *target* here — only the Todo to
// Ready audit writes that — it is listed so a candidate at Ready has
// somewhere to be strictly behind.
export const PIPELINE = ['Ready', 'In Progress', 'Ready For QA'];

export const USAGE = [
  'usage: node scripts/reconcile-status.mjs < candidates.json',
  'stdin: candidates, each with id, identifier, state',
  'env: GITHUB_REPOSITORY',
  'stdout: the writes to make, as [{ id, identifier, from, to }]',
].join('\n');

/**
 * The status a candidate should move to, or null when it should not move:
 * currentState is not on the pipeline, or the derived target is not
 * strictly ahead of it. Never invents a status outside PIPELINE and never
 * moves a ticket backward — both read off the same PIPELINE index compare,
 * so there is one place either guarantee could break.
 */
export function deriveTargetStatus({ currentState, hasBranch, hasMergedPr }) {
  const target = hasMergedPr ? 'Ready For QA' : hasBranch ? 'In Progress' : null;
  if (target === null) return null;
  const from = PIPELINE.indexOf(currentState);
  const to = PIPELINE.indexOf(target);
  if (from === -1 || to === -1) return null;
  return to > from ? target : null;
}

/**
 * The writes to make for a set of candidates, in the order given.
 * ctx: { refs (parseRefs's shape), mergedPrBranches (string[]) }.
 */
export function reconcile(candidates, ctx) {
  const writes = [];
  for (const candidate of candidates ?? []) {
    const hasBranch = ctx.refs.some((ref) => isTicketBranch(candidate.identifier, ref.name));
    const hasMergedPr = ctx.mergedPrBranches.some((name) => isTicketBranch(candidate.identifier, name));
    const to = deriveTargetStatus({ currentState: candidate.state, hasBranch, hasMergedPr });
    if (to) writes.push({ id: candidate.id, identifier: candidate.identifier, from: candidate.state, to });
  }
  return writes;
}

/**
 * The entry, with its I/O injected: git(args) and gh(args) return stdout, or
 * null when the command fails.
 *
 * Fails SOFT on both reads, unlike claims.mjs: a branch list or a merged-PR
 * list this run could not read just means this run reconciles fewer
 * tickets, never that it refuses to run or writes something wrong. There is
 * no "taking a ticket without the check" hazard here to fail closed against.
 */
export function run({ env, stdin, git, gh, stdout, stderr }) {
  const usage = (why) => {
    stderr(`${why}\n${USAGE}\n`);
    return EXIT.USAGE;
  };

  let candidates;
  try {
    candidates = JSON.parse(stdin);
  } catch {
    return usage('stdin is not JSON');
  }
  if (!Array.isArray(candidates)) return usage('stdin is not a JSON array');

  const refsText = git(['for-each-ref', `--format=${REF_FORMAT}`, 'refs/remotes/origin/']);
  const refs = refsText === null ? [] : parseRefs(refsText);
  if (refsText === null) {
    stderr('::warning title=Status reconcile::Could not read the branches on GitHub. No ticket moves to In Progress this run.\n');
  }

  const repo = env.GITHUB_REPOSITORY ? ['--repo', env.GITHUB_REPOSITORY] : [];
  const prText = gh(['pr', 'list', '--state', 'merged', '--limit', '200', '--json', 'headRefName', ...repo]);
  let mergedPrBranches = [];
  try {
    const prs = JSON.parse(prText ?? '');
    if (!Array.isArray(prs)) throw new Error('not an array');
    mergedPrBranches = prs.map((pr) => pr?.headRefName).filter((name) => typeof name === 'string');
  } catch {
    stderr('::warning title=Status reconcile::Could not list merged PRs. No ticket moves to Ready For QA this run.\n');
  }

  const writes = reconcile(candidates, { refs, mergedPrBranches });
  stdout(`${JSON.stringify(writes)}\n`);
  return EXIT.OK;
}
