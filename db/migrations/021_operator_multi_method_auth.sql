-- TAC-272: operator multi-method auth (phone OTP OR email magic link to the
-- same operators row).
--
-- Splits operators.auth_user_id into two nullable columns — one per Supabase
-- auth method — and updates the RLS policy + linking flow so an operator can
-- sign in via either method and resolve to the same row.
--
-- Studio applies this file as a single transaction. Sequence chosen so every
-- step is valid against the state left by the previous step; any failure
-- rolls back the whole migration.

begin;

-- Step 1: add the new columns (nullable, no constraints yet).
alter table operators
  add column auth_user_id_phone uuid,
  add column auth_user_id_email uuid;

-- Step 2: backfill from the existing auth_user_id by probing auth.users.
-- Phone wins if both phone and email are set on the same auth.users row
-- (Supabase today provisions one identity per auth.users row, but defensive).
update operators o
   set auth_user_id_phone = u.id
  from auth.users u
 where o.auth_user_id = u.id
   and u.phone is not null;

update operators o
   set auth_user_id_email = u.id
  from auth.users u
 where o.auth_user_id = u.id
   and u.email is not null
   and o.auth_user_id_phone is null;

-- Step 3: integrity check — every existing operators row must have at least
-- one of the two columns set after backfill. Abort the whole migration with
-- a loud error if not (don't silently leave an operator unauth-able).
do $$
declare bad_count int;
begin
  select count(*) into bad_count
    from operators
   where auth_user_id_phone is null and auth_user_id_email is null;
  if bad_count > 0 then
    raise exception 'TAC-272 backfill incomplete: % operators have neither auth_user_id_phone nor auth_user_id_email', bad_count;
  end if;
end $$;

-- Step 4: generic backfill of unlinked auth.users rows. For each auth.users
-- row that no operator currently references via either new column, attempt
-- phone-then-email match against operators. Skip with NOTICE on collision
-- (>1 operator matches) or no-match — don't pick one arbitrarily, and don't
-- abort the migration (stranded auth users will self-heal via lazy-link on
-- next sign-in if/when a matching operator is provisioned).
do $$
declare
  u record;
  match_id uuid;
  match_count int;
begin
  for u in
    select id, phone, email
      from auth.users
     where not exists (
       select 1 from operators o
        where o.auth_user_id_phone = id or o.auth_user_id_email = id
     )
  loop
    if u.phone is not null then
      select id, count(*) over () into match_id, match_count
        from operators
       where phone_number = '+' || u.phone
         and auth_user_id_phone is null
       limit 1;
      if match_count = 1 then
        update operators set auth_user_id_phone = u.id where id = match_id;
        raise notice 'TAC-272 backfill: linked auth.users % to operators % via phone', u.id, match_id;
      elsif match_count > 1 then
        raise notice 'TAC-272 backfill SKIP: phone % matched % operators', u.phone, match_count;
      else
        raise notice 'TAC-272 backfill SKIP: phone % no matching operator', u.phone;
      end if;
    elsif u.email is not null then
      select id, count(*) over () into match_id, match_count
        from operators
       where email = u.email
         and auth_user_id_email is null
       limit 1;
      if match_count = 1 then
        update operators set auth_user_id_email = u.id where id = match_id;
        raise notice 'TAC-272 backfill: linked auth.users % to operators % via email', u.id, match_id;
      elsif match_count > 1 then
        raise notice 'TAC-272 backfill SKIP: email % matched % operators', u.email, match_count;
      else
        raise notice 'TAC-272 backfill SKIP: email % no matching operator', u.email;
      end if;
    end if;
  end loop;
end $$;

-- Step 5: replace the RLS policy. The live policy (operators_select_own,
-- created in Studio — not in any prior migration) was:
--   USING (auth_user_id = auth.uid())
-- We replace it with an OR clause across both new columns. IS NOT NULL
-- guards on each side defend against NULL-equality semantics under RLS.
drop policy if exists operators_select_own on operators;

create policy operators_select_own on operators
  for select to authenticated
  using (
    (auth_user_id_phone is not null and auth_user_id_phone = auth.uid())
    or
    (auth_user_id_email is not null and auth_user_id_email = auth.uid())
  );

-- Step 6: drop the orphan link_operator_auth RPC. This function was created
-- in Studio (not via any migration), references operators.auth_user_id
-- directly, and has zero call sites in app code — confirmed by grep across
-- the repo. Dropping it before the column drop avoids leaving a function
-- whose body fails at next invocation. The replacement is the TS-side
-- linkOperatorByAuthUser helper introduced in this same PR.
drop function if exists public.link_operator_auth(text, text);

-- Step 7: drop the old column + index. Safe now that the new columns are
-- populated, the new RLS policy is live, the orphan RPC is gone, and app
-- code is updated in the same PR.
drop index if exists idx_operators_auth_user_id;
alter table operators drop column auth_user_id;

-- Step 8: enforce UNIQUE on the new columns and CHECK that at least one
-- is set per row (so an operators row can never become unauth-able).
alter table operators
  add constraint operators_auth_user_id_phone_key unique (auth_user_id_phone),
  add constraint operators_auth_user_id_email_key unique (auth_user_id_email),
  add constraint operators_must_have_auth check (
    auth_user_id_phone is not null or auth_user_id_email is not null
  );

-- Step 9: partial indexes mirror TAC-258's idx_messages_review_state_pending
-- pattern — UNIQUE creates a btree already, but the WHERE-NOT-NULL filter
-- keeps the index tight for the common "lookup by auth.uid()" path.
create index idx_operators_auth_user_id_phone
  on operators(auth_user_id_phone) where auth_user_id_phone is not null;
create index idx_operators_auth_user_id_email
  on operators(auth_user_id_email) where auth_user_id_email is not null;

-- Step 10: enforce phone_number NOT NULL going forward (per ticket "Schema
-- notes"). Both current operators have phone_number set; future inserts
-- that omit it fail loud rather than producing half-auth rows.
alter table operators
  alter column phone_number set not null;

commit;
