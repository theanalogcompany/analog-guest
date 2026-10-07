-- 072: the recommendation-turn-one regression scenario
--
-- The harness reads `regression_scenarios` and treats the builtin set in
-- lib/eval/regression-scenarios.ts as a FALLBACK only (069's header), so a
-- scenario added in code alone is inert and silently so - migration 071's
-- whole lesson, arriving a second time.
--
-- What this one guards: the 2026-10-06 n=6 run printed "10/11 scenarios
-- passed" on v2.10.0-draft while the agent could not answer "what is a good
-- first order?" at all - 11/11 bare welcomes, with retrieval having already
-- supplied the answer. The gate was green because every knowledge-* scenario
-- asks a CLOSED factual question (wifi, milk, address, outside food, pastry
-- list), and the agent answers those correctly even while broken. No scenario
-- asked it to RECOMMEND anything, so nothing in the set could see the defect.
-- That is "distrust a gate whose true-positive history you cannot produce"
-- arriving as a false green for the second time in two days.
--
-- The bar is a menu token because the failure mode names no menu item at all:
-- broken scored 0/6, correct 5-6/6. `target` is the other half - a fix that
-- bought answering by killing move pursuit would sail through a reply-only
-- bar, and bare-hey cannot catch that on an inbound that asks something.
--
-- Lesson text is verbatim from lib/eval/regression-scenarios.ts, which stays
-- the seed and the fallback.
--
-- ADDITIVE, BUT THE DEPLOYED CODE READS IT - apply in Studio BEFORE merging.
-- Until it is applied the harness runs eleven scenarios and its PASS line does
-- not cover open recommendation asks at all.

begin;

insert into regression_scenarios
  (key, lesson, script, target, expect_first_name, no_turn_one_name_ask,
   expect_reply_contains, forbid_policy_keys)
values
  (
    'recommendation-turn-one',
    'The OPEN taste-ask on turn one, answered. Measured 2026-10-06 on v2.10.0-draft: "what is a good first order?" returned a bare welcome 11/11 while retrieval had already handed the model the answer ("the cafe recommends SoFi with a pastry"), and the n=6 gate was GREEN throughout - all five knowledge-* scenarios are CLOSED factual questions (wifi, milk, address, outside food, pastry list), which the agent answers correctly even while broken, so nothing in the set pointed at an open recommendation. That is the template v2.11.0 defect and the reason the guest''s own agenda became a move. The bar is a menu token because the failure names no menu item at all: broken scored 0/6, correct 5-6/6. The target set is the other half of the assertion - a fix that bought answering by killing move pursuit would pass a reply-only bar, and bare-hey alone would not catch it on an inbound that asks something.',
    '["what is a good first order?"]'::jsonb,
    '["find_their_thing","understand_order","what_they_came_for"]'::jsonb,
    null,
    true,
    'SoFi',
    '[]'::jsonb
  );

commit;
