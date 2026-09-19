/**
 * run-report.mjs — what the build workflow says on a ticket when its session
 * runs into the turn limit (TAC-447).
 *
 * A session can meet the limit in two ways, and they need different notices:
 *
 * - The CLI stops it. The result's subtype is `error_max_turns` (audit runs
 *   34949521131 and 34980172868: 61 turns against 60). The work is
 *   incomplete, so the ticket gets [TURN-LIMIT]: it blocks, like [SILENT-RUN],
 *   and names what reached GitHub and what died with the runner.
 * - The session finishes, and claude-code-action fails the step afterwards
 *   because `num_turns` is over the limit (run 35288433905: `success` at 128
 *   against 120; `base-action/src/run-claude-sdk.ts:241-250` in the action's
 *   `v1` tag, 2261fcf when read). Nothing was cut short, so the ticket gets [OVER-LIMIT], which is
 *   bookkeeping. It must not count as the newest comment: posted after a PR
 *   link, a non-bookkeeping comment would hide it, and the next /work-ticket
 *   run would read the ticket as unbuilt.
 *
 * What reached GitHub is read from the runner's own git refs after the
 * session. `git push` updates refs/remotes/origin/<branch> only when the push
 * succeeds, and the checkout fetched every branch at the start, so a
 * branch pushed by an earlier run is there too. No network call is needed,
 * which keeps this testable with a fake `git`.
 *
 * No I/O at module load, and none outside `run`'s injected dependencies. The
 * workflow runs it from a shell step, never from the session, so no allowlist
 * applies.
 */

import { redact } from './linear-cli.mjs';

export const EXIT = { OK: 0, USAGE: 2 };

export const ENDING = {
  FINISHED: 'finished',
  FINISHED_OVER_LIMIT: 'finished-over-limit',
  STOPPED_AT_LIMIT: 'stopped-at-limit',
  ERRORED: 'errored',
  NO_RECORD: 'no-record',
};

export const USAGE = [
  'usage:',
  '  node scripts/run-report.mjs ending <execution-file> <max-turns>',
  '  node scripts/run-report.mjs notice <ticket> <execution-file> <max-turns>',
  'env for notice: RUN_URL, GITHUB_RUN_ID, DENIALS, DENIED, LINEAR_API_KEY (redacted, never printed)',
].join('\n');

const TICKET = /^[A-Z][A-Z0-9]*-\d+$/;

/**
 * The session's result message from the action's execution file, or null.
 * The file is a JSON array of messages; the last `result` one is the
 * session's outcome, as the workflow's own jq reads it.
 */
export function lastResult(text) {
  let records;
  try {
    records = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(records)) return null;
  const results = records.filter((r) => r && r.type === 'result');
  return results.length > 0 ? results[results.length - 1] : null;
}

/**
 * How the session ended, relative to its turn limit. The over-limit test is
 * the action's own (subtype success, not is_error, num_turns > maxTurns), so
 * this agrees with the step that fails the run.
 */
export function classifyEnding(result, maxTurns) {
  if (!result) return ENDING.NO_RECORD;
  if (result.subtype === 'error_max_turns') return ENDING.STOPPED_AT_LIMIT;
  const succeeded = result.subtype === 'success' && !result.is_error;
  if (!succeeded) return ENDING.ERRORED;
  if (typeof result.num_turns === 'number' && result.num_turns > maxTurns) {
    return ENDING.FINISHED_OVER_LIMIT;
  }
  return ENDING.FINISHED;
}

function lines(text) {
  return (text ?? '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Uncommitted work in each side folder: every worktree but the checkout
 * itself, which is the first `git worktree list` names. A resume edits its
 * branch in one (TAC-471), and the checkout's own `git status` cannot see
 * inside it: `.worktrees/` is gitignored. Each is read with
 * `git -C <path> status --porcelain`. null for the list, or for one folder's
 * changes, means git could not answer: unknown, which is not the same as none.
 */
function readSideFolders(git) {
  const out = git(['worktree', 'list', '--porcelain']);
  if (out === null) return null;
  const blocks = out.split(/\n[ \t]*\n/).map(lines).filter((block) => block.length > 0);
  return blocks
    .slice(1)
    .map((block) => ({
      path: block.find((l) => l.startsWith('worktree '))?.slice('worktree '.length) ?? null,
      branch: block.find((l) => l.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length) ?? null,
    }))
    .filter((folder) => folder.path !== null)
    .map((folder) => {
      const status = git(['-C', folder.path, 'status', '--porcelain']);
      return { ...folder, uncommitted: status === null ? null : lines(status) };
    });
}

/**
 * The ticket's branches, and what is on each, from the runner's git.
 * `git(args)` returns stdout, or null when the command fails.
 *
 * A ticket's branch is `jaipal/<ticket>-...`, matched without regard to case:
 * sessions name it with the lowercase id (`jaipal/tac-396-...`).
 */
export function readGitState(git, ticket) {
  const refsOut = git(['for-each-ref', '--format=%(refname)', 'refs/heads/', 'refs/remotes/origin/']);
  if (refsOut === null) return { readable: false };

  const own = new RegExp(`^refs/(heads|remotes/origin)/(jaipal/${escapeRegExp(ticket)}-.+)$`, 'i');
  const byName = new Map();
  for (const ref of lines(refsOut)) {
    const m = ref.match(own);
    if (!m) continue;
    const entry = byName.get(m[2]) ?? { name: m[2], local: false, remote: false };
    if (m[1] === 'heads') entry.local = true;
    else entry.remote = true;
    byName.set(m[2], entry);
  }

  // null when git could not answer: unknown, which is not the same as none.
  const log = (range) => {
    const out = git(['log', '--format=%h %s', range]);
    return out === null ? null : lines(out);
  };
  const branches = [...byName.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((b) => ({
      ...b,
      onGitHub: b.remote ? log(`refs/remotes/origin/main..refs/remotes/origin/${b.name}`) : [],
      notPushed: b.local
        ? log(b.remote
          ? `refs/remotes/origin/${b.name}..refs/heads/${b.name}`
          : `refs/remotes/origin/main..refs/heads/${b.name}`)
        : [],
    }));

  return {
    readable: true,
    head: (git(['rev-parse', '--abbrev-ref', 'HEAD']) ?? '').trim() || null,
    branches,
    uncommitted: (() => {
      const out = git(['status', '--porcelain']);
      return out === null ? null : lines(out);
    })(),
    sideFolders: readSideFolders(git),
    // A session must never commit to main. If one did, say so rather than
    // letting it vanish with the runner. Unreadable here means no local main.
    onLocalMain: log('refs/remotes/origin/main..refs/heads/main') ?? [],
  };
}

// Long lists are cut, so a session that touched many files still gets a
// comment Linear accepts.
export const MAX_LIST = 50;

function capped(items) {
  if (items.length <= MAX_LIST) return items;
  return [...items.slice(0, MAX_LIST), `...and ${items.length - MAX_LIST} more`];
}

// The report goes inside ```text fences. A backtick run in a commit subject
// or a file name would close the fence, so backticks are swapped for a
// look-alike, as the workflow's [DENIALS] list does.
function fenced(items) {
  const body = items.length > 0 ? capped(items).join('\n') : '(none)';
  return ['```text', body.replaceAll('`', '\u02cb'), '```'].join('\n');
}

const UNKNOWN = '(unknown: git could not read it)';

/** The pushed / not pushed / not committed report, as markdown. */
export function renderGitReport(state) {
  if (!state.readable) {
    return 'The runner\'s git could not be read, so what was pushed is unknown. Check the ticket\'s branch on GitHub.';
  }

  const out = [];
  const remote = state.branches.filter((b) => b.remote);
  if (remote.length === 0) {
    out.push('On GitHub, and kept: no branch for this ticket, so nothing.');
  } else {
    out.push('On GitHub, and kept:');
    out.push(fenced(remote.flatMap((b) => b.onGitHub === null
      ? [`${b.name} ${UNKNOWN}`]
      : [
          `${b.name} (${b.onGitHub.length} commit${b.onGitHub.length === 1 ? '' : 's'} ahead of main)`,
          ...b.onGitHub.map((c) => `  ${c}`),
        ])));
  }

  const notPushed = state.branches.filter((b) => b.notPushed === null || b.notPushed.length > 0);
  out.push('Committed on the runner but never pushed, and lost:');
  out.push(fenced(notPushed.flatMap((b) => b.notPushed === null
    ? [`${b.name} ${UNKNOWN}`]
    : [b.name, ...b.notPushed.map((c) => `  ${c}`)])));

  out.push(`Changed on the runner but never committed, and lost${state.head ? ` (on ${state.head})` : ''}:`);
  out.push(fenced(state.uncommitted ?? [UNKNOWN]));

  if (state.sideFolders === null) {
    out.push('Changed in a side folder but never committed, and lost:');
    out.push(fenced([UNKNOWN]));
  } else {
    for (const folder of state.sideFolders ?? []) {
      out.push(`Changed in the side folder ${folder.path} but never committed, and lost${folder.branch ? ` (on ${folder.branch})` : ''}:`);
      out.push(fenced(folder.uncommitted ?? [UNKNOWN]));
    }
  }

  if (state.onLocalMain.length > 0) {
    out.push('Committed to main on the runner, which a session must never do. Never pushed, and lost:');
    out.push(fenced(state.onLocalMain));
  }
  return out.join('\n\n');
}

const PREFIX = '**[FROM CLAUDE CODE]**';

/** [TURN-LIMIT]: the CLI stopped the session. Blocking, like [SILENT-RUN]. */
export function renderTurnLimit({ ticket, turns, maxTurns, gitReport, runUrl, denials, denied }) {
  return [
    PREFIX,
    '',
    `[TURN-LIMIT] ${ticket}`,
    '',
    `The build session was stopped at its turn limit (${turns} turns against a limit of ${maxTurns}) before it finished, so the work on this ticket is incomplete. This notice comes from the workflow, not the session.`,
    '',
    gitReport,
    '',
    `- Run: ${runUrl}`,
    `- Permission denials: ${denials}`,
    '',
    'Denied, first 20, key redacted:',
    '',
    fenced(denied),
    '',
    'Reply here to continue. The next scheduled run resumes the build from the branch on GitHub; anything listed as lost has to be redone. If the ticket is too large for one session, split it instead of replying.',
  ].join('\n');
}

/**
 * [OVER-LIMIT]: the session finished, and the action failed the run for
 * going over the limit. Bookkeeping: the automation skips it (TAC-447,
 * question 3: the run stays failed, and this says what was pushed).
 */
export function renderOverLimit({ ticket, turns, maxTurns, gitReport, runUrl, runId }) {
  return [
    PREFIX,
    '',
    `[OVER-LIMIT] ${ticket} run=${runId} turns=${turns} limit=${maxTurns}`,
    '',
    `This run's session finished its work on this ticket, but it used ${turns} turns against a limit of ${maxTurns}, so the run is marked failed. The session was not cut short. Bookkeeping: the automation ignores this comment.`,
    '',
    gitReport,
    '',
    `Run: ${runUrl}`,
  ].join('\n');
}

function parseMaxTurns(text) {
  return /^\d+$/.test(text ?? '') && Number(text) > 0 ? Number(text) : null;
}

function readResult(readFile, path) {
  let text;
  try {
    text = readFile(path);
  } catch {
    return null;
  }
  return lastResult(text);
}

/**
 * `ending` prints how the session ended. `notice` prints the comment body
 * for the two limit endings, and nothing for any other ending, so the
 * workflow posts only what it is given.
 */
export function run({ argv, env, readFile, git, stdout, stderr }) {
  const key = env.LINEAR_API_KEY ?? '';
  const usage = (why) => {
    stderr(`${redact(why, key)}\n${USAGE}\n`);
    return EXIT.USAGE;
  };

  const [verb, ...rest] = argv;

  if (verb === 'ending') {
    if (rest.length !== 2) return usage('ending takes exactly two arguments: <execution-file> <max-turns>');
    const maxTurns = parseMaxTurns(rest[1]);
    if (maxTurns === null) return usage(`"${rest[1]}" is not a turn limit`);
    stdout(`${classifyEnding(readResult(readFile, rest[0]), maxTurns)}\n`);
    return EXIT.OK;
  }

  if (verb === 'notice') {
    if (rest.length !== 3) return usage('notice takes exactly three arguments: <ticket> <execution-file> <max-turns>');
    // A manual dispatch can pass the id in lowercase; Linear accepts either.
    const ticket = rest[0].toUpperCase();
    const [, file, limit] = rest;
    if (!TICKET.test(ticket)) return usage(`"${rest[0]}" is not a ticket identifier`);
    const maxTurns = parseMaxTurns(limit);
    if (maxTurns === null) return usage(`"${limit}" is not a turn limit`);

    const result = readResult(readFile, file);
    const ending = classifyEnding(result, maxTurns);
    if (ending !== ENDING.STOPPED_AT_LIMIT && ending !== ENDING.FINISHED_OVER_LIMIT) return EXIT.OK;

    const common = {
      ticket,
      turns: result.num_turns ?? 'an unknown number of',
      maxTurns,
      gitReport: renderGitReport(readGitState(git, ticket)),
      runUrl: env.RUN_URL ?? '(no run url)',
    };
    const body = ending === ENDING.STOPPED_AT_LIMIT
      ? renderTurnLimit({
          ...common,
          denials: env.DENIALS ?? '0',
          denied: lines(env.DENIED).map((l) => l.replace(/^- /, '')).filter((l) => l !== '(none)'),
        })
      : renderOverLimit({ ...common, runId: env.GITHUB_RUN_ID ?? 'unknown' });
    stdout(`${redact(body, key)}\n`);
    return EXIT.OK;
  }

  return usage(verb === undefined ? 'no command given' : `unknown command "${verb}"`);
}
