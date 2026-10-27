-- Dumpy delivery fee tests.
--
-- Proves the fee rules hold:
--   * the fee is off until a platform admin sets an amount and a UPI ID, and
--     only platform admins can read or change the settings
--   * only helper deliveries carry a fee, copied when booked, paid by the taker
--   * nothing is owed until a helper delivers; cancelled or self-delivered
--     items owe nothing
--   * only the taker sees the UPI ID and marks the fee paid; a taker who owes
--     a fee cannot book another helper until they pay
--   * platform admins see the ledger and confirm, reset or waive fees
--   * nobody changes fee columns with a plain update
--
-- How to run: like delivery_test.sql (SQL Editor, or psql). Everything runs in
-- one transaction that is rolled back, so it is safe on the real project. The
-- live fee settings are put back as they were by the rollback. All people and
-- societies are made up.

begin;

create schema dumpy_ftests;
grant usage on schema dumpy_ftests to anon, authenticated;

create function dumpy_ftests.act_as(p_user uuid) returns void language plpgsql as $$
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

create function dumpy_ftests.ok(p_pass boolean, p_label text) returns void language plpgsql as $$
begin
  if p_pass is distinct from true then
    raise exception 'FAIL: %', p_label;
  end if;
  raise notice 'ok - %', p_label;
end $$;

create function dumpy_ftests.refused(p_sql text, p_label text, p_code text default '42501')
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

create function dumpy_ftests.slot(p_day int, p_hour int) returns timestamptz language sql stable as $$
  select (((now() at time zone 'Asia/Kolkata')::date + p_day) + make_time(p_hour, 0, 0)) at time zone 'Asia/Kolkata'
$$;

create table dumpy_ftests.ids (name text primary key, id uuid);
grant all on dumpy_ftests.ids to authenticated;
grant execute on all functions in schema dumpy_ftests to anon, authenticated;

-- ----------------------------------------------------------------- fixtures
-- Society F: f_owner owns the items, f_taker takes them, f_helper delivers,
-- f_plain is another member. f_boss runs Dumpy (platform admin) and is not
-- in the society.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', id::uuid, 'authenticated', 'authenticated',
       email, '', now(), '', '', '', '', '{}', '{}', now(), now()
from (values
  ('7e570000-0000-4000-8000-0000000f0001', 'test.f.owner@example.com'),
  ('7e570000-0000-4000-8000-0000000f0002', 'test.f.taker@example.com'),
  ('7e570000-0000-4000-8000-0000000f0003', 'test.f.helper@example.com'),
  ('7e570000-0000-4000-8000-0000000f0004', 'test.f.plain@example.com'),
  ('7e570000-0000-4000-8000-0000000f0005', 'test.f.boss@example.com')
) as t(id, email);

insert into public.societies (id, name, invite_code) values
  ('7e570000-0000-4000-8000-0000000f50c1', 'Test Society F', 'TESTFFFF');

insert into public.memberships (user_id, society_id, status)
select id::uuid, '7e570000-0000-4000-8000-0000000f50c1', 'approved'
from (values ('7e570000-0000-4000-8000-0000000f0001'), ('7e570000-0000-4000-8000-0000000f0002'),
             ('7e570000-0000-4000-8000-0000000f0003'), ('7e570000-0000-4000-8000-0000000f0004')) t(id);

insert into public.profiles (user_id, display_name, tower, flat, phone) values
  ('7e570000-0000-4000-8000-0000000f0001', 'Test Owner',  'A', 'A-101', '9000000101'),
  ('7e570000-0000-4000-8000-0000000f0002', 'Test Taker',  'C', 'C-303', '9000000303'),
  ('7e570000-0000-4000-8000-0000000f0003', 'Test Helper', 'B', 'B-202', '9000000202'),
  ('7e570000-0000-4000-8000-0000000f0004', 'Test Plain',  'D', 'D-404', null);

insert into public.delivery_helpers (society_id, user_id) values
  ('7e570000-0000-4000-8000-0000000f50c1', '7e570000-0000-4000-8000-0000000f0003');

insert into public.platform_admins (user_id) values ('7e570000-0000-4000-8000-0000000f0005');

-- Start from "fee off", whatever the live settings are (rolled back at the end).
update public.platform_settings set delivery_fee_inr = 0, fee_upi_id = null, fee_payee_name = 'Dumpy';

-- Four items, each requested by the taker.
insert into public.listings (id, society_id, owner_id, title, price_inr)
select id::uuid, '7e570000-0000-4000-8000-0000000f50c1', '7e570000-0000-4000-8000-0000000f0001', title, 0
from (values ('7e570000-0000-4000-8000-0000000f1001', 'Test lamp'),
             ('7e570000-0000-4000-8000-0000000f1002', 'Test chair'),
             ('7e570000-0000-4000-8000-0000000f1003', 'Test rug'),
             ('7e570000-0000-4000-8000-0000000f1004', 'Test fan')) t(id, title);
insert into public.requests (id, listing_id, society_id, requester_id)
select ('7e570000-0000-4000-8000-0000000f200' || n)::uuid, ('7e570000-0000-4000-8000-0000000f100' || n)::uuid,
       '7e570000-0000-4000-8000-0000000f50c1', '7e570000-0000-4000-8000-0000000f0002'
from generate_series(1, 4) n;

select dumpy_ftests.act_as('7e570000-0000-4000-8000-0000000f0001');
select public.accept_request(('7e570000-0000-4000-8000-0000000f200' || n)::uuid) from generate_series(1, 4) n;

-- ------------------------------------------------------------- settings
select dumpy_ftests.ok(public.delivery_fee() = 0, 'The fee starts off');
insert into dumpy_ftests.ids
select 'off', public.arrange_delivery('7e570000-0000-4000-8000-0000000f1001', 'helper', dumpy_ftests.slot(1, 10), '');
select dumpy_ftests.ok((select fee_inr || fee_status from public.get_delivery('7e570000-0000-4000-8000-0000000f1001')) = '0none',
  'While the fee is off, a helper delivery carries no fee');

select dumpy_ftests.refused($$ select * from public.platform_fee_settings() $$,
  'A member cannot read the fee settings');
select dumpy_ftests.refused($$ select public.platform_set_fee_settings(50, 'someone@okbank', 'Me') $$,
  'A member cannot change the fee');
select dumpy_ftests.refused($$ select * from public.platform_settings $$,
  'Nobody reads the settings table directly');
select dumpy_ftests.refused($$ select * from public.platform_delivery_fees() $$,
  'A member cannot see the fee ledger');

select dumpy_ftests.act_as('7e570000-0000-4000-8000-0000000f0005');
select dumpy_ftests.refused($$ select public.platform_set_fee_settings(20, null, 'Dumpy') $$,
  'A fee needs a UPI ID to be paid to', '22023');
select dumpy_ftests.refused($$ select public.platform_set_fee_settings(20, 'not a upi id', 'Dumpy') $$,
  'The UPI ID must look like name@bank', '22023');
select dumpy_ftests.refused($$ select public.platform_set_fee_settings(501, 'dumpy.demo@okbank', 'Dumpy') $$,
  'The fee is at most ₹500', '22023');
select public.platform_set_fee_settings(20, ' dumpy.demo@okbank ', ' Demo Dumpy ');
select dumpy_ftests.ok((select delivery_fee_inr || ' ' || fee_upi_id || ' ' || fee_payee_name from public.platform_fee_settings())
                       = '20 dumpy.demo@okbank Demo Dumpy',
  'A platform admin sets a ₹20 fee and the UPI ID it is paid to');

-- --------------------------------------------------------------- booking
select dumpy_ftests.act_as('7e570000-0000-4000-8000-0000000f0004');
select dumpy_ftests.ok(public.delivery_fee() = 20, 'Members see the fee for the delivery form');

select dumpy_ftests.act_as('7e570000-0000-4000-8000-0000000f0001');
select public.arrange_delivery('7e570000-0000-4000-8000-0000000f1001', 'helper', dumpy_ftests.slot(1, 12), '');
select dumpy_ftests.ok((select fee_inr from public.get_delivery('7e570000-0000-4000-8000-0000000f1001')) = 0,
  'Changing a helper delivery booked while the fee was off keeps it free');
select public.cancel_delivery((select id from dumpy_ftests.ids where name = 'off'));

insert into dumpy_ftests.ids
select 'd1', public.arrange_delivery('7e570000-0000-4000-8000-0000000f1001', 'helper', dumpy_ftests.slot(1, 10), '₹30 cash');
select dumpy_ftests.ok((select fee_inr || ' ' || fee_status || ' ' || fee_i_pay || ' ' || coalesce(fee_upi_id, '-')
                        from public.get_delivery('7e570000-0000-4000-8000-0000000f1001')) = '20 upcoming false -',
  'The owner books a helper: ₹20 fee, paid by the taker, nothing to pay yet');
select dumpy_ftests.ok((select tip_note from public.get_delivery('7e570000-0000-4000-8000-0000000f1001')) = '₹30 cash',
  'The helper tip stays as the pair wrote it');

insert into dumpy_ftests.ids
select 'd2', public.arrange_delivery('7e570000-0000-4000-8000-0000000f1002', 'owner_delivers', dumpy_ftests.slot(1, 10), '');
select dumpy_ftests.ok((select fee_inr || fee_status from public.get_delivery('7e570000-0000-4000-8000-0000000f1002')) = '0none',
  'Owner-delivers carries no fee');

-- Fee changes later never touch a booked delivery.
select dumpy_ftests.act_as('7e570000-0000-4000-8000-0000000f0005');
select public.platform_set_fee_settings(25, 'dumpy.demo@okbank', 'Demo Dumpy');
select dumpy_ftests.act_as('7e570000-0000-4000-8000-0000000f0002');
select public.arrange_delivery('7e570000-0000-4000-8000-0000000f1001', 'helper', dumpy_ftests.slot(1, 14), '₹30 cash');
select dumpy_ftests.ok((select fee_inr from public.get_delivery('7e570000-0000-4000-8000-0000000f1001')) = 20,
  'Changing the slot keeps the fee it was booked with, even after the fee went up');
select public.arrange_delivery('7e570000-0000-4000-8000-0000000f1001', 'taker_collects', dumpy_ftests.slot(1, 14), '');
select dumpy_ftests.ok((select fee_inr || fee_status from public.get_delivery('7e570000-0000-4000-8000-0000000f1001')) = '0none',
  'Switching to "I''ll collect it" drops the fee');
select public.arrange_delivery('7e570000-0000-4000-8000-0000000f1001', 'helper', dumpy_ftests.slot(1, 14), '');
select dumpy_ftests.ok((select fee_inr from public.get_delivery('7e570000-0000-4000-8000-0000000f1001')) = 25,
  'Switching back to a helper takes today''s fee');

-- ------------------------------------------------- plain writes are refused
select dumpy_ftests.refused($$
  update public.deliveries set fee_inr = 0, fee_confirmed_at = now()
$$, 'Nobody changes fee columns with a plain update');

-- ------------------------------------------------- nothing owed until delivered
select dumpy_ftests.refused($$ select public.mark_delivery_fee_paid((select id from dumpy_ftests.ids where name = 'd1')) $$,
  'Nothing to pay before the item arrives', '55000');

select dumpy_ftests.act_as('7e570000-0000-4000-8000-0000000f0003');
select public.claim_delivery((select id from dumpy_ftests.ids where name = 'd1'));
select public.mark_delivered((select id from dumpy_ftests.ids where name = 'd1'));

select dumpy_ftests.act_as('7e570000-0000-4000-8000-0000000f0001');
select dumpy_ftests.ok((select fee_status || ' ' || fee_i_pay || ' ' || coalesce(fee_upi_id, '-')
                       from public.get_delivery('7e570000-0000-4000-8000-0000000f1001')) = 'due false -',
  'After delivery the fee is due; the owner does not get the UPI ID');
select dumpy_ftests.refused($$ select public.mark_delivery_fee_paid((select id from dumpy_ftests.ids where name = 'd1')) $$,
  'The owner cannot mark the taker''s fee paid');

select dumpy_ftests.act_as('7e570000-0000-4000-8000-0000000f0002');
select dumpy_ftests.ok((select fee_status || ' ' || fee_i_pay || ' ' || fee_upi_id || ' ' || fee_payee_name || ' ' || fee_ref
                        from public.get_delivery('7e570000-0000-4000-8000-0000000f1001'))
                       = 'due true dumpy.demo@okbank Demo Dumpy ' || public.delivery_fee_ref((select id from dumpy_ftests.ids where name = 'd1')),
  'The taker gets the UPI ID, name and reference to pay');

-- --------------------------------------------- unpaid fees block new helpers
select dumpy_ftests.refused($$
  select public.arrange_delivery('7e570000-0000-4000-8000-0000000f1003', 'helper', dumpy_ftests.slot(1, 10), '')
$$, 'While a fee is unpaid, the taker cannot book another helper', '55000');
select dumpy_ftests.act_as('7e570000-0000-4000-8000-0000000f0001');
select dumpy_ftests.refused($$
  select public.arrange_delivery('7e570000-0000-4000-8000-0000000f1003', 'helper', dumpy_ftests.slot(1, 10), '')
$$, 'Nor can the owner book a helper for that taker', '55000');
select dumpy_ftests.ok(public.arrange_delivery('7e570000-0000-4000-8000-0000000f1003', 'owner_delivers', dumpy_ftests.slot(1, 10), '') is not null,
  'Free delivery modes still work while a fee is unpaid');

select dumpy_ftests.act_as('7e570000-0000-4000-8000-0000000f0002');
select dumpy_ftests.ok(public.mark_delivery_fee_paid((select id from dumpy_ftests.ids where name = 'd1')) is not null,
  'The taker marks the fee paid');
select dumpy_ftests.ok((select fee_status || coalesce(fee_upi_id, '-') from public.get_delivery('7e570000-0000-4000-8000-0000000f1001'))
                       = 'markeddumpy.demo@okbank',
  'Marked paid, waiting for a platform admin to check');
select dumpy_ftests.ok(public.arrange_delivery('7e570000-0000-4000-8000-0000000f1003', 'helper', dumpy_ftests.slot(1, 10), '') is not null,
  'Once marked paid, the taker can book a helper again');
insert into dumpy_ftests.ids select 'd3', id from public.deliveries where listing_id = '7e570000-0000-4000-8000-0000000f1003' and status = 'open';

-- ------------------------------------------------- cancelled and hand-over
select public.cancel_delivery((select id from dumpy_ftests.ids where name = 'd3'));
reset role;
select dumpy_ftests.ok((select public.delivery_fee_status(d) from public.deliveries d where id = (select id from dumpy_ftests.ids where name = 'd3')) = 'none',
  'A cancelled helper delivery owes nothing');

select dumpy_ftests.act_as('7e570000-0000-4000-8000-0000000f0002');
insert into dumpy_ftests.ids
select 'd4', public.arrange_delivery('7e570000-0000-4000-8000-0000000f1004', 'helper', dumpy_ftests.slot(1, 10), '');
select dumpy_ftests.act_as('7e570000-0000-4000-8000-0000000f0001');
select public.mark_handed_over('7e570000-0000-4000-8000-0000000f1004');
reset role;
select dumpy_ftests.ok((select public.delivery_fee_status(d) from public.deliveries d where id = (select id from dumpy_ftests.ids where name = 'd4')) = 'none',
  'Handed over before any helper took it: no fee');

-- ------------------------------------------------------------- the ledger
select dumpy_ftests.act_as('7e570000-0000-4000-8000-0000000f0005');
select dumpy_ftests.ok((select count(*) || ' ' || min(title) || ' ' || min(payer_name) || ' ' || min(helper_name) || ' ' || min(fee_status) || ' ' || sum(fee_inr)
                        from public.platform_delivery_fees()) = '1 Test lamp Test Taker Test Helper marked 25',
  'The platform admin sees one fee: the lamp, marked paid, ₹25');
select dumpy_ftests.ok((select due_inr || ' ' || marked_inr || ' ' || confirmed_inr from public.platform_delivery_fee_totals()) = '0 25 0',
  'Totals: ₹25 marked paid');

select public.platform_settle_delivery_fee((select id from dumpy_ftests.ids where name = 'd1'), 'unpaid');
select dumpy_ftests.ok((select fee_status from public.platform_delivery_fees()) = 'due',
  'Not received puts it back to due');
select dumpy_ftests.ok(public.platform_settle_delivery_fee((select id from dumpy_ftests.ids where name = 'd1'), 'confirm') = 'confirmed',
  'Confirm received');
select dumpy_ftests.ok((select confirmed_inr from public.platform_delivery_fee_totals()) = 25,
  'Totals: ₹25 received');
select dumpy_ftests.refused($$ select public.platform_settle_delivery_fee((select id from dumpy_ftests.ids where name = 'd2'), 'confirm') $$,
  'A delivery with no fee cannot be settled', '55000');
select dumpy_ftests.refused($$ select public.platform_settle_delivery_fee((select id from dumpy_ftests.ids where name = 'd1'), 'refund') $$,
  'Only confirm, unpaid or waive', '22023');

select dumpy_ftests.act_as('7e570000-0000-4000-8000-0000000f0002');
select dumpy_ftests.ok((select fee_status || coalesce(fee_upi_id, '-') from public.get_delivery('7e570000-0000-4000-8000-0000000f1001')) = 'confirmed-',
  'The taker sees the fee as received, and no longer gets the UPI ID');
select dumpy_ftests.refused($$ select public.platform_settle_delivery_fee((select id from dumpy_ftests.ids where name = 'd1'), 'waive') $$,
  'A member cannot settle fees');

-- -------------------------------------------------- business UPI ID (20261026120000)
select dumpy_ftests.act_as('7e570000-0000-4000-8000-0000000f0005');
select dumpy_ftests.refused($$ select public.platform_set_fee_settings(25, 'q123456@ybl', 'Dumpy', true, '12') $$,
  'The merchant code is 4 digits', '22023');
select public.platform_set_fee_settings(25, 'Q123456@ybl', 'Dumpy', true, '5399');
select dumpy_ftests.ok((select fee_upi_business::text || ' ' || fee_merchant_code from public.platform_fee_settings()) = 'true 5399',
  'A platform admin marks the fee UPI ID as a business one, with its merchant code');
select public.platform_settle_delivery_fee((select id from dumpy_ftests.ids where name = 'd1'), 'unpaid');

select dumpy_ftests.act_as('7e570000-0000-4000-8000-0000000f0002');
select dumpy_ftests.ok((select fee_upi_id || ' ' || fee_upi_business::text || ' ' || fee_merchant_code
                        from public.get_delivery('7e570000-0000-4000-8000-0000000f1001')) = 'Q123456@ybl true 5399',
  'The taker who owes the fee learns it is a business UPI ID, so the app opens with the amount filled in');
select dumpy_ftests.act_as('7e570000-0000-4000-8000-0000000f0001');
select dumpy_ftests.ok((select coalesce(fee_upi_business::text, '-') || coalesce(fee_merchant_code, '-')
                        from public.get_delivery('7e570000-0000-4000-8000-0000000f1001')) = '--',
  'The owner does not get the payment details');
select dumpy_ftests.refused($$ select public.platform_set_fee_settings(25, 'q123456@ybl', 'Dumpy', true, '5399') $$,
  'A member cannot change the business setting');

select dumpy_ftests.act_as('7e570000-0000-4000-8000-0000000f0005');
select public.platform_set_fee_settings(25, 'Q123456@ybl', 'Dumpy', false, '5399');
select dumpy_ftests.ok((select fee_upi_business::text || coalesce(fee_merchant_code, '-') from public.platform_fee_settings()) = 'false-',
  'Turning business off clears the merchant code');

select dumpy_ftests.act_as(null);
select dumpy_ftests.refused($$ select public.delivery_fee() $$, 'Signed-out visitors cannot call the fee functions');

reset role;
select 'All Dumpy delivery fee tests passed' as result;

rollback;
