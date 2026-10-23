-- Dumpy isolation tests (stages 2 and 4).
--
-- Proves the row-level security rules hold:
--   * a member of society A cannot read, insert or update society B's rows
--   * a pending (or suspended) member sees nothing
--   * one member cannot edit another member's listing
--   * flat, phone and UPI ID are never readable through a plain select
--
-- How to run:
--   * Supabase dashboard: SQL Editor > New query, paste this whole file, Run.
--     It passes if it finishes without an error. A failure stops with an
--     error that starts with "FAIL:" and says which rule broke.
--   * Command line: psql "<connection string>" -v ON_ERROR_STOP=1 -f supabase/tests/isolation_test.sql
--     Each passing check prints a line starting with "ok".
--
-- It creates its own test societies and people, and undoes all of it at the
-- end (the whole file runs inside one transaction that is rolled back), so it
-- is safe to run on the real project.

begin;

-- ------------------------------------------------------------------ helpers
create schema dumpy_tests;
grant usage on schema dumpy_tests to anon, authenticated;

-- Act as a signed-in person (or as a signed-out visitor when p_user is null).
create function dumpy_tests.act_as(p_user uuid) returns void language plpgsql as $$
begin
  if p_user is null then
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    execute 'set local role anon';
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
  end if;
end $$;

create function dumpy_tests.ok(p_pass boolean, p_label text) returns void language plpgsql as $$
begin
  if p_pass is distinct from true then
    raise exception 'FAIL: %', p_label;
  end if;
  raise notice 'ok - %', p_label;
end $$;

-- Passes when the statement is refused with the expected error code
-- (42501 = permission denied or row-level security violation).
create function dumpy_tests.refused(p_sql text, p_label text, p_code text default '42501')
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate = p_code then
      raise notice 'ok - %', p_label;
      return;
    end if;
    raise exception 'FAIL: % (refused, but with % %)', p_label, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL: % (it was allowed)', p_label;
end $$;

-- Number of rows a statement changed (0 means row-level security hid them).
create function dumpy_tests.changed(p_sql text) returns integer language plpgsql as $$
declare _n integer;
begin
  execute p_sql;
  get diagnostics _n = row_count;
  return _n;
end $$;

grant execute on all functions in schema dumpy_tests to anon, authenticated;

-- ----------------------------------------------------------------- fixtures
-- Societies A and B, and people:
--   a_admin    approved admin of A
--   a_owner    approved member of A, owns listing A1
--   a_other    approved member of A, owns listing A2
--   a_pending  asked to join A, not approved yet
--   a_susp     suspended member of A
--   b_owner    approved member of B, owns listing B1
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', id::uuid, 'authenticated', 'authenticated',
       email, '', now(), '', '', '', '', '{}', '{}', now(), now()
from (values
  ('7e570000-0000-4000-8000-0000000000a0', 'test.a.admin@example.com'),
  ('7e570000-0000-4000-8000-0000000000a1', 'test.a.owner@example.com'),
  ('7e570000-0000-4000-8000-0000000000a2', 'test.a.other@example.com'),
  ('7e570000-0000-4000-8000-0000000000a3', 'test.a.pending@example.com'),
  ('7e570000-0000-4000-8000-0000000000a4', 'test.a.suspended@example.com'),
  ('7e570000-0000-4000-8000-0000000000b1', 'test.b.owner@example.com')
) as t(id, email);

insert into public.societies (id, name, invite_code) values
  ('7e570000-0000-4000-8000-00000000aaaa', 'Test Society A', 'TESTAAAA'),
  ('7e570000-0000-4000-8000-00000000bbbb', 'Test Society B', 'TESTBBBB');

insert into public.memberships (user_id, society_id, role, status) values
  ('7e570000-0000-4000-8000-0000000000a0', '7e570000-0000-4000-8000-00000000aaaa', 'admin',  'approved'),
  ('7e570000-0000-4000-8000-0000000000a1', '7e570000-0000-4000-8000-00000000aaaa', 'member', 'approved'),
  ('7e570000-0000-4000-8000-0000000000a2', '7e570000-0000-4000-8000-00000000aaaa', 'member', 'approved'),
  ('7e570000-0000-4000-8000-0000000000a3', '7e570000-0000-4000-8000-00000000aaaa', 'member', 'pending'),
  ('7e570000-0000-4000-8000-0000000000a4', '7e570000-0000-4000-8000-00000000aaaa', 'member', 'suspended'),
  ('7e570000-0000-4000-8000-0000000000b1', '7e570000-0000-4000-8000-00000000bbbb', 'member', 'approved');

insert into public.profiles (user_id, display_name, tower, flat, phone, upi_id) values
  ('7e570000-0000-4000-8000-0000000000a0', 'Test Admin',   'A', 'A-101', '9000000010', 'test.admin@upi'),
  ('7e570000-0000-4000-8000-0000000000a1', 'Test Owner',   'A', 'A-102', '9000000011', 'test.owner@upi'),
  ('7e570000-0000-4000-8000-0000000000a2', 'Test Other',   'B', 'B-201', '9000000012', null),
  ('7e570000-0000-4000-8000-0000000000a3', 'Test Pending', 'C', 'C-301', null, null),
  ('7e570000-0000-4000-8000-0000000000a4', 'Test Susp',    'C', 'C-302', null, null),
  ('7e570000-0000-4000-8000-0000000000b1', 'Test B Owner', 'X', 'X-901', '9000000019', null);

insert into public.listings (id, society_id, owner_id, title, price_inr) values
  ('7e570000-0000-4000-8000-0000000a1111', '7e570000-0000-4000-8000-00000000aaaa', '7e570000-0000-4000-8000-0000000000a1', 'A1 chair', 0),
  ('7e570000-0000-4000-8000-0000000a2222', '7e570000-0000-4000-8000-00000000aaaa', '7e570000-0000-4000-8000-0000000000a2', 'A2 lamp', 150),
  ('7e570000-0000-4000-8000-0000000b1111', '7e570000-0000-4000-8000-00000000bbbb', '7e570000-0000-4000-8000-0000000000b1', 'B1 sofa', 500);

insert into public.listing_photos (listing_id, society_id, storage_path, position) values
  ('7e570000-0000-4000-8000-0000000a1111', '7e570000-0000-4000-8000-00000000aaaa',
   '7e570000-0000-4000-8000-00000000aaaa/7e570000-0000-4000-8000-0000000a1111/1.webp', 0),
  ('7e570000-0000-4000-8000-0000000b1111', '7e570000-0000-4000-8000-00000000bbbb',
   '7e570000-0000-4000-8000-00000000bbbb/7e570000-0000-4000-8000-0000000b1111/1.webp', 0);

insert into storage.objects (bucket_id, name, owner) values
  ('listing-photos', '7e570000-0000-4000-8000-00000000aaaa/7e570000-0000-4000-8000-0000000a1111/1.webp', '7e570000-0000-4000-8000-0000000000a1'),
  ('listing-photos', '7e570000-0000-4000-8000-00000000bbbb/7e570000-0000-4000-8000-0000000b1111/1.webp', '7e570000-0000-4000-8000-0000000000b1');

insert into public.requests (id, listing_id, society_id, requester_id, message) values
  ('7e570000-0000-4000-8000-00000000e001', '7e570000-0000-4000-8000-0000000a1111', '7e570000-0000-4000-8000-00000000aaaa', '7e570000-0000-4000-8000-0000000000a2', 'A2 wants A1'),
  ('7e570000-0000-4000-8000-00000000e002', '7e570000-0000-4000-8000-0000000b1111', '7e570000-0000-4000-8000-00000000bbbb', '7e570000-0000-4000-8000-0000000000b1', 'placeholder');
-- (b_owner cannot request their own item through the website; this row only
-- exists so society B has a request for A to try to read.)

-- =================================================== 1. society A vs society B
select dumpy_tests.act_as('7e570000-0000-4000-8000-0000000000a1');  -- a_owner

select dumpy_tests.ok((select count(*) from public.listings where society_id = '7e570000-0000-4000-8000-00000000aaaa') = 2,
  'A member reads their own society''s listings');
select dumpy_tests.ok((select count(*) from public.listings where society_id = '7e570000-0000-4000-8000-00000000bbbb') = 0,
  'A member cannot read B''s listings');
select dumpy_tests.ok((select count(*) from public.societies) = 1,
  'A member reads only their own society');
select dumpy_tests.ok((select count(*) from public.memberships where society_id = '7e570000-0000-4000-8000-00000000bbbb') = 0,
  'A member cannot read B''s memberships');
select dumpy_tests.ok((select count(*) from public.profiles where user_id = '7e570000-0000-4000-8000-0000000000b1') = 0,
  'A member cannot read a B member''s profile');
select dumpy_tests.ok((select count(*) from public.listing_photos where society_id = '7e570000-0000-4000-8000-00000000bbbb') = 0,
  'A member cannot read B''s photo rows');
select dumpy_tests.ok((select count(*) from public.requests where society_id = '7e570000-0000-4000-8000-00000000bbbb') = 0,
  'A member cannot read B''s requests');
select dumpy_tests.ok((select count(*) from storage.objects where bucket_id = 'listing-photos' and name like '7e570000-0000-4000-8000-00000000bbbb/%') = 0,
  'A member cannot read B''s photo files');
select dumpy_tests.ok((select count(*) from storage.objects where bucket_id = 'listing-photos' and name like '7e570000-0000-4000-8000-00000000aaaa/%') = 1,
  'A member reads A''s photo files');

select dumpy_tests.refused($$
  insert into public.listings (society_id, owner_id, title)
  values ('7e570000-0000-4000-8000-00000000bbbb', '7e570000-0000-4000-8000-0000000000a1', 'sneaky')
$$, 'A member cannot post a listing into B');

select dumpy_tests.refused($$
  insert into public.requests (listing_id, society_id, requester_id)
  values ('7e570000-0000-4000-8000-0000000b1111', '7e570000-0000-4000-8000-00000000bbbb', '7e570000-0000-4000-8000-0000000000a1')
$$, 'A member cannot request B''s item');

select dumpy_tests.refused($$
  insert into public.listing_photos (listing_id, society_id, storage_path)
  values ('7e570000-0000-4000-8000-0000000b1111', '7e570000-0000-4000-8000-00000000bbbb',
          '7e570000-0000-4000-8000-00000000bbbb/7e570000-0000-4000-8000-0000000b1111/2.webp')
$$, 'A member cannot add a photo row to B''s listing');

select dumpy_tests.refused($$
  insert into storage.objects (bucket_id, name, owner)
  values ('listing-photos', '7e570000-0000-4000-8000-00000000bbbb/7e570000-0000-4000-8000-0000000b1111/2.webp', auth.uid())
$$, 'A member cannot upload a photo file into B''s folder');

select dumpy_tests.ok(dumpy_tests.changed($$
  update public.listings set title = 'hacked' where id = '7e570000-0000-4000-8000-0000000b1111'
$$) = 0, 'A member cannot update B''s listing');

select dumpy_tests.ok(dumpy_tests.changed($$
  update public.societies set name = 'hacked' where id = '7e570000-0000-4000-8000-00000000bbbb'
$$) = 0, 'A member cannot rename B');

select dumpy_tests.ok(dumpy_tests.changed($$
  update public.requests set status = 'cancelled' where id = '7e570000-0000-4000-8000-00000000e002'
$$) = 0, 'A member cannot change B''s requests');

select dumpy_tests.refused($$
  update public.listings set society_id = '7e570000-0000-4000-8000-00000000bbbb'
  where id = '7e570000-0000-4000-8000-0000000a1111'
$$, 'An owner cannot move their listing into another society');

select dumpy_tests.ok(not public.owns_listing_path(
  '7e570000-0000-4000-8000-00000000bbbb/7e570000-0000-4000-8000-0000000a1111/1.webp'),
  'A photo path that pairs B with an A listing is refused');

-- ================================================= 2. one member vs another
select dumpy_tests.ok(dumpy_tests.changed($$
  update public.listings set title = 'mine now' where id = '7e570000-0000-4000-8000-0000000a2222'
$$) = 0, 'A member cannot edit another member''s listing');

select dumpy_tests.ok(dumpy_tests.changed($$
  update public.listings set status = 'withdrawn' where id = '7e570000-0000-4000-8000-0000000a2222'
$$) = 0, 'A member cannot withdraw another member''s listing');

select dumpy_tests.refused($$
  delete from public.listings where id = '7e570000-0000-4000-8000-0000000a2222'
$$, 'Nobody can delete listings from the website');

select dumpy_tests.refused($$
  insert into public.listings (society_id, owner_id, title)
  values ('7e570000-0000-4000-8000-00000000aaaa', '7e570000-0000-4000-8000-0000000000a2', 'posted as someone else')
$$, 'A member cannot post a listing as someone else');

select dumpy_tests.refused($$
  insert into storage.objects (bucket_id, name, owner)
  values ('listing-photos', '7e570000-0000-4000-8000-00000000aaaa/7e570000-0000-4000-8000-0000000a2222/x.webp', auth.uid())
$$, 'A member cannot upload photos to another member''s listing');

select dumpy_tests.ok(dumpy_tests.changed($$
  update public.listings set title = 'A1 chair (blue)' where id = '7e570000-0000-4000-8000-0000000a1111'
$$) = 1, 'An owner can edit their own listing');

-- (Checked through the policy's own function rather than a real upload, so
-- the test does not depend on Storage's internal tables.)
select dumpy_tests.ok(public.owns_listing_path(
  '7e570000-0000-4000-8000-00000000aaaa/7e570000-0000-4000-8000-0000000a1111/2.webp'),
  'An owner can upload photos to their own listing');
select dumpy_tests.ok(not public.owns_listing_path(
  '7e570000-0000-4000-8000-00000000aaaa/7e570000-0000-4000-8000-0000000a2222/2.webp'),
  'The upload rule says no for another member''s listing');
select dumpy_tests.ok(not public.owns_listing_path(
  '7e570000-0000-4000-8000-00000000aaaa/7e570000-0000-4000-8000-0000000a1111/deeper/2.webp'),
  'The upload rule says no for paths outside society/listing/file');

select dumpy_tests.refused($$
  update public.listings set status = 'hidden' where id = '7e570000-0000-4000-8000-0000000a1111'
$$, 'An owner cannot hide their own listing (only admins hide)');

select dumpy_tests.ok(dumpy_tests.changed($$
  update public.requests set status = 'declined' where id = '7e570000-0000-4000-8000-00000000e001'
$$) = 1, 'An owner can decline a request on their listing');

select dumpy_tests.ok(dumpy_tests.changed($$
  update public.memberships set status = 'approved' where user_id = '7e570000-0000-4000-8000-0000000000a3'
$$) = 0, 'A plain member cannot approve anyone');

select dumpy_tests.ok((select count(*) from public.admin_list_members('7e570000-0000-4000-8000-00000000aaaa')) = 0,
  'A plain member gets nothing from admin_list_members');

-- requests between two members of A
select dumpy_tests.act_as('7e570000-0000-4000-8000-0000000000a1');
select dumpy_tests.ok(dumpy_tests.changed($$
  insert into public.requests (listing_id, society_id, requester_id, message)
  values ('7e570000-0000-4000-8000-0000000a2222', '7e570000-0000-4000-8000-00000000aaaa', auth.uid(), 'A1 owner wants A2')
$$) = 1, 'A member can request a neighbour''s available item');

select dumpy_tests.refused($$
  insert into public.requests (listing_id, society_id, requester_id)
  values ('7e570000-0000-4000-8000-0000000a1111', '7e570000-0000-4000-8000-00000000aaaa', auth.uid())
$$, 'A member cannot request their own item');

select dumpy_tests.act_as('7e570000-0000-4000-8000-0000000000a2');  -- a_other, owner of A2
select dumpy_tests.refused($$
  update public.requests set status = 'accepted'
  where listing_id = '7e570000-0000-4000-8000-0000000a2222'
$$, 'An owner cannot accept by plain update (stage 6 adds accept_request)');
select dumpy_tests.refused($$
  update public.requests set message = 'rewritten'
  where listing_id = '7e570000-0000-4000-8000-0000000a2222'
$$, 'An owner cannot rewrite a requester''s message');
select dumpy_tests.ok((select count(*) from public.requests where requester_id = '7e570000-0000-4000-8000-0000000000a2') = 1,
  'A requester sees their own request');
select dumpy_tests.ok((select count(*) from public.requests where listing_id = '7e570000-0000-4000-8000-0000000a2222') = 1,
  'An owner sees requests on their listing');

-- ======================================================= 3. private details
select dumpy_tests.act_as('7e570000-0000-4000-8000-0000000000a1');
select dumpy_tests.refused($$ select phone from public.profiles $$,
  'Nobody can select phone, even their own');
select dumpy_tests.refused($$ select upi_id from public.profiles $$,
  'Nobody can select upi_id, even their own');
select dumpy_tests.refused($$ select flat from public.profiles $$,
  'Nobody can select flat, even their own');
select dumpy_tests.refused($$ select * from public.profiles $$,
  'select * on profiles is refused (it would include private columns)');
select dumpy_tests.ok((select count(*) from public.profiles where user_id = '7e570000-0000-4000-8000-0000000000a2') = 1,
  'A member sees a neighbour''s name and tower');
select dumpy_tests.ok((select count(*) from public.profiles where user_id = '7e570000-0000-4000-8000-0000000000a3') = 0,
  'A member cannot see a pending person''s profile');
select dumpy_tests.ok((select phone from public.get_my_profile()) = '9000000011',
  'get_my_profile returns your own phone');
select dumpy_tests.ok(dumpy_tests.changed($$
  update public.profiles set phone = '9000000099' where user_id = auth.uid()
$$) = 1, 'A person can update their own phone');
select dumpy_tests.ok(dumpy_tests.changed($$
  update public.profiles set display_name = 'hacked' where user_id = '7e570000-0000-4000-8000-0000000000a2'
$$) = 0, 'A person cannot update someone else''s profile');

-- ==================================================== 4. pending and suspended
select dumpy_tests.act_as('7e570000-0000-4000-8000-0000000000a3');  -- a_pending
select dumpy_tests.ok((select count(*) from public.listings) = 0, 'A pending member sees no listings');
select dumpy_tests.ok((select count(*) from public.societies) = 0, 'A pending member sees no society');
select dumpy_tests.ok((select count(*) from public.listing_photos) = 0, 'A pending member sees no photo rows');
select dumpy_tests.ok((select count(*) from public.requests) = 0, 'A pending member sees no requests');
select dumpy_tests.ok((select count(*) from storage.objects where bucket_id = 'listing-photos') = 0, 'A pending member sees no photo files');
select dumpy_tests.ok((select count(*) from public.profiles where user_id <> auth.uid()) = 0, 'A pending member sees nobody else''s profile');
select dumpy_tests.ok((select count(*) from public.memberships) = 1
  and (select status from public.memberships) = 'pending', 'A pending member sees only their own pending membership');
select dumpy_tests.refused($$
  insert into public.listings (society_id, owner_id, title)
  values ('7e570000-0000-4000-8000-00000000aaaa', auth.uid(), 'too early')
$$, 'A pending member cannot post');
select dumpy_tests.ok(dumpy_tests.changed($$
  update public.memberships set status = 'approved' where user_id = auth.uid()
$$) = 0, 'A pending member cannot approve themselves');
select dumpy_tests.refused($$
  insert into public.memberships (user_id, society_id, status)
  values (auth.uid(), '7e570000-0000-4000-8000-00000000bbbb', 'approved')
$$, 'Nobody can insert a membership directly');

select dumpy_tests.act_as('7e570000-0000-4000-8000-0000000000a4');  -- a_susp
select dumpy_tests.ok((select count(*) from public.listings) = 0, 'A suspended member sees no listings');
select dumpy_tests.ok(dumpy_tests.changed($$
  delete from public.memberships where user_id = auth.uid()
$$) = 0, 'A suspended member cannot delete their membership to rejoin');

-- ============================================================ 5. joining
select dumpy_tests.act_as('7e570000-0000-4000-8000-0000000000a1');
select dumpy_tests.ok((select status from public.join_society(' testbbbb ')) = 'pending',
  'join_society with B''s code creates a pending membership');
select dumpy_tests.ok((select count(*) from public.listings where society_id = '7e570000-0000-4000-8000-00000000bbbb') = 0,
  'After asking to join B, an A member still sees nothing of B');
select dumpy_tests.refused($$ select public.join_society('NOPE0000') $$,
  'A wrong invite code is refused', 'P0002');
select dumpy_tests.ok((select count(*) from public.my_memberships()) = 2,
  'my_memberships lists both of your memberships');
select dumpy_tests.ok((select society_name || '/' || status from public.my_memberships()
                        where society_id = '7e570000-0000-4000-8000-00000000bbbb') = 'Test Society B/pending',
  'my_memberships names the society you are still waiting to join');

select dumpy_tests.act_as('7e570000-0000-4000-8000-0000000000a3');  -- a_pending
select dumpy_tests.ok((select count(*) from public.my_memberships()) = 1
                      and (select status from public.my_memberships()) = 'pending',
  'my_memberships shows a pending person only their own request');

-- ============================================================ 6. admins
select dumpy_tests.act_as('7e570000-0000-4000-8000-0000000000a0');  -- a_admin
select dumpy_tests.ok((select count(*) from public.admin_list_members('7e570000-0000-4000-8000-00000000aaaa')) = 5,
  'An admin lists everyone in their society');
select dumpy_tests.ok((select flat from public.admin_list_members('7e570000-0000-4000-8000-00000000aaaa')
                        where user_id = '7e570000-0000-4000-8000-0000000000a3') = 'C-301',
  'An admin sees a pending person''s flat to check them');
select dumpy_tests.ok((select count(*) from public.admin_list_members('7e570000-0000-4000-8000-00000000bbbb')) = 0,
  'An admin of A gets nothing about B');
select dumpy_tests.ok(dumpy_tests.changed($$
  update public.memberships set status = 'approved' where user_id = '7e570000-0000-4000-8000-0000000000b1'
$$) = 0, 'An admin of A cannot touch B''s memberships');
select dumpy_tests.ok(dumpy_tests.changed($$
  update public.memberships set role = 'member' where user_id = auth.uid()
$$) = 0, 'An admin cannot demote themselves by accident');
select dumpy_tests.ok(dumpy_tests.changed($$
  update public.memberships set status = 'approved' where user_id = '7e570000-0000-4000-8000-0000000000a3'
$$) = 1, 'An admin approves a pending member');
select dumpy_tests.ok(dumpy_tests.changed($$
  update public.listings set status = 'hidden' where id = '7e570000-0000-4000-8000-0000000a2222'
$$) = 1, 'An admin can hide a listing');

select dumpy_tests.act_as('7e570000-0000-4000-8000-0000000000a3');  -- now approved
select dumpy_tests.ok((select count(*) from public.listings) = 1,
  'Once approved, the new member sees the society''s visible listings (hidden one excluded)');

select dumpy_tests.act_as('7e570000-0000-4000-8000-0000000000a2');  -- owner of hidden A2
select dumpy_tests.ok((select count(*) from public.listings where id = '7e570000-0000-4000-8000-0000000a2222') = 1,
  'An owner still sees their own hidden listing');
select dumpy_tests.ok(dumpy_tests.changed($$
  update public.listings set status = 'available' where id = '7e570000-0000-4000-8000-0000000a2222'
$$) = 0, 'An owner cannot un-hide a listing an admin hid');

-- ============================================================ 7. signed out
select dumpy_tests.act_as(null);
select dumpy_tests.refused($$ select count(*) from public.listings $$, 'A signed-out visitor cannot read listings');
select dumpy_tests.refused($$ select count(*) from public.profiles $$, 'A signed-out visitor cannot read profiles');
select dumpy_tests.refused($$ select count(*) from public.societies $$, 'A signed-out visitor cannot read societies');
select dumpy_tests.refused($$ select public.join_society('TESTAAAA') $$, 'A signed-out visitor cannot join a society');
select dumpy_tests.refused($$ select * from public.my_memberships() $$, 'A signed-out visitor cannot list memberships');
select dumpy_tests.ok((select count(*) from storage.objects where bucket_id = 'listing-photos') = 0,
  'A signed-out visitor sees no photo files');

-- ===================================================== 8. one accepted request
reset role;
select dumpy_tests.refused($$
  insert into public.requests (listing_id, society_id, requester_id, status) values
    ('7e570000-0000-4000-8000-0000000a1111', '7e570000-0000-4000-8000-00000000aaaa', '7e570000-0000-4000-8000-0000000000a0', 'accepted'),
    ('7e570000-0000-4000-8000-0000000a1111', '7e570000-0000-4000-8000-00000000aaaa', '7e570000-0000-4000-8000-0000000000a3', 'accepted')
$$, 'A listing can never have two accepted requests', '23505');
select dumpy_tests.refused($$
  insert into public.requests (listing_id, society_id, requester_id) values
    ('7e570000-0000-4000-8000-0000000a1111', '7e570000-0000-4000-8000-00000000bbbb', '7e570000-0000-4000-8000-0000000000b1')
$$, 'A request''s society must match its listing''s society', '23503');

select 'All Dumpy isolation tests passed' as result;

rollback;
