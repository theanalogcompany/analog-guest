/**
 * linear-cli.mjs — the logic behind scripts/linear.mjs, the one way a CI
 * Claude Code session writes to Linear (TAC-444).
 *
 * Why it exists: the workflow prompts used to teach writes as a JSON request
 * body the session typed by hand, every newline and quote escaped, then sent
 * with curl. A multi-screen plan is hard to escape by hand, so sessions kept
 * reaching for jq to do it, on a file in the runner's temp folder. Claude Code
 * refuses jq (and rg, cat, wc, grep, sed, head, tail) on any file outside the
 * checkout, whatever the allowlist says, so every one of those attempts was
 * refused and the session fell back to escaping by hand. This takes the text
 * as a plain markdown file and does the encoding itself. `node` is not
 * path-checked and `Bash(node:*)` is already on both workflows' allowlists,
 * so no allowlist change was needed.
 *
 * No I/O at module load, and none outside `run`'s injected dependencies, so
 * the tests drive it with a fake fetch and a fake key.
 *
 * The key: read from the environment by the caller and passed in. It is only
 * ever sent as the Authorization header. Every line this module prints goes
 * through `redact` first, so a Linear error or a network error that echoes
 * the key still can't put it in a session transcript.
 */

import { commentMarker, isBotComment } from './comment-provenance.mjs';

export const LINEAR_ENDPOINT = 'https://api.linear.app/graphql';

export const EXIT = { OK: 0, FAILED: 1, USAGE: 2 };

const TIMEOUT_MS = 30_000;

// A ticket identifier (TAC-395) or an issue uuid. Both are what Linear's
// issue(id:) query accepts; anything else fails here with a clear message
// instead of as a GraphQL "entity not found".
const ISSUE_REF =
  /^(?:[A-Z][A-Z0-9]*-\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export const USAGE = [
  'usage:',
  '  node scripts/linear.mjs comment <issue> <file.md>',
  '  node scripts/linear.mjs describe <issue> <file.md>',
  '  node scripts/linear.mjs label add <issue> <label name>',
  '  node scripts/linear.mjs label remove <issue> <label name>',
  '  node scripts/linear.mjs state <issue> <state name>',
  '<issue> is a ticket identifier such as TAC-395, or an issue uuid.',
].join('\n');

const Q_ISSUE = 'query($id: String!) { issue(id: $id) { id identifier team { id } } }';
const M_COMMENT =
  'mutation($id: String!, $body: String!) { commentCreate(input: { issueId: $id, body: $body }) { success comment { id } } }';
const M_DESCRIBE =
  'mutation($id: String!, $description: String!) { issueUpdate(id: $id, input: { description: $description }) { success } }';
const Q_LABELS =
  'query($name: String!) { issueLabels(filter: { name: { eq: $name } }) { nodes { id name team { id } } } }';
const M_LABEL_ADD =
  'mutation($id: String!, $labelId: String!) { issueAddLabel(id: $id, labelId: $labelId) { success } }';
const M_LABEL_REMOVE =
  'mutation($id: String!, $labelId: String!) { issueRemoveLabel(id: $id, labelId: $labelId) { success } }';
const Q_STATES =
  'query($name: String!, $team: ID!) { workflowStates(filter: { name: { eq: $name }, team: { id: { eq: $team } } }) { nodes { id name } } }';
const M_STATE =
  'mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }';

/**
 * Replace every occurrence of the key with ***. An empty key redacts
 * nothing, matching the [DENIALS] step in both workflows.
 */
export function redact(text, key) {
  const s = String(text);
  if (!key) return s;
  return s.split(key).join('***');
}

function fail(error) {
  return { ok: false, error };
}

/**
 * argv (everything after the script path) → a command, or a usage error.
 * Exact argument counts: a stray extra word is far more likely a quoting
 * mistake than intent, and a label name with a space in it must arrive as
 * one quoted argument.
 */
export function parseArgs(argv) {
  const [verb, ...rest] = argv;
  const issueError = (issue) =>
    ISSUE_REF.test(issue ?? '')
      ? null
      : `"${issue ?? ''}" is not a ticket identifier (TAC-395) or an issue uuid`;

  if (verb === 'comment' || verb === 'describe') {
    if (rest.length !== 2) return fail(`${verb} takes exactly two arguments: <issue> <file.md>`);
    const [issue, file] = rest;
    const bad = issueError(issue);
    if (bad) return fail(bad);
    if (!file.trim()) return fail(`${verb} needs a file path`);
    return { ok: true, command: { kind: verb, issue, file } };
  }

  if (verb === 'label') {
    const [op, issue, name, ...extra] = rest;
    if (op !== 'add' && op !== 'remove') return fail('label takes add or remove first');
    if (issue === undefined || name === undefined || extra.length > 0) {
      return fail(`label ${op} takes exactly two arguments: <issue> "<label name>"`);
    }
    const bad = issueError(issue);
    if (bad) return fail(bad);
    if (!name.trim()) return fail('the label name is empty');
    return { ok: true, command: { kind: 'label', op, issue, name } };
  }

  if (verb === 'state') {
    if (rest.length !== 2) return fail('state takes exactly two arguments: <issue> "<state name>"');
    const [issue, name] = rest;
    const bad = issueError(issue);
    if (bad) return fail(bad);
    if (!name.trim()) return fail('the state name is empty');
    return { ok: true, command: { kind: 'state', issue, name } };
  }

  return fail(verb === undefined ? 'no command given' : `unknown command "${verb}"`);
}

/**
 * A comment must be one of Claude Code's own: the **[FROM CLAUDE CODE]**
 * prefix, then its marker. An unprefixed agent comment reads to the
 * automation as human input, which resumes a ticket as if Jaipal had
 * answered (.claude/process.md, "Comments"). The check is the provenance
 * module's, so this can't disagree with how the comment will be read back.
 */
export function checkCommentBody(body) {
  if (!body.trim()) return fail('the comment file is empty');
  if (!isBotComment(body)) {
    return fail('a comment must open with **[FROM CLAUDE CODE]**, then a blank line, then its [MARKER]');
  }
  if (commentMarker(body) === null) {
    return fail('the comment has the **[FROM CLAUDE CODE]** prefix but no [MARKER] straight after it');
  }
  return { ok: true };
}

export function checkDescriptionBody(body) {
  if (!body.trim()) return fail('the description file is empty; refusing to blank the description');
  return { ok: true };
}

function errorText(e) {
  return e instanceof Error ? e.message : String(e);
}

async function gql(deps, query, variables) {
  let res;
  try {
    res = await deps.fetch(LINEAR_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: deps.key },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    return fail(`the request to Linear failed: ${errorText(e)}`);
  }

  let text;
  try {
    text = await res.text();
  } catch (e) {
    return fail(`reading Linear's response failed: ${errorText(e)}`);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return fail(`Linear answered HTTP ${res.status} with a body that is not JSON: ${text.slice(0, 300)}`);
  }

  if (Array.isArray(json?.errors) && json.errors.length > 0) {
    const messages = json.errors.map((e) => e?.message ?? JSON.stringify(e)).join('; ');
    return fail(`Linear returned errors (HTTP ${res.status}): ${messages}`);
  }
  if (!res.ok) return fail(`Linear answered HTTP ${res.status}`);
  if (!json?.data) return fail('Linear returned no data');
  return { ok: true, data: json.data };
}

async function resolveIssue(deps, ref) {
  const r = await gql(deps, Q_ISSUE, { id: ref });
  if (!r.ok) return r;
  const issue = r.data.issue;
  if (!issue?.id) return fail(`no issue ${ref}`);
  return { ok: true, issue: { id: issue.id, identifier: issue.identifier ?? ref, teamId: issue.team?.id ?? null } };
}

// A label name can exist once per team and once workspace-wide. Take the one
// this ticket can carry: its own team's, or a workspace label.
async function resolveLabel(deps, name, teamId) {
  const r = await gql(deps, Q_LABELS, { name });
  if (!r.ok) return r;
  const nodes = r.data.issueLabels?.nodes ?? [];
  const usable = nodes.filter((l) => !l.team || l.team.id === teamId);
  if (usable.length === 0) return fail(`no label named "${name}" that this ticket can carry`);
  if (usable.length > 1) return fail(`${usable.length} labels are named "${name}"; refusing to guess`);
  return { ok: true, id: usable[0].id };
}

async function resolveState(deps, name, teamId) {
  if (!teamId) return fail('the ticket has no team, so its states cannot be looked up');
  const r = await gql(deps, Q_STATES, { name, team: teamId });
  if (!r.ok) return r;
  const nodes = r.data.workflowStates?.nodes ?? [];
  if (nodes.length === 0) return fail(`no state named "${name}" in this ticket's team`);
  if (nodes.length > 1) return fail(`${nodes.length} states are named "${name}"; refusing to guess`);
  return { ok: true, id: nodes[0].id };
}

// Anything but a literal success: true is a failed write.
function succeeded(data, field) {
  return data?.[field]?.success === true;
}

async function execute(command, deps) {
  if (command.kind === 'comment' || command.kind === 'describe') {
    let body;
    try {
      body = await deps.readFile(command.file);
    } catch (e) {
      return fail(`cannot read ${command.file}: ${errorText(e)}`);
    }
    const checked = command.kind === 'comment' ? checkCommentBody(body) : checkDescriptionBody(body);
    if (!checked.ok) return checked;

    const found = await resolveIssue(deps, command.issue);
    if (!found.ok) return found;
    const { issue } = found;

    if (command.kind === 'comment') {
      const r = await gql(deps, M_COMMENT, { id: issue.id, body });
      if (!r.ok) return r;
      if (!succeeded(r.data, 'commentCreate')) return fail('Linear did not return success: true for the comment');
      const id = r.data.commentCreate.comment?.id;
      return { ok: true, message: `ok: comment posted on ${issue.identifier}${id ? ` (${id})` : ''}` };
    }

    const r = await gql(deps, M_DESCRIBE, { id: issue.id, description: body });
    if (!r.ok) return r;
    if (!succeeded(r.data, 'issueUpdate')) return fail('Linear did not return success: true for the description');
    return { ok: true, message: `ok: description updated on ${issue.identifier}` };
  }

  const found = await resolveIssue(deps, command.issue);
  if (!found.ok) return found;
  const { issue } = found;

  if (command.kind === 'label') {
    const label = await resolveLabel(deps, command.name, issue.teamId);
    if (!label.ok) return label;
    const add = command.op === 'add';
    const field = add ? 'issueAddLabel' : 'issueRemoveLabel';
    const r = await gql(deps, add ? M_LABEL_ADD : M_LABEL_REMOVE, { id: issue.id, labelId: label.id });
    if (!r.ok) return r;
    if (!succeeded(r.data, field)) return fail(`Linear did not return success: true for the label ${command.op}`);
    return {
      ok: true,
      message: add
        ? `ok: label "${command.name}" added to ${issue.identifier}`
        : `ok: label "${command.name}" removed from ${issue.identifier}`,
    };
  }

  const state = await resolveState(deps, command.name, issue.teamId);
  if (!state.ok) return state;
  const r = await gql(deps, M_STATE, { id: issue.id, stateId: state.id });
  if (!r.ok) return r;
  if (!succeeded(r.data, 'issueUpdate')) return fail('Linear did not return success: true for the state change');
  return { ok: true, message: `ok: ${issue.identifier} moved to ${command.name}` };
}

/**
 * The whole CLI. Returns the exit code; prints one line on stdout on success
 * and one on stderr on failure, both redacted.
 *
 * deps: { argv, env, fetch, readFile(path) → Promise<string>, stdout(text), stderr(text) }
 */
export async function run({ argv, env, fetch, readFile, stdout, stderr }) {
  const key = env.LINEAR_API_KEY ?? '';
  const out = (text) => stdout(`${redact(text, key)}\n`);
  const err = (text) => stderr(`${redact(text, key)}\n`);

  try {
    const parsed = parseArgs(argv);
    if (!parsed.ok) {
      err(`linear.mjs: ${parsed.error}\n${USAGE}`);
      return EXIT.USAGE;
    }
    if (!key) {
      err('linear.mjs: LINEAR_API_KEY is not set');
      return EXIT.USAGE;
    }

    const result = await execute(parsed.command, { key, fetch, readFile });
    if (!result.ok) {
      err(`linear.mjs: failed: ${result.error}`);
      return EXIT.FAILED;
    }
    out(result.message);
    return EXIT.OK;
  } catch (e) {
    err(`linear.mjs: failed unexpectedly: ${errorText(e)}`);
    return EXIT.FAILED;
  }
}
