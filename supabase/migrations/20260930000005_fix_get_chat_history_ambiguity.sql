-- Upgrade regression fixes, found by supabase/tests/upgrade_conversations.test.ts.
--
-- 1. get_chat_history declares `id` as an OUT parameter (RETURNS TABLE), so
--    the ownership guard `where id = p_conversation_id` was ambiguous
--    (SQLSTATE 42702, column reference "id" is ambiguous) and every call to
--    get_chat_history failed — including the legacy 1-arg signature the chat
--    panel still uses. Alias the table so the column reference is unique.
--
-- 2. create_chat_conversation did not strip outer whitespace while
--    rename_chat_conversation and the first-turn auto-title both trim. Align
--    create on trim() so a title never keeps leading/trailing spaces.
--
-- 3. finalize_chat_credit writes the user/assistant pair in one statement, so
--    both rows share the same now() timestamp. Ordering on created_at alone
--    was therefore unstable and could return the reply before the prompt.
--    Break ties on role: user first when ascending, assistant first when
--    descending (the phase the LIMIT applies to). Both phases put the user
--    row first so a LIMIT cut can only ever drop the tail reply of the oldest
--    visible turn, never orphan a reply in front of its prompt.

-- ── 1. get_chat_history (qualified column reference) ──────────
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
    select 1 from public.chat_conversations cc
     where cc.id = p_conversation_id and cc.user_id = v_user_id
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
       order by cm.created_at desc,
                case cm.role when 'user' then 0 else 1 end,
                cm.id
       limit p_limit
    ) sub
    order by sub.created_at asc,
             case sub.role when 'user' then 0 else 1 end,
             sub.id;
end;
$$;

revoke all on function public.get_chat_history(integer, uuid) from public;
grant execute on function public.get_chat_history(integer, uuid) to authenticated;

-- ── 2. create_chat_conversation (trim outer whitespace) ──────
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

  v_title := left(nullif(regexp_replace(trim(coalesce(p_title, '')), '\s+', ' ', 'g'), ''), 60);
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
