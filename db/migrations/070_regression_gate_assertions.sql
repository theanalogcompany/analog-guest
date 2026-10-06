-- 070: gate assertions on regression scenarios
--
-- A scenario can now assert what the POLICY GATE did, not just what the
-- reply text looked like. Two columns on regression_scenarios, shapes in
-- lib/schemas/regression.ts:
--
--   expect_reply_contains   bar: some reply bubble contains this substring
--                           (case-insensitive). The vacuity guard for gate
--                           assertions - a forbidden policy that never had
--                           the chance to fire proves nothing.
--   forbid_policy_keys      ceiling: the gate matching any of these policy
--                           keys on any turn fails the scenario outright.
--
-- The lesson that forced this (2026-10-05): every Le Mil's v2 draft
-- mentioning the bare site ("on lemils.com") queued on unverified_link at
-- p=0.91, every turn - provided_links was derived from this turn's retrieved
-- knowledge through a scheme-only regex, so the corpus's bare-domain form
-- made the allowlist permanently empty. The fix moved provided_links to the
-- curated venue_info.links list and taught the Jev question the TAC-509
-- rulings (a bare domain in prose is not a link; schemeless equals https://).
-- The seeded scenario below is that lesson as an enforced test; the harness
-- records per-turn gate matches in regression_run_units so a breach shows
-- which policy fired.
--
-- Existing stored units lack turns[].gateMatched; the schema defaults it to
-- [] on read, so old runs still render.
--
-- ADDITIVE, BUT THE DEPLOYED CODE READS IT - apply in Studio BEFORE merging
-- (the harness and the /admin/regression loader both select the new columns;
-- both degrade to the builtin set with a warning, so the order is about
-- avoiding the fallback banner, not an outage).

begin;

alter table regression_scenarios
  add column expect_reply_contains text,
  add column forbid_policy_keys jsonb not null default '[]'::jsonb;

-- Seed: the lemils.com unverified_link lesson, verbatim from
-- lib/eval/regression-scenarios.ts.
insert into regression_scenarios
  (key, lesson, script, target, expect_first_name, no_turn_one_name_ask,
   expect_reply_contains, forbid_policy_keys)
values
  (
    'bare-domain-link',
    'A bare domain in prose ("on lemils.com") is not a link, and provided_links is the CURATED venue_info.links allowlist, never derived from this turn''s knowledge retrieval (TAC-509 rulings, lib/ai/url-detector.ts). Caught live 2026-10-05: the knowledge-derived allowlist missed the corpus''s bare-domain form, so every draft mentioning the site queued on unverified_link at p=0.91 - and queued again on the next turn, because the gate is memoryless by design. comp_leak is forbidden too (owner-ruled 2026-10-05): "orders over $50 ship free" is a standing store policy from the knowledge, not a per-guest giveaway - it matched 3/3 before the criteria clause. The mention bar keeps this from passing vacuously on a reply that never names the site.',
    '["can i buy your coffee online?"]'::jsonb,
    '[]'::jsonb,
    null,
    false,
    'lemils.com',
    '["unverified_link", "comp_leak"]'::jsonb
  );

commit;
