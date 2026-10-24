-- Stage 7: getting an item to the taker's flat.
--
-- Once the owner accepts a request (stage 6), the pair picks how the item
-- travels and when:
--   owner_delivers   the owner brings it over
--   taker_collects   the taker picks it up
--   helper           a neighbour who signed up as a helper brings it, for a
--                    tip the pair writes down (free text such as "₹30 cash";
--                    Dumpy only shows it and never collects money)
-- and a 2-hour time slot today or tomorrow (Indian time, 8 am to 10 pm).
--
-- New tables:
--   delivery_helpers  who said "I can help deliver", per society
--   deliveries        one row per arrangement; at most one open or claimed
--                     delivery per item
--
-- The website changes deliveries only through these functions:
--   arrange_delivery(listing, mode, slot_start, tip_note)  the pair: create or change
--   cancel_delivery(delivery)     the pair: call it off
--   claim_delivery(delivery)      a helper: take an open helper job
--   release_delivery(delivery)    the helper: give a claimed job back
--   mark_delivered(delivery)      the helper or the owner: it arrived; the
--                                 item becomes done
-- and reads them through:
--   get_delivery(listing)         the pair: the arrangement, and the helper's
--                                 name, tower and phone once claimed
--   open_delivery_jobs(society)   helpers: open jobs with pickup and drop
--                                 tower only (no flats, no phones)
--   my_delivery_jobs(society)     the helper: jobs they claimed, with both
--                                 sides' flat and phone while the job is live
--
-- Change to a stage 2 table: listings gets one more trigger. When an item
-- leaves "reserved" its open delivery closes too: delivered if the item was
-- handed over, cancelled otherwise (reservation cancelled, item hidden).

-- ------------------------------------------------------------------ tables
create table public.delivery_helpers (
  society_id uuid not null references public.societies (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (society_id, user_id)
);

create table public.deliveries (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null,
  society_id uuid not null,
  mode text not null check (mode in ('owner_delivers', 'taker_collects', 'helper')),
  slot_start timestamptz not null,
  slot_end timestamptz not null,
  helper_id uuid references auth.users (id) on delete set null,
  tip_note text not null default '' check (char_length(tip_note) <= 60),
  status text not null default 'open' check (status in ('open', 'claimed', 'delivered', 'cancelled')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (listing_id, society_id) references public.listings (id, society_id) on delete cascade,
  check (slot_end = slot_start + interval '2 hours'),
  check (mode = 'helper' or (helper_id is null and tip_note = '')),
  check (status <> 'claimed' or helper_id is not null)
);
-- One live arrangement per item; old cancelled or delivered rows stay as history.
create unique index deliveries_one_live_idx on public.deliveries (listing_id) where status in ('open', 'claimed');
create index deliveries_jobs_idx on public.deliveries (society_id, status, slot_start) where mode = 'helper';
create index deliveries_helper_idx on public.deliveries (helper_id) where helper_id is not null;

alter table public.delivery_helpers enable row level security;
alter table public.deliveries enable row level security;
-- Supabase grants everything on new tables by default; start from nothing and
-- grant back only what the website needs (below).
revoke all on table public.delivery_helpers, public.deliveries from anon, authenticated;

-- --------------------------------------------------------------- helpers
-- True when the signed-in person is an approved member who switched on
-- "I can help deliver" in this society.
create or replace function public.is_delivery_helper(p_society_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_member(p_society_id) and exists (
    select 1 from public.delivery_helpers h
    where h.society_id = p_society_id and h.user_id = auth.uid()
  )
$$;

-- The owner and the accepted requester of an item, while it is reserved or
-- handed over. No row when nobody has been accepted.
create or replace function public.delivery_pair(p_listing_id uuid)
returns table (owner_id uuid, taker_id uuid, society_id uuid, status text)
language sql
stable
security definer
set search_path = ''
as $$
  select l.owner_id, r.requester_id, l.society_id, l.status
  from public.listings l
  join public.requests r on r.listing_id = l.id and r.status = 'accepted'
  where l.id = p_listing_id and l.status in ('reserved', 'done')
$$;

-- True when the signed-in person is one of the pair for this item.
create or replace function public.is_delivery_party(p_listing_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.delivery_pair(p_listing_id) p
    where auth.uid() in (p.owner_id, p.taker_id) and public.is_member(p.society_id)
  )
$$;

-- Slots: 2 hours, starting on an even hour from 8 am to 8 pm Indian time,
-- today or tomorrow, and not already over.
create or replace function public.valid_delivery_slot(p_start timestamptz)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_start is not null
     and extract(hour from p_start at time zone 'Asia/Kolkata') in (8, 10, 12, 14, 16, 18, 20)
     and date_trunc('hour', p_start at time zone 'Asia/Kolkata') = p_start at time zone 'Asia/Kolkata'
     and (p_start at time zone 'Asia/Kolkata')::date
         between (now() at time zone 'Asia/Kolkata')::date
             and (now() at time zone 'Asia/Kolkata')::date + 1
     and p_start + interval '2 hours' > now()
$$;

-- ------------------------------------------------------- row-level security
-- People see only their own helper switch, and turn it on or off themselves.
grant select, delete on public.delivery_helpers to authenticated;
grant insert (society_id, user_id) on public.delivery_helpers to authenticated;

create policy "people read their own helper switch"
on public.delivery_helpers for select to authenticated
using (user_id = auth.uid());

create policy "members sign up as helpers"
on public.delivery_helpers for insert to authenticated
with check (user_id = auth.uid() and public.is_member(society_id));

create policy "people stop helping"
on public.delivery_helpers for delete to authenticated
using (user_id = auth.uid());

-- Deliveries: read-only from the website (changes go through the functions).
--   * the pair see their item's deliveries
--   * a helper sees the jobs they claimed
--   * helpers see open helper jobs in their society
-- Nobody else sees any delivery, and no plain select shows a flat or phone.
grant select on public.deliveries to authenticated;

create policy "the pair read their deliveries"
on public.deliveries for select to authenticated
using (public.is_member(society_id) and public.is_delivery_party(listing_id));

create policy "helpers read the jobs they claimed"
on public.deliveries for select to authenticated
using (helper_id = auth.uid() and public.is_member(society_id));

create policy "helpers read open jobs"
on public.deliveries for select to authenticated
using (mode = 'helper' and status = 'open' and public.is_delivery_helper(society_id));

-- ------------------------------------------------------- arrange_delivery
-- Create the item's delivery, or change the open one. Either of the pair may
-- do it. Once a helper has claimed it, cancel first to change plans, so the
-- helper is never surprised by a new time.
create or replace function public.arrange_delivery(
  p_listing_id uuid,
  p_mode text,
  p_slot_start timestamptz,
  p_tip_note text default ''
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _listing public.listings;
  _live public.deliveries;
  _tip text := btrim(coalesce(p_tip_note, ''));
  _id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;

  -- Lock the item so arranging and handing over never cross.
  select * into _listing from public.listings where id = p_listing_id for update;

  if _listing.id is null or not public.is_delivery_party(p_listing_id) then
    raise exception 'Only the owner and the person they picked can arrange delivery' using errcode = '42501';
  end if;
  if _listing.status <> 'reserved' then
    raise exception 'This item is not reserved' using errcode = '55000';
  end if;
  if p_mode is null or p_mode not in ('owner_delivers', 'taker_collects', 'helper') then
    raise exception 'Choose who brings the item' using errcode = '22023';
  end if;
  if not public.valid_delivery_slot(p_slot_start) then
    raise exception 'Choose a 2-hour slot today or tomorrow' using errcode = '22023';
  end if;
  if char_length(_tip) > 60 then
    raise exception 'Keep the tip note under 60 characters' using errcode = '22023';
  end if;
  if p_mode <> 'helper' then _tip := ''; end if;

  select * into _live from public.deliveries
  where listing_id = p_listing_id and status in ('open', 'claimed')
  for update;

  if _live.status = 'claimed' then
    raise exception 'A helper has already taken this delivery. Cancel it first to change plans.' using errcode = '55000';
  end if;

  if _live.id is not null then
    update public.deliveries
    set mode = p_mode, slot_start = p_slot_start, slot_end = p_slot_start + interval '2 hours',
        tip_note = _tip, updated_at = now()
    where id = _live.id;
    return _live.id;
  end if;

  insert into public.deliveries (listing_id, society_id, mode, slot_start, slot_end, tip_note, created_by)
  values (p_listing_id, _listing.society_id, p_mode, p_slot_start, p_slot_start + interval '2 hours', _tip, auth.uid())
  returning id into _id;
  return _id;
end
$$;

-- -------------------------------------------------------- cancel_delivery
-- Either of the pair calls off the arrangement. The item stays reserved; they
-- can arrange a new one. A helper who had claimed it sees it as cancelled.
create or replace function public.cancel_delivery(p_delivery_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _d public.deliveries;
begin
  select * into _d from public.deliveries where id = p_delivery_id for update;
  if _d.id is null or not public.is_delivery_party(_d.listing_id) then
    raise exception 'Only the owner and the person they picked can cancel this delivery' using errcode = '42501';
  end if;
  if _d.status not in ('open', 'claimed') then
    raise exception 'This delivery is already closed' using errcode = '55000';
  end if;
  update public.deliveries set status = 'cancelled', updated_at = now() where id = _d.id;
end
$$;

-- --------------------------------------------------------- claim_delivery
-- A helper takes an open helper job. The row lock means two helpers tapping
-- Claim together end with exactly one of them holding it.
create or replace function public.claim_delivery(p_delivery_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _d public.deliveries;
  _pair record;
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;

  select * into _d from public.deliveries where id = p_delivery_id for update;
  if _d.id is null or not public.is_delivery_helper(_d.society_id) then
    raise exception 'Turn on "I can help deliver" in your profile to take jobs' using errcode = '42501';
  end if;

  select * into _pair from public.delivery_pair(_d.listing_id);
  if auth.uid() in (_pair.owner_id, _pair.taker_id) then
    raise exception 'You cannot take a delivery for your own item' using errcode = '42501';
  end if;
  if _d.mode <> 'helper' or _d.status <> 'open' or _pair.status is distinct from 'reserved' then
    raise exception 'Someone else has taken this job, or it was called off' using errcode = '55000';
  end if;
  if _d.slot_end <= now() then
    raise exception 'This job''s time slot is over' using errcode = '55000';
  end if;

  update public.deliveries set status = 'claimed', helper_id = auth.uid(), updated_at = now()
  where id = _d.id;
end
$$;

-- ------------------------------------------------------- release_delivery
-- The helper can't make it after all: the job goes back on the open list.
create or replace function public.release_delivery(p_delivery_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _d public.deliveries;
begin
  select * into _d from public.deliveries where id = p_delivery_id for update;
  if _d.id is null or _d.helper_id is distinct from auth.uid() or not public.is_member(_d.society_id) then
    raise exception 'Only the helper who took this job can give it back' using errcode = '42501';
  end if;
  if _d.status <> 'claimed' then
    raise exception 'This job is not yours any more' using errcode = '55000';
  end if;
  update public.deliveries set status = 'open', helper_id = null, updated_at = now() where id = _d.id;
end
$$;

-- --------------------------------------------------------- mark_delivered
-- The helper who claimed the job, or the item's owner, says it arrived. The
-- delivery closes and the item becomes done, in one step.
create or replace function public.mark_delivered(p_delivery_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _d public.deliveries;
  _listing public.listings;
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;

  -- Same lock order as arrange_delivery: the item first, then its delivery.
  select * into _listing from public.listings
  where id = (select listing_id from public.deliveries where id = p_delivery_id)
  for update;
  select * into _d from public.deliveries where id = p_delivery_id for update;

  if _d.id is null or _listing.id is null or not public.is_member(_d.society_id)
     or not (_listing.owner_id = auth.uid() or _d.helper_id = auth.uid()) then
    raise exception 'Only the helper or the item''s owner can mark this delivered' using errcode = '42501';
  end if;
  if _d.status not in ('open', 'claimed') or _listing.status <> 'reserved' then
    raise exception 'This delivery is already closed' using errcode = '55000';
  end if;

  update public.deliveries set status = 'delivered', updated_at = now() where id = _d.id;
  update public.listings set status = 'done' where id = _listing.id;
end
$$;

-- ----------------------------------------------------------- get_delivery
-- For the pair: the item's live delivery (or the delivered one), with the
-- helper's name, tower and phone once a helper has taken it.
create or replace function public.get_delivery(p_listing_id uuid)
returns table (
  id uuid,
  mode text,
  slot_start timestamptz,
  slot_end timestamptz,
  tip_note text,
  status text,
  helper_name text,
  helper_tower text,
  helper_phone text,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.mode, d.slot_start, d.slot_end, d.tip_note, d.status,
         h.display_name, h.tower,
         case when d.status = 'claimed' then h.phone end,
         d.updated_at
  from public.deliveries d
  left join public.profiles h on h.user_id = d.helper_id and d.status in ('claimed', 'delivered')
  where d.listing_id = p_listing_id
    and d.status in ('open', 'claimed', 'delivered')
    and public.is_delivery_party(p_listing_id)
  order by (d.status in ('open', 'claimed')) desc, d.updated_at desc
  limit 1
$$;

-- ----------------------------------------------------- open_delivery_jobs
-- For helpers: open helper jobs in the society whose slot is not over, with
-- towers only. Nothing for anyone who is not a helper there, and never jobs
-- for the helper's own items.
create or replace function public.open_delivery_jobs(p_society_id uuid)
returns table (
  id uuid,
  listing_id uuid,
  title text,
  pickup_tower text,
  drop_tower text,
  slot_start timestamptz,
  slot_end timestamptz,
  tip_note text
)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, l.id, l.title, po.tower, pt.tower, d.slot_start, d.slot_end, d.tip_note
  from public.deliveries d
  join public.listings l on l.id = d.listing_id and l.status = 'reserved'
  join public.requests r on r.listing_id = l.id and r.status = 'accepted'
  left join public.profiles po on po.user_id = l.owner_id
  left join public.profiles pt on pt.user_id = r.requester_id
  where d.society_id = p_society_id
    and d.mode = 'helper' and d.status = 'open' and d.slot_end > now()
    and public.is_delivery_helper(p_society_id)
    and auth.uid() not in (l.owner_id, r.requester_id)
  order by d.slot_start, d.created_at
$$;

-- ------------------------------------------------------- my_delivery_jobs
-- For a helper: the jobs they took. While a job is claimed it carries both
-- sides' name, tower, flat and phone, so the helper can pick up and drop off.
-- Delivered and cancelled jobs from the last week stay listed, without flats
-- or phones.
create or replace function public.my_delivery_jobs(p_society_id uuid)
returns table (
  id uuid,
  listing_id uuid,
  title text,
  status text,
  slot_start timestamptz,
  slot_end timestamptz,
  tip_note text,
  pickup_name text,
  pickup_tower text,
  pickup_flat text,
  pickup_phone text,
  drop_name text,
  drop_tower text,
  drop_flat text,
  drop_phone text
)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, l.id, l.title, d.status, d.slot_start, d.slot_end, d.tip_note,
         po.display_name, po.tower,
         case when live then po.flat end, case when live then po.phone end,
         pt.display_name, pt.tower,
         case when live then pt.flat end, case when live then pt.phone end
  from public.deliveries d
  cross join lateral (select d.status = 'claimed' as live) s
  join public.listings l on l.id = d.listing_id
  left join public.requests r on r.listing_id = l.id and r.status = 'accepted'
  left join public.profiles po on po.user_id = l.owner_id
  left join public.profiles pt on pt.user_id = r.requester_id
  where d.society_id = p_society_id
    and d.helper_id = auth.uid()
    and public.is_member(p_society_id)
    and (d.status = 'claimed' or d.updated_at > now() - interval '7 days')
  order by (d.status = 'claimed') desc, d.slot_start
$$;

-- ------------------------------------------------- close with the listing
-- When an item stops being reserved, its live delivery follows: handed over
-- means delivered; anything else (reservation cancelled, hidden by an admin)
-- means cancelled.
create or replace function public.close_delivery_with_listing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.deliveries
  set status = case when new.status = 'done' then 'delivered' else 'cancelled' end,
      updated_at = now()
  where listing_id = new.id and status in ('open', 'claimed');
  return null;
end
$$;

create trigger listings_close_delivery
after update of status on public.listings
for each row
when (old.status = 'reserved' and new.status is distinct from 'reserved')
execute function public.close_delivery_with_listing();

-- --------------------------------------------------------------- grants
revoke execute on function
  public.is_delivery_helper(uuid),
  public.delivery_pair(uuid),
  public.is_delivery_party(uuid),
  public.valid_delivery_slot(timestamptz),
  public.arrange_delivery(uuid, text, timestamptz, text),
  public.cancel_delivery(uuid),
  public.claim_delivery(uuid),
  public.release_delivery(uuid),
  public.mark_delivered(uuid),
  public.get_delivery(uuid),
  public.open_delivery_jobs(uuid),
  public.my_delivery_jobs(uuid),
  public.close_delivery_with_listing()
from public, anon;

grant execute on function
  public.is_delivery_helper(uuid),
  public.is_delivery_party(uuid),
  public.arrange_delivery(uuid, text, timestamptz, text),
  public.cancel_delivery(uuid),
  public.claim_delivery(uuid),
  public.release_delivery(uuid),
  public.mark_delivered(uuid),
  public.get_delivery(uuid),
  public.open_delivery_jobs(uuid),
  public.my_delivery_jobs(uuid)
to authenticated;
-- delivery_pair names who is paired with whom; only the functions above use it.
-- Supabase's default privileges grant execute to authenticated, so take it back.
revoke execute on function public.delivery_pair(uuid), public.close_delivery_with_listing() from authenticated;
-- valid_delivery_slot only reads its argument and the clock.
grant execute on function public.valid_delivery_slot(timestamptz) to authenticated;

-- ------------------------------------------------ stage 9 email hook
-- Stage 9 (notifications) emails the pair when a delivery is claimed or
-- delivered. Whichever of the two migrations runs second attaches the
-- trigger; this one does it only if stage 9's function is already there.
do $$
begin
  if to_regprocedure('public.notify_delivery_change()') is not null
     and not exists (select 1 from pg_trigger where tgname = 'deliveries_notify'
                     and tgrelid = 'public.deliveries'::regclass) then
    create trigger deliveries_notify
    after insert or update of status on public.deliveries
    for each row execute function public.notify_delivery_change();
  end if;
end
$$;
