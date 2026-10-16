# Instagram token URLs harness

Checks that no URL built in `lib/messaging/instagram/oauth-exchange.ts` is ever logged,
returned, or put in an error (TAC-516). It matters because two calls there, the long-lived
exchange and the token refresh, carry the access token in the query string: graph.instagram.com
refused header auth on both in production on 2026-10-16.

What it checks:

- **What Meta is sent** on the two changed calls: the unversioned Graph root path,
  `access_token` (and `client_secret` on the exchange only) in the query, no Authorization
  header, and Meta's new token and a 60-day expiry back on success.
- **Every outcome of every call in the module leaks nothing:** success, a body that is not
  JSON, Meta's error quoting the URL, a 200 with nothing usable, and network throws with the
  URL in the message, `stack`, `cause.message` and `cause.input` (where Node's fetch really
  puts it), a timeout and an abort. A leak is the token, the app secret, the authorization
  code, `access_token=`, `client_secret=` or a Meta host in the returned result or in anything
  sent to `console` while the call ran.
- **A throw with the URL in the error's name and `cause.code`**, the two fields a network
  failure does carry, comes back as `'unknown'`. This one runs only on the three calls the
  module catches itself: the account read and the webhook subscription go through `graph.ts`,
  which passes both fields through, and their URLs carry no token.
- **Failures still say what failed:** a Meta refusal keeps code, type and fbtrace_id, and a
  connection reset keeps `TypeError` / `ECONNRESET`.
- **The source:** no `console`, no `throw`, no read of a response's `url`, and exactly one
  place that builds a URL at the Graph root.

**Run by hand. Not in CI, not an npm script, not a test suite.** Run it when you change
`oauth-exchange.ts` or the failure shaping in `graph.ts`.

## Run it

From the repo root, on Node 24:

```bash
env -i PATH="$PATH" HOME="$HOME" npx tsx scripts/harness/instagram-token-urls/harness.ts
```

`env -i` because it must pass with no credential in the process. It prints one `PASS` or
`FAIL` line per check and exits non-zero if any failed. No network, no database.

## It can fail

When it shipped, each of these alone was applied to the module and the harness failed:
logging the query on a network throw (11 checks), carrying `e.message` as the error name (11),
keeping Meta's error message (3), returning `response.url` on a malformed body (3), and the
pre-fix module with header auth (9).
