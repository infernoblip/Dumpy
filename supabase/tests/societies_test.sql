-- Dumpy stage 12 tests: more societies.
--
-- Proves:
--   * starting a society: only signed-in people with a profile can ask; only a
--     platform admin sees and answers requests; approving creates a society
--     with its own invite code and makes the asker its admin; the new society
--     runs on its own and sees nothing of the others, and they see nothing of it
--   * sharing with nearby societies: only admins link; sharing needs both
--     sides; a linked society sees only available listings marked "nearby"
--     (and their photos), never memberships, profiles, requests, reports,
--     contacts or other listings; an unlinked society sees nothing; either
--     side can stop it
--
-- Run it like isolation_test.sql (SQL Editor, or psql -v ON_ERROR_STOP=1 -f).
-- Everything runs in one transaction that is rolled back, so it is safe on the
-- real project. All names here are made up.

begin;

create schema dumpy_tests;
grant usage on schema dumpy_tests to anon, authenticated;

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

create function dumpy_tests.changed(p_sql text) returns integer language plpgsql as $$
declare _n integer;
begin
  execute p_sql;
  get diagnostics _n = row_count;
  return _n;
end $$;

-- A society's link code, as the admin would read it off their admin page.
create function dumpy_tests.code_of(p_society uuid) returns text language sql security definer as $$
  select link_code from public.societies where id = p_society
$$;

grant execute on all functions in schema dumpy_tests to anon, authenticated;

-- ----------------------------------------------------------------- fixtures
-- Societies A and B (they will link), C (never links).
--   a_admin, a_owner, a_other   in A (a_owner posts, a_other asks for an item)
--   b_admin, b_member           in B; b_pending and b_susp are not approved
--   c_member                    in C
--   newbie                      has a profile, no society; asks to start D
--   noprofile                   signed in, no profile yet
--   p_admin                     runs Dumpy (platform admin), no society
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', id::uuid, 'authenticated', 'authenticated',
       email, '', now(), '', '', '', '', '{}', '{}', now(), now()
from (values
  ('7e571200-0000-4000-8000-0000000000a0', 'test12.a.admin@example.com'),
  ('7e571200-0000-4000-8000-0000000000a1', 'test12.a.owner@example.com'),
  ('7e571200-0000-4000-8000-0000000000a2', 'test12.a.other@example.com'),
  ('7e571200-0000-4000-8000-0000000000b0', 'test12.b.admin@example.com'),
  ('7e571200-0000-4000-8000-0000000000b1', 'test12.b.member@example.com'),
  ('7e571200-0000-4000-8000-0000000000b2', 'test12.b.pending@example.com'),
  ('7e571200-0000-4000-8000-0000000000b3', 'test12.b.suspended@example.com'),
  ('7e571200-0000-4000-8000-0000000000c1', 'test12.c.member@example.com'),
  ('7e571200-0000-4000-8000-0000000000d0', 'test12.newbie@example.com'),
  ('7e571200-0000-4000-8000-0000000000d9', 'test12.noprofile@example.com'),
  ('7e571200-0000-4000-8000-0000000000f0', 'test12.platform@example.com')
) as t(id, email);

insert into public.societies (id, name, invite_code) values
  ('7e571200-0000-4000-8000-00000000aaaa', 'Test12 Society A', 'TESTAA12'),
  ('7e571200-0000-4000-8000-00000000bbbb', 'Test12 Society B', 'TESTBB12'),
  ('7e571200-0000-4000-8000-00000000cccc', 'Test12 Society C', 'TESTCC12');

insert into public.memberships (user_id, society_id, role, status) values
  ('7e571200-0000-4000-8000-0000000000a0', '7e571200-0000-4000-8000-00000000aaaa', 'admin',  'approved'),
  ('7e571200-0000-4000-8000-0000000000a1', '7e571200-0000-4000-8000-00000000aaaa', 'member', 'approved'),
  ('7e571200-0000-4000-8000-0000000000a2', '7e571200-0000-4000-8000-00000000aaaa', 'member', 'approved'),
  ('7e571200-0000-4000-8000-0000000000b0', '7e571200-0000-4000-8000-00000000bbbb', 'admin',  'approved'),
  ('7e571200-0000-4000-8000-0000000000b1', '7e571200-0000-4000-8000-00000000bbbb', 'member', 'approved'),
  ('7e571200-0000-4000-8000-0000000000b2', '7e571200-0000-4000-8000-00000000bbbb', 'member', 'pending'),
  ('7e571200-0000-4000-8000-0000000000b3', '7e571200-0000-4000-8000-00000000bbbb', 'member', 'suspended'),
  ('7e571200-0000-4000-8000-0000000000c1', '7e571200-0000-4000-8000-00000000cccc', 'member', 'approved');

insert into public.profiles (user_id, display_name, tower, flat, phone) values
  ('7e571200-0000-4000-8000-0000000000a0', 'T12 A Admin',  'A', 'A-101', '9000000101'),
  ('7e571200-0000-4000-8000-0000000000a1', 'T12 A Owner',  'A', 'A-102', '9000000102'),
  ('7e571200-0000-4000-8000-0000000000a2', 'T12 A Other',  'B', 'B-201', null),
  ('7e571200-0000-4000-8000-0000000000b0', 'T12 B Admin',  'P', 'P-101', null),
  ('7e571200-0000-4000-8000-0000000000b1', 'T12 B Member', 'Q', 'Q-202', '9000000112'),
  ('7e571200-0000-4000-8000-0000000000b2', 'T12 B Pending','Q', 'Q-203', null),
  ('7e571200-0000-4000-8000-0000000000b3', 'T12 B Susp',   'Q', 'Q-204', null),
  ('7e571200-0000-4000-8000-0000000000c1', 'T12 C Member', 'X', 'X-901', null),
  ('7e571200-0000-4000-8000-0000000000d0', 'T12 Newbie',   'N', 'N-101', null),
  ('7e571200-0000-4000-8000-0000000000f0', 'T12 Platform', null, null, null);

insert into public.platform_admins (user_id) values ('7e571200-0000-4000-8000-0000000000f0');

-- A's items: near (nearby, available), local (society only), near_res (nearby
-- but reserved), near_old (nearby but past its 30 days). B: b_near, b_local.
insert into public.listings (id, society_id, owner_id, title, price_inr, visibility, status, expires_at) values
  ('7e571200-0000-4000-8000-0000000a0001', '7e571200-0000-4000-8000-00000000aaaa', '7e571200-0000-4000-8000-0000000000a1', 'A near chair', 0,   'nearby',  'available', now() + interval '10 days'),
  ('7e571200-0000-4000-8000-0000000a0002', '7e571200-0000-4000-8000-00000000aaaa', '7e571200-0000-4000-8000-0000000000a1', 'A local lamp', 100, 'society', 'available', now() + interval '10 days'),
  ('7e571200-0000-4000-8000-0000000a0003', '7e571200-0000-4000-8000-00000000aaaa', '7e571200-0000-4000-8000-0000000000a1', 'A near desk',  0,   'nearby',  'available', now() + interval '10 days'),
  ('7e571200-0000-4000-8000-0000000a0004', '7e571200-0000-4000-8000-00000000aaaa', '7e571200-0000-4000-8000-0000000000a1', 'A near old',   0,   'nearby',  'available', now() - interval '1 day'),
  ('7e571200-0000-4000-8000-0000000b0001', '7e571200-0000-4000-8000-00000000bbbb', '7e571200-0000-4000-8000-0000000000b1', 'B near rack',  50,  'nearby',  'available', now() + interval '10 days'),
  ('7e571200-0000-4000-8000-0000000b0002', '7e571200-0000-4000-8000-00000000bbbb', '7e571200-0000-4000-8000-0000000000b1', 'B local fan',  0,   'society', 'available', now() + interval '10 days'),
  ('7e571200-0000-4000-8000-0000000c0001', '7e571200-0000-4000-8000-00000000cccc', '7e571200-0000-4000-8000-0000000000c1', 'C near kettle',0,   'nearby',  'available', now() + interval '10 days');

insert into public.listing_photos (listing_id, society_id, storage_path, position) values
  ('7e571200-0000-4000-8000-0000000a0001', '7e571200-0000-4000-8000-00000000aaaa',
   '7e571200-0000-4000-8000-00000000aaaa/7e571200-0000-4000-8000-0000000a0001/1.webp', 0),
  ('7e571200-0000-4000-8000-0000000a0002', '7e571200-0000-4000-8000-00000000aaaa',
   '7e571200-0000-4000-8000-00000000aaaa/7e571200-0000-4000-8000-0000000a0002/1.webp', 0);
insert into storage.objects (bucket_id, name, owner) values
  ('listing-photos', '7e571200-0000-4000-8000-00000000aaaa/7e571200-0000-4000-8000-0000000a0001/1.webp', '7e571200-0000-4000-8000-0000000000a1'),
  ('listing-photos', '7e571200-0000-4000-8000-00000000aaaa/7e571200-0000-4000-8000-0000000a0002/1.webp', '7e571200-0000-4000-8000-0000000000a1'),
  -- a file in the nearby item's folder that has no photo row
  ('listing-photos', '7e571200-0000-4000-8000-00000000aaaa/7e571200-0000-4000-8000-0000000a0001/stray.webp', '7e571200-0000-4000-8000-0000000000a1');

-- a_other asks for "A near chair" and reports "A near desk"; then the desk is
-- reserved for a_other.
insert into public.requests (id, listing_id, society_id, requester_id, message) values
  ('7e571200-0000-4000-8000-00000000e001', '7e571200-0000-4000-8000-0000000a0001', '7e571200-0000-4000-8000-00000000aaaa', '7e571200-0000-4000-8000-0000000000a2', 'I would like it'),
  ('7e571200-0000-4000-8000-00000000e002', '7e571200-0000-4000-8000-0000000a0003', '7e571200-0000-4000-8000-00000000aaaa', '7e571200-0000-4000-8000-0000000000a2', 'Desk please');
insert into public.reports (listing_id, society_id, reporter_id, reason) values
  ('7e571200-0000-4000-8000-0000000a0001', '7e571200-0000-4000-8000-00000000aaaa', '7e571200-0000-4000-8000-0000000000a2', 'spam');
select dumpy_tests.act_as('7e571200-0000-4000-8000-0000000000a1');
select from public.accept_request('7e571200-0000-4000-8000-00000000e002');
reset role;

-- ======================================================= 1. starting a society
select dumpy_tests.act_as(null);
select dumpy_tests.refused($$ select public.request_society('Test12 Society D', 'Testcity') $$,
  'A signed-out visitor cannot ask to start a society');
select dumpy_tests.refused($$ select public.is_platform_admin() $$,
  'A signed-out visitor cannot even ask who runs Dumpy');

select dumpy_tests.act_as('7e571200-0000-4000-8000-0000000000d9');  -- noprofile
select dumpy_tests.refused($$ select public.request_society('Test12 Society D', 'Testcity') $$,
  'Someone without a profile is asked to set one up first', '55000');

select dumpy_tests.act_as('7e571200-0000-4000-8000-0000000000d0');  -- newbie
select dumpy_tests.refused($$ select public.request_society(' ', 'Testcity') $$,
  'A society name is required', '22023');
select dumpy_tests.refused($$ select public.request_society('Test12 Society D', '') $$,
  'A city is required', '22023');
select dumpy_tests.ok(public.request_society('  Test12   Society D ', 'Testcity') is not null,
  'A signed-in person with a profile asks to start a society');
select dumpy_tests.ok((select status || '/' || name || '/' || contact_email from public.society_requests
                       where requested_by = auth.uid()) = 'pending/Test12 Society D/test12.newbie@example.com',
  'The request is pending, tidied up, and carries the email they signed in with');
select dumpy_tests.refused($$ select public.request_society('test12 society d', 'Testcity') $$,
  'Asking twice for the same society is refused', '23505');
select dumpy_tests.refused($$
  insert into public.society_requests (name, city, contact_email, requested_by)
  values ('Sneaky', 'Testcity', 'x@example.com', auth.uid())
$$, 'Requests cannot be written with a plain insert');
select dumpy_tests.refused($$ update public.society_requests set status = 'approved' $$,
  'Nobody can approve their own request with a plain update');
select dumpy_tests.ok((select count(*) from public.my_memberships()) = 0,
  'Asking does not make them a member of anything yet');
select dumpy_tests.ok(not public.is_platform_admin(), 'An ordinary person is not a platform admin');

select dumpy_tests.act_as('7e571200-0000-4000-8000-0000000000a0');  -- a_admin, a society admin but not platform
select dumpy_tests.ok((select count(*) from public.society_requests) = 0,
  'Others cannot read someone''s society request');
select dumpy_tests.ok((select count(*) from public.platform_society_requests()) = 0,
  'A society admin is not shown the platform request list');
select dumpy_tests.ok((select count(*) from public.platform_societies()) = 0,
  'A society admin is not shown the list of all societies');
select dumpy_tests.refused(format('select public.approve_society_request(%L)',
  (select id from public.society_requests limit 1)),
  'A society admin cannot approve a new society');
select dumpy_tests.refused($$ select public.reject_society_request(gen_random_uuid(), 'no') $$,
  'A society admin cannot reject a new society');
select dumpy_tests.refused($$ select link_code from public.societies $$,
  'Link codes cannot be read with a plain select');
select dumpy_tests.refused($$ select * from public.platform_admins $$,
  'Nobody reads the platform admin list');
select dumpy_tests.refused($$ insert into public.platform_admins (user_id) values (auth.uid()) $$,
  'Nobody makes themselves a platform admin');

select dumpy_tests.act_as('7e571200-0000-4000-8000-0000000000f0');  -- p_admin
select dumpy_tests.ok(public.is_platform_admin(), 'The platform admin is recognised');
select dumpy_tests.ok((select requester_name || '/' || status from public.platform_society_requests()
                       where name = 'Test12 Society D') = 'T12 Newbie/pending',
  'The platform admin sees the request with the asker''s name');
select dumpy_tests.ok((select count(*) from public.platform_societies() where name like 'Test12 Society _') = 3,
  'The platform admin sees every society');
select dumpy_tests.ok((select count(*) from public.listings) = 0
                      and (select count(*) from public.memberships) = 0
                      and (select count(*) from public.society_requests) = 0,
  'Running Dumpy does not let the platform admin read any society''s items, members or plain request rows');

create temporary table d_new on commit drop as
  select * from public.approve_society_request(
    (select id from public.platform_society_requests() where name = 'Test12 Society D'));
grant select on d_new to authenticated;
select dumpy_tests.ok((select invite_code ~ '^[A-Z0-9]{8}$' from d_new), 'Approving gives the new society its own invite code');
select dumpy_tests.refused(format('select public.approve_society_request(%L)',
  (select id from public.platform_society_requests() where name = 'Test12 Society D')),
  'A request cannot be approved twice', '55000');

select dumpy_tests.act_as('7e571200-0000-4000-8000-0000000000d0');  -- newbie, now admin of D
select dumpy_tests.ok((select role || '/' || status || '/' || society_name from public.my_memberships()) = 'admin/approved/Test12 Society D',
  'The person who asked is now the approved admin of the new society');
select dumpy_tests.ok((select status from public.society_requests where requested_by = auth.uid()) = 'approved'
                      and (select society_id from public.society_requests where requested_by = auth.uid()) = (select society_id from d_new),
  'They see their request approved and pointing at the new society');
select dumpy_tests.ok((select count(*) from public.societies) = 1
                      and (select city from public.societies) = 'Testcity',
  'The new admin reads only their own society, with its city');
select dumpy_tests.ok((select count(*) from public.listings) = 0
                      and (select count(*) from public.profiles where user_id <> auth.uid()) = 0
                      and (select count(*) from public.admin_list_members('7e571200-0000-4000-8000-00000000aaaa')) = 0,
  'The new society sees no items, people or members of the others');
select dumpy_tests.ok(dumpy_tests.changed(format(
  'insert into public.listings (society_id, owner_id, title) values (%L, auth.uid(), %L)',
  (select society_id from d_new), 'D first item')) = 1, 'The new admin posts the new society''s first item');

select dumpy_tests.act_as('7e571200-0000-4000-8000-0000000000c1');  -- c_member joins D with the code
select dumpy_tests.ok((select status from public.join_society((select lower(invite_code) from d_new))) = 'pending',
  'A neighbour asks to join the new society with its invite code');
select dumpy_tests.ok((select count(*) from public.listings where title = 'D first item') = 0,
  'While pending, they see nothing of it');

select dumpy_tests.act_as('7e571200-0000-4000-8000-0000000000d0');
select dumpy_tests.ok(dumpy_tests.changed(format(
  'update public.memberships set status = %L where society_id = %L and user_id = %L',
  'approved', (select society_id from d_new), '7e571200-0000-4000-8000-0000000000c1')) = 1,
  'The new society''s own admin approves them');

select dumpy_tests.act_as('7e571200-0000-4000-8000-0000000000c1');
select dumpy_tests.ok((select count(*) from public.listings where title = 'D first item') = 1,
  'Once approved they see the new society''s items');

select dumpy_tests.act_as('7e571200-0000-4000-8000-0000000000a0');  -- a_admin
select dumpy_tests.ok((select count(*) from public.societies where id = (select society_id from d_new)) = 0
                      and (select count(*) from public.listings where title = 'D first item') = 0
                      and (select count(*) from public.admin_list_members((select society_id from d_new))) = 0,
  'The first society sees nothing of the new one');

-- Turning a request down, withdrawing one, and the limit of 3.
select dumpy_tests.act_as('7e571200-0000-4000-8000-0000000000c1');
select from public.request_society('Test12 Society E', 'Testcity');
select from public.request_society('Test12 Society F', 'Testcity');
select dumpy_tests.act_as('7e571200-0000-4000-8000-0000000000f0');
select from public.reject_society_request((select id from public.platform_society_requests() where name = 'Test12 Society E'),
  'Please ask your society office to write in first.');
select dumpy_tests.refused(format('select public.reject_society_request(%L)',
  (select id from public.platform_society_requests() where name = 'Test12 Society E')),
  'An answered request cannot be answered again', '55000');
select dumpy_tests.act_as('7e571200-0000-4000-8000-0000000000c1');
select dumpy_tests.ok((select status || '/' || note from public.society_requests where name = 'Test12 Society E')
                      = 'rejected/Please ask your society office to write in first.',
  'The asker sees the request turned down, with the note');
select dumpy_tests.ok(dumpy_tests.changed($$ delete from public.society_requests where name = 'Test12 Society E' $$) = 0,
  'An answered request cannot be deleted');
select dumpy_tests.ok(dumpy_tests.changed($$ delete from public.society_requests where name = 'Test12 Society F' $$) = 1,
  'A pending request can be withdrawn');
select from public.request_society('Test12 Society G', 'Testcity');
select from public.request_society('Test12 Society H', 'Testcity');
select from public.request_society('Test12 Society I', 'Testcity');
select dumpy_tests.refused($$ select public.request_society('Test12 Society J', 'Testcity') $$,
  'Nobody can have more than 3 requests waiting', '55000');
select dumpy_tests.act_as('7e571200-0000-4000-8000-0000000000d0');
select from public.request_society('Test12 Society G', 'Testcity');
select dumpy_tests.act_as('7e571200-0000-4000-8000-0000000000f0');
select from public.approve_society_request((select id from public.platform_society_requests()
                                       where name = 'Test12 Society G' and requester_name = 'T12 C Member'));
select dumpy_tests.refused(format('select public.approve_society_request(%L)',
  (select id from public.platform_society_requests() where name = 'Test12 Society G' and status = 'pending')),
  'A second society with the same name in the same city is refused', '23505');

-- ===================================================== 2. nearby societies
select dumpy_tests.act_as('7e571200-0000-4000-8000-0000000000b1');  -- b_member
select dumpy_tests.ok((select count(*) from public.listings where society_id = '7e571200-0000-4000-8000-00000000aaaa') = 0,
  'Before linking, B sees none of A''s items, not even nearby ones');

select dumpy_tests.act_as('7e571200-0000-4000-8000-0000000000a1');  -- a_owner, not an admin
select dumpy_tests.ok(public.society_link_code('7e571200-0000-4000-8000-00000000aaaa') is null,
  'A plain member does not get the link code');
select dumpy_tests.refused(format('select public.link_society(%L, %L)', '7e571200-0000-4000-8000-00000000aaaa',
  dumpy_tests.code_of('7e571200-0000-4000-8000-00000000bbbb')),
  'A plain member cannot link their society');
select dumpy_tests.refused($$ select * from public.society_links $$,
  'Nobody reads society links with a plain select');

select dumpy_tests.act_as('7e571200-0000-4000-8000-0000000000b0');  -- b_admin
select dumpy_tests.ok(public.society_link_code('7e571200-0000-4000-8000-00000000aaaa') is null,
  'An admin cannot get another society''s link code');
select dumpy_tests.ok(public.society_link_code('7e571200-0000-4000-8000-00000000bbbb') = dumpy_tests.code_of('7e571200-0000-4000-8000-00000000bbbb'),
  'An admin gets their own society''s link code');
select dumpy_tests.refused(format('select public.link_society(%L, %L)', '7e571200-0000-4000-8000-00000000aaaa',
  dumpy_tests.code_of('7e571200-0000-4000-8000-00000000cccc')),
  'An admin cannot link a society they do not run');

select dumpy_tests.act_as('7e571200-0000-4000-8000-0000000000a0');  -- a_admin
select dumpy_tests.refused($$ select public.link_society('7e571200-0000-4000-8000-00000000aaaa', 'NOSUCHCD') $$,
  'A wrong link code is refused', 'P0002');
select dumpy_tests.refused(format('select public.link_society(%L, %L)', '7e571200-0000-4000-8000-00000000aaaa',
  dumpy_tests.code_of('7e571200-0000-4000-8000-00000000aaaa')),
  'A society cannot link to itself', '22023');
select dumpy_tests.refused(format('select public.join_society(%L)', dumpy_tests.code_of('7e571200-0000-4000-8000-00000000bbbb')),
  'A link code does not work as an invite code', 'P0002');
select dumpy_tests.ok((select name || '/' || status from public.link_society('7e571200-0000-4000-8000-00000000aaaa',
  lower(dumpy_tests.code_of('7e571200-0000-4000-8000-00000000bbbb')))) = 'Test12 Society B/asked',
  'A''s admin asks to share with B using B''s code; it waits for B');

select dumpy_tests.act_as('7e571200-0000-4000-8000-0000000000b1');  -- b_member
select dumpy_tests.ok((select count(*) from public.listings where society_id = '7e571200-0000-4000-8000-00000000aaaa') = 0,
  'One side agreeing is not enough: B still sees none of A''s items');
select dumpy_tests.ok((select count(*) from public.nearby_societies('7e571200-0000-4000-8000-00000000bbbb')) = 0,
  'B''s plain members are not shown A''s ask');

select dumpy_tests.act_as('7e571200-0000-4000-8000-0000000000b0');  -- b_admin
select dumpy_tests.ok((select name || '/' || status from public.nearby_societies('7e571200-0000-4000-8000-00000000bbbb')) = 'Test12 Society A/asking',
  'B''s admin sees that A asked');
select dumpy_tests.refused(format('select public.accept_society_link(%L, %L)', '7e571200-0000-4000-8000-00000000bbbb', '7e571200-0000-4000-8000-00000000cccc'),
  'B cannot accept a society that never asked', 'P0002');
select from public.accept_society_link('7e571200-0000-4000-8000-00000000bbbb', '7e571200-0000-4000-8000-00000000aaaa');
select dumpy_tests.ok((select status from public.nearby_societies('7e571200-0000-4000-8000-00000000bbbb')) = 'linked',
  'B''s admin agrees, and the two societies are linked');

select dumpy_tests.act_as('7e571200-0000-4000-8000-0000000000a1');  -- a_owner
select dumpy_tests.ok((select name || '/' || status from public.nearby_societies('7e571200-0000-4000-8000-00000000aaaa')) = 'Test12 Society B/linked',
  'A''s members see B''s name as a linked society');

select dumpy_tests.act_as('7e571200-0000-4000-8000-0000000000c1');  -- c_member
select dumpy_tests.ok((select count(*) from public.nearby_societies('7e571200-0000-4000-8000-00000000aaaa')) = 0,
  'Outsiders are not told who A shares with');

select dumpy_tests.act_as('7e571200-0000-4000-8000-0000000000b1');  -- b_member, linked
select dumpy_tests.ok((select string_agg(title, ',') from public.listings where society_id = '7e571200-0000-4000-8000-00000000aaaa') = 'A near chair',
  'Linked: B sees only A''s available nearby items (not society-only, reserved or out-of-date ones)');
select dumpy_tests.ok((select count(*) from public.listing_photos where society_id = '7e571200-0000-4000-8000-00000000aaaa') = 1
                      and (select listing_id from public.listing_photos where society_id = '7e571200-0000-4000-8000-00000000aaaa') = '7e571200-0000-4000-8000-0000000a0001',
  'B sees the photo rows of the nearby item only');
select dumpy_tests.ok((select string_agg(name, ',') from storage.objects where name like '7e571200-0000-4000-8000-00000000aaaa/%')
                      = '7e571200-0000-4000-8000-00000000aaaa/7e571200-0000-4000-8000-0000000a0001/1.webp',
  'B can open the nearby item''s photo file, and no other file of A');
select dumpy_tests.ok((select count(*) from public.societies) = 1,
  'B still reads only its own society row (A''s invite code stays hidden)');
select dumpy_tests.ok((select count(*) from public.memberships where society_id = '7e571200-0000-4000-8000-00000000aaaa') = 0,
  'B cannot read A''s members');
select dumpy_tests.ok((select count(*) from public.profiles where user_id in
                       ('7e571200-0000-4000-8000-0000000000a0', '7e571200-0000-4000-8000-0000000000a1', '7e571200-0000-4000-8000-0000000000a2')) = 0,
  'B cannot read A''s people, not even the nearby item''s owner''s name');
select dumpy_tests.ok((select count(*) from public.requests where society_id = '7e571200-0000-4000-8000-00000000aaaa') = 0,
  'B cannot read requests on A''s items');
select dumpy_tests.ok((select count(*) from public.reports where society_id = '7e571200-0000-4000-8000-00000000aaaa') = 0,
  'B cannot read reports on A''s items');
select dumpy_tests.ok((select count(*) from public.get_contact('7e571200-0000-4000-8000-0000000a0001')) = 0
                      and (select count(*) from public.get_contact('7e571200-0000-4000-8000-0000000a0003')) = 0,
  'B gets no contact details from A');
select dumpy_tests.ok((select count(*) from public.admin_list_members('7e571200-0000-4000-8000-00000000aaaa')) = 0,
  'B gets no member list from A');
select dumpy_tests.refused($$
  insert into public.requests (listing_id, society_id, requester_id)
  values ('7e571200-0000-4000-8000-0000000a0001', '7e571200-0000-4000-8000-00000000aaaa', auth.uid())
$$, 'B cannot ask for a nearby item (requests stay inside a society)');
select dumpy_tests.refused($$
  insert into public.reports (listing_id, society_id, reporter_id, reason)
  values ('7e571200-0000-4000-8000-0000000a0001', '7e571200-0000-4000-8000-00000000aaaa', auth.uid(), 'spam')
$$, 'B cannot report a nearby item');
select dumpy_tests.ok(dumpy_tests.changed($$
  update public.listings set title = 'hacked', visibility = 'society' where id = '7e571200-0000-4000-8000-0000000a0001'
$$) = 0, 'B cannot change a nearby item');
select dumpy_tests.refused($$
  insert into public.listing_photos (listing_id, society_id, storage_path)
  values ('7e571200-0000-4000-8000-0000000a0001', '7e571200-0000-4000-8000-00000000aaaa',
          '7e571200-0000-4000-8000-00000000aaaa/7e571200-0000-4000-8000-0000000a0001/2.webp')
$$, 'B cannot add a photo to a nearby item');
select dumpy_tests.refused($$
  insert into storage.objects (bucket_id, name, owner)
  values ('listing-photos', '7e571200-0000-4000-8000-00000000aaaa/7e571200-0000-4000-8000-0000000a0001/2.webp', auth.uid())
$$, 'B cannot upload into a nearby item''s folder');
select dumpy_tests.refused($$ select public.accept_request('7e571200-0000-4000-8000-00000000e001') $$,
  'B cannot accept requests on A''s items');

select dumpy_tests.act_as('7e571200-0000-4000-8000-0000000000b2');  -- b_pending
select dumpy_tests.ok((select count(*) from public.listings) = 0, 'A pending member of B sees no nearby items');
select dumpy_tests.act_as('7e571200-0000-4000-8000-0000000000b3');  -- b_susp
select dumpy_tests.ok((select count(*) from public.listings) = 0, 'A suspended member of B sees no nearby items');
select dumpy_tests.act_as('7e571200-0000-4000-8000-0000000000c1');  -- c_member (C is not linked)
select dumpy_tests.ok((select count(*) from public.listings where society_id in
                       ('7e571200-0000-4000-8000-00000000aaaa', '7e571200-0000-4000-8000-00000000bbbb')) = 0,
  'An unlinked society sees nothing of A or B');
select dumpy_tests.act_as('7e571200-0000-4000-8000-0000000000a2');  -- a_other
select dumpy_tests.ok((select string_agg(title, ',') from public.listings where society_id = '7e571200-0000-4000-8000-00000000bbbb') = 'B near rack',
  'It works both ways: A sees only B''s nearby item');
select dumpy_tests.ok((select count(*) from public.listings where society_id = '7e571200-0000-4000-8000-00000000cccc') = 0,
  'A does not see C''s nearby item');

-- Owners choose per item.
select dumpy_tests.ok(dumpy_tests.changed($$
  update public.listings set visibility = 'nearby' where id = '7e571200-0000-4000-8000-0000000a0002'
$$) = 0, 'Only the owner can share an item with nearby societies');
select dumpy_tests.act_as('7e571200-0000-4000-8000-0000000000a1');  -- a_owner
select dumpy_tests.refused($$ update public.listings set visibility = 'everyone' where id = '7e571200-0000-4000-8000-0000000a0002' $$,
  'Visibility is "society" or "nearby" only', '23514');
select dumpy_tests.ok(dumpy_tests.changed($$
  update public.listings set visibility = 'nearby' where id = '7e571200-0000-4000-8000-0000000a0002'
$$) = 1, 'The owner shares the lamp with nearby societies');
select dumpy_tests.act_as('7e571200-0000-4000-8000-0000000000b1');
select dumpy_tests.ok((select count(*) from public.listings where society_id = '7e571200-0000-4000-8000-00000000aaaa') = 2,
  'B now sees the lamp too');
select dumpy_tests.act_as('7e571200-0000-4000-8000-0000000000a1');
select dumpy_tests.ok(dumpy_tests.changed($$
  update public.listings set status = 'withdrawn' where id = '7e571200-0000-4000-8000-0000000a0002'
$$) = 1, 'The owner withdraws the lamp');
select dumpy_tests.act_as('7e571200-0000-4000-8000-0000000000b1');
select dumpy_tests.ok((select string_agg(title, ',') from public.listings where society_id = '7e571200-0000-4000-8000-00000000aaaa') = 'A near chair',
  'A withdrawn nearby item disappears for B');
select dumpy_tests.ok((select count(*) from storage.objects where name like '7e571200-0000-4000-8000-00000000aaaa/7e571200-0000-4000-8000-0000000a0002/%') = 0,
  'and so do its photo files');

-- Either side can stop sharing.
select dumpy_tests.act_as('7e571200-0000-4000-8000-0000000000b1');
select dumpy_tests.refused($$ select public.unlink_society('7e571200-0000-4000-8000-00000000bbbb', '7e571200-0000-4000-8000-00000000aaaa') $$,
  'A plain member cannot stop sharing');
select dumpy_tests.act_as('7e571200-0000-4000-8000-0000000000b0');
select from public.unlink_society('7e571200-0000-4000-8000-00000000bbbb', '7e571200-0000-4000-8000-00000000aaaa');
select dumpy_tests.act_as('7e571200-0000-4000-8000-0000000000b1');
select dumpy_tests.ok((select count(*) from public.listings where society_id = '7e571200-0000-4000-8000-00000000aaaa') = 0
                      and (select count(*) from storage.objects where name like '7e571200-0000-4000-8000-00000000aaaa/%') = 0,
  'Once B stops sharing, B sees nothing of A again');
select dumpy_tests.act_as('7e571200-0000-4000-8000-0000000000a0');
select dumpy_tests.ok((select count(*) from public.nearby_societies('7e571200-0000-4000-8000-00000000aaaa')) = 0,
  'and the link is gone on A''s side too');

select 'All Dumpy society tests passed' as result;

rollback;
