-- Creates your society and makes you its first admin. Run it once, in the
-- Supabase dashboard: SQL Editor > New query, paste this file, edit the two
-- lines marked EDIT, then Run.
--
-- Before you run it: open the Dumpy website, sign in with your email and fill
-- in your profile, so your account exists.
--
-- It prints the society's invite code. Share that with neighbours; you can
-- also see it any time on the website under Profile > Society admin.
-- The society name is typed here, in the dashboard, and never saved in the
-- repo. Safe to run twice: the second run changes nothing and says so.

with input as (
  select
    'Type your society name here'::text as society_name,   -- EDIT
    'your.email@example.com'::text      as admin_email      -- EDIT: the email you sign in with
),
admin_user as (
  select u.id
  from auth.users u
  join input i on lower(u.email) = lower(btrim(i.admin_email))
),
already as (
  select s.id, s.name, s.invite_code
  from public.societies s
  join input i on lower(s.name) = lower(btrim(i.society_name))
),
new_society as (
  insert into public.societies (name)
  select btrim(i.society_name) from input i
  where exists (select 1 from admin_user)
    and not exists (select 1 from already)
    and btrim(i.society_name) <> 'Type your society name here'
  returning id, name, invite_code
),
new_admin as (
  insert into public.memberships (user_id, society_id, role, status)
  select a.id, s.id, 'admin', 'approved'
  from admin_user a cross join new_society s
  returning user_id
)
select case
  when (select btrim(society_name) from input) = 'Type your society name here'
    then 'Nothing created: type your society name on the line marked EDIT first.'
  when not exists (select 1 from admin_user)
    then 'Nothing created: no Dumpy account uses that email yet. Sign in on the website once, then run this again.'
  when exists (select 1 from already)
    then 'Nothing created: a society with that name already exists. Its invite code is '
         || (select invite_code from already limit 1) || '.'
  else 'Done. You are the admin of ' || (select name from new_society)
       || '. Invite code: ' || (select invite_code from new_society)
end as result;
