-- Replay accuracy for idempotent retries: get_chat_request_state must return
-- the reply (and media) that THIS request produced, not the newest reply in
-- the conversation, and a pre-threading request must only match pre-threading
-- messages. Two extra output columns; callers read named fields, so the added
-- columns are invisible to them.
-- Postgres cannot widen a composite return type in place, so the old body is
-- replaced through a drop first. Nothing else calls this function.

drop function if exists public.get_chat_request_state(uuid);

create or replace function public.get_chat_request_state(
  p_idempotency_key uuid
) returns table (
  request_id uuid,
  state text,
  assistant_reply text,
  media_path text,
  media_kind text
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
    return query select null::uuid, null::text, null::text, null::text, null::text;
    return;
  end if;

  if v_request.state = 'completed' then
    -- The FIRST assistant message at/after this request started is the one
    -- finalize_chat_credit persisted for it; anything newer belongs to a
    -- later request. A request without a conversation (legacy flat history,
    -- or its thread was deleted) only matches messages that have no thread.
    select * into v_msg
      from public.chat_messages
     where user_id = v_user_id
       and role = 'assistant'
       and created_at >= v_request.created_at
       and (case when v_request.conversation_id is null
                 then conversation_id is null
                 else conversation_id = v_request.conversation_id end)
     order by created_at asc
     limit 1;
  end if;

  return query
    select v_request.id, v_request.state, v_msg.content, v_msg.media_path, v_msg.media_kind;
end;
$$;

revoke all on function public.get_chat_request_state(uuid) from public;
grant execute on function public.get_chat_request_state(uuid) to authenticated;
