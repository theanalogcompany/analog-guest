# lib/messaging/instagram - the Meta half

Loads only when you work in this directory.

Meta app on the **Instagram Login** path: `graph.instagram.com` and an Instagram User token.
Never `graph.facebook.com`, never a Page token. Modules here are imported **by path** -
there is no barrel, because a barrel is what would let a test hand a stubbed verifier to
code that needs the real one.

## Routing depends on one hand-set column

`venues.instagram_account_id` maps an inbound delivery to a venue. It has **no write path
outside the connect flow** and for existing venues was set by hand in Studio. Until it is
set, every delivery is skipped as `venue_not_found` and nothing is saved.

The value is the webhook's `entry.id`. Get it with the venue's token from
`GET /me?fields=user_id,username` and take **`user_id`**, not `id` - `id` is app-scoped, and
storing it routes every message to no venue at all, silently. Confirm by the logs:
`instagram_event_skipped` stops and `instagram_event_persisted` appears.

## Signature verification

`x-hub-signature-256` is **enforced**. A delivery that fails it, and every delivery while
`INSTAGRAM_APP_SECRET` is unset or empty, gets 403 with nothing from its body logged. That
403 is the route's only non-2xx.

Three rules, each written from a real hole:

1. **Never log a digest, not even from a log-only scaffold.** HMAC is keyed by our secret
   over their body, so our digest of any body is a valid signature for that body until the
   secret rotates. `verifyInstagramSignature` returns a reason and never the digest, and a
   test fails if any outcome carries one.
2. **An empty secret is a valid HMAC key.** `createHmac('sha256', '')` does not throw; it
   produces a digest anyone can compute. Refuse an empty secret in the **verifier**, not only
   in the route, and test each layer separately - with both guards present, removing either
   still refuses an ordinary request, so a plain 403 assertion cannot tell whether the other
   is there.
3. **Truncate AFTER comparing, never before.** Cutting a received signature to digest length
   first lets a long forgery match by being trimmed to fit.

`verify-webhook.ts` here is **not** `lib/messaging/verify-webhook.ts`. Sendblue echoes its
secret in plaintext in a header and is not HMAC at all; the reusable precedent is Square's.

Timing safety is asserted the only way it can be: the test mocks `node:crypto` with the real
module spread and `timingSafeEqual` wrapped in a spy, asserting the spy decides the
comparison. A constant-time compare cannot be told from `===` by its result.

**Replay is open.** Meta signs no timestamp and no nonce, so a captured genuine delivery
stays valid until the secret rotates. Dedupe on the message `mid`, which Meta's retries
require anyway.

## The route answers 200 on almost everything

`app/api/webhooks/instagram/route.ts` returns 200 on every path including a parse failure, an
unhandled throw, and **a failed save** - where Sendblue and Square reserve 5xx so the provider
retries. That is deliberate: Meta disables a subscription after repeated non-2xx, and a
non-transient failure would keep failing until the channel switched off with no alert.

The cost is stated rather than hidden: **a failed save loses that event.** And if genuine
deliveries start getting the 403, Meta will eventually disable the subscription and nothing
here alerts. A rotated or cleared secret is the likely cause - fix the secret or revert
rather than debug in place.

## Parsing and persistence

`parse-events.ts` is pure: a verified delivery becomes typed events in delivery order (Meta
batches `entry[] x messaging[]`), told apart by the item's own keys. The guest comes from the
**recipient** on an echo.

Anything unrecognised becomes an `unhandled` event carrying **key names, never values**, and
is logged and acknowledged rather than dropped silently.

`handle-events.ts` saves them one at a time, each in its own try/catch, following the Sendblue
order: venue, guest, duplicate check on `provider_message_id`, insert.

- **Every insert names `channel: 'instagram'` explicitly.** Migration 048 defaults the column
  to `'text'`, so an omitted channel silently records an Instagram message as a text.
- Only a guest's own message or postback creates a guest. An echo or a read for an unknown
  IGSID is skipped, so staff messaging a supplier from the venue account creates no guest.
- **`is_echo` marks the venue's side, not staff.** A reply typed by hand in the Instagram app
  and the agent's own API sends both arrive as echoes.
- A read receipt's key is `read`, not `messaging_seen` (that is only the subscription field
  name), and it names one `mid`, so read state is per message.
- `provider_sent_at` is the `messaging[]` item's own `timestamp`, **never `entry.time`**,
  which is when Meta sent the delivery (0.4 to 1.1 s later, far more on a redelivery).

Guest IGSIDs seen are 16 digits where the account id is 17, so the two kinds of ID do not
share a length.

## Echoes race our own sends

The send path learns the `mid` only from the Send API response, and Meta can deliver the echo
first. **Nothing orders the two, and the code must not assume an order.** An agent send whose
insert collides on `provider_message_id` fills in that echo row; an operator send folds the
echo into the card. When our write lands first, the echo is skipped as a duplicate and the row
keeps `provider_sent_at` NULL - so no reader may assume an outbound Instagram row has it.

**The structural guard on external resolution:** an echo arriving while the reply window is
**expired** cannot be one of our own sends, because every send is gated on the window being
open. Nothing in an echo itself distinguishes ours from staff's. Relaxing this into "an echo
arrived, clear a card" would let the agent silently close its own cards. It uses Meta's true
deadline with **no margin** - subtracting the margin makes the expired set larger, and that is
exactly where one of our sends could still be in flight.

## Outbound

Only `lib/agent/dispatch-instagram-reply.ts` and `lib/operator/dispatch-instagram-outbound.ts`
may import `send.ts`, `window.ts`, `reply-check.ts`, `send-target.ts` or `graph.ts`.
`window-import-guard.test.ts` enforces it in both directions.

- **24-hour reply window** computed from `provider_sent_at` on the newest inbound row that has
  one. `INSTAGRAM_WINDOW_MARGIN_MS` is 5 minutes, a judgement against roughly 11 s of known
  error.
- **1000-byte cap** (UTF-8 bytes, not characters), refused rather than truncated.
- A **follow-up never auto-sends** on Instagram, whatever the window says.
- `mark_seen`, `typing_on`, `typing_off` carry **only** `recipient` and `sender_action` - Meta
  forbids merging one into a send, so it is always two calls. `typing_on` is sent twice
  because it expires after 20 seconds and generation alone runs to ~11 s at p90. Nothing sends
  `typing_off` after a delivered reply; the send clears it.
- Every sender action **fails open** and nothing on the reply path reads one.

## Tokens

`resolveInstagramAccessToken` is the cutover: an active `instagram_credentials` row wins, and a
venue with no row falls back to `INSTAGRAM_ACCESS_TOKEN`. Deploying the credential path changed
nothing for any venue until one connected.

Two decisions in it: an **expired** venue token is returned rather than refused, because Meta
answers with code 190 which is a true specific signal where refusing would report
`token_missing` and say something false. A credential that **cannot be decrypted** fails hard
and never falls back, because the venue already points at its own account and borrowing the
shared token reads as a mysterious Meta rejection rather than the encryption-key problem it is.

It lives in `credentials-store.ts`, not `send-target.ts`, because `send-target` is one of four
guarded outbound modules and four non-outbound callers need credentials.

`fetchConnectedAccount` reads **`user_id`, not `id`** - see the routing section.

**Documented deviation:** Meta's docs show `ig_exchange_token` and `refresh_access_token` with
the token in the query string; both send it in the Authorization header instead. That
`graph.instagram.com` accepts header auth there is a Meta-side fact this repo cannot verify.
Both fail loudly if it is wrong.

## Three signature schemes, three parsers

Do not merge them. The webhook HMAC (above), our own OAuth `state` (payload first), and Meta's
`signed_request` (**signature first**). Swapping the halves of the third verifies nothing while
looking reasonable.

## Profile refresh

`refresh-profile.ts`, handed to `waitUntil`, never awaited. Writes `instagram_username`,
`instagram_name`, `instagram_profile_fetched_at` only.

**The display name never goes into `first_name`.** The agent would greet the guest by a name
they never gave the venue, and `learn_name` would close on it.

Meta's error message is dropped everywhere in this directory, because it quotes the scoped ID -
or, on the token paths, the token. Errors carry code, subcode, type and `fbtrace_id` only.

Four failure events, kept distinct so none reads as another: `instagram_profile_token_missing`,
`instagram_profile_token_rejected` (code 190), `instagram_profile_wrong_account` (all error
level), and `instagram_profile_fetch_failed` (warn - a privacy refusal, a block, a timeout).

**When a second venue connects, every message from its guests logs
`instagram_profile_wrong_account` until tokens are per venue.** That is deliberate: the refresh
compares the token's own account with the venue's before fetching, so the failure is never
mistaken for Meta or a guest's privacy setting.

## Deletion

`delete-venue-data.ts` **tombstones** the scoped id (`deleted:<uuid>`) rather than nulling it.
`guests_must_have_identity` forbids nulling phone and scoped id together, so the approved
redaction list would have failed every deletion request - found at implementation time, because
no fixture in this repo enforces a CHECK. One tombstone per guest; a shared value collides on
the unique constraint.

**A redaction list written from the columns you remember is a list of the columns you
remember.** Enumerate from the schema. `messages.ungrounded_claims` holds verbatim guest
excerpts and `pending_commitment` holds model-written descriptions of them.

## Fixtures

`fixtures/` holds real deliveries captured 2026-09-17 with IDs, `mid`s and text replaced,
because this repo is public. **Never commit a delivery's signature beside its body.** Copy
fixtures from logs by script, never by hand - a hand transcription put a postback's `mid`
outside `postback` instead of inside it.
