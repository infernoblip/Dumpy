-- Dumpy notification tests (stage 9).
--
-- Proves:
--   * each event queues exactly one email for each right person, and nobody else
--   * nobody with emails turned off gets one
--   * the website can't read, write or send notifications
--   * a notification can be claimed for sending only once
--
-- Run it like isolation_test.sql: paste into the SQL Editor (passes when it
-- finishes without an error), or
--   psql "<connection string>" -v ON_ERROR_STOP=1 -f supabase/tests/notifications_test.sql
-- Everything runs in one transaction that is rolled back.
--
-- On the live project, rows created here trigger real calls to the send-email
-- function only after commit, and this file never commits, so no email is sent.

begin;

create schema dumpy_ntests;
grant usage on schema dumpy_ntests to anon, authenticated, service_role;

create function dumpy_ntests.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end $$;

create function dumpy_ntests.as_service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  execute 'set local role service_role';
end $$;

create function dumpy_ntests.ok(p_pass boolean, p_label text) returns void language plpgsql as $$
begin
  if p_pass is distinct from true then
    raise exception 'FAIL: %', p_label;
  end if;
  raise notice 'ok - %', p_label;
end $$;

create function dumpy_ntests.refused(p_sql text, p_label text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate = '42501' then
      raise notice 'ok - %', p_label;
      return;
    end if;
    raise exception 'FAIL: % (refused, but with % %)', p_label, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL: % (it was allowed)', p_label;
end $$;

-- Notifications of one kind for one person, and all of society N's
-- (read as the table owner).
create function dumpy_ntests.count(p_kind text, p_recipient uuid) returns integer
language sql security definer set search_path = '' as $$
  select count(*)::int from public.notifications
  where kind = p_kind and recipient_id = p_recipient
$$;
create function dumpy_ntests.total() returns integer
language sql security definer set search_path = '' as $$
  select count(*)::int from public.notifications
  where society_id = '7e590000-0000-4000-8000-00000000aaaa'
$$;

-- A request's id, by who asked for which item.
create function dumpy_ntests.req(p_requester text, p_listing text) returns uuid
language sql security definer set search_path = '' as $$
  select id from public.requests
  where requester_id = ('7e590000-0000-4000-8000-00000000000' || p_requester)::uuid
    and listing_id = ('7e590000-0000-4000-8000-0000000c000' || p_listing)::uuid
$$;

grant execute on all functions in schema dumpy_ntests to anon, authenticated, service_role;

-- ------------------------------------------------------------- fixtures
-- Society N:
--   n_owner   owns the chair (free) and the lamp (paid)
--   n_one, n_two, n_three   ask for things
--   n_quiet   has emails turned off
--   n_helper  delivers
--   n_pending asked to join, not approved
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', id::uuid, 'authenticated', 'authenticated',
       email, '', now(), '', '', '', '', '{}', '{}', now(), now()
from (values
  ('7e590000-0000-4000-8000-000000000001', 'test.n.owner@example.com'),
  ('7e590000-0000-4000-8000-000000000002', 'test.n.one@example.com'),
  ('7e590000-0000-4000-8000-000000000003', 'test.n.two@example.com'),
  ('7e590000-0000-4000-8000-000000000004', 'test.n.three@example.com'),
  ('7e590000-0000-4000-8000-000000000005', 'test.n.quiet@example.com'),
  ('7e590000-0000-4000-8000-000000000006', 'test.n.helper@example.com'),
  ('7e590000-0000-4000-8000-000000000007', 'test.n.pending@example.com')
) as t(id, email);

insert into public.societies (id, name, invite_code) values
  ('7e590000-0000-4000-8000-00000000aaaa', 'Test Society N', 'TESTNNNN');

insert into public.memberships (user_id, society_id, role, status)
select id::uuid, '7e590000-0000-4000-8000-00000000aaaa', 'member',
       case when id like '%7' then 'pending' else 'approved' end
from (values ('7e590000-0000-4000-8000-000000000001'), ('7e590000-0000-4000-8000-000000000002'),
             ('7e590000-0000-4000-8000-000000000003'), ('7e590000-0000-4000-8000-000000000004'),
             ('7e590000-0000-4000-8000-000000000005'), ('7e590000-0000-4000-8000-000000000006'),
             ('7e590000-0000-4000-8000-000000000007')) as t(id);

insert into public.profiles (user_id, display_name, tower, flat, email_notifications) values
  ('7e590000-0000-4000-8000-000000000001', 'Test N Owner',   'A', 'A-101', true),
  ('7e590000-0000-4000-8000-000000000002', 'Test N One',     'B', 'B-201', true),
  ('7e590000-0000-4000-8000-000000000003', 'Test N Two',     'C', 'C-301', true),
  ('7e590000-0000-4000-8000-000000000004', 'Test N Three',   'C', 'C-302', true),
  ('7e590000-0000-4000-8000-000000000005', 'Test N Quiet',   'D', 'D-401', false),
  ('7e590000-0000-4000-8000-000000000006', 'Test N Helper',  'E', 'E-501', true),
  ('7e590000-0000-4000-8000-000000000007', 'Test N Pending', 'F', 'F-601', true);

insert into public.listings (id, society_id, owner_id, title, price_inr) values
  ('7e590000-0000-4000-8000-0000000c0001', '7e590000-0000-4000-8000-00000000aaaa', '7e590000-0000-4000-8000-000000000001', 'Test chair', 0),
  ('7e590000-0000-4000-8000-0000000c0002', '7e590000-0000-4000-8000-00000000aaaa', '7e590000-0000-4000-8000-000000000005', 'Quiet lamp', 100);

-- ======================================================== 1. new requests
select dumpy_ntests.act_as('7e590000-0000-4000-8000-000000000002');
insert into public.requests (listing_id, society_id, requester_id, message) values
  ('7e590000-0000-4000-8000-0000000c0001',
   '7e590000-0000-4000-8000-00000000aaaa', '7e590000-0000-4000-8000-000000000002', 'After 6 pm?');
select dumpy_ntests.ok(dumpy_ntests.count('request_new', '7e590000-0000-4000-8000-000000000001') = 1
                       and dumpy_ntests.total() = 1,
  'A new request queues exactly one email, to the owner');

select dumpy_ntests.act_as('7e590000-0000-4000-8000-000000000003');
insert into public.requests (listing_id, society_id, requester_id) values
  ('7e590000-0000-4000-8000-0000000c0001',
   '7e590000-0000-4000-8000-00000000aaaa', '7e590000-0000-4000-8000-000000000003');
select dumpy_ntests.act_as('7e590000-0000-4000-8000-000000000005');
insert into public.requests (listing_id, society_id, requester_id) values
  ('7e590000-0000-4000-8000-0000000c0001',
   '7e590000-0000-4000-8000-00000000aaaa', '7e590000-0000-4000-8000-000000000005');
select dumpy_ntests.ok(dumpy_ntests.count('request_new', '7e590000-0000-4000-8000-000000000001') = 3,
  'Each new request queues its own email to the owner');

-- The owner of the lamp has emails off.
select dumpy_ntests.act_as('7e590000-0000-4000-8000-000000000002');
insert into public.requests (listing_id, society_id, requester_id) values
  ('7e590000-0000-4000-8000-0000000c0002',
   '7e590000-0000-4000-8000-00000000aaaa', '7e590000-0000-4000-8000-000000000002');
select dumpy_ntests.ok(dumpy_ntests.count('request_new', '7e590000-0000-4000-8000-000000000005') = 0,
  'An owner with emails off gets no email about a new request');

-- Editing the message of a pending request sends nothing.
update public.requests set message = 'Any time' where id = dumpy_ntests.req('2','2');
select dumpy_ntests.ok(dumpy_ntests.total() = 3, 'Editing a request message sends nothing');

-- ================================================== 2. accepting and declining
select dumpy_ntests.act_as('7e590000-0000-4000-8000-000000000001');
select public.accept_request(dumpy_ntests.req('2','1'));
select dumpy_ntests.ok(dumpy_ntests.count('request_accepted', '7e590000-0000-4000-8000-000000000002') = 1,
  'Accepting queues one email to the chosen requester');
select dumpy_ntests.ok(dumpy_ntests.count('request_declined', '7e590000-0000-4000-8000-000000000003') = 1,
  'The other requester gets one "picked someone else" email');
select dumpy_ntests.ok(dumpy_ntests.count('request_declined', '7e590000-0000-4000-8000-000000000005') = 0,
  'A requester with emails off gets no decline email');
select dumpy_ntests.ok(dumpy_ntests.total() = 5
                       and dumpy_ntests.count('request_accepted', '7e590000-0000-4000-8000-000000000001') = 0
                       and dumpy_ntests.count('request_declined', '7e590000-0000-4000-8000-000000000001') = 0,
  'Accepting sends nothing else, and nothing to the owner');

-- Cancelling the reservation puts requests back to pending: no emails.
select public.cancel_reservation('7e590000-0000-4000-8000-0000000c0001');
select dumpy_ntests.ok(dumpy_ntests.total() = 5, 'Cancelling a reservation sends no email');

-- Accept the second requester this time.
select public.accept_request(dumpy_ntests.req('3','1'));
select dumpy_ntests.ok(dumpy_ntests.count('request_accepted', '7e590000-0000-4000-8000-000000000003') = 1
                       and dumpy_ntests.count('request_declined', '7e590000-0000-4000-8000-000000000002') = 0
                       and dumpy_ntests.total() = 6,
  'A second pick emails the new taker only; the cancelled one is not told twice');

-- People who are not approved members never get emails.
reset role;
select public.queue_notification('request_new', '7e590000-0000-4000-8000-0000000c0001',
  '7e590000-0000-4000-8000-000000000007', null);
select dumpy_ntests.ok(dumpy_ntests.count('request_new', '7e590000-0000-4000-8000-000000000007') = 0,
  'A pending member is never emailed');

-- ======================================================== 3. deliveries
-- Stage 7 owns the real deliveries table. If it isn't here yet, use a
-- stand-in with the columns the trigger reads.
do $$
begin
  if to_regclass('public.deliveries') is null then
    create table public.deliveries (
      id uuid primary key default gen_random_uuid(),
      listing_id uuid not null,
      society_id uuid not null,
      mode text not null,
      slot_start timestamptz not null,
      slot_end timestamptz not null,
      helper_id uuid,
      status text not null default 'open'
    );
    create trigger deliveries_notify
    after insert or update of status on public.deliveries
    for each row execute function public.notify_delivery_change();
  end if;
end $$;

-- Insert directly as the table owner: this tests the email trigger, not
-- stage 7's rules about who may create or claim a delivery.
insert into public.deliveries (id, listing_id, society_id, mode, slot_start, slot_end, status)
values ('7e590000-0000-4000-8000-00000000d001', '7e590000-0000-4000-8000-0000000c0001',
        '7e590000-0000-4000-8000-00000000aaaa', 'helper',
        date_trunc('hour', now()) + interval '1 day', date_trunc('hour', now()) + interval '1 day 2 hours', 'open');
select dumpy_ntests.ok(dumpy_ntests.total() = 6, 'An open delivery job sends no email');

update public.deliveries set status = 'claimed', helper_id = '7e590000-0000-4000-8000-000000000006'
where id = '7e590000-0000-4000-8000-00000000d001';
select dumpy_ntests.ok(dumpy_ntests.count('delivery_claimed', '7e590000-0000-4000-8000-000000000001') = 1
                       and dumpy_ntests.count('delivery_claimed', '7e590000-0000-4000-8000-000000000003') = 1
                       and dumpy_ntests.count('delivery_claimed', '7e590000-0000-4000-8000-000000000006') = 0
                       and dumpy_ntests.total() = 8,
  'A claimed delivery emails the owner and the taker once each');

update public.deliveries set status = 'claimed' where id = '7e590000-0000-4000-8000-00000000d001';
select dumpy_ntests.ok(dumpy_ntests.total() = 8, 'Saving a delivery without a status change sends nothing');

update public.deliveries set status = 'delivered' where id = '7e590000-0000-4000-8000-00000000d001';
select dumpy_ntests.ok(dumpy_ntests.count('delivered', '7e590000-0000-4000-8000-000000000001') = 1
                       and dumpy_ntests.count('delivered', '7e590000-0000-4000-8000-000000000003') = 1
                       and dumpy_ntests.total() = 10,
  'A delivered delivery emails the owner and the taker once each');

-- ============================================= 4. the website can't touch it
select dumpy_ntests.act_as('7e590000-0000-4000-8000-000000000001');
select dumpy_ntests.refused($$ select count(*) from public.notifications $$,
  'Signed-in people cannot read notifications');
select dumpy_ntests.refused($$
  insert into public.notifications (society_id, listing_id, recipient_id, kind)
  values ('7e590000-0000-4000-8000-00000000aaaa', '7e590000-0000-4000-8000-0000000c0001',
          '7e590000-0000-4000-8000-000000000002', 'request_new')
$$, 'Signed-in people cannot add notifications');
select dumpy_ntests.refused($$ select * from public.claim_notification(gen_random_uuid()) $$,
  'Signed-in people cannot claim a notification');
select dumpy_ntests.refused($$ select public.finish_notification(gen_random_uuid()) $$,
  'Signed-in people cannot mark a notification sent');
select dumpy_ntests.refused($$
  select public.queue_notification('request_new', '7e590000-0000-4000-8000-0000000c0001',
    '7e590000-0000-4000-8000-000000000002', null)
$$, 'Signed-in people cannot queue an email');

-- ====================================================== 5. the profile switch
select dumpy_ntests.ok((select email_notifications from public.get_my_profile()) = true,
  'get_my_profile shows the email switch');
update public.profiles set email_notifications = false where user_id = '7e590000-0000-4000-8000-000000000001';
select dumpy_ntests.ok((select email_notifications from public.get_my_profile()) = false,
  'A person can turn their own emails off');
update public.profiles set email_notifications = false where user_id = '7e590000-0000-4000-8000-000000000002';
reset role;
select dumpy_ntests.ok((select email_notifications from public.profiles
                        where user_id = '7e590000-0000-4000-8000-000000000002'),
  'Nobody can turn off someone else''s emails');
select dumpy_ntests.act_as('7e590000-0000-4000-8000-000000000002');
select dumpy_ntests.refused($$ select email_notifications from public.profiles $$,
  'Neighbours cannot see who has emails turned off');

-- =========================================================== 6. sending
-- The owner turned emails off in part 5; turn them back on for now.
reset role;
update public.profiles set email_notifications = true where user_id = '7e590000-0000-4000-8000-000000000001';
select dumpy_ntests.as_service();
create temp table claimed on commit drop as
select * from public.claim_notification(
  (select id from public.notifications
   where kind = 'request_new' and request_id = dumpy_ntests.req('2','1')));
select dumpy_ntests.ok((select count(*) from claimed) = 1
                       and (select email from claimed) = 'test.n.owner@example.com'
                       and (select title from claimed) = 'Test chair'
                       and (select actor_name from claimed) = 'Test N One'
                       and (select message from claimed) = 'After 6 pm?',
  'The send-email function gets the email address, item and requester');
select dumpy_ntests.ok((select count(*) from public.claim_notification((select id from claimed))) = 0,
  'A notification can be claimed only once');
select public.finish_notification((select id from claimed));
select dumpy_ntests.ok((select status from public.notifications where id = (select id from claimed)) = 'sent',
  'finish_notification marks it sent');

-- Emails off again: an email queued before that is now skipped.
reset role;
update public.profiles set email_notifications = false where user_id = '7e590000-0000-4000-8000-000000000001';
select dumpy_ntests.as_service();
select dumpy_ntests.ok((select count(*) from public.claim_notification(
  (select id from public.notifications
   where kind = 'request_new' and request_id = dumpy_ntests.req('3','1')))) = 0,
  'Someone who turned emails off after an event still gets no email');
select dumpy_ntests.ok((select status from public.notifications
       where kind = 'request_new' and request_id = dumpy_ntests.req('3','1')) = 'skipped',
  'That notification is recorded as skipped');

create temp table claimed2 on commit drop as
select * from public.claim_notification(
  (select id from public.notifications
   where kind = 'request_accepted' and recipient_id = '7e590000-0000-4000-8000-000000000003'));
select dumpy_ntests.ok((select count(*) from claimed2) = 1 and (select message from claimed2) is null,
  'Only the new-request email carries the requester''s message');
select public.finish_notification((select id from claimed2), 'Resend said no');
select dumpy_ntests.ok((select status from public.notifications where id = (select id from claimed2)) = 'failed',
  'A failed send is recorded as failed');

select 'All Dumpy notification tests passed' as result;

rollback;
