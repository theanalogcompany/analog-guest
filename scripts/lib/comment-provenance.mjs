/**
 * comment-provenance.mjs — shared predicates for telling Claude Code's own
 * Linear comments apart from human input.
 *
 * The Linear MCP posts every comment under Jaipal's account, so author id is
 * not provenance (TAC-396). The working convention uses body prefixes
 * instead — `**[FROM CLAUDE CODE]**`, `**[FROM CLAUDE CHAT]**`,
 * `**[FROM CLAUDE CHAT — RULING...]**` — and these functions are the one
 * place that convention is parsed. scripts/slack-rulings.mjs imports them
 * rather than carrying its own copy, so the two can't drift apart the way
 * build-ready.yml's and audit-new-todo.yml's jq once did.
 *
 * Pure, no I/O: every function takes a comment body string and returns a
 * value. None of them reads `author` — the fixture that matters here is a
 * thread where every comment shares one author id, and these functions never
 * look at it.
 */

const CC_PREFIX = /^\s*\*\*\[FROM CLAUDE CODE\]\*\*/;
const CHAT_RULING_PREFIX = /^\s*\*\*\[FROM CLAUDE CHAT\s*[—-]\s*RULING/;
const CHAT_PLAIN_PREFIX = /^\s*\*\*\[FROM CLAUDE CHAT\]\*\*/;

// The first bracketed marker directly after the CC prefix. An optional run
// of literal asterisks between the prefix and the bracket is tolerated
// (mirrors the pre-existing BLOCKING_MARKER regex this replaces). A marker
// quoted mid-body, or on a comment that isn't CC's own, never matches —
// per .claude/process.md, "A comment's marker is the first [MARKER] after
// the prefix," not a substring match anywhere in the body.
const MARKER_AFTER_PREFIX =
  /^\s*\*\*\[FROM CLAUDE CODE\]\*\*\s*\**\[([A-Z][A-Z-]*)\]/;

/**
 * Linear stores a ticket description's brackets escaped (`\[AUDIT\]`), but
 * every comment body read back so far has come back unescaped (TAC-396's
 * audit). Unescape defensively before every check below, so a CC prefix that
 * does come back escaped still reads as CC's own rather than falling through
 * to "unrecognised = human."
 */
export function unescapeBrackets(text) {
  return text.replace(/\\([[\]])/g, '$1');
}

/** True when the comment opens with the `**[FROM CLAUDE CODE]**` prefix. */
export function isBotComment(body) {
  return CC_PREFIX.test(unescapeBrackets(body));
}

/**
 * The marker directly after the CC prefix (e.g. "PLAN", "NEEDS-INPUT"), or
 * null when the comment isn't CC's own or carries no marker there.
 */
export function commentMarker(body) {
  return unescapeBrackets(body).match(MARKER_AFTER_PREFIX)?.[1] ?? null;
}

/**
 * A ruling: opens `**[FROM CLAUDE CHAT — RULING`. This is the only
 * non-CC-prefixed comment shape that advances a gate (TAC-396, question 2) —
 * a plain `**[FROM CLAUDE CHAT]**` comment with no `— RULING` is context and
 * never counts, whatever it says.
 *
 * No call site in code: the consumer is the CHAT-vs-RULING rule in
 * .claude/process.md's "Comments" section and
 * .claude/commands/work-ticket.md's Phase 0 step 2b, prose an LLM follows
 * rather than code that imports this. Not dead code to clean up.
 */
export function isRulingComment(body) {
  return CHAT_RULING_PREFIX.test(unescapeBrackets(body));
}

/**
 * A plain `**[FROM CLAUDE CHAT]**` comment with no `— RULING` suffix.
 * Context, not a decision — never matched against ## Open questions.
 *
 * No call site in code either, same reason as isRulingComment above.
 */
export function isContextChatComment(body) {
  return CHAT_PLAIN_PREFIX.test(unescapeBrackets(body));
}

/**
 * The markers a workflow writes to record what it did, never a turn:
 * `.claude/process.md`'s "Comments" table and `build-ready.yml`'s own
 * `marker_is("CLAIM|RESUME-CLAIM|SLACK|DENIALS|OVER-LIMIT")` jq regex carry
 * this same list. Kept here too, so a JS consumer (TAC-446's Needs Decision
 * reconciler is the first) has one definition rather than a third copy —
 * the jq copy stays, since there is no way to share code between bash and
 * this module.
 */
export const BOOKKEEPING_MARKERS = ['CLAIM', 'RESUME-CLAIM', 'SLACK', 'DENIALS', 'OVER-LIMIT'];

/**
 * A bot comment whose marker is one of BOOKKEEPING_MARKERS. False for a
 * non-bot comment, and false for a bot comment with no marker or an
 * unrecognised one — this only ever answers "did a workflow file this as
 * bookkeeping," never "is this comment safe to ignore" in general.
 */
export function isBookkeepingComment(body) {
  const marker = commentMarker(body);
  return marker !== null && BOOKKEEPING_MARKERS.includes(marker);
}

// A section heading in the shape audit-ticket.md's own sections use: an
// optional markdown heading prefix, an optional "N. " number, then an
// ALL-CAPS name, wrapped in an optional run of asterisks either side.
// "**3. QUESTIONS**" and "## 3. QUESTIONS" both match; a numbered prose
// line such as "1. **What counts...**" does not, because its name would
// have to be entirely uppercase letters/spaces/slashes/dashes to the end
// of the line, and prose isn't.
const SECTION_HEADING = /^[ \t]*#{0,6}[ \t]*\**[ \t]*(?:\d+\.[ \t]*)?([A-Z][A-Z /-]*?)[ \t]*\**[ \t]*$/;

function sections(text) {
  const lines = text.split('\n');
  const found = [];
  let offset = 0;
  for (const line of lines) {
    const m = line.match(SECTION_HEADING);
    if (m) found.push({ headingStart: offset, contentStart: offset + line.length + 1, name: m[1].trim() });
    offset += line.length + 1;
  }
  return found;
}

/**
 * Whether an [AUDIT] comment's own QUESTIONS section still asks Jaipal
 * something, as opposed to a clean audit ("None.") or one that lists only
 * calls it decided without asking (audit-ticket.md, "Decided without
 * asking" — those carry a reason, never a question, whatever precedes
 * them). Heading-tolerant (see SECTION_HEADING above): real audits have
 * used both the bold-heading form the spec gives and a "## N. NAME" form.
 *
 * An audit whose QUESTIONS section this cannot find defaults to TRUE —
 * still asking — because an unparseable audit should read as needing a
 * look, not silently lose its label.
 */
export function auditHasQuestions(body) {
  const text = unescapeBrackets(body);
  const found = sections(text);
  const i = found.findIndex((s) => s.name.toUpperCase() === 'QUESTIONS');
  if (i === -1) return true;
  const start = found[i].contentStart;
  const end = i + 1 < found.length ? found[i + 1].headingStart : text.length;
  const section = text.slice(start, end);
  const beforeDecided = section.split(/decided without asking/i)[0];
  return /^[ \t]*\d+\.[ \t]/m.test(beforeDecided);
}
