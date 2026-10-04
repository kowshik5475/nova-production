-- NOVA AI PLAY — PHASE 6
-- Display-name editing: narrowly scoped SECURITY DEFINER RPC.
-- ============================================================
-- profiles today:
--   id uuid PK → auth.users
--   display_name text NOT NULL
--   RLS: SELECT own only (auth.uid() = id). No client UPDATE policy.
--
-- This migration adds ONE function that updates ONLY display_name
-- for auth.uid(). It does not grant table UPDATE, does not touch
-- xp / level / streak / wallet, and does not alter existing policies.
-- ============================================================

create or replace function public.update_own_display_name(p_display_name text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_name text;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  v_name := btrim(coalesce(p_display_name, ''));

  if length(v_name) = 0 then
    raise exception 'Display name is required';
  end if;

  if length(v_name) > 50 then
    raise exception 'Display name must be 50 characters or fewer';
  end if;

  update public.profiles
     set display_name = v_name,
         updated_at = timezone('utc'::text, now())
   where id = v_uid;

  if not found then
    raise exception 'Profile not found';
  end if;

  return v_name;
end;
$$;

revoke all on function public.update_own_display_name(text) from public;
revoke all on function public.update_own_display_name(text) from anon;
grant execute on function public.update_own_display_name(text) to authenticated;
