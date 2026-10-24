-- Makes you a platform admin: the person who approves new societies on
-- Dumpy's "Run Dumpy" page (pages/platform.html). Run it once, in the
-- Supabase dashboard: SQL Editor > New query, paste this file, edit the line
-- marked EDIT, then Run.
--
-- Before you run it: sign in on the Dumpy website once with that email, so
-- your account exists. Safe to run twice.
--
-- To remove someone later:
--   delete from public.platform_admins
--   where user_id = (select id from auth.users where lower(email) = lower('their.email@example.com'));

with input as (
  select 'your.email@example.com'::text as email   -- EDIT: the email you sign in with
),
who as (
  select u.id from auth.users u join input i on lower(u.email) = lower(btrim(i.email))
),
added as (
  insert into public.platform_admins (user_id)
  select id from who
  on conflict (user_id) do nothing
  returning user_id
)
select case
  when not exists (select 1 from who)
    then 'Nothing changed: no Dumpy account uses that email yet. Sign in on the website once, then run this again.'
  when exists (select 1 from added)
    then 'Done. Open Profile > Run Dumpy on the website to see requests for new societies.'
  else 'Nothing changed: that account is already a platform admin.'
end as result;
