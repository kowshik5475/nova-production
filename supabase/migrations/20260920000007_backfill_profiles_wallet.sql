-- NOVA 2.0: backfill profiles + wallet for users created before the trigger.
-- The on_auth_user_created trigger (migration 1) only fires on NEW inserts.
-- Users who signed up before migration 1 was applied have no profile/wallet rows.
-- This migration is idempotent: it only inserts rows for users who lack them.

-- Backfill: insert missing profiles for existing auth.users
insert into public.profiles (id, display_name, level, xp, streak)
select
  au.id,
  coalesce(au.raw_user_meta_data ->> 'display_name', split_part(au.email, '@', 1)),
  1, 0, 0
from auth.users au
left join public.profiles p on p.id = au.id
where p.id is null;

-- Backfill: insert missing wallets for existing auth.users
insert into public.wallet (user_id, earned_coins, ai_credits)
select au.id, 0, 0
from auth.users au
left join public.wallet w on w.user_id = au.id
where w.user_id is null;
