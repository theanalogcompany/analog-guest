# lib/guests - per-guest state the agent reads and writes

Loads only when you work in this directory. Every helper is `RAGResult`-shaped and never
throws into the agent loop.

## Commitments

`guest_commitments` is the ledger of every promise the agent makes. Status machine:
`open -> pending_ack -> acknowledged | redeemed | expired | cancelled`, enforced by a CHECK
plus app-level CAS.

**Every transition is CAS-gated, and `rowcount === 1` is the guarantee.** That rowcount is
what anchors push idempotency: the orchestrator and the cron both gate their push on it, so
a concurrent imminent inbound and morning tick produce exactly one push.

**CAS predicates are scoped on `venue_id` AND `guest_id`, not on `id` and `status` alone.**
The id on the agent path comes from the **model**, copied out of the prompt block, so a
hallucinated or stale one transitioned whatever row it named - including another guest's or
another venue's - and returned what looked like a clean win.

Two cancel helpers exist and the split is deliberate: `markCancelled` gates on
`pending_ack` alone (the decline path), `cancelCommitmentForGuest` gates on
`open | pending_ack` (a reply that says a comp is off, which is usually `open` with no
arrival signal). Widening the first would change the decline path. Each carries a comment
pointing at the other.

Terminal states are excluded from cancellation deliberately - flipping a redeemed row would
erase the record that the venue honoured it.

### Dedup

At most one **open** commitment per `(venue_id, guest_id, lower(trim(description)))`.

**The app-level check inside `createCommitmentFromPending` is the enforcement; the partial
unique index is the backstop.**

`type` is deliberately **not** in the key: two open promises with the same description are
the same promise to the guest whatever the model labelled them. That creates one hazard,
closed by `shouldUpgrade`: a plain reuse would let an open `recommendation` absorb a later
operator-approved `comp`, returning `ok` while recording no comp - no code, arrival push
saying "recommendation", the operator's authorisation leaving no trace. The upgrade is
**one-directional**; a comp is never downgraded, because that would destroy a code the guest
already has.

The field set that moves on upgrade must be exact - a partial copy lets `code` silently go
missing, which is the original bug's exact shape.

Dedup reads **fail open** - proceed to insert, because losing a real commitment to a
hiccuped SELECT is worse than a duplicate the index will reject anyway.

### Expiry is owned elsewhere

`commitment-expiry.ts` is the **single derivation site** for every horizon. Scope is
obligations only (comp, hold, discount) via `OBLIGATION_TYPES`, which is an **allowlist** so
a fifth type defaults to being left alone rather than inheriting a negation nobody revisited.

`expires_at` is **server-derived, never agent-set.** An upgrade takes the comp horizon keyed
off the row's own `created_at`, never `now` - keying off `now` would extend the horizon every
time the guest mentioned it.

Do not derive an expiry anywhere else, including in the upgrade path. A second derivation
site is how the two drift.

`venueLocalInstant` is **two-pass** and must stay so: the offset has to be sampled at an
instant that is itself what you are solving for, and a single pass is silently an hour wrong
for any local time on the far side of a DST transition.

Escalation writes `escalated_at` as an **idempotency marker, not an audit trail** - it
answers one question, has a human been told. The reason rides on the PostHog event. Without
durable state the hourly cron re-fires the same alert for the whole window, which is not
noisy, it is worthless.

A failed `markEscalated` must `return`, not fall through to `markExpired` - falling through
moves the row out of `open`, which is the scan's own filter, so it is never examined again: a
comp closed with nobody told.

## Guest context

`guests.context` JSONB. Read through `getGuestContext` / `GuestContextSchema`, never via raw
`->` / `->>` paths - those bypass the expired-entry filter and the observation truncation.

**Writes are last-write-wins.** Two near-simultaneous inbounds both deep-merge against the
same baseline and the second clobbers the first. Accepted at pilot scale; the fix if pilot
data shows it is an optimistic-lock on `updated_at` with retry.

The identity columns (`first_name`, `last_name`) sync inside the **same** multi-SET UPDATE,
so they can never describe a different state than the JSONB.

**`learn_name` closes on any string in `first_name`.** The field is written verbatim and
THE-157 rules out length constraints on the LLM-facing schema, so an arbitrary string a
guest offers closes the intention permanently and renders into every later prompt.
Documented and accepted.

The patch schema and the persisted schema **deliberately diverge**: the patch side is slim
to protect the optional-field budget, the persisted side is widened with a union so older
rows still parse. Migration is lazy - the next emission that touches a field overwrites the
legacy shape in place.

## last_visit_at has three writers and they must agree

Two Square paths and the self-reported-order path. **Any writer of `last_visit_at` must
write `last_visit_precision` in the same statement**, or a guest who self-reports once
(`approximate`) and then becomes a POS regular is permanently blocked from the post-visit
ladder: the timestamp advances past a stale precision and nothing rewrites it.

`null` precision is **permissive** - it means nobody recorded one, which is every row
predating the column. Do not tidy the gate from `=== 'approximate'` to `!== 'pinned'`; that
silently switches off every legacy row.

---

Root `CLAUDE.md` is the index for the whole repo, `docs/decisions/README.md` holds the
cross-cutting decisions, and `README.md` is the navigable map of both.
