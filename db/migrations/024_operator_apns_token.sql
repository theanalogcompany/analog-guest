-- 024_operator_apns_token.sql
-- adds APNs device-token columns to operators for tac-207. when the
-- approval-policy gate (tac-212) routes a draft to the operator queue with
-- a severe trigger (model_flagged, comp_regex_backstop, or
-- fidelity_below_auto_send_floor), sendDraftFlaggedPush fans out to every
-- operator whose allowed-venue allowlist covers the draft's venue and whose
-- apns_device_token is non-null, then POSTs a push to api.push.apple.com.
--
-- additive + nullable so the migration is backwards-compatible (per
-- CLAUDE.md "Ordering for backwards-incompatible migrations" — order
-- doesn't matter here; existing operators stay null until they register
-- via POST /api/operator/devices from the analog-operator app).
--
-- single token per operator on the operators table itself rather than a
-- separate operator_devices table — pilot scope is one device per operator.
-- multi-device support is deferred post-pilot; revisiting would mean
-- extracting these columns into a child table, but the rest of the push
-- pipeline (jwt signer, http/2 client, fanout query) stays unchanged.
--
-- partial index mirrors migration 022's idx_guests_demo shape: only the
-- subset of operators that have actually registered pays for indexing.
-- the fanout query joins operator_venues to operators and filters on
-- apns_device_token IS NOT NULL — the partial index covers that predicate.

alter table operators
  add column apns_device_token text,
  add column apns_token_updated_at timestamptz;

-- partial index: only rows with a registered token are indexed.
create index idx_operators_apns_token on operators(id)
  where apns_device_token is not null;
