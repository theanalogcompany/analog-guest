#!/usr/bin/env node
/**
 * slack-rulings.mjs — two-way sync between Linear "Needs Ruling" and Slack.
 *
 * Outbound: a ticket enters Needs Ruling → one Slack message, its questions
 *           in the body. The Slack timestamp is recorded on the ticket in a
 *           [SLACK] marker comment.
 * Inbound:  replies in that Slack thread → posted to Linear as human input,
 *           which is what lets the build workflow resume the ticket.
 *
 * The marker comment is EDITED, never re-created, so it never becomes the
 * newest comment on the ticket. If it did, the build workflow would read a
 * [FROM CLAUDE CODE] comment as the last word and refuse to resume.
 *
 * Env: LINEAR_API_KEY, SLACK_BOT_TOKEN, SLACK_CHANNEL_ID
 */

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
      state: { name: { eq: "Needs Ruling" } }
    }) {
      nodes {
        id identifier title url description
        labels { nodes { name } }
        comments { nodes { id body createdAt } }
      }
    }
  }
`);

const issues = data.issues.nodes;
console.log(`${issues.length} ticket(s) in Needs Ruling`);

// Pull the numbered questions out of the ticket body, if it has a block.
function questionsOf(description) {
  if (!description) return null;
  const m = description.match(/##\s*Open questions\s*\n([\s\S]*?)(?=\n##\s|\s*$)/i);
  if (!m) return null;
  const text = m[1].trim();
  return text.length ? text.slice(0, 2500) : null;
}

function markerOf(issue) {
  return issue.comments.nodes.find(c => c.body.includes(MARKER)) || null;
}

function parseMarker(body) {
  const ts = body.match(/ts=([0-9.]+)/)?.[1];
  const synced = body.match(/synced=([0-9.]+)/)?.[1] ?? '0';
  return { ts, synced };
}

function markerBody(ts, synced) {
  return `**[FROM CLAUDE CODE]**\n\n${MARKER} channel=${CHANNEL} ts=${ts} synced=${synced}`;
}

// ── outbound: post tickets that have never been posted ──────────────────────

for (const issue of issues) {
  if (markerOf(issue)) continue;

  const kind = issue.labels.nodes.some(l => l.name === 'Needs Action')
    ? ':wrench: *You have to run something*'
    : ':thinking_face: *Decision needed*';

  const questions = questionsOf(issue.description);

  const text = [
    `${kind}  <${issue.url}|${issue.identifier}>  ${issue.title}`,
    '',
    questions ?? '_Questions are in the ticket — open it._',
    '',
    '_Reply in this thread. `1: A. 2: yes. 3: skip.`_',
  ].join('\n');

  const posted = await slack('chat.postMessage', {
    channel: CHANNEL,
    text,
    unfurl_links: false,
  });

  await linear(
    `mutation($id: String!, $body: String!) {
       commentCreate(input: { issueId: $id, body: $body }) { success }
     }`,
    { id: issue.id, body: markerBody(posted.ts, posted.ts) }
  );

  console.log(`posted ${issue.identifier}`);
}

// ── inbound: pull thread replies back into Linear ───────────────────────────

for (const issue of issues) {
  const marker = markerOf(issue);
  if (!marker) continue;

  const { ts, synced } = parseMarker(marker.body);
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

  // EDIT the marker, never create a new one — a new bot comment would become
  // the newest on the ticket and block the resume we just enabled.
  await linear(
    `mutation($id: String!, $body: String!) {
       commentUpdate(id: $id, input: { body: $body }) { success }
     }`,
    { id: marker.id, body: markerBody(ts, newest) }
  );

  await slack('reactions.add', {
    channel: CHANNEL,
    timestamp: ts,
    name: 'white_check_mark',
  }).catch(() => {}); // already reacted is fine

  console.log(`synced ${fresh.length} reply(ies) from ${issue.identifier}`);
}

console.log('done');
