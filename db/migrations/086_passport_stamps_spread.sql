-- 086: passport stamps fill a spread, not a page (TAC-587)
--
-- 085 put six stamps on a page, top page first, and held that with
-- `passport_stamps_page_from_seq`: page = (seq - 1) / 6 + 1. TAC-587 fills a
-- spread's two facing pages together: twelve stamps to a spread, each landing
-- on whichever of the spread's two pages lib/passport/layout.ts picks. The
-- page is no longer a function of seq, only the spread is, so the check is
-- widened to "this stamp's page is one of its spread's two pages".
--
-- IT ONLY WIDENS. Every page the old check allowed, the new one allows: the
-- old page (seq - 1) / 6 + 1 is always 2 * ((seq - 1) / 12) + 1 or + 2. The
-- 7 live rows (one test guest at the Le Mil's test venue, 2026-10-14) all
-- pass it. The (venue, guest, page, slot) and (venue, guest, seq) keys are
-- unchanged and still serialise two stamps racing for one guest.
--
-- The constraint name was verified live in pg_constraint before writing this:
-- `passport_stamps_page_from_seq CHECK ((page = (((seq - 1) / 6) + 1)))`.
--
-- NOT db:apply. A DROP on a live table is outside what the applier accepts,
-- by design. Applied by hand in Supabase Studio, from the TAC-587
-- [NEEDS-ACTION], BEFORE the code merges: the new code puts stamp 3 on page
-- 2, which the old check rejects. Applying it first is safe, because the code
-- deployed before it still writes pages the new check allows.
--
-- Rollback restores the old check. It aborts once any stamp sits on its
-- spread's second page out of seq order, and that is the right outcome: those
-- rows are real. Roll the code back instead and leave the check wide.

begin;

set local lock_timeout = '5s';

alter table passport_stamps drop constraint passport_stamps_page_from_seq;

alter table passport_stamps add constraint passport_stamps_page_in_spread
  check (page in (2 * ((seq - 1) / 12) + 1, 2 * ((seq - 1) / 12) + 2));

commit;
