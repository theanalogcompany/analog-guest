-- TAC-285: link_operator_auth RPC for operator-app sign-in.
--
-- analog-operator/lib/auth/operator.ts calls supabase.rpc('link_operator_auth',
-- { p_phone, p_email }) right after Supabase OTP / magic-link verification. The
-- RPC looks up the operators row by phone or email, stamps auth.uid() into the
-- matching auth_user_id_* column, bumps last_seen_at, and returns the row.
--
-- Context: migration 021 dropped a prior link_operator_auth(text, text) Studio
-- RPC as orphaned ("zero call sites in app code"). That rationale reverses now
-- that analog-operator has a real caller and the auth_user_id_* columns are
-- stable. Re-introducing the RPC name is deliberate; the TS-side
-- linkOperatorByAuthUser helper (lib/auth/link-operator.ts) remains the
-- canonical path for analog-guest's own auth surfaces (admin cookie session +
-- bearer-token API).
--
-- Phone-format contract: caller passes E.164 with leading `+`; we compare
-- directly to operators.phone_number (also `+`). We never touch
-- auth.users.phone (which Supabase stores without `+`).
--
-- Idempotent: repeated calls from the same auth.uid() re-set the same column
-- to the same value. UNIQUE constraints on (auth_user_id_phone,
-- auth_user_id_email, phone_number, email) catch cross-row collisions; the
-- function lets those bubble as Postgres errors rather than swallow.

begin;

create or replace function public.link_operator_auth(
  p_phone text,
  p_email text
) returns operators
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_op  operators%rowtype;
begin
  -- SECURITY DEFINER bypasses RLS, so we re-assert the authn boundary and the
  -- input contract here. Both raises are programming-error conditions: the
  -- caller must be inside an authenticated request and must supply at least
  -- one identity.
  if v_uid is null then
    raise exception 'link_operator_auth: auth.uid() is null';
  end if;
  if p_phone is null and p_email is null then
    raise exception 'link_operator_auth: both p_phone and p_email are null';
  end if;

  -- Phone-first branch (email used only when phone is null).
  if p_phone is not null then
    update operators
       set auth_user_id_phone = v_uid,
           last_seen_at = now()
     where phone_number = p_phone
    returning * into v_op;
  else
    update operators
       set auth_user_id_email = v_uid,
           last_seen_at = now()
     where email = p_email
    returning * into v_op;
  end if;

  -- Not found → return NULL (client maps to a `not_provisioned` toast).
  -- Found → return the updated row so the caller has the operators record
  -- without a second round-trip.
  if found then
    return v_op;
  else
    return null;
  end if;
end
$$;

revoke all on function public.link_operator_auth(text, text) from public, anon;
grant execute on function public.link_operator_auth(text, text) to authenticated;

commit;
