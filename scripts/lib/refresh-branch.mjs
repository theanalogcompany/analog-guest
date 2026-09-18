/**
 * refresh-branch.mjs — brings a resumed ticket's branch up to date with the
 * files the session's prompt assumes are present (TAC-462).
 *
 * TAC-444 shipped scripts/linear.mjs as the only way a CI session writes to
 * Linear, and every build-ready.yml prompt now teaches it as the only write
 * form. A ticket branch cut before that merge (5fca596) has no such file: the
 * session's every Linear write fails with MODULE_NOT_FOUND, and it cannot
 * even post a notice saying so — the [SILENT-RUN] failure class arriving
 * through a new door, a session that works and cannot report because the
 * tool it was told to use is not in its checkout.
 *
 * Run by the workflow's own shell, before Claude starts — not by the
 * session. `git merge` and `git rebase` are not in the session's
 * --allowedTools, so it could not repair this itself without a new allowlist
 * entry; a pre-session step outside the Bash restriction entirely is the one
 * shape that needs no such entry. For each ticket about to be worked: find
 * its branch, check whether every file the taught prompt form needs is
 * actually there, and if not, merge main into it on GitHub — additive, never
 * destructive, and no --force-with-lease judgement call in something that
 * runs unattended on every tick.
 *
 * Scoped to exactly the files the taught write form needs: scripts/linear.mjs
 * and its own import chain (scripts/lib/linear-cli.mjs, which imports
 * scripts/lib/comment-provenance.mjs — confirmed by reading both). Nothing
 * else the prompts assume exists (scripts/claims.mjs, scripts/run-report.mjs)
 * is ever invoked by the session; both run only from the workflow's own
 * checkout, against main. A generic "diff this branch against main's file
 * list and merge whatever's missing" would start merging main into every
 * resumed branch on every run — a far bigger behaviour change than the
 * evidence for this ticket supports.
 *
 * The check itself needs no network call: the checkout already fetched every
 * branch (fetch-depth: 0), so `git cat-file -e origin/<branch>:<path>` reads
 * a file's presence straight off the local refs. The repair does need one: a
 * local `git merge` would need a write credential this step doesn't carry
 * (the checkout persists none, TAC-463) and the result would still have to
 * be pushed by something with write access, so the merge itself goes through
 * the GitHub REST API (`POST /repos/{repo}/merges`) — the same merge a human
 * clicking the button on GitHub's compare view would make. A courtesy local
 * fetch afterwards refreshes the ref so a caller inspecting the checkout
 * right away sees it; the API response is what actually matters, and the
 * session's own `git fetch origin` before it ever checks the branch out
 * (work-ticket.md step 13) is the real backstop if the courtesy fetch fails.
 *
 * git/gh: (args: string[]) => { ok: boolean, output: string }. A different
 * shape from claims.mjs's exec(), which only ever needs success/failure and
 * throws the rest away: this needs the real failure text for the
 * [STALE-BRANCH] notice, so a genuine conflict reads differently from a
 * transient API hiccup at a glance, rather than both being silently retried
 * forever. Documented as a deliberate divergence, not drift.
 *
 * No I/O at module load, and none outside run's injected dependencies.
 */

import { isTicketBranch } from './claims.mjs';

export const REQUIRED_FILES = ['scripts/linear.mjs', 'scripts/lib/linear-cli.mjs', 'scripts/lib/comment-provenance.mjs'];

export const MERGE_COMMIT_MESSAGE = 'Bring this branch up to date with main (TAC-462: the Linear write helper)';

export const EXIT = { OK: 0, USAGE: 2 };

export const USAGE = [
  'usage: node scripts/refresh-branch.mjs < tickets.json',
  'stdin: the ticket identifiers about to be worked, as a JSON array of strings',
  'env: GITHUB_REPOSITORY',
  'stdout: the per-ticket results, as [{ ticket, outcome, branch?, missing?, error? }]',
].join('\n');

/**
 * The ticket's branch on GitHub, from `git for-each-ref
 * --format=%(refname:short) refs/remotes/origin/jaipal`, or null when it has
 * none yet. refsOutput is that command's raw stdout: one short ref per line
 * (e.g. "origin/jaipal/tac-462-x").
 */
export function findBranch(refsOutput, identifier) {
  const names = (refsOutput ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((name) => name.replace(/^origin\//, ''));
  return names.find((name) => isTicketBranch(identifier, name)) ?? null;
}

/** Which of REQUIRED_FILES are missing from a branch on GitHub. */
export function missingFiles(git, branch) {
  return REQUIRED_FILES.filter((file) => !git(['cat-file', '-e', `origin/${branch}:${file}`]).ok);
}

/**
 * One ticket's result:
 *
 *   'no-branch'   — the ticket has no branch yet. Nothing to fix.
 *   'up-to-date'  — every required file is already present.
 *   'merged'      — some were missing; a merge commit of main now supplies
 *                   them. `missing` names what was missing.
 *   'failed'      — some were missing and the merge could not be made.
 *                   `error` carries gh's own output, verbatim: a genuine
 *                   conflict and a transient API hiccup get the same
 *                   outcome, and reading the real text is how a human tells
 *                   them apart, rather than the workflow guessing and
 *                   silently retrying one of them forever.
 */
export function refreshOne({ identifier, refsOutput, git, gh, repo }) {
  const branch = findBranch(refsOutput, identifier);
  if (branch === null) return { ticket: identifier, outcome: 'no-branch' };

  const missing = missingFiles(git, branch);
  if (missing.length === 0) return { ticket: identifier, branch, outcome: 'up-to-date' };

  const merge = gh([
    'api',
    `repos/${repo}/merges`,
    '-f',
    `base=${branch}`,
    '-f',
    'head=main',
    '-f',
    `commit_message=${MERGE_COMMIT_MESSAGE}`,
  ]);
  if (!merge.ok) return { ticket: identifier, branch, outcome: 'failed', missing, error: merge.output };

  // Courtesy only, per the module header: the merge already succeeded on
  // GitHub, so a failure here does not change the outcome.
  git(['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);

  return { ticket: identifier, branch, outcome: 'merged', missing };
}

/**
 * The entry. Takes an array — one ticket per run in practice (LIMIT=1) — so
 * the shape does not have to change if that ever widens.
 *
 * Fails SOFT when the local branch list can't be read, like
 * reconcile-status.mjs and unlike claims.mjs: there is no two-session hazard
 * here to fail closed against, only a repair this run cannot make, which
 * costs no more than the [SILENT-RUN] this ticket already exists to replace.
 */
export function run({ env, stdin, git, gh, stdout, stderr }) {
  const usage = (why) => {
    stderr(`${why}\n${USAGE}\n`);
    return EXIT.USAGE;
  };

  let tickets;
  try {
    tickets = JSON.parse(stdin);
  } catch {
    return usage('stdin is not JSON');
  }
  if (!Array.isArray(tickets) || tickets.some((t) => typeof t !== 'string')) {
    return usage('stdin is not a JSON array of ticket identifiers');
  }
  if (tickets.length === 0) {
    stdout('[]\n');
    return EXIT.OK;
  }

  const repo = env.GITHUB_REPOSITORY ?? '';
  const refs = git(['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin/jaipal']);
  if (!refs.ok) {
    stderr('::warning title=Stale-branch check::Could not read this ticket\'s branches on GitHub. No branch is refreshed this run.\n');
  }
  const refsOutput = refs.ok ? refs.output : '';

  const results = tickets.map((identifier) => refreshOne({ identifier, refsOutput, git, gh, repo }));
  stdout(`${JSON.stringify(results)}\n`);
  return EXIT.OK;
}
