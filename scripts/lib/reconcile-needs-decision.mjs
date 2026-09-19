/**
 * reconcile-needs-decision.mjs — derives whether Needs Decision should be on
 * a ticket, from its comment thread, reconciled on every build run
 * (TAC-446).
 *
 * The label drifts in both directions and both failures are silent: a
 * `[PLAN]` posted with a denied write never gets the label at all (TAC-396,
 * 2026-09-17 23:04), a plan or a ruling that clears every open question
 * doesn't take the label off (TAC-325's plan ended "Open questions: None"
 * with the label left on; TAC-389's ruling answered every open question and
 * the label stayed), and a stale label from an earlier cycle survives once
 * nothing removes it deliberately. This module makes the label a FUNCTION of
 * the thread rather than a side effect some write site has to remember:
 * fold the comments in order, and the fold IS the answer, so a missed write
 * anywhere corrects itself the next time this runs rather than persisting.
 *
 * The fold, left to right from `false`, per `.claude/process.md`'s Comments
 * table:
 *
 * - A bookkeeping comment (`comment-provenance.mjs`'s BOOKKEEPING_MARKERS —
 *   [CLAIM], [RESUME-CLAIM], [SLACK], [DENIALS], [OVER-LIMIT]): unchanged.
 *   They record what a workflow did, never a turn.
 * - [PLAN], [NEEDS-INPUT], [BUILD-SKIPPED], [AUDIT-SKIPPED], [SILENT-RUN],
 *   [TURN-LIMIT]: true. Each of these asks Jaipal something.
 * - [HUMAN-REVIEW-REQUIRED]: false. It means a hard-stop plan is approved
 *   and the build is Jaipal's own session — nothing left for the label to
 *   flag.
 * - [AUDIT]: true when its `3. QUESTIONS` section asks at least one
 *   numbered question outside a `Decided without asking` subsection, else
 *   false. See auditHasOpenQuestions.
 * - Any other bot comment — [NEEDS-ACTION] (a different label, Needs
 *   Action, not this one), [FINDING], the [POLLING-*] markers,
 *   [CANCELLED], a PR-link comment with no marker, or a bot comment with no
 *   marker at all (TAC-396's "Resume check, no new turn" and "Finding from
 *   TAC-394" comments, both real): unchanged.
 * - A plain `**[FROM CLAUDE CHAT]**` comment with no `— RULING`: unchanged.
 *   Context, never a decision (TAC-396).
 * - Anything else — unprefixed human input, or a `**[FROM CLAUDE CHAT —
 *   RULING` comment: false. A human ruling, whatever else it says, is why
 *   the label exists in the first place: it means Jaipal answered.
 *
 * Pure, no I/O, same shape as reconcile-status.mjs (TAC-466): a derive
 * function, a reconcile function that turns candidates into only the writes
 * needed, and a run() with I/O injected. Unlike that module, this one needs
 * no git or gh call — every input is already in the same Linear query
 * build-ready.yml's "Find tickets to work" step already runs, so run() only
 * ever touches stdin and stdout.
 *
 * Skips any candidate carrying Needs Action: Linear's Blocked On group holds
 * at most one, and correcting a simultaneous Needs Action + stray Needs
 * Decision isn't one of the documented incidents, so this leaves that case
 * alone rather than guessing at the right behaviour.
 */

import { commentMarker, isBookkeepingComment, isBotComment, isContextChatComment, unescapeBrackets } from './comment-provenance.mjs';

export const EXIT = { OK: 0, USAGE: 2 };

// Each of these always asks Jaipal something (.claude/process.md's Comments
// table) — the marker alone decides, whatever the comment says.
const ALWAYS_LABEL_MARKERS = new Set(['PLAN', 'NEEDS-INPUT', 'BUILD-SKIPPED', 'AUDIT-SKIPPED', 'SILENT-RUN', 'TURN-LIMIT']);

// A hard-stop plan is approved; the build is Jaipal's own session. Nothing
// left for the label to flag.
const NEVER_LABEL_MARKERS = new Set(['HUMAN-REVIEW-REQUIRED']);

function headingPattern(number, word) {
  // Tolerates both real forms seen in this repo's audits: a bold
  // `**3. QUESTIONS**` (TAC-396, TAC-325) and a markdown `## 3. QUESTIONS`
  // (TAC-389). The number's dot, the trailing asterisks and the case are
  // all optional/insensitive so a minor reformatting doesn't defeat it.
  return new RegExp(`(?:^|\\n)[ \\t]*(?:#{1,6}|\\*{1,2})[ \\t]*${number}\\.?[ \\t]*${word}[ \\t]*\\*{0,2}[ \\t]*(?=\\n|$)`, 'i');
}

const QUESTIONS_HEADING = headingPattern(3, 'QUESTIONS');
const FINDINGS_HEADING = headingPattern(4, 'FINDINGS');
const DECIDED_WITHOUT_ASKING_HEADING = /\*\*\s*Decided without asking\s*\*\*/i;
const NUMBERED_QUESTION_LINE = /^[ \t]*\d+\.[ \t]+\S/m;

/**
 * Whether an [AUDIT] comment's `3. QUESTIONS` section asks Jaipal at least
 * one numbered question, outside any `Decided without asking` subsection.
 *
 * Defaults to true — keep or add the label — when the `3. QUESTIONS`
 * heading can't be found at all. A malformed or unparseable audit should
 * fail toward "still needs a look," never toward silently clearing a label
 * that might be covering a real question.
 */
export function auditHasOpenQuestions(body) {
  const text = unescapeBrackets(body ?? '');
  const start = QUESTIONS_HEADING.exec(text);
  if (!start) return true;
  const afterHeading = text.slice(start.index + start[0].length);
  const end = FINDINGS_HEADING.exec(afterHeading);
  const section = end ? afterHeading.slice(0, end.index) : afterHeading;
  const decided = DECIDED_WITHOUT_ASKING_HEADING.exec(section);
  const questionsOnly = decided ? section.slice(0, decided.index) : section;
  return NUMBERED_QUESTION_LINE.test(questionsOnly);
}

/**
 * Whether Needs Decision should be on, folded over a ticket's comments in
 * `createdAt` order. Each comment needs only `body` and `createdAt`.
 */
export function deriveNeedsDecision(comments) {
  const sorted = [...(comments ?? [])].sort((a, b) => Date.parse(a?.createdAt ?? '') - Date.parse(b?.createdAt ?? ''));

  let state = false;
  for (const comment of sorted) {
    const body = comment?.body ?? '';

    if (isBookkeepingComment(body)) continue;

    if (isBotComment(body)) {
      const marker = commentMarker(body);
      if (marker === null) continue; // a CC comment with no marker: unchanged
      if (ALWAYS_LABEL_MARKERS.has(marker)) {
        state = true;
      } else if (NEVER_LABEL_MARKERS.has(marker)) {
        state = false;
      } else if (marker === 'AUDIT') {
        state = auditHasOpenQuestions(body);
      }
      // any other recognised or unrecognised bot marker: unchanged
      continue;
    }

    if (isContextChatComment(body)) continue; // plain CHAT: context, unchanged

    // Whatever is left is either unprefixed human input or a
    // `**[FROM CLAUDE CHAT — RULING` comment — both are a ruling.
    state = false;
  }
  return state;
}

export const USAGE = [
  'usage: node scripts/reconcile-needs-decision.mjs < candidates.json',
  'stdin: candidates, each with id, identifier, hasNeedsDecision, hasNeedsAction,',
  '  comments: [{ body, createdAt }]',
  'stdout: the writes to make, as [{ id, identifier, action: "add"|"remove" }]',
].join('\n');

/**
 * The writes to make for a set of candidates, in the order given. A
 * candidate already carrying Needs Action is skipped outright — see the
 * module header.
 */
export function reconcile(candidates) {
  const writes = [];
  for (const candidate of candidates ?? []) {
    if (candidate?.hasNeedsAction) continue;
    const derived = deriveNeedsDecision(candidate?.comments);
    const has = Boolean(candidate?.hasNeedsDecision);
    if (derived === has) continue;
    writes.push({ id: candidate.id, identifier: candidate.identifier, action: derived ? 'add' : 'remove' });
  }
  return writes;
}

/**
 * The entry, with its I/O injected. No git or gh call — every candidate
 * already carries everything this needs.
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

  const writes = reconcile(candidates);
  stdout(`${JSON.stringify(writes)}\n`);
  return EXIT.OK;
}
