-- Dumpy payment tests (stage 8).
--
-- Proves:
--   * only the owner can mark a paid item as paid, and only once it is
--     reserved or handed over
--   * free items can never be marked paid
--   * nobody can set paid_at with a plain update
--   * only the matched pair can read whether it was paid
--   * the UPI ID reaches only the accepted taker of a paid item
--
-- Run it like isolation_test.sql: paste it into the SQL Editor (passes if it
-- finishes without an error), or
--   psql "<connection string>" -v ON_ERROR_STOP=1 -f supabase/tests/payments_test.sql
-- Everything runs in one transaction that is rolled back, so it is safe to run
-- on the real project.

begin;

create schema dumpy_pay_tests;
grant usage on schema dumpy_pay_tests to anon, authenticated;

create function dumpy_pay_tests.act_as(p_user uuid) returns void language plpgsql as $$
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

create function dumpy_pay_tests.ok(p_pass boolean, p_label text) returns void language plpgsql as $$
begin
  if p_pass is distinct from true then
    raise exception 'FAIL: %', p_label;
  end if;
  raise notice 'ok - %', p_label;
end $$;

create function dumpy_pay_tests.refused(p_sql text, p_label text, p_code text default '42501')
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

grant execute on all functions in schema dumpy_pay_tests to anon, authenticated;

-- ----------------------------------------------------------------- fixtures
--   p_owner   approved member of P, owns a paid lamp (₹150) and a free chair
--   p_taker   approved member of P, asks for both
--   p_other   approved member of P, also asks for the lamp
--   p_admin   admin of P
--   q_member  approved member of society Q
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', id::uuid, 'authenticated', 'authenticated',
       email, '', now(), '', '', '', '', '{}', '{}', now(), now()
from (values
  ('7e580000-0000-4000-8000-0000000000a1', 'test.pay.owner@example.com'),
  ('7e580000-0000-4000-8000-0000000000a2', 'test.pay.taker@example.com'),
  ('7e580000-0000-4000-8000-0000000000a3', 'test.pay.other@example.com'),
  ('7e580000-0000-4000-8000-0000000000a0', 'test.pay.admin@example.com'),
  ('7e580000-0000-4000-8000-0000000000b1', 'test.pay.q@example.com')
) as t(id, email);

insert into public.societies (id, name, invite_code) values
  ('7e580000-0000-4000-8000-00000000aaaa', 'Test Pay Society P', 'TESTPAYP'),
  ('7e580000-0000-4000-8000-00000000bbbb', 'Test Pay Society Q', 'TESTPAYQ');

insert into public.memberships (user_id, society_id, role, status) values
  ('7e580000-0000-4000-8000-0000000000a1', '7e580000-0000-4000-8000-00000000aaaa', 'member', 'approved'),
  ('7e580000-0000-4000-8000-0000000000a2', '7e580000-0000-4000-8000-00000000aaaa', 'member', 'approved'),
  ('7e580000-0000-4000-8000-0000000000a3', '7e580000-0000-4000-8000-00000000aaaa', 'member', 'approved'),
  ('7e580000-0000-4000-8000-0000000000a0', '7e580000-0000-4000-8000-00000000aaaa', 'admin',  'approved'),
  ('7e580000-0000-4000-8000-0000000000b1', '7e580000-0000-4000-8000-00000000bbbb', 'member', 'approved');

insert into public.profiles (user_id, display_name, tower, flat, phone, upi_id) values
  ('7e580000-0000-4000-8000-0000000000a1', 'Test Pay Owner', 'A', 'A-101', '9000000021', 'test.payowner@upi'),
  ('7e580000-0000-4000-8000-0000000000a2', 'Test Pay Taker', 'B', 'B-201', '9000000022', 'test.paytaker@upi'),
  ('7e580000-0000-4000-8000-0000000000a3', 'Test Pay Other', 'C', 'C-301', null, null),
  ('7e580000-0000-4000-8000-0000000000a0', 'Test Pay Admin', 'A', 'A-102', null, null),
  ('7e580000-0000-4000-8000-0000000000b1', 'Test Pay Q',     'X', 'X-901', null, null);

insert into public.listings (id, society_id, owner_id, title, price_inr) values
  ('7e580000-0000-4000-8000-0000000a1111', '7e580000-0000-4000-8000-00000000aaaa', '7e580000-0000-4000-8000-0000000000a1', 'Paid lamp', 150),
  ('7e580000-0000-4000-8000-0000000a2222', '7e580000-0000-4000-8000-00000000aaaa', '7e580000-0000-4000-8000-0000000000a1', 'Free chair', 0);

insert into public.requests (id, listing_id, society_id, requester_id) values
  ('7e580000-0000-4000-8000-00000000f001', '7e580000-0000-4000-8000-0000000a1111', '7e580000-0000-4000-8000-00000000aaaa', '7e580000-0000-4000-8000-0000000000a2'),
  ('7e580000-0000-4000-8000-00000000f002', '7e580000-0000-4000-8000-0000000a1111', '7e580000-0000-4000-8000-00000000aaaa', '7e580000-0000-4000-8000-0000000000a3'),
  ('7e580000-0000-4000-8000-00000000f003', '7e580000-0000-4000-8000-0000000a2222', '7e580000-0000-4000-8000-00000000aaaa', '7e580000-0000-4000-8000-0000000000a2');

-- ------------------------------------------------------- before acceptance
select dumpy_pay_tests.act_as('7e580000-0000-4000-8000-0000000000a1');  -- owner
select dumpy_pay_tests.refused($$ select public.set_paid('7e580000-0000-4000-8000-0000000a1111', true) $$,
  'An available item cannot be marked paid', '55000');

select public.accept_request('7e580000-0000-4000-8000-00000000f001');
select public.accept_request('7e580000-0000-4000-8000-00000000f003');

-- ------------------------------------------------------------ UPI ID reach
select dumpy_pay_tests.act_as('7e580000-0000-4000-8000-0000000000a2');  -- taker
select dumpy_pay_tests.ok((select upi_id from public.get_contact('7e580000-0000-4000-8000-0000000a1111')) = 'test.payowner@upi',
  'The accepted taker of a paid item gets the owner''s UPI ID');
select dumpy_pay_tests.ok((select upi_id from public.get_contact('7e580000-0000-4000-8000-0000000a2222')) is null,
  'The taker of a free item gets no UPI ID');
select dumpy_pay_tests.act_as('7e580000-0000-4000-8000-0000000000a1');  -- owner
select dumpy_pay_tests.ok((select upi_id from public.get_contact('7e580000-0000-4000-8000-0000000a1111')) is null,
  'The owner never gets the taker''s UPI ID');
select dumpy_pay_tests.act_as('7e580000-0000-4000-8000-0000000000a3');  -- declined requester
select dumpy_pay_tests.ok((select count(*) from public.get_contact('7e580000-0000-4000-8000-0000000a1111')) = 0,
  'A declined requester gets no UPI ID');

-- ------------------------------------------------------- who can mark paid
select dumpy_pay_tests.act_as('7e580000-0000-4000-8000-0000000000a2');  -- taker
select dumpy_pay_tests.refused($$ select public.set_paid('7e580000-0000-4000-8000-0000000a1111', true) $$,
  'The taker cannot mark the item paid');
select dumpy_pay_tests.refused($$
  update public.requests set paid_at = now() where id = '7e580000-0000-4000-8000-00000000f001'
$$, 'The taker cannot set paid_at by plain update');
select dumpy_pay_tests.act_as('7e580000-0000-4000-8000-0000000000a0');  -- admin
select dumpy_pay_tests.refused($$ select public.set_paid('7e580000-0000-4000-8000-0000000a1111', true) $$,
  'Even an admin cannot mark someone else''s item paid');
select dumpy_pay_tests.act_as('7e580000-0000-4000-8000-0000000000b1');  -- other society
select dumpy_pay_tests.refused($$ select public.set_paid('7e580000-0000-4000-8000-0000000a1111', true) $$,
  'A member of another society cannot mark it paid');
select dumpy_pay_tests.act_as(null);
select dumpy_pay_tests.refused($$ select public.set_paid('7e580000-0000-4000-8000-0000000a1111', true) $$,
  'A signed-out visitor cannot call set_paid');

select dumpy_pay_tests.act_as('7e580000-0000-4000-8000-0000000000a1');  -- owner
select dumpy_pay_tests.refused($$
  update public.requests set paid_at = now() where id = '7e580000-0000-4000-8000-00000000f001'
$$, 'The owner cannot set paid_at by plain update either');
select dumpy_pay_tests.refused($$ select public.set_paid('7e580000-0000-4000-8000-0000000a2222', true) $$,
  'A free item can never be marked paid', '55000');
select dumpy_pay_tests.ok(public.set_paid('7e580000-0000-4000-8000-0000000a1111', true) is not null,
  'The owner marks a reserved paid item as paid');
select dumpy_pay_tests.ok((select paid_at from public.requests where id = '7e580000-0000-4000-8000-00000000f001') is not null,
  'The owner sees it as paid');

-- ---------------------------------------------------------- who can see it
select dumpy_pay_tests.act_as('7e580000-0000-4000-8000-0000000000a2');  -- taker
select dumpy_pay_tests.ok((select paid_at from public.requests where id = '7e580000-0000-4000-8000-00000000f001') is not null,
  'The taker sees it as paid');
select dumpy_pay_tests.act_as('7e580000-0000-4000-8000-0000000000a3');  -- declined requester
select dumpy_pay_tests.ok((select count(*) from public.requests where id = '7e580000-0000-4000-8000-00000000f001') = 0,
  'Another requester cannot see whether it was paid');
select dumpy_pay_tests.act_as('7e580000-0000-4000-8000-0000000000b1');
select dumpy_pay_tests.ok((select count(*) from public.requests where listing_id = '7e580000-0000-4000-8000-0000000a1111') = 0,
  'A member of another society cannot see it');

-- --------------------------------------------- unmark, cancel, hand over
select dumpy_pay_tests.act_as('7e580000-0000-4000-8000-0000000000a1');  -- owner
select dumpy_pay_tests.ok(public.set_paid('7e580000-0000-4000-8000-0000000a1111', false) is null,
  'The owner can undo Mark as paid');
select dumpy_pay_tests.ok(public.set_paid('7e580000-0000-4000-8000-0000000a1111', true) is not null,
  'The owner marks it paid again');

-- Cancel the reservation and give it to someone else: they start unpaid.
select public.cancel_reservation('7e580000-0000-4000-8000-0000000a1111');
select public.accept_request('7e580000-0000-4000-8000-00000000f002');
select dumpy_pay_tests.ok((select paid_at from public.requests where id = '7e580000-0000-4000-8000-00000000f002') is null,
  'After a cancelled reservation, the next taker starts unpaid');

select public.mark_handed_over('7e580000-0000-4000-8000-0000000a1111');
select dumpy_pay_tests.ok(public.set_paid('7e580000-0000-4000-8000-0000000a1111', true) is not null,
  'A handed-over item can still be marked paid (cash at handover)');
select dumpy_pay_tests.ok((select paid_at from public.requests where id = '7e580000-0000-4000-8000-00000000f002') is not null,
  'Marking paid touches only the accepted request');

select 'All Dumpy payment tests passed' as result;

rollback;
