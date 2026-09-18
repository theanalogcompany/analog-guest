#!/usr/bin/env node
/**
 * slack-rulings.mjs — two-way sync between tickets blocked on Jaipal and Slack.
 *
 * Blocked on Jaipal is a label, not a status: any open ticket carrying
 * Needs Decision or Needs Action, whatever its status. "Open" means not Done,
 * Canceled or Duplicate. Duplicate is its own status type in this workspace,
 * not a canceled one, so the filter lists it explicitly.
 *
 * Outbound: a ticket gains a Blocked On label → one Slack message, its
 *           questions in the body. The Slack timestamp is recorded on the
 *           ticket in a [SLACK] marker comment. That thread belongs to the
 *           ticket for life: when what the ticket is blocked on changes, the
 *           update goes out as a reply in the same thread, never as a new
 *           channel message.
 * Inbound:  replies in that Slack thread → posted to Linear as human input,
 *           which is what lets the build workflow resume the ticket. It
 *           resumes only Ready and In Progress tickets, so for any other
 *           status the message says plainly that replying won't unblock it.
 *
 * The marker's q= field is a hash of what the ticket is blocked on: its
 * ## Open questions block plus the id of its newest [NEEDS-INPUT],
 * [HUMAN-REVIEW-REQUIRED], [PLAN], [NEEDS-ACTION], [AUDIT-SKIPPED],
 * [BUILD-SKIPPED], [SILENT-RUN] or [TURN-LIMIT] comment. A thread reply
 * goes out only when that hash changes, so a ticket sitting unanswered gets
 * nothing run after run. (TAC-406)
 *
 * The marker comment is EDITED, never re-created, so each ticket carries
 * exactly one. Creating it still makes it the newest comment, after any
 * ruling already on the ticket. build-ready.yml and work-ticket.md both skip
 * [SLACK], [CLAIM], [RESUME-CLAIM], [DENIALS] and [OVER-LIMIT] comments
 * when deciding who spoke last, so the marker never buries a ruling.
 *
 * Env: LINEAR_API_KEY, SLACK_BOT_TOKEN, SLACK_CHANNEL_ID
 */

import { createHash } from 'node:crypto';
import { commentMarker, isBotComment } from './lib/comment-provenance.mjs';

const LINEAR = process.env.LINEAR_API_KEY;
const SLACK = process.env.SLACK_BOT_TOKEN;
const CHANNEL = process.env.SLACK_CHANNEL_ID;

if (!LINEAR || !SLACK || !CHANNEL) {
  console.error('Need LINEAR_API_KEY, SLACK_BOT_TOKEN and SLACK_CHANNEL_ID.');
  process.exit(1);
}

const MARKER = '[SLACK]';

async function linear(query, variables = {}) {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: LINEAR },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error('Linear: ' + JSON.stringify(body.errors));
  return body.data;
}

async function slack(method, payload, verb = 'POST') {
  const url = `https://slack.com/api/${method}`;
  const opts =
    verb === 'GET'
      ? { headers: { Authorization: `Bearer ${SLACK}` } }
      : {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${SLACK}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify(payload),
        };
  const target =
    verb === 'GET' ? `${url}?${new URLSearchParams(payload)}` : url;
  const body = await (await fetch(target, opts)).json();
  if (!body.ok) throw new Error(`Slack ${method}: ${body.error}`);
  return body;
}

// ── fetch everything blocked on Jaipal ──────────────────────────────────────

const data = await linear(`
  query {
    issues(first: 100, filter: {
      team: { key: { eq: "TAC" } },
      labels: { some: { name: { in: ["Needs Decision", "Needs Action"] } } },
      state: { type: { nin: ["completed", "canceled", "duplicate"] } }
    }) {
      nodes {
        id identifier title url description
        state { name }
        labels { nodes { name } }
        comments(first: 250) { nodes { id body createdAt } }
      }
    }
  }
`);

const issues = data.issues.nodes;
console.log(`${issues.length} ticket(s) blocked on Jaipal`);

// The whole ## Open questions block, or null when the ticket has none.
function openQuestionsBlock(description) {
  if (!description) return null;
  const m = description.match(/##\s*Open questions\s*\n([\s\S]*?)(?=\n##\s|\s*$)/i);
  if (!m) return null;
  const text = m[1].trim();
  return text.length ? text : null;
}

// Pull the numbered questions out of the ticket body, if it has a block.
function questionsOf(description) {
  return openQuestionsBlock(description)?.slice(0, 2500) ?? null;
}

// process.md: an agent comment opens with the prefix, a blank line, then the
// marker. Matching the marker in that position, rather than anywhere in the
// body, keeps a ruling or an audit that merely quotes a marker from counting
// as a new blocking state. isBotComment/commentMarker (scripts/lib/
// comment-provenance.mjs, TAC-396) are the shared, tested definition of that
// rule — carrying a second copy here is what let this file and
// build-ready.yml's jq drift in the first place.
const BLOCKING_MARKERS = new Set([
  'NEEDS-INPUT',
  'HUMAN-REVIEW-REQUIRED',
  'PLAN',
  'NEEDS-ACTION',
  'AUDIT-SKIPPED',
  'BUILD-SKIPPED',
  'SILENT-RUN',
  'TURN-LIMIT',
]);

function isBlockingComment(body) {
  return isBotComment(body) && BLOCKING_MARKERS.has(commentMarker(body) ?? '');
}

function newestBlockingComment(issue) {
  return (
    issue.comments.nodes
      .filter(c => isBlockingComment(c.body))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .at(-1) ?? null
  );
}

// Strip what re-saving a ticket can change without changing its words:
// Linear's backslash escapes, line endings, surrounding whitespace, blank
// lines.
function normalize(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\\([^\w\s])/g, '$1')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n');
}

// What the ticket is blocked on, as 16 hex characters, or 'none' when there
// is nothing to post. Hashes the whole block rather than the 2,500 characters
// that get posted, so a change past the cut still counts.
function blockingHash(issue) {
  const block = openQuestionsBlock(issue.description);
  const comment = newestBlockingComment(issue);
  if (!block && !comment) return 'none';
  return createHash('sha256')
    .update(`${block ? normalize(block) : ''}\0${comment?.id ?? ''}`)
    .digest('hex')
    .slice(0, 16);
}

function markerOf(issue) {
  return issue.comments.nodes.find(c => c.body.includes(MARKER)) || null;
}

function parseMarker(body) {
  const ts = body.match(/ts=([0-9.]+)/)?.[1];
  const synced = body.match(/synced=([0-9.]+)/)?.[1] ?? '0';
  // Absent on markers written before TAC-406.
  const q = body.match(/\bq=([0-9a-f]{16}|none)\b/)?.[1];
  return { ts, synced, q };
}

function markerBody(ts, synced, q) {
  const qField = q ? ` q=${q}` : '';
  return `**[FROM CLAUDE CODE]**\n\n${MARKER} channel=${CHANNEL} ts=${ts} synced=${synced}${qField}`;
}

function kindOf(issue) {
  return issue.labels.nodes.some(l => l.name === 'Needs Action')
    ? ':wrench: *You have to run something*'
    : ':thinking_face: *Decision needed*';
}

// build-ready.yml resumes only these statuses. A reply on a ticket anywhere
// else lands as a comment and starts nothing, which is worse than no invite
// to reply at all: it reads as answered.
const RESUMABLE_STATES = new Set(['Ready', 'In Progress']);

function replyLine(issue) {
  // A skip notice needs an edit to the ticket, whatever its status: the
  // automations read the Repo: line and labels, never a reply.
  const newest = newestBlockingComment(issue);
  const marker = newest ? commentMarker(newest.body) : null;
  if (marker === 'BUILD-SKIPPED') {
    return '_Replying here will not unblock it: the ticket needs splitting into one ticket per repo. Open the ticket._';
  }
  if (marker === 'SILENT-RUN') {
    return '_The last build run on this ticket posted nothing. Read the run linked in the ticket before replying: a reply here re-runs it, and until the cause is fixed the same failure repeats._';
  }
  if (marker === 'TURN-LIMIT') {
    return '_The last build run on this ticket ran out of turns. The ticket says what was pushed. A reply here resumes the build from the pushed branch; if the ticket is too big for one run, split it instead._';
  }
  if (marker === 'AUDIT-SKIPPED') {
    return '_Replying here will not unblock it: the ticket needs its Repo: line or repo labels fixed. Open the ticket._';
  }
  if (RESUMABLE_STATES.has(issue.state.name)) {
    return '_Reply in this thread. `1: A. 2: yes. 3: skip.`_';
  }
  return `_This ticket is in ${issue.state.name}, and nothing acts on a reply while it is there. Replying here will not unblock it. Open the ticket to see what it needs._`;
}

function firstPostText(issue) {
  return [
    `${kindOf(issue)}  <${issue.url}|${issue.identifier}>  ${issue.title}`,
    '',
    questionsOf(issue.description) ?? '_Questions are in the ticket — open it._',
    '',
    replyLine(issue),
  ].join('\n');
}

function updateText(issue) {
  const newest = newestBlockingComment(issue);
  const marker = newest ? commentMarker(newest.body) : null;
  return [
    `:arrows_counterclockwise: *Updated*  ${kindOf(issue)}  <${issue.url}|${issue.identifier}>`,
    ...(marker ? [`Newest in the ticket: \`[${marker}]\``] : []),
    '',
    questionsOf(issue.description) ?? '_Details are in the ticket — open it._',
    '',
    replyLine(issue),
  ].join('\n');
}

// ── outbound: one channel message per ticket, then replies in its thread ────

for (const issue of issues) {
  const marker = markerOf(issue);
  const q = blockingHash(issue);

  if (!marker) {
    const posted = await slack('chat.postMessage', {
      channel: CHANNEL,
      text: firstPostText(issue),
      unfurl_links: false,
    });

    await linear(
      `mutation($id: String!, $body: String!) {
         commentCreate(input: { issueId: $id, body: $body }) { success }
       }`,
      { id: issue.id, body: markerBody(posted.ts, posted.ts, q) }
    );

    console.log(`posted ${issue.identifier}`);
    continue;
  }

  const { ts, synced, q: postedQ } = parseMarker(marker.body);
  if (!ts || postedQ === q) continue;

  // A marker from before TAC-406 has no q. Its channel message already
  // carried the questions, so record the current state without posting.
  if (postedQ !== undefined && q !== 'none') {
    await slack('chat.postMessage', {
      channel: CHANNEL,
      thread_ts: ts,
      text: updateText(issue),
      unfurl_links: false,
    });
    console.log(`replied in thread for ${issue.identifier}`);
  } else {
    console.log(`recorded q for ${issue.identifier}, nothing posted`);
  }

  const body = markerBody(ts, synced, q);
  await linear(
    `mutation($id: String!, $body: String!) {
       commentUpdate(id: $id, input: { body: $body }) { success }
     }`,
    { id: marker.id, body }
  );
  // Inbound runs later in this pass and rebuilds the marker from this body.
  marker.body = body;
}

// ── inbound: pull thread replies back into Linear ───────────────────────────

for (const issue of issues) {
  const marker = markerOf(issue);
  if (!marker) continue;

  const { ts, synced, q } = parseMarker(marker.body);
  if (!ts) continue;

  const thread = await slack(
    'conversations.replies',
    { channel: CHANNEL, ts, limit: '50' },
    'GET'
  );

  // Skip the parent, anything from a bot, anything already synced.
  const fresh = (thread.messages || [])
    .filter(m => m.ts !== ts)
    .filter(m => !m.bot_id && !m.subtype)
    .filter(m => Number(m.ts) > Number(synced));

  if (!fresh.length) continue;

  for (const reply of fresh) {
    // No [FROM CLAUDE CODE] prefix — this must read as human input, because
    // that is what the build workflow keys on to resume the ticket.
    const body = `**Ruling, via Slack**\n\n${reply.text}`;
    await linear(
      `mutation($id: String!, $body: String!) {
         commentCreate(input: { issueId: $id, body: $body }) { success }
       }`,
      { id: issue.id, body }
    );
  }

  const newest = fresh[fresh.length - 1].ts;

  // EDIT the marker, never create a new one. markerOf reads whichever [SLACK]
  // comment comes first, so a second marker could leave synced= stale and the
  // same replies would be copied to Linear again.
  await linear(
    `mutation($id: String!, $body: String!) {
       commentUpdate(id: $id, input: { body: $body }) { success }
     }`,
    { id: marker.id, body: markerBody(ts, newest, q) }
  );

  await slack('reactions.add', {
    channel: CHANNEL,
    timestamp: ts,
    name: 'white_check_mark',
  }).catch(() => {}); // already reacted is fine

  console.log(`synced ${fresh.length} reply(ies) from ${issue.identifier}`);
}

console.log('done');
