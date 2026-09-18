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
 * No call site yet as of TAC-396: the intended consumer is the
 * CHAT-vs-RULING distinction in .claude/process.md and
 * .claude/commands/work-ticket.md (prose an LLM follows, not code that
 * imports this), and that doc edit is blocked pending a [NEEDS-ACTION] on
 * the ticket — Claude Code's own tool refuses writes to those two files as
 * "sensitive" from a session with no human present to grant it. Not dead
 * code to clean up.
 */
export function isRulingComment(body) {
  return CHAT_RULING_PREFIX.test(unescapeBrackets(body));
}

/**
 * A plain `**[FROM CLAUDE CHAT]**` comment with no `— RULING` suffix.
 * Context, not a decision — never matched against ## Open questions.
 *
 * No call site yet either, same reason as isRulingComment above.
 */
export function isContextChatComment(body) {
  return CHAT_PLAIN_PREFIX.test(unescapeBrackets(body));
}
