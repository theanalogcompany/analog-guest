# lib/operator - the building blocks behind app/api/operator/*

Loads only when you work in this directory.

Every helper here is `RAGResult`-shaped (`{ok: true, ...} | {ok: false, error}`). Failure
modes are distinguished (`message_not_found | out_of_allowlist | db_error`) even when the
route flattens them, so logging can tell them apart later.

## Venue scope: one field used to mean two opposite things

`allowedVenueIds: string[]` carried opposite meanings on the two auth paths. Empty meant
**every venue** on the cookie path (`verifyAnalogAdminAccess` throws 403 unless the operator
is an analog admin *before* building the array) and **no venue** on the bearer path
(`verifyOperatorRequest` builds it from literal `operator_venues` rows). The idiom
`if (ids.length > 0) applyFilter()` is correct on the first and a fleet-wide grant on the
second. It was pasted onto bearer data at four call sites.

**Read a scope through the helpers in `lib/auth/venue-scope.ts`** - `allowsVenue`,
`bearerAllowsVenue`, `venueScopeDeniesAll`, `venueFilterIds`. Never reach into an arm.
Narrowing on `kind` typechecks, so `scope.kind === 'venues' && scope.ids.length > 0 && ...`
is the original bug with one extra clause. Do not use the property access, the
destructure or the bracket form.

`bearerAllowsVenue` exists separately because `allowsVenue` returns true for the fleet-wide
arm, so passing a cookie scope into an operator helper would dispatch against any venue.

**Also wrong, and easy to miss:** a caller that length-tests `venueFilterIds`' *result*
before applying the filter contains no `.ids`, typechecks, and restores the fleet grant.

## Out of scope and non-existent are the same 404

"No such message" and "a message at a venue outside this operator's allowlist" both return
`{"error":"not_found"}`, byte-identical on the wire, so a client cannot probe for the
existence of another venue's data. The helpers keep the two apart internally
(`message_not_found` vs `out_of_allowlist`) for logging; the route flattens them. An invalid
UUID is also a 404, not a 400 - the Contract enumerates no 400, and a non-UUID id does not
exist by definition.

This rule lived in the root `CLAUDE.md` section that the index restructure removed, and for a
while its only written home was an unindexed planning document. It is a property of every
route under `app/api/operator/*`, so it lives here.

## Queue projections are a cross-repo Contract

`listPendingQueue`, `listHeadsUpQueue`, `listOperatorConversations`, `loadGuestThread`.

The client parses these lists **all-or-nothing**, so one unexpected null empties the queue
for every operator at that venue, with a TestFlight-length recovery. Consequences:

- **Contract fields are ALWAYS PRESENT** - empty array, empty string, or an explicit null
  the Contract names. Never `undefined`, so the client never branches on presence.
- `phoneFallback` / `guestPhoneFallback` stay non-nullable `''` for a phoneless guest.
- **`tsc` cannot protect you here.** Regenerated `db/types.ts` types every RPC return column
  as non-null, so a genuine null is invisible to the compiler. Check each field against the
  Contract's literal payload, not against what the implementation emits.

`guestChannel` is derived **differently** on the two surfaces, deliberately. On a queue draft
it is the draft row's own `messages.channel`, because dispatch routes on the card's channel
and the field must mean "what approving this card will do". On a conversation summary there
is no draft, so it defers to `resolveConversationChannel`.

`replyWindowExpiresAt` is Meta's true deadline with **no margin subtracted** - the client
applies its own, and the server's send gate closes 5 minutes earlier. Its null is two-valued
and `guestChannel` separates them: a text conversation has no window; an Instagram
conversation with a null here has an *unknown* window, not an expired one.

## Card copy

**No card-facing string contains an em dash.** These are read fast on a phone mid-shift,
where an em dash is a pause the reader has to parse. That covers every key of the label map
plus the fallback.

`labelForTrigger(code, carrier)` is the one resolver behind both `reviewReason` and
`reviewTriggerLabels`, so a card's primary line and its chips cannot disagree.

**A label must be true on every case the trigger fires for.** Three were not: one said "this
offers something free" while firing on holds and discounts too; one claimed the venue chose
to review these while also firing on the fleet-wide default; one said a message was held
behind an earlier one when the row *was* the replacement. Check what your trigger actually
fires on before writing its sentence.

Model-written text (a commitment description) reaching a card is stripped of em and en
dashes and capped at a word boundary first. Checking the **static** map
cannot see a dash arriving that way.

`messages.review_reason` holds values outside `APPROVAL_TRIGGERS` -
`operator_decline_initiated`, `crisis_safety_reply`, `generation_failed`,
`instagram_send_failed`, `media_only_inbound` - stamped by the path that owns them. `ExtraReviewReason` exists so the label map stays exhaustive at compile
time.

## Dispatch

`dispatchOperatorOutbound` flips `review_state` optimistically, sends, then writes
`status='sent'`. Refusals that must happen **before** the flip: `empty_body`,
`no_phone_number`. After the flip the card is out of the queue, so a late refusal strands the
row.

The known v1 gap: if the provider throws after the flip, the row sits `approved` with a null
`provider_message_id`, invisible to the queue and unretryable. Recovery is manual.

Post-dispatch it reads `messages.pending_commitment` and `pending_cancellation` and acts on
them, and fires intention recording with the **dispatched body** - never `row.body`, so a
question the operator edited out is not recorded as asked.

That recording call is synchronous and runs *after* the guest already has the message, so it
must not be able to reject the dispatch. Wrap anything you add there.

## Reached-guest condition

Which messages reached the guest (inbound, or outbound whose `review_state` is not pending
and whose `status` is `sending`/`sent`/`delivered`) is written in **three** places: here as a
PostgREST `.or()` built from `DELIVERED_OUTBOUND_STATUSES`, and in two migrations' SQL. It
has to run in SQL before the row cap, so it cannot be one function.

Change all three together, and **find** which migration currently defines each function
rather than assuming one: a superseded migration reads fine while the live function goes
unchecked - which happened.

`sending` counts as delivered here and **not** in `count_outbound_responses`. The Sendblue
webhook maps QUEUED to `sending` and callbacks arrive out of order, so a message the guest
read can sit there indefinitely. Leaving it out of a reply-rate count under-counts; marking
it never-sent in a prompt invites the model to say it again.

`recent_context` deliberately has **no** `body <> ''` filter - a photo-only text is context
the operator needs. Do not add one.

---

Root `CLAUDE.md` is the index for the whole repo, `docs/decisions/README.md` holds the
cross-cutting decisions, and `README.md` is the navigable map of both.
