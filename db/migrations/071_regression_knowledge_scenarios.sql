-- 071: the five knowledge-retrieval regression scenarios
--
-- These existed in lib/eval/regression-scenarios.ts since the Le Mil's site
-- ingest and had NEVER RUN. The harness reads `regression_scenarios` and
-- treats the builtin set as a fallback only (069's header), so a scenario
-- added in code alone is inert - and silently so. The 2026-10-05 n=6 run on
-- v2.10.0-draft printed "6/6 scenarios passed", which reads as full coverage
-- and was in fact the six rows seeded by 069 and 070. The scenario encoding
-- the very fix that run was certifying, knowledge-cafe-address, was not among
-- them.
--
-- That is the "distrust a gate whose true-positive history you cannot
-- produce" rule arriving as a false green rather than a miss. The harness
-- warns loudly when the TABLE is unreadable, but a table that reads fine and
-- is merely incomplete looks identical to a passing run. Nothing closes that
-- gap in general; this migration closes it for these five.
--
-- Lessons are verbatim from lib/eval/regression-scenarios.ts, which stays the
-- seed and the fallback. Each bar is a DISTINCTIVE token present in exactly
-- one source, never a generic word, so the bar cannot be met by a model being
-- agreeable about a question it cannot answer.
--
-- ADDITIVE, BUT THE DEPLOYED CODE READS IT - apply in Studio BEFORE merging.
-- Until it is applied, the harness runs seven scenarios and its PASS line
-- does not cover retrieval or the venue profile at all.

begin;

insert into regression_scenarios
  (key, lesson, script, target, expect_first_name, no_turn_one_name_ask,
   expect_reply_contains, forbid_policy_keys)
values
  (
    'knowledge-wifi',
    'Guest-phrased cafe question answered from the venue site. Pre-ingest this retrieved "window seats on weekdays for reading" - seating advice for a Wi-Fi question - because no corpus row carried the answer. The bar is "password" rather than "wifi": the entry says guests should ask the team for the current password, so the token can only come from that entry and not from a model being agreeable.',
    '["do u have wifi?"]'::jsonb,
    '[]'::jsonb,
    null,
    false,
    'password',
    '[]'::jsonb
  ),
  (
    'knowledge-pastries',
    'Pre-ingest this retrieved "what Malenad tastes like" for a pastry question. "Butter and Rose" is the Foster City micro-bakery and appears in exactly one entry, so the bar cannot be met by a plausible guess. This fact was also one of the 11 lost when voicenote transcripts stopped being knowledge, and it is now sourced from the venue site instead (lib/rag/knowledge-source-roles.ts).',
    '["what pastries do you have?"]'::jsonb,
    '[]'::jsonb,
    null,
    false,
    'Butter and Rose',
    '[]'::jsonb
  ),
  (
    'knowledge-milk',
    'A dietary question needs the real answer, not a hedge. "Straus" is the organic A2 dairy and appears in one entry; a model with no retrieval would say "we have oat milk" or deflect, and both fail this bar. Guards the specific-fact half of retrieval rather than the register half.',
    '["what milk do you use?"]'::jsonb,
    '[]'::jsonb,
    null,
    false,
    'Straus',
    '[]'::jsonb
  ),
  (
    'knowledge-cafe-address',
    'The fabricated-address case, and the reason for template v2.10.0. The cafe is at 1330 Polk St. That did NOT reach the prompt: run-turn.ts rendered the venue section as a 4000-char slice of the venue_info JSON, Le Mil''s row is 22,258 chars, so the cut landed inside `menu` and menu was the only key the model ever saw. Measured 2026-10-05 on v2.9.0: "where are you located?" and "what''s your address?" each returned a Polk Street number found nowhere in the venue''s data, differing between two runs of the identical prompt, and the gate sent both. Retrieval cannot rescue this - the ingest added roughly ten stockist and farmers-market addresses, so all four chunks on this question are OTHER locations, and the one corpus row carrying the cafe''s own address frames it as a grand opening on 15 August 2026, in the past. The bar is the address itself because nothing downstream can catch a fabricated fact.',
    '["where are you located?"]'::jsonb,
    '[]'::jsonb,
    null,
    false,
    '1330 Polk',
    '[]'::jsonb
  ),
  (
    'knowledge-outside-food',
    'The regression test for the self-dedupe bug. "Outside food and drinks are not permitted at Le Mil''s cafe" was extracted correctly and then DROPPED as a 0.8966 duplicate of "walk-in only and does not take reservations" - a different fact entirely. Short policy sentences about one subject embed close because they share shape, and the numeric-and-names guard cannot save them because they carry neither. The fix is that entries from one source page are never collapsed (scripts/ingest-venue-site-pure.ts). NOTE on what this scenario now proves: the same fact is also in venue_info.amenities.notes, which template v2.10.0 renders into every prompt, so a pass no longer tells you the corpus row is back - it tells you the fact is reachable by some route. The corpus half is checked by re-crawling, not here.',
    '["can i bring my own food?"]'::jsonb,
    '[]'::jsonb,
    null,
    false,
    'outside food',
    '[]'::jsonb
  );

commit;
