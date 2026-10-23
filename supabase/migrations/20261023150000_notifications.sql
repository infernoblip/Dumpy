-- Stage 9: email notifications.
--
-- How an email gets sent:
--   1. Triggers on requests (and on deliveries, once stage 7 adds that table)
--      add one row to notifications for each person who should hear about a
--      change. People who turned emails off get no row.
--   2. A trigger on notifications asks the send-email Edge Function (through
--      pg_net) to send that one row. The function's address is the Vault
--      secret "send_email_url"; until it exists, rows just wait as pending.
--   3. The function calls claim_notification(id), which moves the row from
--      pending to sending exactly once and returns what the email needs, then
--      finish_notification(id, error) records sent or failed.
--
-- Because a row can be claimed only once, each event sends at most one email,
-- even if the function is called twice for the same row. The function needs no
-- secret of its own: calling it can only send an email the database already
-- decided to send.
--
-- Emails:
--   request_new       someone asked for an item           -> the owner
--   request_accepted  the owner picked this requester     -> that requester
--   request_declined  the owner picked someone else       -> each other requester
--   delivery_claimed  a helper claimed the delivery job   -> owner and taker
--   delivered         the delivery was marked delivered   -> owner and taker
--
-- Changes to other stages' tables:
--   profiles  (stage 2): new column email_notifications, default on.
--   requests  (stage 2): new trigger requests_notify (after insert or status change).
--   deliveries (stage 7): new trigger deliveries_notify, added here only if the
--             table already exists. If stage 7 lands later, its migration adds:
--               create trigger deliveries_notify
--               after insert or update of status on public.deliveries
--               for each row execute function public.notify_delivery_change();

-- ------------------------------------------------------ profile switch
alter table public.profiles
  add column email_notifications boolean not null default true;

-- People change their own switch. Neighbours can't read it; get_my_profile()
-- returns it to its owner.
grant insert (email_notifications), update (email_notifications) on public.profiles to authenticated;

-- ------------------------------------------------------ notifications
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  society_id uuid not null,
  listing_id uuid not null,
  recipient_id uuid not null references auth.users (id) on delete cascade,
  -- the other person in the story: the requester, the owner or the helper
  actor_id uuid references auth.users (id) on delete set null,
  kind text not null check (kind in
    ('request_new', 'request_accepted', 'request_declined', 'delivery_claimed', 'delivered')),
  request_id uuid references public.requests (id) on delete cascade,
  delivery_id uuid,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  error text check (char_length(error) <= 500),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  foreign key (listing_id, society_id) references public.listings (id, society_id) on delete cascade
);
create index notifications_recipient_idx on public.notifications (recipient_id, created_at desc);
create index notifications_pending_idx on public.notifications (created_at) where status = 'pending';

-- Only the database itself and the send-email function (service role) touch
-- this table. The website can't read or write it.
revoke all on public.notifications from anon, authenticated;
alter table public.notifications enable row level security;

-- ---------------------------------------------------------- queueing
-- Adds one notification unless the recipient turned emails off or is no
-- longer an approved member of the item's society.
create or replace function public.queue_notification(
  p_kind text,
  p_listing_id uuid,
  p_recipient_id uuid,
  p_actor_id uuid,
  p_request_id uuid default null,
  p_delivery_id uuid default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _society uuid;
begin
  select l.society_id into _society from public.listings l where l.id = p_listing_id;
  if _society is null or p_recipient_id is null then
    return;
  end if;
  if exists (select 1 from public.profiles p
             where p.user_id = p_recipient_id and not p.email_notifications) then
    return;
  end if;
  if not exists (select 1 from public.memberships m
                 where m.user_id = p_recipient_id and m.society_id = _society
                   and m.status = 'approved') then
    return;
  end if;
  insert into public.notifications
    (society_id, listing_id, recipient_id, actor_id, kind, request_id, delivery_id)
  values
    (_society, p_listing_id, p_recipient_id, p_actor_id, p_kind, p_request_id, p_delivery_id);
end
$$;

-- requests: new request -> owner; accepted / declined -> the requester.
create or replace function public.notify_request_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  _owner uuid;
begin
  select l.owner_id into _owner from public.listings l where l.id = new.listing_id;

  if tg_op = 'INSERT' then
    if new.status = 'pending' then
      perform public.queue_notification('request_new', new.listing_id, _owner, new.requester_id, new.id);
    end if;
  elsif new.status is distinct from old.status then
    if new.status = 'accepted' then
      perform public.queue_notification('request_accepted', new.listing_id, new.requester_id, _owner, new.id);
    elsif new.status = 'declined' then
      perform public.queue_notification('request_declined', new.listing_id, new.requester_id, _owner, new.id);
    end if;
  end if;
  return null;
end
$$;

create trigger requests_notify
after insert or update of status on public.requests
for each row execute function public.notify_request_change();

-- deliveries (stage 7): claimed / delivered -> owner and taker.
-- Reads the row as JSON so it doesn't depend on the exact columns stage 7
-- chooses beyond id, listing_id, status and (optionally) helper_id.
create or replace function public.notify_delivery_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  _new jsonb := to_jsonb(new);
  _old_status text := case when tg_op = 'UPDATE' then to_jsonb(old) ->> 'status' end;
  _status text := _new ->> 'status';
  _listing uuid := (_new ->> 'listing_id')::uuid;
  _helper uuid := nullif(_new ->> 'helper_id', '')::uuid;
  _kind text;
  _owner uuid;
  _taker uuid;
begin
  if _status is not distinct from _old_status then
    return null;
  end if;
  _kind := case _status when 'claimed' then 'delivery_claimed' when 'delivered' then 'delivered' end;
  if _kind is null then
    return null;
  end if;

  select l.owner_id into _owner from public.listings l where l.id = _listing;
  select r.requester_id into _taker from public.requests r
  where r.listing_id = _listing and r.status = 'accepted';

  perform public.queue_notification(_kind, _listing, _owner, coalesce(_helper, _taker), null, (_new ->> 'id')::uuid);
  perform public.queue_notification(_kind, _listing, _taker, coalesce(_helper, _owner), null, (_new ->> 'id')::uuid);
  return null;
end
$$;

do $$
begin
  -- Stage 7's migration adds the same trigger if it runs after this one.
  if to_regclass('public.deliveries') is not null
     and not exists (select 1 from pg_trigger
                     where tgname = 'deliveries_notify' and tgrelid = to_regclass('public.deliveries')) then
    execute 'create trigger deliveries_notify
             after insert or update of status on public.deliveries
             for each row execute function public.notify_delivery_change()';
  end if;
end
$$;

-- ---------------------------------------------------- calling the function
-- pg_net sends HTTP requests from the database after the transaction commits
-- (a rolled-back change sends nothing). Plain Postgres used by the local
-- tests doesn't have it, so only enable it where it exists.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net with schema extensions;
  end if;
end
$$;

create or replace function public.send_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  _url text;
begin
  if to_regnamespace('net') is null or to_regnamespace('vault') is null then
    return null;
  end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1'
    into _url using 'send_email_url';
  if _url is null then
    return null;
  end if;
  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 10000)'
    using _url,
          jsonb_build_object('id', new.id),
          jsonb_build_object('Content-Type', 'application/json');
  return null;
exception when others then
  -- Never let an email problem stop someone asking for or accepting an item.
  -- The row stays pending.
  raise warning 'send_notification: %', sqlerrm;
  return null;
end
$$;

create trigger notifications_send
after insert on public.notifications
for each row execute function public.send_notification();

-- ------------------------------------------- used by the send-email function
-- Moves a pending notification to sending, once, and returns what the email
-- needs. Returns no row if it was already claimed, if the person has since
-- turned emails off (the row becomes skipped), or if it doesn't exist.
create or replace function public.claim_notification(p_id uuid)
returns table (
  id uuid,
  kind text,
  email text,
  recipient_name text,
  listing_id uuid,
  title text,
  price_inr integer,
  actor_name text,
  actor_tower text,
  message text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _n public.notifications;
begin
  update public.notifications n set status = 'sending', sent_at = now()
  where n.id = p_id and n.status = 'pending'
  returning * into _n;
  if _n.id is null then
    return;
  end if;

  if exists (select 1 from public.profiles p
             where p.user_id = _n.recipient_id and not p.email_notifications) then
    update public.notifications n set status = 'skipped', sent_at = null where n.id = _n.id;
    return;
  end if;

  return query
  select _n.id, _n.kind, u.email::text, rp.display_name, l.id, l.title, l.price_inr,
         ap.display_name, ap.tower,
         case when _n.kind = 'request_new' then r.message end
  from public.listings l
  join auth.users u on u.id = _n.recipient_id
  left join public.profiles rp on rp.user_id = _n.recipient_id
  left join public.profiles ap on ap.user_id = _n.actor_id
  left join public.requests r on r.id = _n.request_id
  where l.id = _n.listing_id;
end
$$;

-- Records how sending went: no error means sent.
create or replace function public.finish_notification(p_id uuid, p_error text default null)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.notifications
  set status = case when p_error is null then 'sent' else 'failed' end,
      error = left(p_error, 500),
      sent_at = now()
  where id = p_id and status = 'sending'
$$;

-- --------------------------------------------------------------- grants
revoke execute on function
  public.queue_notification(text, uuid, uuid, uuid, uuid, uuid),
  public.notify_request_change(),
  public.notify_delivery_change(),
  public.send_notification(),
  public.claim_notification(uuid),
  public.finish_notification(uuid, text)
from public, anon, authenticated;

grant execute on function
  public.claim_notification(uuid),
  public.finish_notification(uuid, text)
to service_role;
