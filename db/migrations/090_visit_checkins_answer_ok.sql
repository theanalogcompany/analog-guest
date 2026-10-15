-- 090: visit_checkins.answer gains 'ok' (TAC-588 hotfix, ruled 2026-10-15).
--
-- A check-in answer used to be read off the classifier's praisedExperience,
-- the review-ask signal, whose bar is set high on purpose. "it was good" fell
-- under it and was stored as 'not_yet'; after a receipt scan's item question,
-- which is the visit's only check-back, that left the visit with nothing to
-- follow it and no warm close (UAT, 2026-10-15). Answers are now read by a
-- reader of their own (lib/ai/read-checkin-answer.ts), with four outcomes, and
-- the ruling added a third stored value for the lukewarm one:
--
--   good     they liked it          the happy sign-off, with the review link
--   ok       "fine", "not bad"      no review link and no further question
--   bad      they did not           the complaint path, unchanged
--   not_yet  not tried, or unclear  unchanged
--
-- 'ok' needs no check-back (owesCheckback reads only null and 'not_yet') and
-- never carries the review link (deriveSignOffReviewAsk reads only 'good').
--
-- A WIDENING. Every row today satisfies the new check, so it is safe to apply
-- with the current code deployed, and it MUST be applied before the code that
-- writes 'ok' deploys: until then every 'ok' write fails the old check, and the
-- answer is lost on a turn that otherwise goes out.
--
-- NOT ADDITIVE: it drops and re-adds a constraint on a live table, so db:apply
-- refuses it by design. Apply by hand in Supabase Studio. The constraint name
-- was read from pg_constraint on 2026-10-15.

begin;

set local lock_timeout = '5s';

alter table visit_checkins drop constraint visit_checkins_answer_check;

alter table visit_checkins add constraint visit_checkins_answer_check
  check (answer in ('good', 'ok', 'bad', 'not_yet'));

commit;
