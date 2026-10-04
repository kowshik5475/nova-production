-- NOVA 2.0: auto-provision profiles + wallet on user sign-up.
-- Creates a trigger on auth.users that fires after insert.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name, level, xp)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)),
    1,
    0
  );

  insert into public.wallet (user_id, earned_coins, ai_credits)
  values (new.id, 0, 0);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();
