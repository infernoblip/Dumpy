-- Dumpy delivery proof tests (20261107120000).
--
-- Proves:
--   * only the helper uploads the photo, to their own job's folder; only the
--     pair, the helper and the society's admins read it
--   * the helper can't mark a job delivered without an uploaded photo
--   * only the seller confirms the pickup
--   * only the buyer confirms receipt; "no" opens a problem, emails the helper
--     and the admins, and gives the buyer the admins' and seller's phones
--   * a society admin decides; "delivered" needs the helper's second
--     confirmation; others can't decide
--
-- Runs in one transaction that is rolled back. All people are made up.

begin;

create schema dumpy_ptests;
grant usage on schema dumpy_ptests to anon, authenticated;

create function dumpy_ptests.act_as(p_user uuid) returns void language plpgsql as $$
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

create function dumpy_ptests.ok(p_pass boolean, p_label text) returns void language plpgsql as $$
begin
  if p_pass is distinct from true then
    raise exception 'FAIL: %', p_label;
  end if;
  raise notice 'ok - %', p_label;
end $$;

create function dumpy_ptests.refused(p_sql text, p_label text, p_code text default '42501')
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

create function dumpy_ptests.slot(p_day int, p_hour int) returns timestamptz language sql stable as $$
  select (((now() at time zone 'Asia/Kolkata')::date + p_day) + make_time(p_hour, 0, 0)) at time zone 'Asia/Kolkata'
$$;

create table dumpy_ptests.ids (name text primary key, id uuid);
grant all on dumpy_ptests.ids to authenticated;
grant execute on all functions in schema dumpy_ptests to anon, authenticated;

-- ----------------------------------------------------------------- fixtures
-- Society E: e_owner sells, e_taker takes, e_helper delivers, e_admin is the
-- society admin, e_plain is another member.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', id::uuid, 'authenticated', 'authenticated',
       email, '', now(), '', '', '', '', '{}', '{}', now(), now()
from (values ('7e570000-0000-4000-8000-0000000e0001', 'test.e.owner@example.com'), ('7e570000-0000-4000-8000-0000000e0002', 'test.e.taker@example.com'),
             ('7e570000-0000-4000-8000-0000000e0003', 'test.e.helper@example.com'), ('7e570000-0000-4000-8000-0000000e0004', 'test.e.admin@example.com'),
             ('7e570000-0000-4000-8000-0000000e0005', 'test.e.plain@example.com')) as t(id, email);
insert into public.societies (id, name, invite_code) values ('7e570000-0000-4000-8000-0000000e50c1', 'Test Society E', 'TESTEEEE');
insert into public.memberships (user_id, society_id, status, role)
select id::uuid, '7e570000-0000-4000-8000-0000000e50c1', 'approved', r
from (values ('7e570000-0000-4000-8000-0000000e0001', 'member'), ('7e570000-0000-4000-8000-0000000e0002', 'member'), ('7e570000-0000-4000-8000-0000000e0003', 'member'), ('7e570000-0000-4000-8000-0000000e0004', 'admin'), ('7e570000-0000-4000-8000-0000000e0005', 'member')) t(id, r);
insert into public.profiles (user_id, display_name, tower, flat, phone) values
  ('7e570000-0000-4000-8000-0000000e0001', 'Test Owner',  'A', 'A-101', '9000000101'),
  ('7e570000-0000-4000-8000-0000000e0002', 'Test Taker',  'C', 'C-303', '9000000303'),
  ('7e570000-0000-4000-8000-0000000e0003', 'Test Helper', 'B', 'B-202', '9000000202'),
  ('7e570000-0000-4000-8000-0000000e0004', 'Test Admin',  'D', 'D-404', '9000000404'),
  ('7e570000-0000-4000-8000-0000000e0005', 'Test Plain',  'E', 'E-505', null);
insert into public.delivery_helpers (society_id, user_id) values ('7e570000-0000-4000-8000-0000000e50c1', '7e570000-0000-4000-8000-0000000e0003');
insert into public.listings (id, society_id, owner_id, title, price_inr) values
  ('7e570000-0000-4000-8000-0000000e1001', '7e570000-0000-4000-8000-0000000e50c1', '7e570000-0000-4000-8000-0000000e0001', 'Test bookshelf', 0),
  ('7e570000-0000-4000-8000-0000000e1002', '7e570000-0000-4000-8000-0000000e50c1', '7e570000-0000-4000-8000-0000000e0001', 'Test kettle', 0);
insert into public.requests (listing_id, society_id, requester_id) values ('7e570000-0000-4000-8000-0000000e1001', '7e570000-0000-4000-8000-0000000e50c1', '7e570000-0000-4000-8000-0000000e0002'), ('7e570000-0000-4000-8000-0000000e1002', '7e570000-0000-4000-8000-0000000e50c1', '7e570000-0000-4000-8000-0000000e0002');
select dumpy_ptests.act_as('7e570000-0000-4000-8000-0000000e0001');
select public.accept_request(r.id) from public.requests r where r.listing_id in ('7e570000-0000-4000-8000-0000000e1001', '7e570000-0000-4000-8000-0000000e1002');
insert into dumpy_ptests.ids select 'd1', public.arrange_delivery('7e570000-0000-4000-8000-0000000e1001', 'helper', dumpy_ptests.slot(1, 10), '');
insert into dumpy_ptests.ids select 'd2', public.arrange_delivery('7e570000-0000-4000-8000-0000000e1002', 'helper', dumpy_ptests.slot(1, 12), '');
select dumpy_ptests.refused($$ select public.confirm_pickup((select id from dumpy_ptests.ids where name = 'd1')) $$,
  'The seller cannot confirm a pickup before a helper takes the job', '55000');

select dumpy_ptests.act_as('7e570000-0000-4000-8000-0000000e0003');
select public.claim_delivery(id) from dumpy_ptests.ids;

-- ---------------------------------------------------------------- photo
reset role;
create function dumpy_ptests.path(p_name text) returns text language sql as $$
  select '7e570000-0000-4000-8000-0000000e50c1/' || (select id from dumpy_ptests.ids where name = p_name) || '/proof.webp'
$$;
grant execute on function dumpy_ptests.path(text) to authenticated;
select dumpy_ptests.act_as('7e570000-0000-4000-8000-0000000e0003');

select dumpy_ptests.refused($$ select public.mark_delivered((select id from dumpy_ptests.ids where name = 'd1')) $$,
  'The helper cannot mark it delivered without a photo', '22023');
select dumpy_ptests.refused($$ select public.mark_delivered((select id from dumpy_ptests.ids where name = 'd1'), dumpy_ptests.path('d1')) $$,
  'or with a photo that never uploaded', '22023');

select dumpy_ptests.act_as('7e570000-0000-4000-8000-0000000e0005');
select dumpy_ptests.refused($$ insert into storage.objects (bucket_id, name) values ('delivery-proofs', dumpy_ptests.path('d1')) $$,
  'Another member cannot upload a photo for the job', '42501');
select dumpy_ptests.act_as('7e570000-0000-4000-8000-0000000e0003');
select dumpy_ptests.refused($$ insert into storage.objects (bucket_id, name) values ('delivery-proofs', '7e570000-0000-4000-8000-0000000e50c1/' || gen_random_uuid() || '/x.webp') $$,
  'The helper cannot upload into another delivery''s folder', '42501');
insert into storage.objects (bucket_id, name) values ('delivery-proofs', dumpy_ptests.path('d1'));
select dumpy_ptests.ok(true, 'The helper uploads the photo for their job');

-- ---------------------------------------------------------------- pickup
select dumpy_ptests.act_as('7e570000-0000-4000-8000-0000000e0002');
select dumpy_ptests.refused($$ select public.confirm_pickup((select id from dumpy_ptests.ids where name = 'd1')) $$,
  'The buyer cannot confirm the pickup');
select dumpy_ptests.act_as('7e570000-0000-4000-8000-0000000e0001');
select dumpy_ptests.ok(public.confirm_pickup((select id from dumpy_ptests.ids where name = 'd1')) is not null,
  'The seller confirms the helper picked it up');
select dumpy_ptests.ok((select pickup_confirmed_at is not null and helper_name = 'Test Helper' from public.get_delivery('7e570000-0000-4000-8000-0000000e1001')),
  'The seller sees the helper and the confirmed pickup');
select dumpy_ptests.act_as('7e570000-0000-4000-8000-0000000e0002');
select dumpy_ptests.ok((select helper_name || ' ' || helper_tower || ' ' || (slot_start is not null)::text from public.get_delivery('7e570000-0000-4000-8000-0000000e1001')) = 'Test Helper B true',
  'The buyer sees who the helper is and when they come');

select dumpy_ptests.refused($$ select public.confirm_received((select id from dumpy_ptests.ids where name = 'd1'), true) $$,
  'Nothing to confirm before it is delivered', '55000');

select dumpy_ptests.act_as('7e570000-0000-4000-8000-0000000e0003');
select public.mark_delivered((select id from dumpy_ptests.ids where name = 'd1'), dumpy_ptests.path('d1'));
select dumpy_ptests.ok((select proof_path from public.deliveries where id = (select id from dumpy_ptests.ids where name = 'd1')) = dumpy_ptests.path('d1'),
  'With the photo uploaded, the helper marks it delivered and the photo is kept');

select dumpy_ptests.act_as('7e570000-0000-4000-8000-0000000e0002');
select dumpy_ptests.ok((select count(*) from storage.objects where bucket_id = 'delivery-proofs') = 1, 'The buyer can see the photo');
select dumpy_ptests.act_as('7e570000-0000-4000-8000-0000000e0004');
select dumpy_ptests.ok((select count(*) from storage.objects where bucket_id = 'delivery-proofs') = 1, 'The society admin can see the photo');
select dumpy_ptests.act_as('7e570000-0000-4000-8000-0000000e0005');
select dumpy_ptests.ok((select count(*) from storage.objects where bucket_id = 'delivery-proofs') = 0, 'Another member cannot');

-- ------------------------------------------------------- buyer says no
select dumpy_ptests.act_as('7e570000-0000-4000-8000-0000000e0001');
select dumpy_ptests.refused($$ select public.confirm_received((select id from dumpy_ptests.ids where name = 'd1'), false) $$,
  'The seller cannot answer for the buyer');
select dumpy_ptests.ok((select count(*) from public.delivery_problem_contacts('7e570000-0000-4000-8000-0000000e1001')) = 0, 'The seller gets no problem contacts');

select dumpy_ptests.act_as('7e570000-0000-4000-8000-0000000e0002');
select dumpy_ptests.ok((select count(*) from public.delivery_problem_contacts('7e570000-0000-4000-8000-0000000e1001')) = 0, 'No contacts before a problem is reported');
select dumpy_ptests.ok(public.confirm_received((select id from dumpy_ptests.ids where name = 'd1'), false) = 'problem',
  'The buyer says they did not receive it');
select dumpy_ptests.ok((select string_agg(role || ':' || display_name || ':' || phone, ', ' order by role) from public.delivery_problem_contacts('7e570000-0000-4000-8000-0000000e1001'))
                       = 'admin:Test Admin:9000000404, seller:Test Owner:9000000101',
  'The buyer gets the society admin''s and the seller''s phone numbers');

reset role;
select dumpy_ptests.ok((select string_agg(p.display_name, ', ' order by p.display_name) from public.notifications n
                         join public.profiles p on p.user_id = n.recipient_id where n.kind = 'delivery_problem')
                       = 'Test Admin, Test Helper', 'The helper and the society admin are emailed about the problem');

select dumpy_ptests.act_as('7e570000-0000-4000-8000-0000000e0005');
select dumpy_ptests.refused($$ select public.resolve_delivery_problem((select id from dumpy_ptests.ids where name = 'd1'), 'delivered') $$,
  'A plain member cannot decide');
select dumpy_ptests.ok((select count(*) from public.society_delivery_problems('7e570000-0000-4000-8000-0000000e50c1')) = 0, 'and cannot see the problems list');

select dumpy_ptests.act_as('7e570000-0000-4000-8000-0000000e0004');
select dumpy_ptests.ok((select title || ' ' || helper_phone || ' ' || seller_phone || ' ' || buyer_phone || ' ' || (proof_path is not null)::text
                        from public.society_delivery_problems('7e570000-0000-4000-8000-0000000e50c1')) = 'Test bookshelf 9000000202 9000000101 9000000303 true',
  'The society admin sees the problem with everyone''s phone and the photo');
select dumpy_ptests.refused($$ select public.resolve_delivery_problem((select id from dumpy_ptests.ids where name = 'd1'), 'delivered') $$,
  'The admin cannot rule "delivered" before the helper confirms again', '55000');

select dumpy_ptests.act_as('7e570000-0000-4000-8000-0000000e0003');
select dumpy_ptests.ok((select problem_at is not null and drop_phone = '9000000303' from public.my_delivery_jobs('7e570000-0000-4000-8000-0000000e50c1') where title = 'Test bookshelf'),
  'The helper sees the problem on their jobs, with the buyer''s phone');
select dumpy_ptests.ok(public.helper_reconfirm_delivery((select id from dumpy_ptests.ids where name = 'd1')) is not null,
  'The helper confirms a second time that they delivered it');

select dumpy_ptests.act_as('7e570000-0000-4000-8000-0000000e0004');
select public.resolve_delivery_problem((select id from dumpy_ptests.ids where name = 'd1'), 'delivered');
select dumpy_ptests.ok((select problem_outcome from public.society_delivery_problems('7e570000-0000-4000-8000-0000000e50c1')) = 'delivered',
  'Then the society admin rules it delivered');
select dumpy_ptests.refused($$ select public.resolve_delivery_problem((select id from dumpy_ptests.ids where name = 'd1'), 'not_delivered') $$,
  'A decided problem stays decided', '55000');
select dumpy_ptests.act_as('7e570000-0000-4000-8000-0000000e0002');
select dumpy_ptests.refused($$ select public.confirm_received((select id from dumpy_ptests.ids where name = 'd1'), true) $$,
  'The buyer cannot change it after the admin decided', '55000');

-- ------------------------------------------------------- buyer says yes
select dumpy_ptests.act_as('7e570000-0000-4000-8000-0000000e0003');
insert into storage.objects (bucket_id, name) values ('delivery-proofs', dumpy_ptests.path('d2'));
select public.mark_delivered((select id from dumpy_ptests.ids where name = 'd2'), dumpy_ptests.path('d2'));
select dumpy_ptests.act_as('7e570000-0000-4000-8000-0000000e0002');
select dumpy_ptests.ok(public.confirm_received((select id from dumpy_ptests.ids where name = 'd2'), true) = 'received', 'The buyer says they got it');
select dumpy_ptests.refused($$ select public.confirm_received((select id from dumpy_ptests.ids where name = 'd2'), false) $$,
  'and cannot report a problem afterwards', '55000');

reset role;
select 'All Dumpy delivery proof tests passed' as result;

rollback;
