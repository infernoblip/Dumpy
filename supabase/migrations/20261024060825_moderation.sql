-- Stage 10: moderation.
--
-- Adds:
--   reports table                      a member flags an item for the admins
--   resolve_reports(listing_id, hide)  admin: hide the item (all its open
--                                      reports become "actioned") or dismiss
--                                      them (they become "dismissed")
--   renew_listing(listing_id)          owner: put an expired or withdrawn item
--                                      back up for another 30 days
--   expire_old_listings()              marks available items expired once
--                                      expires_at has passed; pg_cron runs it
--                                      every hour (job "dumpy-expire-listings")
--
-- Change to a stage 2 table: listings gets a trigger that caps expires_at at
-- 30 days from now for anything the website writes, so nobody can keep an
-- item up forever by setting a far-off date.
--
-- Suspending a member needs no new rule: admins already set
-- memberships.status to 'suspended' or back to 'approved' (stage 2), and every
-- policy calls is_member(), which only counts approved members.

-- ------------------------------------------------------------------ reports
create table public.reports (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null,
  society_id uuid not null,
  reporter_id uuid not null references auth.users (id) on delete cascade,
  reason text not null check (reason in ('not_allowed', 'spam', 'offensive', 'other')),
  note text not null default '' check (char_length(note) <= 300),
  status text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users (id) on delete set null,
  foreign key (listing_id, society_id) references public.listings (id, society_id) on delete cascade,
  -- one report per person per item
  unique (listing_id, reporter_id)
);
create index reports_queue_idx on public.reports (society_id, status, created_at);

revoke all on table public.reports from anon, authenticated;
alter table public.reports enable row level security;

-- Reporters see their own reports; admins see their society's. Nobody else,
-- so the owner of an item never learns who reported it.
grant select on public.reports to authenticated;
grant insert (listing_id, society_id, reporter_id, reason, note) on public.reports to authenticated;
-- No update or delete grants: admins resolve reports with resolve_reports().

create policy "reporters read their own reports"
on public.reports for select to authenticated
using (reporter_id = auth.uid() and public.is_member(society_id));

create policy "admins read their society's reports"
on public.reports for select to authenticated
using (public.is_admin(society_id));

-- Report someone else's item that is up (available or reserved).
create policy "members report items"
on public.reports for insert to authenticated
with check (
  reporter_id = auth.uid()
  and status = 'open'
  and public.is_member(society_id)
  and exists (
    select 1 from public.listings l
    where l.id = listing_id
      and l.society_id = reports.society_id
      and l.status in ('available', 'reserved')
      and l.owner_id <> auth.uid()
  )
);

-- --------------------------------------------------------- resolve_reports
-- Admin of the item's society only. p_hide true: the item is hidden and every
-- open report on it is marked actioned. p_hide false: the open reports are
-- dismissed and the item is left as it is. Returns how many reports closed.
create or replace function public.resolve_reports(p_listing_id uuid, p_hide boolean)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _listing public.listings;
  _n integer;
begin
  select * into _listing from public.listings where id = p_listing_id for update;
  if _listing.id is null or not public.is_admin(_listing.society_id) then
    raise exception 'Only an admin of this society can do this' using errcode = '42501';
  end if;

  if p_hide then
    update public.listings set status = 'hidden' where id = _listing.id;
  end if;

  update public.reports
  set status = case when p_hide then 'actioned' else 'dismissed' end,
      resolved_at = now(),
      resolved_by = auth.uid()
  where listing_id = _listing.id and status = 'open';
  get diagnostics _n = row_count;
  return _n;
end
$$;

-- ----------------------------------------------------------- renew_listing
-- The owner puts an expired (or withdrawn) item back up for 30 more days.
create or replace function public.renew_listing(p_listing_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _listing public.listings;
begin
  select * into _listing from public.listings where id = p_listing_id for update;
  if _listing.id is null or _listing.owner_id is distinct from auth.uid()
     or not public.is_member(_listing.society_id) then
    raise exception 'Only the item''s owner can do this' using errcode = '42501';
  end if;
  if _listing.status not in ('expired', 'withdrawn') then
    raise exception 'Only expired or withdrawn items can be put back up' using errcode = '55000';
  end if;

  update public.listings
  set status = 'available', expires_at = now() + interval '30 days'
  where id = _listing.id;
end
$$;

-- ------------------------------------------------------ expire_old_listings
-- Run by pg_cron (below), never by the website.
create or replace function public.expire_old_listings()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _n integer;
begin
  update public.listings set status = 'expired'
  where status = 'available' and expires_at <= now();
  get diagnostics _n = row_count;
  return _n;
end
$$;

-- --------------------------------------------------- cap expires_at at 30 days
create or replace function public.cap_listing_expiry()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'anon')
     and new.expires_at > now() + interval '30 days' then
    new.expires_at := now() + interval '30 days';
  end if;
  return new;
end
$$;

create trigger listings_cap_expiry
before insert or update of expires_at on public.listings
for each row execute function public.cap_listing_expiry();

-- --------------------------------------------------------------- grants
revoke execute on function
  public.resolve_reports(uuid, boolean),
  public.renew_listing(uuid),
  public.expire_old_listings(),
  public.cap_listing_expiry()
from public, anon;

grant execute on function
  public.resolve_reports(uuid, boolean),
  public.renew_listing(uuid)
to authenticated;

revoke execute on function public.expire_old_listings(), public.cap_listing_expiry() from authenticated;

-- ------------------------------------------------------------ hourly job
-- pg_cron ships with Supabase. On a plain Postgres without it (the local
-- tests), this step is skipped and expire_old_listings() is called by hand.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    -- Scheduling a job under a name that already exists replaces it.
    perform cron.schedule('dumpy-expire-listings', '7 * * * *', 'select public.expire_old_listings()');
  else
    raise notice 'pg_cron is not available here: listings will not expire on their own';
  end if;
end
$$;
