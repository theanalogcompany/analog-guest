/**
 * turn-limit-restart.mjs — whether a turn-limited ticket should be resumed
 * automatically, without a human reply (TAC-480).
 *
 * TAC-447 made a turn-limited run legible: [TURN-LIMIT] names what reached
 * GitHub and blocks the ticket for Jaipal. On 2026-09-18 both TAC-325 and
 * TAC-376 needed nothing but a human noticing the notice and replying — the
 * work itself needed no judgement. This module is the check that tells a
 * ticket whose last attempt made progress from one that is genuinely stuck.
 *
 * Progress is read off the [TURN-LIMIT] notice itself, never assumed:
 * renderTurnLimit (run-report.mjs) embeds the branch's current head and
 * commit-ahead count in the marker line. A restart is claimed with
 * [AUTO-RESTART], carrying that same head, so the NEXT decision can tell
 * whether the branch moved since — the same shape [RESUME-CLAIM]'s `ruling=`
 * gives claims.mjs, but counted across the whole run of automatic attempts
 * rather than against one ruling. Reusing [RESUME-CLAIM]'s own per-ruling
 * `attempts` counter (build-ready.yml) doesn't work here: every automatic
 * restart posts its own new [TURN-LIMIT], which becomes the new newest
 * comment, which would reset a per-ruling counter to zero on every attempt —
 * an unbounded loop, not a bounded one.
 *
 * The count and the progress check both look only at comments since the most
 * recent HUMAN comment (or from the start, if none) — a human reply resets
 * the budget, because it is a fresh ruling to act on, with its own attempts
 * to spend.
 *
 * No I/O at module load, and none outside the functions' own arguments. Run
 * by scripts/turn-limit-restart.mjs from the "Find tickets to work" step,
 * never by the session.
 */

import { commentMarker, isBotComment, unescapeBrackets } from './comment-provenance.mjs';

export const EXIT = { OK: 0, USAGE: 2 };

export const DEFAULT_MAX_AUTO_RESTARTS = 2;

export const USAGE = [
  'usage: node scripts/turn-limit-restart.mjs < candidates.json',
  'stdin: the queue\'s candidates, each with',
  '  id, identifier, newestId, mode (start|resume|turn-limited), comments { body createdAt }',
  'env: MAX_AUTO_RESTARTS (default 2), GITHUB_RUN_ID',
  'stdout: { candidates: [...], exhausted: [...] }',
].join('\n');

const PREFIX = '**[FROM CLAUDE CODE]**';

// The rest of a marker line, after the given marker.
function markerLine(body, marker) {
  const m = unescapeBrackets(body).match(new RegExp(`\\[${marker}\\]([^\n]*)`));
  return m?.[1] ?? '';
}

/**
 * The head short sha and commit-ahead count a [TURN-LIMIT] notice embeds
 * (run-report.mjs's renderTurnLimit: `head=<sha|none> commits=<N>`), or null
 * when the comment isn't one, or carries neither field (a notice from before
 * this ticket).
 */
export function parseHeadState(body) {
  if (commentMarker(body) !== 'TURN-LIMIT') return null;
  const line = markerLine(body, 'TURN-LIMIT');
  const head = line.match(/\bhead=(\S+)/)?.[1];
  const commits = line.match(/\bcommits=(\d+)/)?.[1];
  if (head === undefined || commits === undefined) return null;
  return { head: head === 'none' ? null : head, commits: Number(commits) };
}

/**
 * The attempt number and the branch head it was claimed at, from an
 * [AUTO-RESTART] comment, or null when the comment isn't one or carries
 * neither field.
 */
export function parseAutoRestartClaim(body) {
  if (commentMarker(body) !== 'AUTO-RESTART') return null;
  const line = markerLine(body, 'AUTO-RESTART');
  const attempt = line.match(/\battempt=(\d+)\//)?.[1];
  const headSha = line.match(/\bheadSha=(\S+)/)?.[1];
  if (attempt === undefined || headSha === undefined) return null;
  return { attempt: Number(attempt), headSha: headSha === 'none' ? null : headSha };
}

function sortedByTime(comments) {
  return (comments ?? [])
    .map((c) => ({ ...c, at: Date.parse(c.createdAt ?? '') }))
    .filter((c) => Number.isFinite(c.at))
    .sort((a, b) => a.at - b.at);
}

/**
 * Whether a turn-limited ticket's thread should be resumed automatically.
 *
 * `comments`: the ticket's full comment thread, any order (sorted here).
 * `bound`: MAX_AUTO_RESTARTS.
 *
 * Only ever decides something when the NEWEST comment is a [TURN-LIMIT] —
 * anything else (a human reply, a [PLAN], a [NEEDS-ACTION], ...) is not this
 * module's question, and the ordinary start/resume selection already has it.
 */
export function decideAutoRestart({ comments, bound }) {
  const sorted = sortedByTime(comments);
  const newest = sorted.at(-1);
  if (!newest || !isBotComment(newest.body) || commentMarker(newest.body) !== 'TURN-LIMIT') {
    return { restart: false, reason: 'not-turn-limited' };
  }

  const headState = parseHeadState(newest.body) ?? { head: null, commits: 0 };

  // Comments since the most recent human reply (or the whole thread, if
  // none): a human reply is a fresh ruling, with its own attempts to spend.
  let sinceIndex = 0;
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    if (!isBotComment(sorted[i].body)) {
      sinceIndex = i + 1;
      break;
    }
  }
  const priorRestarts = sorted
    .slice(sinceIndex, -1)
    .map((c) => parseAutoRestartClaim(c.body))
    .filter((c) => c !== null);

  const attemptsSoFar = priorRestarts.length;
  if (attemptsSoFar >= bound) {
    return { restart: false, reason: 'bound-reached', attempt: attemptsSoFar };
  }

  const priorClaim = priorRestarts.at(-1) ?? null;
  const progress = priorClaim === null ? headState.commits > 0 : headState.head !== priorClaim.headSha;
  if (!progress) {
    return { restart: false, reason: 'no-progress', attempt: attemptsSoFar };
  }
  return { restart: true, attempt: attemptsSoFar + 1, head: headState.head };
}

/** [AUTO-RESTART]: bookkeeping, claiming an automatic resume. */
export function renderAutoRestartClaim({ ticket, attempt, bound, headSha, runId }) {
  return [PREFIX, '', `[AUTO-RESTART] ${ticket} attempt=${attempt}/${bound} headSha=${headSha ?? 'none'} run=${runId}`].join('\n');
}

/**
 * [AUTO-RESTART-LIMIT]: the chain of automatic restarts stopped, either the
 * bound is reached or the most recent attempt pushed nothing new. Blocking,
 * like [TURN-LIMIT] — the ticket goes back to waiting for Jaipal, in terms
 * that name splitting as the next step.
 */
export function renderAutoRestartLimit({ ticket, attempt, bound, runId }) {
  return [
    PREFIX,
    '',
    `[AUTO-RESTART-LIMIT] ${ticket} attempt=${attempt}/${bound} run=${runId}`,
    '',
    `This ticket was resumed automatically ${attempt} time${attempt === 1 ? '' : 's'} after its turn limit, without a human reply. That is as far as it goes on its own: another automatic restart would either repeat past the bound of ${bound}, or repeat an attempt that pushed nothing new.`,
    '',
    'Reply here to continue. If the ticket is too large for one session, split it instead of replying.',
  ].join('\n');
}

function parseBound(text) {
  if (text === undefined || text === '') return DEFAULT_MAX_AUTO_RESTARTS;
  const n = Number(text);
  return Number.isFinite(n) && n > 0 && Number.isInteger(n) ? n : null;
}

/**
 * The entry: reads the queue's candidates from stdin (mode start | resume |
 * turn-limited). start/resume pass through unchanged. Each turn-limited
 * candidate is decided via decideAutoRestart and either:
 *   - upgraded to mode: "resume" carrying `autoRestart` (attempt, headSha,
 *     the [AUTO-RESTART] body to post) — claims.mjs's ordinary liveness
 *     check then applies to it exactly as to a human-ruled resume;
 *   - moved to `exhausted`, carrying the [AUTO-RESTART-LIMIT] body to post
 *     and whether the ticket still needs the Blocked On label re-added; or
 *   - dropped (no progress on the last attempt): today's [TURN-LIMIT] notice
 *     already asks Jaipal and already names splitting, unchanged.
 */
export function run({ env, stdin, stdout, stderr }) {
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

  const bound = parseBound(env.MAX_AUTO_RESTARTS);
  if (bound === null) return usage(`MAX_AUTO_RESTARTS "${env.MAX_AUTO_RESTARTS}" is not a whole number above 0`);
  const runId = env.GITHUB_RUN_ID ?? 'unknown';

  const out = [];
  const exhausted = [];
  for (const candidate of candidates) {
    if (candidate.mode !== 'turn-limited') {
      out.push(candidate);
      continue;
    }
    const decision = decideAutoRestart({ comments: candidate.comments, bound });
    if (decision.restart) {
      out.push({
        ...candidate,
        mode: 'resume',
        autoRestart: {
          attempt: decision.attempt,
          headSha: decision.head,
          body: renderAutoRestartClaim({ ticket: candidate.identifier, attempt: decision.attempt, bound, headSha: decision.head, runId }),
        },
      });
    } else if (decision.reason === 'bound-reached') {
      exhausted.push({
        id: candidate.id,
        identifier: candidate.identifier,
        hasNeedsDecision: candidate.hasNeedsDecision ?? true,
        body: renderAutoRestartLimit({ ticket: candidate.identifier, attempt: decision.attempt, bound, runId }),
      });
    }
    // reason === 'not-turn-limited' or 'no-progress': dropped. The existing
    // [TURN-LIMIT] notice already asks Jaipal and already names splitting.
  }

  stdout(`${JSON.stringify({ candidates: out, exhausted })}\n`);
  return EXIT.OK;
}
