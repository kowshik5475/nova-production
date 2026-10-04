-- Upgrade Phase F — private Storage bucket for NOVA chat attachments.
--
-- Multimodal input/output never stores raw bytes in PostgreSQL. The browser
-- uploads an image under its own folder (first path segment = auth.uid()), the
-- Edge Function re-validates the path, and only the storage path is written to
-- chat_messages.media_path by finalize_chat_credit.
--
-- Bucket is PRIVATE: every read goes through a short-lived signed URL created
-- by the owner. No public URLs, no service-role usage in the browser.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chat-attachments',
  'chat-attachments',
  false,
  5242880,
  array['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
on conflict (id) do nothing;

-- Owner-scoped object policies. The first folder segment is always the
-- uploader's auth.uid(); anything else fails the check.
drop policy if exists "chat attachments owner upload" on storage.objects;
create policy "chat attachments owner upload"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'chat-attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "chat attachments owner read" on storage.objects;
create policy "chat attachments owner read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'chat-attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "chat attachments owner delete" on storage.objects;
create policy "chat attachments owner delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'chat-attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Storage may not be granted to the API roles on every project — make it
-- explicit. RLS above remains the only access gate.
grant usage on schema storage to authenticated;
grant all on storage.objects to authenticated;
grant all on storage.buckets to authenticated;
