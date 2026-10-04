-- ── fix get_chat_history: return most recent N messages ─────────
-- Previous implementation used ORDER BY asc LIMIT, which returned
-- the OLDEST N messages. This fixes it to return the MOST RECENT N
-- messages while preserving chronological (oldest-first) order.

create or replace function public.get_chat_history(p_limit integer default 50)
returns table (
  id         uuid,
  role       text,
  content    text,
  created_at timestamp with time zone
)
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  return query
    select sub.id, sub.role, sub.content, sub.created_at
    from (
      select cm.id, cm.role, cm.content, cm.created_at
      from public.chat_messages cm
      where cm.user_id = v_user_id
      order by cm.created_at desc
      limit p_limit
    ) sub
    order by sub.created_at asc;
end;
$$;

revoke all on function public.get_chat_history(integer) from public;
grant execute on function public.get_chat_history(integer) to authenticated;
