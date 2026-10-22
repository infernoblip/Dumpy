-- Stage 2: the listing-photos Storage bucket.
--
-- Files live at <society_id>/<listing_id>/<file name>, for example
--   2f1c.../9a7e.../1.webp
-- The bucket is private: photos are read with the signed-in person's session
-- (supabase.storage.from('listing-photos').createSignedUrl(...) or .download()),
-- never through a public URL.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'listing-photos',
  'listing-photos',
  false,
  2 * 1024 * 1024,  -- 2 MB; the post page shrinks photos to about 200 KB first
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- Approved members of the society read its photos.
create policy "members read their society's listing photos"
on storage.objects for select to authenticated
using (bucket_id = 'listing-photos' and public.is_member_of_path(name));

-- Only the listing's owner uploads, replaces or deletes its photos.
create policy "owners upload listing photos"
on storage.objects for insert to authenticated
with check (bucket_id = 'listing-photos' and public.owns_listing_path(name));

create policy "owners replace listing photos"
on storage.objects for update to authenticated
using (bucket_id = 'listing-photos' and public.owns_listing_path(name))
with check (bucket_id = 'listing-photos' and public.owns_listing_path(name));

create policy "owners delete listing photos"
on storage.objects for delete to authenticated
using (bucket_id = 'listing-photos' and public.owns_listing_path(name));
