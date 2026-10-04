-- Upgrade Phase C — threaded conversations for NOVA chat.
--
-- Additive only: no historical migration is edited, no column or table is
-- dropped, no existing policy is widened.
--
-- 1. chat_conversations  — one row per thread (owner-scoped, RLS).
-- 2. chat_messages gains nullable conversation_id / mode / media columns.
-- 3. One-time backfill: every user that already has messages gets exactly one
--    conversation and their messages are attached to it in created_at order.
--    Message ownership, role, content and timestamps are never modified.
-- 4. chat_requests records the conversation + mode at RESERVE time so
--    finalize can never be pointed at another user's thread.
-- 5. reserve_chat_credit / finalize_chat_credit / get_chat_history are
--    re-created with extra (optional) parameters — old signatures are dropped
--    first so PostgREST never sees two overloads.
-- 6. Conversation CRUD RPCs: SECURITY DEFINER, auth.uid() identity only.
--
-- Security invariants preserved:
--   * chat_messages keeps SELECT-own only (still written by finalize only).
--   * chat_requests keeps SELECT-own only (still written by reserve only).
--   * no RPC accepts a target user_id; every one derives identity from auth.uid().
--   * all functions: security definer + set search_path = public + revoke from public.

-- ── 1. chat_conversations ─────────────────────────────────────
create table if not exists public.chat_conversations (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  title           text not null default 'New conversation',
  created_at      timestamp with time zone not null default timezone('utc'::text, now()),
  updated_at      timestamp with time zone not null default timezone('utc'::text, now()),
  last_message_at timestamp with time zone
);

alter table public.chat_conversations enable row level security;

-- Read only for the owner. Mutations go exclusively through the definer RPCs
-- below (create / rename / delete) so title normalisation and ownership checks
-- happen in one place and no client-side UPDATE/DELETE policy exists.
drop policy if exists "Users can read own conversations" on public.chat_conversations;
create policy "Users can read own conversations"
  on public.chat_conversations for select
  using (auth.uid() = user_id);

create index if not exists idx_chat_conversations_user_activity
  on public.chat_conversations (user_id, last_message_at desc nulls last);

-- ── 2. chat_messages: conversation + mode + media ─────────────
alter table public.chat_messages
  add column if not exists conversation_id uuid references public.chat_conversations(id) on delete cascade,
  add column if not exists mode text,
  add column if not exists media_path text,
  add column if not exists media_kind text;

alter table public.chat_messages
  drop constraint if exists chat_messages_mode_allowed,
  add constraint chat_messages_mode_allowed check (
    mode is null or mode in ('chat', 'vision', 'image', 'speech')
  );

alter table public.chat_messages
  drop constraint if exists chat_messages_media_kind_allowed,
  add constraint chat_messages_media_kind_allowed check (
    media_kind is null or media_kind in ('image_input', 'image_output', 'audio_output')
  );

create index if not exists idx_chat_messages_conversation_created
  on public.chat_messages (conversation_id, created_at asc);

-- ── 3. One-time backfill (idempotent) ─────────────────────────
-- Creates at most one conversation per user and attaches their pre-existing
-- messages to it. Existing message rows are only given a conversation_id.
insert into public.chat_conversations (user_id, title, created_at, last_message_at)
select cm.user_id,
       'Earlier conversations',
       min(cm.created_at),
       max(cm.created_at)
  from public.chat_messages cm
 where cm.conversation_id is null
 group by cm.user_id
on conflict do nothing;

with target as (
  select cm.id as message_id, c.id as conversation_id,
         row_number() over (partition by cm.user_id order by cm.created_at asc, cm.id asc) as rn
    from public.chat_messages cm
    join public.chat_conversations c
      on c.user_id = cm.user_id
     and c.title = 'Earlier conversations'
   where cm.conversation_id is null
)
update public.chat_messages m
   set conversation_id = t.conversation_id
  from target t
 where m.id = t.message_id
   and m.conversation_id is null;

update public.chat_conversations c
   set last_message_at = agg.last_at,
       updated_at      = agg.last_at
  from (
    select conversation_id, max(created_at) as last_at
      from public.chat_messages
     where conversation_id is not null
     group by conversation_id
  ) agg
 where c.id = agg.conversation_id
   and (c.last_message_at is distinct from agg.last_at);

-- ── 4. chat_requests: conversation + mode + media ─────────────
alter table public.chat_requests
  add column if not exists conversation_id uuid references public.chat_conversations(id) on delete set null,
  add column if not exists mode text,
  add column if not exists media_path text;

alter table public.chat_requests
  drop constraint if exists chat_requests_mode_allowed,
  add constraint chat_requests_mode_allowed check (
    mode is null or mode in ('chat', 'vision', 'image', 'speech')
  );

-- ── 5. reserve_chat_credit — records conversation + mode ──────
-- DROP required: PostgreSQL cannot add IN parameters with CREATE OR REPLACE.
drop function if exists public.reserve_chat_credit(uuid);

create or replace function public.reserve_chat_credit(
  p_idempotency_key uuid,
  p_conversation_id uuid default null,
  p_mode text default null
) returns table (
  request_id uuid,
  ai_credits integer,
  earned_coins integer,
  state text
)
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_wallet  public.wallet%rowtype;
  v_request public.chat_requests%rowtype;
  v_stale_refund int := 0;
  v_mode text := coalesce(p_mode, 'chat');
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  if v_mode not in ('chat', 'vision', 'image', 'speech') then
    raise exception 'Invalid chat mode';
  end if;

  -- The conversation must belong to the caller. Nothing else is trusted.
  if p_conversation_id is not null and not exists (
    select 1 from public.chat_conversations
     where id = p_conversation_id and user_id = v_user_id
  ) then
    raise exception 'Conversation not found';
  end if;

  -- Check for existing request with this key
  select * into v_request
    from public.chat_requests
    where user_id = v_user_id and idempotency_key = p_idempotency_key;

  if found then
    select public.wallet.earned_coins, public.wallet.ai_credits
      into v_wallet.earned_coins, v_wallet.ai_credits
      from public.wallet where user_id = v_user_id;

    -- completed/reserved → return as-is; released → fall through to re-reserve
    if v_request.state <> 'released' then
      return query select v_request.id, v_wallet.ai_credits, v_wallet.earned_coins, v_request.state;
      return;
    end if;
  end if;

  -- Convert stale reserved (>5 minutes) → released; count only these for refund.
  with converted as (
    update public.chat_requests
      set state = 'released'
      where user_id = v_user_id
        and chat_requests.state = 'reserved'
        and created_at < now() - interval '5 minutes'
      returning id
  )
  select count(*)::int into v_stale_refund from converted;

  if v_stale_refund > 0 then
    update public.wallet
      set ai_credits = public.wallet.ai_credits + v_stale_refund,
          updated_at = now()
      where user_id = v_user_id;
  end if;

  -- Delete released rows. Rows already refunded by release_chat_credit are
  -- removed here without a second refund; stale rows were refunded above.
  delete from public.chat_requests
    where user_id = v_user_id and public.chat_requests.state = 'released';

  -- Lock wallet row
  select * into v_wallet
    from public.wallet
    where user_id = v_user_id
    for update;

  if not found then
    raise exception 'Wallet not found';
  end if;

  if v_wallet.ai_credits < 1 then
    raise exception 'Insufficient AI Credits';
  end if;

  -- Decrement credit
  update public.wallet
    set ai_credits = public.wallet.ai_credits - 1, updated_at = now()
    where user_id = v_user_id
    returning * into v_wallet;

  -- Record reservation together with the routing it was granted for.
  insert into public.chat_requests (user_id, idempotency_key, state, conversation_id, mode)
    values (v_user_id, p_idempotency_key, 'reserved', p_conversation_id, v_mode)
    returning * into v_request;

  return query select v_request.id, v_wallet.ai_credits, v_wallet.earned_coins, v_request.state;
end;
$$;

revoke all on function public.reserve_chat_credit(uuid, uuid, text) from public;
grant execute on function public.reserve_chat_credit(uuid, uuid, text) to authenticated;

-- ── 6. finalize_chat_credit — thread-aware persistence ────────
-- Extra parameters are optional so every existing call site (3 named args)
-- keeps working unchanged. The conversation is read from the reservation row,
-- never from the caller.
drop function if exists public.finalize_chat_credit(uuid, text, text);

create or replace function public.finalize_chat_credit(
  p_request_id       uuid,
  p_user_content     text,
  p_assistant_content text,
  p_mode             text default null,
  p_media_path       text default null,
  p_media_kind       text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_request public.chat_requests%rowtype;
  v_title text;
  v_mode text;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select * into v_request
    from public.chat_requests
    where id = p_request_id and user_id = v_user_id
    for update;

  if not found then
    raise exception 'Chat request not found';
  end if;

  if v_request.state = 'completed' then
    return;
  end if;

  if p_media_kind is not null
     and p_media_kind not in ('image_input', 'image_output', 'audio_output') then
    raise exception 'Invalid media kind';
  end if;

  v_mode := coalesce(p_mode, v_request.mode);

  insert into public.chat_messages (
    id, user_id, role, content, conversation_id, mode, media_path, media_kind
  )
  values
    (gen_random_uuid(), v_user_id, 'user', p_user_content,
     v_request.conversation_id, v_mode,
     case when p_media_kind = 'image_input' then p_media_path else null end,
     case when p_media_kind = 'image_input' then 'image_input' else null end),
    (gen_random_uuid(), v_user_id, 'assistant', p_assistant_content,
     v_request.conversation_id, v_mode,
     case when p_media_kind in ('image_output', 'audio_output') then p_media_path else null end,
     case when p_media_kind in ('image_output', 'audio_output') then p_media_kind else null end);

  insert into public.wallet_transactions (user_id, type, amount, currency, source, reference_id)
    values (v_user_id, 'AI_USAGE', -1, 'AI_CREDIT', 'AI_CHAT', v_request.id::text);

  update public.chat_requests set state = 'completed' where id = p_request_id;

  -- Thread bookkeeping: activity timestamps + first-turn title.
  if v_request.conversation_id is not null then
    select left(regexp_replace(trim(p_user_content), '\s+', ' ', 'g'), 60)
      into v_title
      from public.chat_conversations
     where id = v_request.conversation_id and user_id = v_user_id;

    update public.chat_conversations
       set last_message_at = now(),
           updated_at = now(),
           title = case
                     when title in ('New conversation', 'Earlier conversations')
                       and v_title is not null and v_title <> ''
                     then v_title
                     else title
                   end
     where id = v_request.conversation_id and user_id = v_user_id;
  end if;

  -- Phase 10: streak — only after successful finalize
  perform public.touch_user_streak();

  -- Phase 9: achievement — only after successful finalize
  insert into public.user_achievements (user_id, achievement_id)
  values (v_user_id, 'first_ai_chat')
  on conflict do nothing;
end;
$$;

revoke all on function public.finalize_chat_credit(uuid, text, text, text, text, text) from public;
grant execute on function public.finalize_chat_credit(uuid, text, text, text, text, text) to authenticated;

-- ── 7. get_chat_history — optional conversation filter ────────
-- NULL conversation_id keeps the exact pre-upgrade behaviour (last N across
-- the account), so every existing call site and test still holds.
drop function if exists public.get_chat_history(integer);

create or replace function public.get_chat_history(
  p_limit integer default 50,
  p_conversation_id uuid default null
)
returns table (
  id         uuid,
  role       text,
  content    text,
  created_at timestamp with time zone,
  mode       text,
  media_path text,
  media_kind text
)
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  if p_conversation_id is not null and not exists (
    select 1 from public.chat_conversations
     where id = p_conversation_id and user_id = v_user_id
  ) then
    raise exception 'Conversation not found';
  end if;

  return query
    select sub.id, sub.role, sub.content, sub.created_at, sub.mode, sub.media_path, sub.media_kind
    from (
      select cm.id, cm.role, cm.content, cm.created_at, cm.mode, cm.media_path, cm.media_kind
        from public.chat_messages cm
       where cm.user_id = v_user_id
         and (p_conversation_id is null or cm.conversation_id = p_conversation_id)
       order by cm.created_at desc
       limit p_limit
    ) sub
    order by sub.created_at asc;
end;
$$;

revoke all on function public.get_chat_history(integer, uuid) from public;
grant execute on function public.get_chat_history(integer, uuid) to authenticated;

-- ── 8. get_chat_request_state — replay from the right thread ──
create or replace function public.get_chat_request_state(
  p_idempotency_key uuid
) returns table (
  request_id uuid,
  state text,
  assistant_reply text
)
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_request public.chat_requests%rowtype;
  v_msg     public.chat_messages%rowtype;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select * into v_request
    from public.chat_requests
    where user_id = v_user_id and idempotency_key = p_idempotency_key;

  if not found then
    return query select null::uuid, null::text, null::text;
    return;
  end if;

  if v_request.state = 'completed' then
    select content into v_msg.content
      from public.chat_messages
     where user_id = v_user_id
       and role = 'assistant'
       and created_at >= v_request.created_at
       and (v_request.conversation_id is null or conversation_id = v_request.conversation_id)
     order by created_at desc
     limit 1;
  end if;

  return query select v_request.id, v_request.state, v_msg.content;
end;
$$;

revoke all on function public.get_chat_request_state(uuid) from public;
grant execute on function public.get_chat_request_state(uuid) to authenticated;

-- ── 9. Conversation CRUD RPCs ─────────────────────────────────
create or replace function public.create_chat_conversation(
  p_title text default null
) returns table (conversation_id uuid, title text)
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_id uuid;
  v_title text;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  v_title := left(nullif(regexp_replace(coalesce(p_title, ''), '\s+', ' ', 'g'), ''), 60);
  if v_title is null then
    v_title := 'New conversation';
  end if;

  insert into public.chat_conversations (user_id, title)
  values (v_user_id, v_title)
  returning id into v_id;

  return query select v_id, v_title;
end;
$$;

revoke all on function public.create_chat_conversation(text) from public;
grant execute on function public.create_chat_conversation(text) to authenticated;

create or replace function public.rename_chat_conversation(
  p_conversation_id uuid,
  p_title text
) returns table (conversation_id uuid, title text)
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_title text;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  v_title := left(nullif(regexp_replace(trim(coalesce(p_title, '')), '\s+', ' ', 'g'), ''), 60);
  if v_title is null then
    raise exception 'Title is required';
  end if;

  update public.chat_conversations
     set title = v_title, updated_at = now()
   where id = p_conversation_id and user_id = v_user_id;

  if not found then
    raise exception 'Conversation not found';
  end if;

  return query select p_conversation_id, v_title;
end;
$$;

revoke all on function public.rename_chat_conversation(uuid, text) from public;
grant execute on function public.rename_chat_conversation(uuid, text) to authenticated;

-- Deleting a thread removes its messages too (FK cascade) inside one
-- definer transaction. Only the caller's own row can be matched.
create or replace function public.delete_chat_conversation(
  p_conversation_id uuid
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  delete from public.chat_conversations
   where id = p_conversation_id and user_id = v_user_id;

  if not found then
    raise exception 'Conversation not found';
  end if;
end;
$$;

revoke all on function public.delete_chat_conversation(uuid) from public;
grant execute on function public.delete_chat_conversation(uuid) to authenticated;

create or replace function public.get_chat_conversations(
  p_limit integer default 50
) returns table (
  conversation_id uuid,
  title text,
  created_at timestamp with time zone,
  updated_at timestamp with time zone,
  last_message_at timestamp with time zone,
  message_count bigint
)
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  return query
    select c.id, c.title, c.created_at, c.updated_at, c.last_message_at,
           (select count(*) from public.chat_messages m where m.conversation_id = c.id)
      from public.chat_conversations c
     where c.user_id = v_user_id
     order by coalesce(c.last_message_at, c.updated_at, c.created_at) desc
     limit p_limit;
end;
$$;

revoke all on function public.get_chat_conversations(integer) from public;
grant execute on function public.get_chat_conversations(integer) to authenticated;
