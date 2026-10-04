-- Phase 11: Streak Achievements V1
-- AUTHORITATIVE STREAK → THRESHOLD → AWARD ONCE → PROFILE UI
-- ============================================================
-- Audit findings addressed here:
--   Phase 9 shipped achievements + user_achievements (composite PK
--     (user_id, achievement_id), client SELECT-own only, no client write).
--   Phase 10 shipped public.touch_user_streak(), the only writer of
--     profiles.streak / profiles.last_activity_date (UTC calendar date).
--   No streak achievement catalog rows existed (target_type='streak'
--     is already valid in the core CHECK constraint).
--   Profile achievement UI reads the global catalog + user_achievements,
--     so new catalog rows appear automatically (earned / locked).
--
-- What this migration does (and nothing else):
--   1. Seeds the 3 V1 streak threshold rows (idempotent).
--   2. Replaces touch_user_streak() to award every newly satisfied
--      streak threshold inside the SAME transaction that persists the
--      streak. Streak semantics are unchanged.
--   3. Re-issues the internal-only EXECUTE revokes.
--
-- Not done here: no new RPC, no client award path, no RLS change,
-- no grants to authenticated/anon, no UI change, no second streak
-- function, no timezone fields.
-- ============================================================

-- ── 1. Seed streak achievement catalog (idempotent) ──────────
insert into public.achievements (id, name, description, category, target_type, target_value, icon)
values
  ('streak_3',  '3-Day Streak',  'Maintain a 3-day NOVA activity streak.',  'streak', 'streak',  3, '🔥'),
  ('streak_7',  '7-Day Streak',  'Maintain a 7-day NOVA activity streak.',  'streak', 'streak',  7, '🔥'),
  ('streak_14', '14-Day Streak', 'Maintain a 14-day NOVA activity streak.', 'streak', 'streak', 14, '🔥')
on conflict (id) do nothing;

-- ── 2. touch_user_streak: streak + streak achievements ───────
-- Supersedes 20260924000006 for touch_user_streak() only.
-- Unchanged: auth.uid() identity, UTC calendar date, FOR UPDATE lock,
--            same-day no-op for the streak columns, restart-on-gap.
-- Added:     award step driven by the authoritative streak value and
--            the achievements catalog (target_type = 'streak').
-- The award runs in this function, therefore in the caller's
-- transaction: if the streak update rolls back, the award rolls back.
create or replace function public.touch_user_streak()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_today date := (timezone('utc'::text, now()))::date;
  v_last date;
  v_streak integer;
begin
  if v_uid is null then
    raise exception 'Authentication required';
  end if;

  select last_activity_date, streak
    into v_last, v_streak
    from public.profiles
   where id = v_uid
     for update;

  if not found then
    raise exception 'Profile not found';
  end if;

  if v_last is null or v_last < v_today then
    if v_last is null or v_last < v_today - 1 then
      -- First activity ever, or one+ days missed → restart at 1
      v_streak := 1;
    else
      -- v_last = previous UTC calendar day → consecutive
      v_streak := greatest(coalesce(v_streak, 0), 0) + 1;
    end if;

    update public.profiles
       set streak = v_streak,
           last_activity_date = v_today,
           updated_at = timezone('utc'::text, now())
     where id = v_uid;
  else
    -- Same calendar day (or clock-skew future date): no double increment.
    -- Streak columns stay untouched; v_streak remains the authoritative
    -- persisted value used by the award step below.
    v_streak := coalesce(v_streak, 0);
  end if;

  -- Phase 11: award every streak threshold the authoritative streak satisfies.
  -- Thresholds come from the catalog, never from a client argument.
  -- Composite PK (user_id, achievement_id) + ON CONFLICT DO NOTHING →
  -- a retry can never duplicate a row or re-apply any reward.
  insert into public.user_achievements (user_id, achievement_id)
  select v_uid, a.id
    from public.achievements a
   where a.target_type = 'streak'
     and a.target_value <= v_streak
  on conflict do nothing;
end;
$$;

-- Internal only: no client EXECUTE. Owner (definer of parent RPCs) retains access.
revoke all on function public.touch_user_streak() from public;
revoke all on function public.touch_user_streak() from anon;
revoke all on function public.touch_user_streak() from authenticated;
