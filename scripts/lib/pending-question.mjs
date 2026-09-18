/**
 * pending-question.mjs — which of the build workflow's candidate tickets
 * still ask a question nothing has answered, whatever its labels say
 * (TAC-453).
 *
 * When a human clears `Needs Decision` or `Needs Action` from a ticket
 * without answering the question that put it there — hand-cleared to
 * unblock something else, or drifted back off by a stray label edit
 * (TAC-446) — the next build run reads the ticket as unblocked, selects it
 * to start, and a session spends its one turn budget (TAC-447) discovering
 * the same open question all over again. This module is the check the
 * selection runs, on the comment thread it already fetched, before it
 * decides a Ready-and-unblocked ticket is safe to start.
 *
 * A ticket is pending when its newest turn — skipping bookkeeping
 * (comment-provenance.mjs's BOOKKEEPING_MARKERS) and a plain, non-ruling
 * `**[FROM CLAUDE CHAT]**` comment, since neither can advance a gate and
 * neither should look like "someone answered" or "nothing to see here" —
 * is still one of CC's own that asks Jaipal something and got no reply:
 *
 * - `[NEEDS-INPUT]` or `[PLAN]` -> Needs Decision
 * - `[NEEDS-ACTION]` -> Needs Action
 * - `[AUDIT]` whose own QUESTIONS section still asks a real question
 *   (comment-provenance.mjs's auditHasQuestions) -> Needs Decision
 *
 * Deliberately NOT included: `[HUMAN-REVIEW-REQUIRED]` (no label ever
 * belongs there by design — .claude/process.md, "Remove Needs Decision" —
 * so there's nothing to restore), and `[BUILD-SKIPPED]` /
 * `[AUDIT-SKIPPED]` / `[SILENT-RUN]` / `[TURN-LIMIT]`. Those four resolve
 * by an EDIT to the ticket (or, for [SILENT-RUN]/[TURN-LIMIT], by fixing
 * whatever the run hit), never by a comment reply, so re-selecting one
 * without a reply is not guaranteed to repeat itself the way an
 * unanswered question is — see work-ticket.md's own lastQuestionComment
 * definition, which draws the identical line. Re-flagging those four if
 * their label drifted is TAC-446's broader "is the label true" question,
 * not this narrower "would starting this ticket right now waste the run"
 * one.
 *
 * The caller passes only Ready, single-repo-labelled candidates that
 * already carry neither Needs Decision nor Needs Action — exactly the set
 * build-ready.yml's own selection would otherwise call unblocked and start
 * — so a non-null result from pendingQuestionLabel IS the drift; there is
 * no need to also check the candidate's current labels here.
 *
 * No I/O at module load, and none outside run's injected stdin/stdout.
 */

import { auditHasQuestions, isBookkeepingComment, isBotComment, isContextChatComment, commentMarker } from './comment-provenance.mjs';

export const EXIT = { OK: 0, USAGE: 2 };

export const USAGE = [
  'usage: node scripts/pending-question.mjs < candidates.json',
  'stdin: candidates, each with id, identifier, comments { body createdAt }',
  'stdout: tickets whose blocking label was cleared without an answer,',
  '  as [{ id, identifier, label }]',
].join('\n');

// The label that belongs on a ticket when this marker is the still-
// unanswered tip of the thread. AUDIT is handled separately below, since
// whether it belongs here at all depends on the comment's own content.
export const LABEL_FOR_MARKER = {
  'NEEDS-INPUT': 'Needs Decision',
  PLAN: 'Needs Decision',
  'NEEDS-ACTION': 'Needs Action',
};

function commentAt(comment) {
  return Date.parse(comment?.createdAt ?? '');
}

/**
 * The most recent comment that is a turn: bookkeeping skipped (it records
 * what a workflow did, never a reply) and a plain, non-ruling
 * `**[FROM CLAUDE CHAT]**` comment skipped too — it is context, per
 * .claude/process.md, and advances no gate, so it must not read as
 * "answered" any more than a bookkeeping comment should read as
 * "unanswered." Null when there are no comments at all, or every comment is
 * one of those two shapes.
 */
export function newestTurn(comments) {
  const sorted = [...(comments ?? [])].sort((a, b) => commentAt(a) - commentAt(b));
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const body = sorted[i]?.body ?? '';
    if (isBookkeepingComment(body) || isContextChatComment(body)) continue;
    return sorted[i];
  }
  return null;
}

/**
 * The label a candidate's comment thread says should be on it right now, or
 * null when nothing is pending: the newest turn is a human reply (a ruling
 * or otherwise), or a CC comment whose marker isn't one this module tracks.
 */
export function pendingQuestionLabel(comments) {
  const turn = newestTurn(comments);
  if (!turn) return null;
  const body = turn.body ?? '';
  if (!isBotComment(body)) return null;
  const marker = commentMarker(body);
  if (marker === null) return null;
  if (marker === 'AUDIT') return auditHasQuestions(body) ? 'Needs Decision' : null;
  return LABEL_FOR_MARKER[marker] ?? null;
}

/**
 * The candidates whose label doesn't match what their thread says: each
 * {id, identifier, comments} becomes {id, identifier, label} when
 * pendingQuestionLabel is non-null, in the order given.
 */
export function reconcile(candidates) {
  const out = [];
  for (const candidate of candidates ?? []) {
    const label = pendingQuestionLabel(candidate?.comments);
    if (label) out.push({ id: candidate.id, identifier: candidate.identifier, label });
  }
  return out;
}

/**
 * The entry, with its I/O injected. Fails SOFT in the sense that matters
 * here — a malformed stdin is a usage error, same posture as
 * reconcile-status.mjs, not a claims.mjs-style closed failure: missing a
 * drifted label for one run costs one wasted selection at worst, and there
 * is no two-session hazard to fail closed against.
 */
export function run({ stdin, stdout, stderr }) {
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

  stdout(`${JSON.stringify(reconcile(candidates))}\n`);
  return EXIT.OK;
}
