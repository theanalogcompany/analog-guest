-- 022_add_guest_demo_flag.sql
-- adds an is_demo flag to guests for investor demos + personal smoke-tests
-- of pilot venues (tac-284). when a guest is flagged, the agent runtime
-- gives that guest the fast, ungated experience:
--   - applyApprovalPolicyStage short-circuits to action='send', bypassing
--     the tac-212 approval policy gate IN FULL — including the comp regex
--     backstop. visibility is preserved via the demo_bypassed_approval_gate
--     PostHog event (Slack-relayed when the comp backstop would have fired).
--   - scheduleAndSend is invoked with skipHumanFeelDelay=true, so the
--     mark-as-read pause + typing-indicator pre-roll are skipped.
-- real guest traffic at the same venue is unaffected — the flag is per-guest.
--
-- semantically distinct from is_test_synthetic (migration 007):
--   - is_test_synthetic marks rows SEEDED by run-test-scenarios so analytics
--     + future rollups can exclude them. those guests carry synthetic phone
--     numbers and exist only to drive recognition state during onboarding.
--   - is_demo marks a REAL-phone-number guest (e.g. a teammate's own phone)
--     whose runtime DELIVERY behavior should bypass friction.
-- the two flags are independent — a guest can be either, both, or neither.
--
-- per-venue isolation: guests.venue_id is NOT NULL, so a demo guest is still
-- scoped per-venue. flipping a guest to demo at one venue does not affect the
-- same phone number's guest row at another venue.
--
-- operator surface: flipping the flag is a Supabase Studio SQL UPDATE keyed
-- on (phone_number, venue_id) — see CLAUDE.md "Common gotchas". No UI in v1.

alter table guests
  add column is_demo boolean not null default false;

-- partial index: only demo rows index, real guests don't pay the cost.
-- mirrors migration 007's idx_guests_test_synthetic shape.
create index idx_guests_demo on guests(venue_id, is_demo)
  where is_demo = true;
