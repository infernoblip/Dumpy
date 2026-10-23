-- Dumpy delivery tests (stage 7).
--
-- Proves the delivery rules hold:
--   * only the matched pair arranges, changes or cancels a delivery, and only
--     for a 2-hour slot today or tomorrow
--   * only members who switched on "I can help deliver" see open helper jobs,
--     and they see towers, never flats or phones
--   * a helper claims a job, exactly one helper holds it, and only then do
--     they get both sides' flat and phone
--   * the helper (or the owner) marks it delivered and the item becomes done
--   * other societies, pending members and plain table writes get nothing
--
-- How to run: like isolation_test.sql.
--   * Supabase dashboard: SQL Editor > New query, paste this whole file, Run.
--     It passes if it finishes without an error ("FAIL: ..." says what broke).
--   * Command line: psql "<connection string>" -v ON_ERROR_STOP=1 -f supabase/tests/delivery_test.sql
-- Everything runs in one transaction that is rolled back, so it is safe to
-- run on the real project. All people and societies are made up.

begin;

-- ------------------------------------------------------------------ helpers
create schema dumpy_dtests;
grant usage on schema dumpy_dtests to anon, authenticated;

create function dumpy_dtests.act_as(p_user uuid) returns void language plpgsql as $$
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

create function dumpy_dtests.ok(p_pass boolean, p_label text) returns void language plpgsql as $$
begin
  if p_pass is distinct from true then
    raise exception 'FAIL: %', p_label;
  end if;
  raise notice 'ok - %', p_label;
end $$;

create function dumpy_dtests.refused(p_sql text, p_label text, p_code text default '42501')
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

-- A slot start in Indian time: day 0 is today, 1 is tomorrow.
create function dumpy_dtests.slot(p_day int, p_hour int) returns timestamptz language sql stable as $$
  select (((now() at time zone 'Asia/Kolkata')::date + p_day) + make_time(p_hour, 0, 0)) at time zone 'Asia/Kolkata'
$$;

grant execute on all functions in schema dumpy_dtests to anon, authenticated;

-- ----------------------------------------------------------------- fixtures
-- Society D:
--   d_owner   owns the items          d_taker   their request gets accepted
--   d_helper  helper, claims the job  d_helper2 another helper
--   d_plain   member, not a helper    d_pending asked to join, not approved
-- Society E:
--   e_helper  a helper, but in the other society
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', id::uuid, 'authenticated', 'authenticated',
       email, '', now(), '', '', '', '', '{}', '{}', now(), now()
from (values
  ('7e570000-0000-4000-8000-0000000007d1', 'test.d.owner@example.com'),
  ('7e570000-0000-4000-8000-0000000007d2', 'test.d.taker@example.com'),
  ('7e570000-0000-4000-8000-0000000007d3', 'test.d.helper@example.com'),
  ('7e570000-0000-4000-8000-0000000007d4', 'test.d.helper2@example.com'),
  ('7e570000-0000-4000-8000-0000000007d5', 'test.d.plain@example.com'),
  ('7e570000-0000-4000-8000-0000000007d6', 'test.d.pending@example.com'),
  ('7e570000-0000-4000-8000-0000000007e1', 'test.e.helper@example.com')
) as t(id, email);

insert into public.societies (id, name, invite_code) values
  ('7e570000-0000-4000-8000-00000000d7dd', 'Test Society D', 'TESTDDDD'),
  ('7e570000-0000-4000-8000-00000000d7ee', 'Test Society E', 'TESTEEEE');

insert into public.memberships (user_id, society_id, status) values
  ('7e570000-0000-4000-8000-0000000007d1', '7e570000-0000-4000-8000-00000000d7dd', 'approved'),
  ('7e570000-0000-4000-8000-0000000007d2', '7e570000-0000-4000-8000-00000000d7dd', 'approved'),
  ('7e570000-0000-4000-8000-0000000007d3', '7e570000-0000-4000-8000-00000000d7dd', 'approved'),
  ('7e570000-0000-4000-8000-0000000007d4', '7e570000-0000-4000-8000-00000000d7dd', 'approved'),
  ('7e570000-0000-4000-8000-0000000007d5', '7e570000-0000-4000-8000-00000000d7dd', 'approved'),
  ('7e570000-0000-4000-8000-0000000007d6', '7e570000-0000-4000-8000-00000000d7dd', 'pending'),
  ('7e570000-0000-4000-8000-0000000007e1', '7e570000-0000-4000-8000-00000000d7ee', 'approved');

insert into public.profiles (user_id, display_name, tower, flat, phone) values
  ('7e570000-0000-4000-8000-0000000007d1', 'Test Owner',   'A', 'A-101', '9000000101'),
  ('7e570000-0000-4000-8000-0000000007d2', 'Test Taker',   'C', 'C-303', '9000000303'),
  ('7e570000-0000-4000-8000-0000000007d3', 'Test Helper',  'B', 'B-202', '9000000202'),
  ('7e570000-0000-4000-8000-0000000007d4', 'Test Helper 2','B', 'B-204', null),
  ('7e570000-0000-4000-8000-0000000007d5', 'Test Plain',   'D', 'D-404', null),
  ('7e570000-0000-4000-8000-0000000007d6', 'Test Pending', 'D', 'D-405', null),
  ('7e570000-0000-4000-8000-0000000007e1', 'Test E Helper','E', 'E-101', null);

-- Helpers in D: d_helper2 now; d_helper switches on during the test. e_helper in E.
insert into public.delivery_helpers (society_id, user_id) values
  ('7e570000-0000-4000-8000-00000000d7dd', '7e570000-0000-4000-8000-0000000007d4'),
  ('7e570000-0000-4000-8000-00000000d7ee', '7e570000-0000-4000-8000-0000000007e1');

-- Items: D1 goes by helper, D2 tests cancel and hand-over paths.
insert into public.listings (id, society_id, owner_id, title, price_inr) values
  ('7e570000-0000-4000-8000-000000d70001', '7e570000-0000-4000-8000-00000000d7dd', '7e570000-0000-4000-8000-0000000007d1', 'Test bookshelf', 0),
  ('7e570000-0000-4000-8000-000000d70002', '7e570000-0000-4000-8000-00000000d7dd', '7e570000-0000-4000-8000-0000000007d1', 'Test kettle', 200);

insert into public.requests (id, listing_id, society_id, requester_id) values
  ('7e570000-0000-4000-8000-000000d7f001', '7e570000-0000-4000-8000-000000d70001', '7e570000-0000-4000-8000-00000000d7dd', '7e570000-0000-4000-8000-0000000007d2'),
  ('7e570000-0000-4000-8000-000000d7f002', '7e570000-0000-4000-8000-000000d70001', '7e570000-0000-4000-8000-00000000d7dd', '7e570000-0000-4000-8000-0000000007d5'),
  ('7e570000-0000-4000-8000-000000d7f003', '7e570000-0000-4000-8000-000000d70002', '7e570000-0000-4000-8000-00000000d7dd', '7e570000-0000-4000-8000-0000000007d2'),
  ('7e570000-0000-4000-8000-000000d7f004', '7e570000-0000-4000-8000-000000d70002', '7e570000-0000-4000-8000-00000000d7dd', '7e570000-0000-4000-8000-0000000007d5');

-- Remember the delivery ids as the test goes.
create table dumpy_dtests.ids (name text primary key, id uuid);
grant all on dumpy_dtests.ids to authenticated;

-- ---------------------------------------------------- arranging a delivery
select dumpy_dtests.act_as('7e570000-0000-4000-8000-0000000007d1');
select dumpy_dtests.refused($$
  select public.arrange_delivery('7e570000-0000-4000-8000-000000d70001', 'helper', dumpy_dtests.slot(1, 10), '')
$$, 'No delivery can be arranged before a request is accepted');

select public.accept_request('7e570000-0000-4000-8000-000000d7f001');

select dumpy_dtests.act_as('7e570000-0000-4000-8000-0000000007d3');
select dumpy_dtests.refused($$
  select public.arrange_delivery('7e570000-0000-4000-8000-000000d70001', 'helper', dumpy_dtests.slot(1, 10), '')
$$, 'Someone outside the pair cannot arrange a delivery');
select dumpy_dtests.act_as('7e570000-0000-4000-8000-0000000007d5');
select dumpy_dtests.refused($$
  select public.arrange_delivery('7e570000-0000-4000-8000-000000d70001', 'helper', dumpy_dtests.slot(1, 10), '')
$$, 'A requester who was not picked cannot arrange a delivery');

select dumpy_dtests.act_as('7e570000-0000-4000-8000-0000000007d2');
select dumpy_dtests.refused($$
  select public.arrange_delivery('7e570000-0000-4000-8000-000000d70001', 'helper', dumpy_dtests.slot(1, 9), '')
$$, 'Slots start on an even hour', '22023');
select dumpy_dtests.refused($$
  select public.arrange_delivery('7e570000-0000-4000-8000-000000d70001', 'helper', dumpy_dtests.slot(1, 22), '')
$$, 'The last slot starts at 8 pm', '22023');
select dumpy_dtests.refused($$
  select public.arrange_delivery('7e570000-0000-4000-8000-000000d70001', 'helper', dumpy_dtests.slot(2, 10), '')
$$, 'Slots are today or tomorrow, not later', '22023');
select dumpy_dtests.refused($$
  select public.arrange_delivery('7e570000-0000-4000-8000-000000d70001', 'helper', dumpy_dtests.slot(-1, 10), '')
$$, 'Slots cannot be in the past', '22023');
select dumpy_dtests.refused($$
  select public.arrange_delivery('7e570000-0000-4000-8000-000000d70001', 'drone', dumpy_dtests.slot(1, 10), '')
$$, 'Only the three delivery modes are allowed', '22023');
select dumpy_dtests.refused($$
  select public.arrange_delivery('7e570000-0000-4000-8000-000000d70001', 'helper', dumpy_dtests.slot(1, 10), repeat('x', 61))
$$, 'Tip notes are short', '22023');

insert into dumpy_dtests.ids
select 'd1', public.arrange_delivery('7e570000-0000-4000-8000-000000d70001', 'helper', dumpy_dtests.slot(1, 10), ' ₹30 cash ');
select dumpy_dtests.ok((select tip_note from public.get_delivery('7e570000-0000-4000-8000-000000d70001')) = '₹30 cash',
  'The taker arranges a helper delivery with a tip note');

select dumpy_dtests.act_as('7e570000-0000-4000-8000-0000000007d1');
select dumpy_dtests.ok(public.arrange_delivery('7e570000-0000-4000-8000-000000d70001', 'helper', dumpy_dtests.slot(1, 18), '₹30 cash')
                       = (select id from dumpy_dtests.ids where name = 'd1'),
  'The owner changes the slot of the same delivery (one live delivery per item)');
select dumpy_dtests.ok((select slot_end - slot_start from public.get_delivery('7e570000-0000-4000-8000-000000d70001')) = interval '2 hours',
  'Slots are 2 hours long');

-- ------------------------------------------------------- who sees open jobs
select dumpy_dtests.act_as('7e570000-0000-4000-8000-0000000007d5');
select dumpy_dtests.ok((select count(*) from public.deliveries) = 0
                       and (select count(*) from public.open_delivery_jobs('7e570000-0000-4000-8000-00000000d7dd')) = 0,
  'A member who is not a helper sees no open jobs');
select dumpy_dtests.ok((select count(*) from public.get_delivery('7e570000-0000-4000-8000-000000d70001')) = 0,
  'A member outside the pair cannot read the delivery');
select dumpy_dtests.refused($$ select public.claim_delivery((select id from dumpy_dtests.ids where name = 'd1')) $$,
  'A member who is not a helper cannot claim a job');

select dumpy_dtests.act_as('7e570000-0000-4000-8000-0000000007d6');
select dumpy_dtests.ok((select count(*) from public.deliveries) = 0
                       and (select count(*) from public.open_delivery_jobs('7e570000-0000-4000-8000-00000000d7dd')) = 0,
  'A pending member sees no deliveries');
select dumpy_dtests.refused($$
  insert into public.delivery_helpers (society_id, user_id)
  values ('7e570000-0000-4000-8000-00000000d7dd', '7e570000-0000-4000-8000-0000000007d6')
$$, 'A pending member cannot sign up as a helper');

select dumpy_dtests.act_as('7e570000-0000-4000-8000-0000000007e1');
select dumpy_dtests.ok((select count(*) from public.deliveries) = 0
                       and (select count(*) from public.open_delivery_jobs('7e570000-0000-4000-8000-00000000d7dd')) = 0,
  'A helper in another society sees no jobs here');
select dumpy_dtests.refused($$ select public.claim_delivery((select id from dumpy_dtests.ids where name = 'd1')) $$,
  'A helper in another society cannot claim a job here');
select dumpy_dtests.refused($$
  insert into public.delivery_helpers (society_id, user_id)
  values ('7e570000-0000-4000-8000-00000000d7dd', '7e570000-0000-4000-8000-0000000007e1')
$$, 'Nobody can sign up as a helper in a society they are not in');

select dumpy_dtests.act_as('7e570000-0000-4000-8000-0000000007d3');
select dumpy_dtests.ok((select count(*) from public.open_delivery_jobs('7e570000-0000-4000-8000-00000000d7dd')) = 0,
  'Before switching on "I can help deliver", nobody sees open jobs');
select dumpy_dtests.refused($$
  insert into public.delivery_helpers (society_id, user_id)
  values ('7e570000-0000-4000-8000-00000000d7dd', '7e570000-0000-4000-8000-0000000007d5')
$$, 'Nobody can sign someone else up as a helper');
insert into public.delivery_helpers (society_id, user_id)
values ('7e570000-0000-4000-8000-00000000d7dd', '7e570000-0000-4000-8000-0000000007d3');
select dumpy_dtests.ok((select count(*) from public.delivery_helpers) = 1,
  'A member switches on "I can help deliver" and sees only their own switch');
select dumpy_dtests.ok((select pickup_tower || '>' || drop_tower || ' ' || tip_note
                        from public.open_delivery_jobs('7e570000-0000-4000-8000-00000000d7dd')) = 'A>C ₹30 cash',
  'A helper sees the open job with pickup tower, drop tower and tip');
select dumpy_dtests.ok((select count(*) from public.deliveries) = 1,
  'A helper can read the open job row itself');
select dumpy_dtests.ok((select count(*) from public.get_delivery('7e570000-0000-4000-8000-000000d70001')) = 0
                       and (select count(*) from public.my_delivery_jobs('7e570000-0000-4000-8000-00000000d7dd')) = 0,
  'Before claiming, a helper gets no flat or phone');

-- The owner, even as a helper, never gets their own item as a job.
select dumpy_dtests.act_as('7e570000-0000-4000-8000-0000000007d1');
insert into public.delivery_helpers (society_id, user_id)
values ('7e570000-0000-4000-8000-00000000d7dd', '7e570000-0000-4000-8000-0000000007d1');
select dumpy_dtests.ok((select count(*) from public.open_delivery_jobs('7e570000-0000-4000-8000-00000000d7dd')) = 0,
  'A helper does not see jobs for their own item');
select dumpy_dtests.refused($$ select public.claim_delivery((select id from dumpy_dtests.ids where name = 'd1')) $$,
  'An owner cannot claim the delivery of their own item');
delete from public.delivery_helpers where user_id = '7e570000-0000-4000-8000-0000000007d1';

-- ------------------------------------------------- plain writes are refused
select dumpy_dtests.act_as('7e570000-0000-4000-8000-0000000007d3');
select dumpy_dtests.refused($$
  update public.deliveries set status = 'claimed', helper_id = auth.uid()
$$, 'A helper cannot claim by a plain update');
select dumpy_dtests.refused($$
  insert into public.deliveries (listing_id, society_id, mode, slot_start, slot_end)
  values ('7e570000-0000-4000-8000-000000d70001', '7e570000-0000-4000-8000-00000000d7dd', 'helper',
          dumpy_dtests.slot(1, 10), dumpy_dtests.slot(1, 12))
$$, 'Nobody inserts deliveries directly');
select dumpy_dtests.refused($$ delete from public.deliveries $$, 'Nobody deletes deliveries');

-- ------------------------------------------------------------- claiming
select public.claim_delivery((select id from dumpy_dtests.ids where name = 'd1'));
select dumpy_dtests.ok((select status from public.my_delivery_jobs('7e570000-0000-4000-8000-00000000d7dd')) = 'claimed',
  'A third member, a helper, claims the job');
select dumpy_dtests.ok((select pickup_flat || ' ' || pickup_phone || ' > ' || drop_flat || ' ' || drop_phone
                        from public.my_delivery_jobs('7e570000-0000-4000-8000-00000000d7dd'))
                       = 'A-101 9000000101 > C-303 9000000303',
  'Once claimed, the helper gets both flats and phones');

select dumpy_dtests.act_as('7e570000-0000-4000-8000-0000000007d4');
select dumpy_dtests.ok((select count(*) from public.open_delivery_jobs('7e570000-0000-4000-8000-00000000d7dd')) = 0
                       and (select count(*) from public.deliveries) = 0,
  'A claimed job leaves the open list for other helpers');
select dumpy_dtests.refused($$ select public.claim_delivery((select id from dumpy_dtests.ids where name = 'd1')) $$,
  'A second helper cannot claim a job that is taken', '55000');
select dumpy_dtests.refused($$ select public.mark_delivered((select id from dumpy_dtests.ids where name = 'd1')) $$,
  'Another helper cannot mark the job delivered');
select dumpy_dtests.refused($$ select public.release_delivery((select id from dumpy_dtests.ids where name = 'd1')) $$,
  'Another helper cannot give the job back');

select dumpy_dtests.act_as('7e570000-0000-4000-8000-0000000007d2');
select dumpy_dtests.ok((select helper_name || ' ' || helper_phone || ' ' || status
                        from public.get_delivery('7e570000-0000-4000-8000-000000d70001')) = 'Test Helper 9000000202 claimed',
  'The pair see who took the job, with their phone');
select dumpy_dtests.refused($$
  select public.arrange_delivery('7e570000-0000-4000-8000-000000d70001', 'owner_delivers', dumpy_dtests.slot(1, 12), '')
$$, 'Once a helper has it, the pair must cancel before changing plans', '55000');
select dumpy_dtests.refused($$ select public.mark_delivered((select id from dumpy_dtests.ids where name = 'd1')) $$,
  'The taker cannot mark it delivered');
select dumpy_dtests.refused($$ select public.release_delivery((select id from dumpy_dtests.ids where name = 'd1')) $$,
  'The pair cannot release the helper''s job (they cancel instead)');

-- The helper gives it back, then takes it again.
select dumpy_dtests.act_as('7e570000-0000-4000-8000-0000000007d3');
select public.release_delivery((select id from dumpy_dtests.ids where name = 'd1'));
select dumpy_dtests.ok((select count(*) from public.open_delivery_jobs('7e570000-0000-4000-8000-00000000d7dd')) = 1
                       and (select count(*) from public.my_delivery_jobs('7e570000-0000-4000-8000-00000000d7dd')) = 0,
  'A helper who gives a job back sees it open again and loses the contact details');
select public.claim_delivery((select id from dumpy_dtests.ids where name = 'd1'));

-- --------------------------------------------------------- delivering
select public.mark_delivered((select id from dumpy_dtests.ids where name = 'd1'));
select dumpy_dtests.ok((select status from public.listings where id = '7e570000-0000-4000-8000-000000d70001') = 'done',
  'The helper marks it delivered and the item closes as done');
select dumpy_dtests.ok((select status || coalesce(pickup_flat, '-') || coalesce(drop_phone, '-')
                        from public.my_delivery_jobs('7e570000-0000-4000-8000-00000000d7dd')) = 'delivered--',
  'After delivery the helper keeps the job in their list, without flats or phones');
select dumpy_dtests.refused($$ select public.mark_delivered((select id from dumpy_dtests.ids where name = 'd1')) $$,
  'A delivered job cannot be delivered twice', '55000');

select dumpy_dtests.act_as('7e570000-0000-4000-8000-0000000007d1');
select dumpy_dtests.ok((select status from public.get_delivery('7e570000-0000-4000-8000-000000d70001')) = 'delivered',
  'The owner sees the delivery as delivered');
select dumpy_dtests.refused($$ select public.cancel_delivery((select id from dumpy_dtests.ids where name = 'd1')) $$,
  'A delivered job cannot be cancelled', '55000');

-- ------------------------------------- owner delivers, cancel and hand over
select public.accept_request('7e570000-0000-4000-8000-000000d7f003');
insert into dumpy_dtests.ids
select 'd2', public.arrange_delivery('7e570000-0000-4000-8000-000000d70002', 'owner_delivers', dumpy_dtests.slot(1, 8), 'ignored');
select dumpy_dtests.ok((select mode || '|' || tip_note || '|' || status from public.get_delivery('7e570000-0000-4000-8000-000000d70002'))
                       = 'owner_delivers||open',
  'The owner arranges to deliver it themselves (tip notes are only for helpers)');

select dumpy_dtests.act_as('7e570000-0000-4000-8000-0000000007d3');
select dumpy_dtests.ok((select count(*) from public.open_delivery_jobs('7e570000-0000-4000-8000-00000000d7dd')) = 0,
  'Helpers do not see deliveries the pair handle themselves');
select dumpy_dtests.refused($$ select public.claim_delivery((select id from dumpy_dtests.ids where name = 'd2')) $$,
  'Helpers cannot claim a delivery the pair handle themselves', '55000');
select dumpy_dtests.refused($$ select public.cancel_delivery((select id from dumpy_dtests.ids where name = 'd2')) $$,
  'Someone outside the pair cannot cancel a delivery');

select dumpy_dtests.act_as('7e570000-0000-4000-8000-0000000007d2');
select public.cancel_delivery((select id from dumpy_dtests.ids where name = 'd2'));
select dumpy_dtests.ok((select count(*) from public.get_delivery('7e570000-0000-4000-8000-000000d70002')) = 0
                       and (select status from public.listings where id = '7e570000-0000-4000-8000-000000d70002') = 'reserved',
  'The taker cancels the delivery; the item stays reserved');
insert into dumpy_dtests.ids
select 'd2b', public.arrange_delivery('7e570000-0000-4000-8000-000000d70002', 'taker_collects', dumpy_dtests.slot(1, 20), '');

select dumpy_dtests.act_as('7e570000-0000-4000-8000-0000000007d1');
select public.cancel_reservation('7e570000-0000-4000-8000-000000d70002');
reset role;
select dumpy_dtests.ok((select count(*) from public.deliveries
                        where listing_id = '7e570000-0000-4000-8000-000000d70002' and status in ('open', 'claimed')) = 0,
  'Cancelling the reservation cancels its delivery');

select dumpy_dtests.act_as('7e570000-0000-4000-8000-0000000007d1');
select public.accept_request('7e570000-0000-4000-8000-000000d7f004');
select dumpy_dtests.ok((select count(*) from public.get_delivery('7e570000-0000-4000-8000-000000d70002')) = 0,
  'A fresh reservation starts with no delivery');
insert into dumpy_dtests.ids
select 'd3', public.arrange_delivery('7e570000-0000-4000-8000-000000d70002', 'helper', dumpy_dtests.slot(1, 14), '');
select public.mark_handed_over('7e570000-0000-4000-8000-000000d70002');
select dumpy_dtests.ok((select status from public.get_delivery('7e570000-0000-4000-8000-000000d70002')) = 'delivered',
  'Mark handed over closes the open delivery as delivered');

select 'All Dumpy delivery tests passed' as result;

rollback;
