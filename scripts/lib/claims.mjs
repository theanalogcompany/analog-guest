/**
 * claims.mjs — which of the build workflow's candidate tickets another
 * session already has (TAC-448).
 *
 * On 2026-09-17 a build run resumed TAC-396 while a local session was
 * building it (run 35299836324, attempt 1: "resume: TAC-396 (In Progress)").
 * The selection read nothing that could show the local session: its resume
 * path checks neither the status nor any sign of another session. This
 * module is the check the selection runs before it takes a ticket.
 *
 * A candidate is claimed when another session has left a trace the
 * selection can read, recent enough to be live (the live window):
 *
 * - a local session's [CLAIM], created or last edited within the window,
 *   unless its marker line says `released`. A session keeps its claim live
 *   by editing it, and hands the ticket back by editing it to `released`
 *   when it stops to wait for Jaipal or backs off. A claim that is not
 *   released holds whatever the ruling: the ruling's time is when the
 *   comment reached Linear, which can be long after a local session heard
 *   the answer another way (Slack, or chat);
 * - a [POLLING-STATE] edited within the window;
 * - a commit on the ticket's branch on GitHub within the window, by anyone
 *   but the build workflow's own session (claude[bot]);
 * - for a start only, an open PR from the ticket's branch. The build is
 *   finished and waiting for Jaipal to merge it.
 *
 * For a resume, a [POLLING-STATE] or a commit counts only if it is no older
 * than the ruling being resumed. A polling session that stopped, or a
 * branch last pushed before Jaipal answered, has not acted on the answer,
 * so the answer is the next session's. One exception: a [POLLING-STATE]
 * edited in the last POLL_HEARTBEAT_MINUTES. A polling session looks at
 * least every 5 minutes (work-ticket.md, "Backoff") and edits that comment
 * each time, so it will pick the ruling up itself.
 *
 * The build workflow's own traces are ignored: its claims ([CLAIM] naming a
 * run, and [RESUME-CLAIM]) and its session's commits. Its concurrency group
 * runs one build at a time, so any earlier run is over by the time this
 * check runs. Those claims exist for local sessions to read.
 *
 * What this cannot see: a local session that has written nothing to Linear
 * and pushed nothing to GitHub, or pushed only to a branch not named
 * jaipal/<ticket>-.... Nothing protects that window, and nothing here
 * pretends to.
 *
 * No I/O at module load, and none outside run's injected dependencies.
 */

import { commentMarker, isBotComment, unescapeBrackets } from './comment-provenance.mjs';

export const EXIT = { OK: 0, FAILED: 1, USAGE: 2 };

export const DEFAULT_LIVE_SESSION_HOURS = 3;
export const POLL_HEARTBEAT_MINUTES = 10;

// The identity the build session commits as: the Claude GitHub App. Seen on
// jaipal/tac-396-comment-provenance-module, pushed by run 35288433905.
export const BUILD_SESSION_COMMITTER = '41898282+claude[bot]@users.noreply.github.com';

// One line per branch on GitHub: name, commit time in seconds, committer.
export const REF_FORMAT = '%(refname:lstrip=3)%09%(committerdate:unix)%09%(committeremail)';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const USAGE = [
  'usage: node scripts/claims.mjs < candidates.json',
  'stdin: the selection\'s candidates, in priority order, each with',
  '  identifier, mode (start|resume), newestAt and comments { body createdAt updatedAt }',
  'env: LIMIT (tickets to take), LIVE_SESSION_HOURS (default 3), GITHUB_REPOSITORY',
  'stdout: the tickets taken, as [{ id, identifier, newestId, mode, state, autoRestart }]',
].join('\n');

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function iso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** When a comment was last touched, in ms, or NaN. An edit counts. */
function touchedAt(comment) {
  const times = [comment.updatedAt, comment.createdAt]
    .map((t) => Date.parse(t ?? ''))
    .filter(Number.isFinite);
  return times.length > 0 ? Math.max(...times) : NaN;
}

// The rest of a claim's marker line, after the marker.
function claimLine(body) {
  return unescapeBrackets(body).match(/\[(?:CLAIM|RESUME-CLAIM)\]([^\n]*)/)?.[1] ?? '';
}

/**
 * The run a claim names, or null. A claim that names a run is the build
 * workflow's own; a local session's claim names none.
 */
export function claimRun(body) {
  return claimLine(body).match(/\brun=(\d+)/)?.[1] ?? null;
}

/** Whether a local claim has been handed back: `released` on its marker line. */
export function claimReleased(body) {
  return /\breleased\b/.test(claimLine(body));
}

/**
 * The comments that can claim a ticket for another session: a local
 * session's [CLAIM] that is not released, and [POLLING-STATE]. Provenance
 * is the prefix (comment-provenance.mjs), never the author: every comment
 * shares one.
 */
export function sessionComments(comments) {
  const out = [];
  for (const comment of comments ?? []) {
    const body = comment?.body ?? '';
    if (!isBotComment(body)) continue;
    const marker = commentMarker(body);
    const local =
      marker === 'POLLING-STATE' || (marker === 'CLAIM' && claimRun(body) === null && !claimReleased(body));
    if (!local) continue;
    const at = touchedAt(comment);
    if (Number.isFinite(at)) out.push({ marker, at });
  }
  return out.sort((a, b) => b.at - a.at);
}

/**
 * Branches on GitHub, from `git for-each-ref --format=REF_FORMAT
 * refs/remotes/origin/`. The checkout fetched every branch, so no network
 * call is needed.
 */
export function parseRefs(text) {
  const refs = [];
  for (const line of (text ?? '').split('\n')) {
    const [name, seconds, email] = line.split('\t');
    if (!name || !seconds) continue;
    const at = Number(seconds) * 1000;
    if (!Number.isFinite(at)) continue;
    refs.push({ name, at, email: (email ?? '').trim().replace(/^<|>$/g, '') });
  }
  return refs;
}

/**
 * Whether a branch name is the ticket's: `jaipal/<ticket>-...`, in any case.
 * The same rule as work-ticket.md's branchExists and run-report.mjs.
 */
export function isTicketBranch(identifier, name) {
  return new RegExp(`^jaipal/${escapeRegExp(identifier)}-.+$`, 'i').test(name);
}

/**
 * Why another session has this candidate, or null when nothing does.
 *
 * ctx: { now (ms), liveHours, refs (parseRefs), openPrBranches (string[],
 * or null when they could not be read) }
 */
export function claimOf(candidate, ctx) {
  const windowStart = ctx.now - ctx.liveHours * HOUR;
  const resume = candidate.mode === 'resume';
  // A resume whose ruling time can't be read: every live trace counts.
  // Skipping a ticket for a few hours is the cheap direction to be wrong.
  const rulingAt = resume ? Date.parse(candidate.newestAt ?? '') : NaN;
  const since = Number.isFinite(rulingAt) ? rulingAt : -Infinity;
  const afterRuling = resume ? ', after the ruling it would resume on' : '';

  for (const trace of sessionComments(candidate.comments)) {
    if (trace.at < windowStart) continue;
    // Not released: the session is working, whenever the ruling landed.
    if (trace.marker === 'CLAIM') return `a local session's [CLAIM], last edited ${iso(trace.at)}`;
    // >= rather than >: Linear can return updatedAt a few ms before
    // createdAt, so a trace posted with the ruling must not fall behind it.
    if (trace.at >= since) return `a [POLLING-STATE], last edited ${iso(trace.at)}${afterRuling}`;
    if (trace.at >= ctx.now - POLL_HEARTBEAT_MINUTES * MINUTE) {
      return `a polling session's [POLLING-STATE], last edited ${iso(trace.at)}: it will pick the ruling up itself`;
    }
  }

  const pushes = ctx.refs
    .filter((ref) => isTicketBranch(candidate.identifier, ref.name))
    .filter((ref) => ref.email !== BUILD_SESSION_COMMITTER)
    .filter((ref) => ref.at >= windowStart && ref.at >= since)
    .sort((a, b) => b.at - a.at);
  if (pushes.length > 0) {
    return `a commit on ${pushes[0].name} at ${iso(pushes[0].at)}${afterRuling}`;
  }

  if (!resume && ctx.openPrBranches) {
    const pr = ctx.openPrBranches.find((name) => isTicketBranch(candidate.identifier, name));
    if (pr) return `an open PR from ${pr}`;
  }

  return null;
}

/**
 * Take up to `limit` candidates, in order, skipping claimed ones. A claimed
 * ticket never uses up the limit, so it can't keep the next ticket waiting.
 */
export function pickUnclaimed(candidates, ctx, limit) {
  const picked = [];
  const skipped = [];
  for (const candidate of candidates) {
    if (picked.length >= limit) break;
    const reason = claimOf(candidate, ctx);
    if (reason) skipped.push({ identifier: candidate.identifier, mode: candidate.mode, state: candidate.state, reason });
    else picked.push(candidate);
  }
  return { picked, skipped };
}

function positiveNumber(text, fallback) {
  if (text === undefined || text === '') return fallback;
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The entry, with its I/O injected: git(args) and gh(args) return stdout, or
 * null when the command fails.
 *
 * Fails closed when the branches can't be read, or come back without main
 * (nothing fetched from GitHub): taking a ticket without the check is the
 * defect this exists to stop. Fails open, with a warning, when
 * the open PRs can't be read: that signal only saves a wasted run on a
 * finished ticket, and the other two still hold.
 */
export function run({ env, stdin, git, gh, now, stdout, stderr }) {
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

  const limit = positiveNumber(env.LIMIT, null);
  if (limit === null || !Number.isInteger(limit)) return usage(`LIMIT "${env.LIMIT ?? ''}" is not a whole number above 0`);
  const liveHours = positiveNumber(env.LIVE_SESSION_HOURS, DEFAULT_LIVE_SESSION_HOURS);
  if (liveHours === null) return usage(`LIVE_SESSION_HOURS "${env.LIVE_SESSION_HOURS}" is not a number above 0`);

  const refsText = git(['for-each-ref', `--format=${REF_FORMAT}`, 'refs/remotes/origin/']);
  const refs = refsText === null ? [] : parseRefs(refsText);
  // No main among them means the checkout fetched no branches from GitHub,
  // and every commit signal would be silently missing. A shallow checkout
  // of main still lists main, so this cannot catch that; the fetch-depth: 0
  // pin in build-workflow.test.ts is what protects the scheduled run.
  if (!refs.some((ref) => ref.name === 'main')) {
    stderr('::error title=Claim check::Could not read the branches on GitHub from the checkout, so no ticket can be checked for another session. Taking nothing.\n');
    return EXIT.FAILED;
  }

  const repo = env.GITHUB_REPOSITORY ? ['--repo', env.GITHUB_REPOSITORY] : [];
  const prText = gh(['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'headRefName', ...repo]);
  let openPrBranches = null;
  try {
    const prs = JSON.parse(prText ?? '');
    if (Array.isArray(prs)) openPrBranches = prs.map((pr) => pr?.headRefName).filter((name) => typeof name === 'string');
  } catch {
    // null: unknown, which is not the same as none
  }
  if (openPrBranches === null) {
    stderr('::warning title=Claim check::Could not list open PRs. A ticket with an open PR may be started and exit at once.\n');
  }

  const ctx = { now, liveHours, refs, openPrBranches };
  const { picked, skipped } = pickUnclaimed(candidates, ctx, limit);
  for (const s of skipped) {
    stderr(`skipped ${s.identifier} (${s.mode}, ${s.state}): another session has it: ${s.reason}.\n`);
  }
  // autoRestart (TAC-480): turn-limit-restart.mjs's own passthrough, null
  // when a candidate never went through it. Lets the claiming loop tell an
  // auto-eligible resume from a human-ruled one without re-deriving it.
  const out = picked.map(({ id, identifier, newestId, mode, state, autoRestart }) => ({
    id,
    identifier,
    newestId,
    mode,
    state,
    autoRestart: autoRestart ?? null,
  }));
  stdout(`${JSON.stringify(out)}\n`);
  return EXIT.OK;
}
