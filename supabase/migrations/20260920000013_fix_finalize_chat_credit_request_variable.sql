-- NOVA 2.0: fix finalize_chat_credit undefined variable.
-- The wallet_transactions INSERT referenced `p_request.id` which does not exist.
-- The correct variable is `v_request` (chat_requests%rowtype).

create or replace function public.finalize_chat_credit(
  p_request_id   uuid,
  p_user_content text,
  p_assistant_content text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_request public.chat_requests%rowtype;
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
    return; -- already finalized (idempotent)
  end if;

  -- Persist messages
  insert into public.chat_messages (user_id, role, content)
    values
      (v_user_id, 'user',      p_user_content),
      (v_user_id, 'assistant', p_assistant_content);

  -- Record the wallet transaction
  insert into public.wallet_transactions (user_id, type, amount, currency, source, reference_id)
    values (v_user_id, 'AI_USAGE', -1, 'AI_CREDIT', 'AI_CHAT', v_request.id::text);

  -- Mark completed (keep row for idempotent retry)
  update public.chat_requests set state = 'completed' where id = p_request_id;
end;
$$;

revoke all on function public.finalize_chat_credit(uuid, text, text) from public;
grant execute on function public.finalize_chat_credit(uuid, text, text) to authenticated;
