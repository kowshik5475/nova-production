-- Phase 7 setup: disposable temp user (out-of-band, avoids email rate limits)
-- Matches field shapes of working p2b users (empty tokens vs NULL)

begin;

delete from auth.users where email = 'phase7del@example.test';

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  confirmation_sent_at, confirmation_token, recovery_token,
  email_change, email_change_token_new, email_change_token_current,
  phone_change, phone_change_token,
  raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at, is_sso_user
)
values (
  '00000000-0000-4000-8000-000000000707'::uuid,
  '00000000-0000-0000-0000-000000000000'::uuid,
  'authenticated',
  'authenticated',
  'phase7del@example.test',
  crypt('TempDelete!234', gen_salt('bf')),
  now(),
  now(),
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"display_name":"Phase7 Del"}'::jsonb,
  now(),
  now(),
  false
);

commit;

select 'temp user ready' as status, id, email from auth.users where email = 'phase7del@example.test';
