-- Removes everything supabase/seed.sql added: Demo Society, its two demo
-- people, their items and requests. Run in the Supabase dashboard's SQL Editor
-- before launching. Safe to run more than once.
-- (The seed adds no photos. If you uploaded test photos to Demo Society, delete
-- its folder in Storage > listing-photos as well.)

delete from public.societies where id = '5d000000-0000-4000-8000-000000000001';

delete from auth.users where id in (
  'd0000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-000000000002'
);
