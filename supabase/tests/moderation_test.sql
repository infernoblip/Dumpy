-- Dumpy moderation tests (stage 10).
--
-- Proves:
--   * members report other people's items, once each; owners never see who
--     reported them; other societies see nothing
--   * only an admin of the item's society hides or dismisses, in one call
--   * a suspended member sees no items, and sees them again once restored
--   * items past expires_at drop out of the feed, and only their owner can
--     put them back up for 30 more days
--
-- How to run: exactly like isolation_test.sql (SQL Editor: paste and Run; it
-- passes if it finishes without an error). Everything happens inside one
-- transaction that is rolled back, so it is safe on the real project.

begin;

-- ------------------------------------------------------------------ helpers
create schema dumpy_mod_tests;
grant usage on schema dumpy_mod_tests to anon, authenticated;

create function dumpy_mod_tests.act_as(p_user uuid) returns void language plpgsql as $$
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

create function dumpy_mod_tests.ok(p_pass boolean, p_label text) returns void language plpgsql as $$
begin
  if p_pass is distinct from true then
    raise exception 'FAIL: %', p_label;
  end if;
  raise notice 'ok - %', p_label;
end $$;

create function dumpy_mod_tests.refused(p_sql text, p_label text, p_code text default '42501')
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

create function dumpy_mod_tests.changed(p_sql text) returns integer language plpgsql as $$
declare _n integer;
begin
  execute p_sql;
  get diagnostics _n = row_count;
  return _n;
end $$;

grant execute on all functions in schema dumpy_mod_tests to anon, authenticated;

-- ----------------------------------------------------------------- fixtures
-- Societies A and B, and people:
--   a_admin   approved admin of A
--   a_owner   approved member of A, owns L1 and L2
--   a_other   approved member of A, owns L3
--   a_third   approved member of A (gets suspended and restored)
--   b_admin   approved admin of B, owns LB
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', id::uuid, 'authenticated', 'authenticated',
       email, '', now(), '', '', '', '', '{}', '{}', now(), now()
from (values
  ('7e571000-0000-4000-8000-0000000000a0', 'mod.a.admin@example.com'),
  ('7e571000-0000-4000-8000-0000000000a1', 'mod.a.owner@example.com'),
  ('7e571000-0000-4000-8000-0000000000a2', 'mod.a.other@example.com'),
  ('7e571000-0000-4000-8000-0000000000a3', 'mod.a.third@example.com'),
  ('7e571000-0000-4000-8000-0000000000b0', 'mod.b.admin@example.com')
) as t(id, email);

insert into public.societies (id, name, invite_code) values
  ('7e571000-0000-4000-8000-00000000aaaa', 'Mod Test Society A', 'MODTESTA'),
  ('7e571000-0000-4000-8000-00000000bbbb', 'Mod Test Society B', 'MODTESTB');

insert into public.memberships (user_id, society_id, role, status) values
  ('7e571000-0000-4000-8000-0000000000a0', '7e571000-0000-4000-8000-00000000aaaa', 'admin',  'approved'),
  ('7e571000-0000-4000-8000-0000000000a1', '7e571000-0000-4000-8000-00000000aaaa', 'member', 'approved'),
  ('7e571000-0000-4000-8000-0000000000a2', '7e571000-0000-4000-8000-00000000aaaa', 'member', 'approved'),
  ('7e571000-0000-4000-8000-0000000000a3', '7e571000-0000-4000-8000-00000000aaaa', 'member', 'approved'),
  ('7e571000-0000-4000-8000-0000000000b0', '7e571000-0000-4000-8000-00000000bbbb', 'admin',  'approved');

insert into public.profiles (user_id, display_name, tower, flat) values
  ('7e571000-0000-4000-8000-0000000000a0', 'Mod Admin', 'A', 'A-101'),
  ('7e571000-0000-4000-8000-0000000000a1', 'Mod Owner', 'A', 'A-102'),
  ('7e571000-0000-4000-8000-0000000000a2', 'Mod Other', 'B', 'B-201'),
  ('7e571000-0000-4000-8000-0000000000a3', 'Mod Third', 'C', 'C-301'),
  ('7e571000-0000-4000-8000-0000000000b0', 'Mod B Admin', 'X', 'X-901');

insert into public.listings (id, society_id, owner_id, title, price_inr) values
  ('7e571000-0000-4000-8000-0000000a1111', '7e571000-0000-4000-8000-00000000aaaa', '7e571000-0000-4000-8000-0000000000a1', 'L1 bottle', 0),
  ('7e571000-0000-4000-8000-0000000a2222', '7e571000-0000-4000-8000-00000000aaaa', '7e571000-0000-4000-8000-0000000000a1', 'L2 shelf', 200),
  ('7e571000-0000-4000-8000-0000000a3333', '7e571000-0000-4000-8000-00000000aaaa', '7e571000-0000-4000-8000-0000000000a2', 'L3 kettle', 0),
  ('7e571000-0000-4000-8000-0000000b1111', '7e571000-0000-4000-8000-00000000bbbb', '7e571000-0000-4000-8000-0000000000b0', 'LB fan', 0);

-- =========================================================== 1. reporting
select dumpy_mod_tests.act_as('7e571000-0000-4000-8000-0000000000a2');  -- a_other
select dumpy_mod_tests.ok(dumpy_mod_tests.changed($$
  insert into public.reports (listing_id, society_id, reporter_id, reason, note)
  values ('7e571000-0000-4000-8000-0000000a1111', '7e571000-0000-4000-8000-00000000aaaa', auth.uid(), 'not_allowed', 'Looks like medicine')
$$) = 1, 'A member reports a neighbour''s item');
select dumpy_mod_tests.refused($$
  insert into public.reports (listing_id, society_id, reporter_id, reason)
  values ('7e571000-0000-4000-8000-0000000a1111', '7e571000-0000-4000-8000-00000000aaaa', auth.uid(), 'spam')
$$, 'The same person cannot report the same item twice', '23505');
select dumpy_mod_tests.refused($$
  insert into public.reports (listing_id, society_id, reporter_id, reason)
  values ('7e571000-0000-4000-8000-0000000a3333', '7e571000-0000-4000-8000-00000000aaaa', auth.uid(), 'spam')
$$, 'A member cannot report their own item');
select dumpy_mod_tests.refused($$
  insert into public.reports (listing_id, society_id, reporter_id, reason)
  values ('7e571000-0000-4000-8000-0000000b1111', '7e571000-0000-4000-8000-00000000bbbb', auth.uid(), 'spam')
$$, 'A member cannot report another society''s item');
select dumpy_mod_tests.refused($$
  insert into public.reports (listing_id, society_id, reporter_id, reason)
  values ('7e571000-0000-4000-8000-0000000a2222', '7e571000-0000-4000-8000-00000000aaaa', '7e571000-0000-4000-8000-0000000000a3', 'spam')
$$, 'A member cannot report in someone else''s name');
select dumpy_mod_tests.refused($$
  insert into public.reports (listing_id, society_id, reporter_id, reason, status)
  values ('7e571000-0000-4000-8000-0000000a2222', '7e571000-0000-4000-8000-00000000aaaa', auth.uid(), 'spam', 'dismissed')
$$, 'A member cannot file a report that is already closed');
select dumpy_mod_tests.refused($$
  insert into public.reports (listing_id, society_id, reporter_id, reason)
  values ('7e571000-0000-4000-8000-0000000a2222', '7e571000-0000-4000-8000-00000000aaaa', auth.uid(), 'boring')
$$, 'Only the four reasons are accepted', '23514');
select dumpy_mod_tests.ok((select count(*) from public.reports) = 1,
  'A reporter sees their own report');
select dumpy_mod_tests.refused($$ update public.reports set status = 'dismissed' $$,
  'A reporter cannot change a report');
select dumpy_mod_tests.refused($$ delete from public.reports $$,
  'A reporter cannot delete a report');

select dumpy_mod_tests.act_as('7e571000-0000-4000-8000-0000000000a3');  -- a_third
select dumpy_mod_tests.ok(dumpy_mod_tests.changed($$
  insert into public.reports (listing_id, society_id, reporter_id, reason)
  values ('7e571000-0000-4000-8000-0000000a1111', '7e571000-0000-4000-8000-00000000aaaa', auth.uid(), 'spam')
$$) = 1, 'A second member reports the same item');
select dumpy_mod_tests.ok((select count(*) from public.reports) = 1,
  'A member sees only their own report, not other people''s');
select dumpy_mod_tests.ok(dumpy_mod_tests.changed($$
  insert into public.reports (listing_id, society_id, reporter_id, reason)
  values ('7e571000-0000-4000-8000-0000000a2222', '7e571000-0000-4000-8000-00000000aaaa', auth.uid(), 'offensive')
$$) = 1, 'A member reports a second item');

select dumpy_mod_tests.act_as('7e571000-0000-4000-8000-0000000000a1');  -- a_owner
select dumpy_mod_tests.ok((select count(*) from public.reports) = 0,
  'An owner cannot see reports on their items (or who made them)');
select dumpy_mod_tests.refused($$ select public.resolve_reports('7e571000-0000-4000-8000-0000000a1111', false) $$,
  'A member cannot dismiss reports');

select dumpy_mod_tests.act_as('7e571000-0000-4000-8000-0000000000b0');  -- b_admin
select dumpy_mod_tests.ok((select count(*) from public.reports) = 0,
  'An admin of another society sees none of A''s reports');
select dumpy_mod_tests.refused($$ select public.resolve_reports('7e571000-0000-4000-8000-0000000a1111', true) $$,
  'An admin of another society cannot hide A''s item');

select dumpy_mod_tests.act_as(null);
select dumpy_mod_tests.refused($$ select count(*) from public.reports $$,
  'A signed-out visitor cannot read reports');
select dumpy_mod_tests.refused($$ select public.resolve_reports('7e571000-0000-4000-8000-0000000a1111', true) $$,
  'A signed-out visitor cannot hide items');

-- ====================================================== 2. the admin queue
select dumpy_mod_tests.act_as('7e571000-0000-4000-8000-0000000000a0');  -- a_admin
select dumpy_mod_tests.ok((select count(*) from public.reports where status = 'open') = 3,
  'An admin sees every open report in their society');
select dumpy_mod_tests.ok(public.resolve_reports('7e571000-0000-4000-8000-0000000a1111', true) = 2,
  'One call hides the item and closes both of its reports');
select dumpy_mod_tests.ok((select status from public.listings where id = '7e571000-0000-4000-8000-0000000a1111') = 'hidden'
                          and (select count(*) from public.reports
                               where listing_id = '7e571000-0000-4000-8000-0000000a1111' and status = 'actioned') = 2,
  'The item is hidden and its reports are marked actioned');
select dumpy_mod_tests.ok(public.resolve_reports('7e571000-0000-4000-8000-0000000a2222', false) = 1,
  'Dismiss closes the other item''s report');
select dumpy_mod_tests.ok((select status from public.listings where id = '7e571000-0000-4000-8000-0000000a2222') = 'available'
                          and (select status from public.reports where listing_id = '7e571000-0000-4000-8000-0000000a2222') = 'dismissed',
  'A dismissed item stays up');
select dumpy_mod_tests.ok((select count(*) from public.reports where status = 'open') = 0,
  'The queue is empty afterwards');

select dumpy_mod_tests.act_as('7e571000-0000-4000-8000-0000000000a3');
select dumpy_mod_tests.ok((select count(*) from public.listings where id = '7e571000-0000-4000-8000-0000000a1111') = 0,
  'Members no longer see the hidden item');
select dumpy_mod_tests.act_as('7e571000-0000-4000-8000-0000000000a1');
select dumpy_mod_tests.ok((select status from public.listings where id = '7e571000-0000-4000-8000-0000000a1111') = 'hidden',
  'The owner sees their item as hidden');
select dumpy_mod_tests.ok(dumpy_mod_tests.changed($$
  update public.listings set status = 'available' where id = '7e571000-0000-4000-8000-0000000a1111'
$$) = 0, 'The owner cannot un-hide it');
select dumpy_mod_tests.refused($$ select public.renew_listing('7e571000-0000-4000-8000-0000000a1111') $$,
  'The owner cannot renew a hidden item back into the feed', '55000');

-- ========================================================== 3. suspension
select dumpy_mod_tests.act_as('7e571000-0000-4000-8000-0000000000a0');
select dumpy_mod_tests.ok(dumpy_mod_tests.changed($$
  update public.memberships set status = 'suspended'
  where user_id = '7e571000-0000-4000-8000-0000000000a3' and society_id = '7e571000-0000-4000-8000-00000000aaaa'
$$) = 1, 'An admin suspends a member');
select dumpy_mod_tests.ok(dumpy_mod_tests.changed($$
  update public.memberships set status = 'suspended' where user_id = auth.uid()
$$) = 0, 'An admin cannot suspend themselves');

select dumpy_mod_tests.act_as('7e571000-0000-4000-8000-0000000000a3');  -- now suspended
select dumpy_mod_tests.ok((select count(*) from public.listings) = 0, 'A suspended member sees no items');
select dumpy_mod_tests.ok((select count(*) from public.reports) = 0, 'A suspended member sees not even their own reports');
select dumpy_mod_tests.refused($$
  insert into public.listings (society_id, owner_id, title)
  values ('7e571000-0000-4000-8000-00000000aaaa', auth.uid(), 'still here')
$$, 'A suspended member cannot post');
select dumpy_mod_tests.refused($$
  insert into public.reports (listing_id, society_id, reporter_id, reason)
  values ('7e571000-0000-4000-8000-0000000a3333', '7e571000-0000-4000-8000-00000000aaaa', auth.uid(), 'spam')
$$, 'A suspended member cannot report');
select dumpy_mod_tests.ok((select status from public.my_memberships()) = 'suspended',
  'A suspended member is told they are suspended');

select dumpy_mod_tests.act_as('7e571000-0000-4000-8000-0000000000a0');
select dumpy_mod_tests.ok(dumpy_mod_tests.changed($$
  update public.memberships set status = 'approved'
  where user_id = '7e571000-0000-4000-8000-0000000000a3' and society_id = '7e571000-0000-4000-8000-00000000aaaa'
$$) = 1, 'An admin restores a suspended member');
select dumpy_mod_tests.act_as('7e571000-0000-4000-8000-0000000000a3');
select dumpy_mod_tests.ok((select count(*) from public.listings) = 2, 'Once restored, they see items again');

-- ============================================================== 4. expiry
-- Pretend L3 was posted 31 days ago.
reset role;
update public.listings set created_at = now() - interval '31 days', expires_at = now() - interval '1 day'
where id = '7e571000-0000-4000-8000-0000000a3333';

select dumpy_mod_tests.act_as('7e571000-0000-4000-8000-0000000000a2');
select dumpy_mod_tests.refused($$ select public.expire_old_listings() $$,
  'Members cannot run the expiry job');

reset role;
select dumpy_mod_tests.ok(public.expire_old_listings() >= 1, 'The expiry job runs');
select dumpy_mod_tests.ok((select status from public.listings where id = '7e571000-0000-4000-8000-0000000a3333') = 'expired',
  'The old item is now expired');
select dumpy_mod_tests.ok((select status from public.listings where id = '7e571000-0000-4000-8000-0000000a2222') = 'available',
  'A newer item stays available');

select dumpy_mod_tests.act_as('7e571000-0000-4000-8000-0000000000a3');
select dumpy_mod_tests.ok((select count(*) from public.listings where status = 'available' and id = '7e571000-0000-4000-8000-0000000a3333') = 0,
  'The expired item drops out of the feed');
select dumpy_mod_tests.refused($$ select public.renew_listing('7e571000-0000-4000-8000-0000000a3333') $$,
  'Someone else cannot renew the item');

select dumpy_mod_tests.act_as('7e571000-0000-4000-8000-0000000000a2');  -- owner of L3
select dumpy_mod_tests.ok((select status from public.listings where id = '7e571000-0000-4000-8000-0000000a3333') = 'expired',
  'The owner sees their expired item');
select public.renew_listing('7e571000-0000-4000-8000-0000000a3333');
select dumpy_mod_tests.ok((select status = 'available' and expires_at > now() + interval '29 days'
                           from public.listings where id = '7e571000-0000-4000-8000-0000000a3333'),
  'Renew puts it back up for another 30 days');
select dumpy_mod_tests.refused($$ select public.renew_listing('7e571000-0000-4000-8000-0000000a3333') $$,
  'An item that is already up cannot be renewed again', '55000');

select dumpy_mod_tests.act_as('7e571000-0000-4000-8000-0000000000a3');
select dumpy_mod_tests.ok((select count(*) from public.listings where id = '7e571000-0000-4000-8000-0000000a3333') = 1,
  'Neighbours see the renewed item again');

-- Nobody keeps an item up forever by writing a far-off date.
select dumpy_mod_tests.act_as('7e571000-0000-4000-8000-0000000000a1');
update public.listings set expires_at = now() + interval '5 years' where id = '7e571000-0000-4000-8000-0000000a2222';
select dumpy_mod_tests.ok((select expires_at <= now() + interval '30 days' from public.listings
                           where id = '7e571000-0000-4000-8000-0000000a2222'),
  'An owner cannot set expires_at more than 30 days ahead');
insert into public.listings (society_id, owner_id, title, expires_at)
values ('7e571000-0000-4000-8000-00000000aaaa', auth.uid(), 'L4 forever', now() + interval '5 years');
select dumpy_mod_tests.ok((select expires_at <= now() + interval '30 days' from public.listings where title = 'L4 forever'),
  'A new item cannot be posted with expires_at more than 30 days ahead');

-- The hourly job is scheduled where pg_cron exists (the live project).
reset role;
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform dumpy_mod_tests.ok(
      exists (select 1 from cron.job where jobname = 'dumpy-expire-listings' and command like '%expire_old_listings%'),
      'The hourly expiry job is scheduled');
  else
    raise notice 'skip - pg_cron is not installed here, so there is no job to check';
  end if;
end $$;

select 'All Dumpy moderation tests passed' as result;

rollback;
