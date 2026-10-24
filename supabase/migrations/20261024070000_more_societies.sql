-- Stage 12: more societies.
--
-- 1. Starting Dumpy in a new society
--    society_requests          someone asks to start Dumpy in their society
--    platform_admins           the people who run Dumpy itself and approve
--                              new societies (added by hand, see
--                              supabase/snippets/make-platform-admin.sql)
--    request_society(name, city)          ask; you become its first admin
--    approve_society_request(id)          platform admin: creates the society
--                                         with its own invite code and makes
--                                         the person who asked its admin
--    reject_society_request(id, note)     platform admin: says no, with a note
--    platform_society_requests()          platform admin: every request
--    platform_societies()                 platform admin: every society
--    is_platform_admin()                  for the website to show the page
--
-- 2. Sharing items with nearby societies
--    society_links             one row per society that agrees to share with
--                              another. Sharing is on only when BOTH societies
--                              have a row for each other.
--    listings.visibility       "society" (default) or "nearby": the owner
--                              chooses, per item, to show it to linked societies
--    societies.link_code       a code an admin gives to a nearby society's
--                              admin; it lets them ask to link, never to join
--    link_society(society, code)          admin: ask to share with a society
--    accept_society_link(society, other)  admin: agree to a society that asked
--    unlink_society(society, other)       admin: stop sharing (both ways), or
--                                         turn down or withdraw an ask
--    nearby_societies(society)            members: linked societies' names;
--                                         admins also see asks both ways
--    society_link_code(society)           admin: the society's link code
--
-- Members of a linked society can see, through row-level security, only
-- listings marked "nearby" that are available, and their photos. Nothing else
-- crosses over: not memberships, profiles (names, towers, flats), requests,
-- reports, deliveries or contact details, and they cannot ask for, report or
-- change a nearby item.
--
-- Changes to earlier stages' tables (stage 2):
--   * societies gets city and link_code columns; plain selects on societies
--     now go through a column list so link_code stays admin-only (through
--     society_link_code). The website only ever read name and invite_code.
--   * listings gets the visibility column (owners may set it) and one more
--     select policy and one more listing_photos select policy, both for linked
--     societies' nearby items.
--   * storage.objects gets one more read policy for photos of nearby items.

-- ------------------------------------------------------------------ societies
alter table public.societies
  add column city text check (char_length(city) <= 60);
-- Every existing society gets its own code (the default runs once per row).
alter table public.societies
  add column link_code text not null unique default public.generate_invite_code()
    check (link_code ~ '^[A-Z0-9]{6,16}$');

revoke select on public.societies from authenticated;
grant select (id, name, invite_code, city, created_at) on public.societies to authenticated;

-- ------------------------------------------------------------ platform admins
-- Not tied to a society: these people run Dumpy itself. Nobody can read or
-- change this table from the website; is_platform_admin() answers about
-- yourself only.
create table public.platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
revoke all on table public.platform_admins from anon, authenticated;
alter table public.platform_admins enable row level security;

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid())
$$;

-- ----------------------------------------------------------- society requests
-- society_id stays empty until the request is approved and the society exists.
create table public.society_requests (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 120),
  city text not null check (char_length(city) between 2 and 60),
  contact_email text not null check (char_length(contact_email) <= 320),
  requested_by uuid not null references auth.users (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  society_id uuid references public.societies (id) on delete set null,
  note text not null default '' check (char_length(note) <= 300),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users (id) on delete set null
);
create index society_requests_by_idx on public.society_requests (requested_by, created_at desc);
create index society_requests_queue_idx on public.society_requests (status, created_at);
-- One open request per person per society name.
create unique index society_requests_one_open_idx
  on public.society_requests (requested_by, lower(name)) where status = 'pending';

revoke all on table public.society_requests from anon, authenticated;
alter table public.society_requests enable row level security;

-- People see their own requests and may withdraw one that is still pending.
-- Asking goes through request_society(); deciding through the platform
-- functions below.
grant select, delete on public.society_requests to authenticated;

create policy "people read their own society requests"
on public.society_requests for select to authenticated
using (requested_by = auth.uid());

create policy "people withdraw their pending society requests"
on public.society_requests for delete to authenticated
using (requested_by = auth.uid() and status = 'pending');

-- Ask to start Dumpy in a society. The contact email is the one you signed in
-- with, so the platform admin knows it is real. At most 3 open requests each.
create or replace function public.request_society(p_name text, p_city text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  _city text := regexp_replace(btrim(coalesce(p_city, '')), '\s+', ' ', 'g');
  _email text;
  _id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where user_id = auth.uid()) then
    raise exception 'Set up your profile first' using errcode = '55000';
  end if;
  if char_length(_name) not between 2 and 120 then
    raise exception 'Enter your society''s name' using errcode = '22023';
  end if;
  if char_length(_city) not between 2 and 60 then
    raise exception 'Enter your city' using errcode = '22023';
  end if;
  if (select count(*) from public.society_requests
      where requested_by = auth.uid() and status = 'pending') >= 3 then
    raise exception 'You already have 3 requests waiting. Wait for an answer first.' using errcode = '55000';
  end if;
  if exists (select 1 from public.society_requests
             where requested_by = auth.uid() and status = 'pending' and lower(name) = lower(_name)) then
    raise exception 'You have already asked to start this society' using errcode = '23505';
  end if;

  select u.email into _email from auth.users u where u.id = auth.uid();

  insert into public.society_requests (name, city, contact_email, requested_by)
  values (_name, _city, coalesce(_email, ''), auth.uid())
  returning id into _id;
  return _id;
end
$$;

-- Platform admin: every request, open ones first, with the asker's name.
create or replace function public.platform_society_requests()
returns table (
  id uuid,
  name text,
  city text,
  contact_email text,
  requested_by uuid,
  requester_name text,
  status text,
  society_id uuid,
  note text,
  created_at timestamptz,
  decided_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, r.name, r.city, r.contact_email, r.requested_by, p.display_name,
         r.status, r.society_id, r.note, r.created_at, r.decided_at
  from public.society_requests r
  left join public.profiles p on p.user_id = r.requested_by
  where public.is_platform_admin()
  order by (r.status = 'pending') desc,
           case when r.status = 'pending' then r.created_at end asc,
           r.decided_at desc nulls last
  limit 200
$$;

-- Platform admin: every society, newest first. Names and cities only.
create or replace function public.platform_societies()
returns table (id uuid, name text, city text, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.name, s.city, s.created_at
  from public.societies s
  where public.is_platform_admin()
  order by s.created_at desc
$$;

-- Platform admin: say yes. Creates the society (with a fresh invite code) and
-- makes the person who asked its approved admin, in one step.
create or replace function public.approve_society_request(p_request_id uuid)
returns table (society_id uuid, invite_code text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  _req public.society_requests;
  _society uuid;
  _code text;
begin
  if not public.is_platform_admin() then
    raise exception 'Only the people who run Dumpy can approve new societies' using errcode = '42501';
  end if;

  select * into _req from public.society_requests where id = p_request_id for update;
  if _req.id is null then
    raise exception 'That request does not exist' using errcode = 'P0002';
  end if;
  if _req.status <> 'pending' then
    raise exception 'That request has already been answered' using errcode = '55000';
  end if;
  if exists (select 1 from public.societies s
             where lower(s.name) = lower(_req.name) and lower(coalesce(s.city, '')) = lower(_req.city)) then
    raise exception 'A society with this name already runs Dumpy in this city' using errcode = '23505';
  end if;

  insert into public.societies (name, city) values (_req.name, _req.city)
  returning id, invite_code into _society, _code;

  insert into public.memberships (user_id, society_id, role, status)
  values (_req.requested_by, _society, 'admin', 'approved');

  update public.society_requests
  set status = 'approved', society_id = _society, decided_at = now(), decided_by = auth.uid()
  where id = _req.id;

  return query select _society, _code;
end
$$;

-- Platform admin: say no, with an optional note the person sees.
create or replace function public.reject_society_request(p_request_id uuid, p_note text default '')
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _req public.society_requests;
  _note text := btrim(coalesce(p_note, ''));
begin
  if not public.is_platform_admin() then
    raise exception 'Only the people who run Dumpy can answer these requests' using errcode = '42501';
  end if;
  if char_length(_note) > 300 then
    raise exception 'Keep the note under 300 characters' using errcode = '22023';
  end if;

  select * into _req from public.society_requests where id = p_request_id for update;
  if _req.id is null then
    raise exception 'That request does not exist' using errcode = 'P0002';
  end if;
  if _req.status <> 'pending' then
    raise exception 'That request has already been answered' using errcode = '55000';
  end if;

  update public.society_requests
  set status = 'rejected', note = _note, decided_at = now(), decided_by = auth.uid()
  where id = _req.id;
end
$$;

-- ------------------------------------------------------------- society links
-- (society_id -> linked_society_id): society_id's admins agreed to share with
-- linked_society_id. Sharing is on only when the reverse row exists too.
-- Read and changed only through the functions below.
create table public.society_links (
  society_id uuid not null references public.societies (id) on delete cascade,
  linked_society_id uuid not null references public.societies (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (society_id, linked_society_id),
  check (society_id <> linked_society_id)
);
create index society_links_reverse_idx on public.society_links (linked_society_id);

revoke all on table public.society_links from anon, authenticated;
alter table public.society_links enable row level security;

-- True when both societies agreed to share with each other.
create or replace function public.societies_linked(p_a uuid, p_b uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.society_links where society_id = p_a and linked_society_id = p_b)
     and exists (select 1 from public.society_links where society_id = p_b and linked_society_id = p_a)
$$;

-- True when the signed-in person is an approved member of some society that
-- shares both ways with p_society_id.
create or replace function public.shares_nearby_with_me(p_society_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    join public.society_links mine
      on mine.society_id = m.society_id and mine.linked_society_id = p_society_id
    join public.society_links theirs
      on theirs.society_id = p_society_id and theirs.linked_society_id = m.society_id
    where m.user_id = auth.uid() and m.status = 'approved'
  )
$$;

-- Admin: the code to hand to a nearby society's admin.
create or replace function public.society_link_code(p_society_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.link_code from public.societies s
  where s.id = p_society_id and public.is_admin(p_society_id)
$$;

-- Admin: ask to share with the society whose link code this is. If they had
-- already asked us, sharing is on straight away.
create or replace function public.link_society(p_society_id uuid, p_link_code text)
returns table (society_id uuid, name text, city text, status text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  _other public.societies;
begin
  if not public.is_admin(p_society_id) then
    raise exception 'Only an admin of your society can do this' using errcode = '42501';
  end if;
  select * into _other from public.societies s
  where s.link_code = upper(regexp_replace(coalesce(p_link_code, ''), '\s', '', 'g'));
  if _other.id is null then
    raise exception 'That link code does not match any society' using errcode = 'P0002';
  end if;
  if _other.id = p_society_id then
    raise exception 'That is your own society''s code' using errcode = '22023';
  end if;

  insert into public.society_links (society_id, linked_society_id, created_by)
  values (p_society_id, _other.id, auth.uid())
  on conflict do nothing;

  return query select _other.id, _other.name, _other.city,
    case when public.societies_linked(p_society_id, _other.id) then 'linked' else 'asked' end;
end
$$;

-- Admin: agree to share with a society that asked first.
create or replace function public.accept_society_link(p_society_id uuid, p_other_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_admin(p_society_id) then
    raise exception 'Only an admin of your society can do this' using errcode = '42501';
  end if;
  if not exists (select 1 from public.society_links
                 where society_id = p_other_id and linked_society_id = p_society_id) then
    raise exception 'That society has not asked to share with you' using errcode = 'P0002';
  end if;
  insert into public.society_links (society_id, linked_society_id, created_by)
  values (p_society_id, p_other_id, auth.uid())
  on conflict do nothing;
end
$$;

-- Admin: stop sharing with a society, turn down its ask, or withdraw ours.
-- Removes both directions, so either side can end it alone.
create or replace function public.unlink_society(p_society_id uuid, p_other_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_admin(p_society_id) then
    raise exception 'Only an admin of your society can do this' using errcode = '42501';
  end if;
  delete from public.society_links
  where (society_id = p_society_id and linked_society_id = p_other_id)
     or (society_id = p_other_id and linked_society_id = p_society_id);
end
$$;

-- Societies p_society_id shares with, for its members ("linked" only), and
-- for its admins also "asked" (we asked, waiting for them) and "asking"
-- (they asked us). Nothing for anyone else.
create or replace function public.nearby_societies(p_society_id uuid)
returns table (society_id uuid, name text, city text, status text)
language sql
stable
security definer
set search_path = ''
as $$
  with mine as (
    select o.id, o.name, o.city,
           exists (select 1 from public.society_links where society_id = p_society_id and linked_society_id = o.id) as we,
           exists (select 1 from public.society_links where society_id = o.id and linked_society_id = p_society_id) as they
    from public.societies o
    where o.id <> p_society_id
      and public.is_member(p_society_id)
      and o.id in (select linked_society_id from public.society_links where society_id = p_society_id
                   union
                   select society_id from public.society_links where linked_society_id = p_society_id)
  )
  select id, name, city,
         case when we and they then 'linked' when we then 'asked' else 'asking' end
  from mine
  where (we and they) or public.is_admin(p_society_id)
  order by (we and they) desc, name
$$;

-- ------------------------------------------------------- listings: visibility
alter table public.listings
  add column visibility text not null default 'society' check (visibility in ('society', 'nearby'));
grant insert (visibility), update (visibility) on public.listings to authenticated;

-- Members of a linked society see nearby items that are up, and nothing else
-- of this society.
create policy "linked societies read nearby listings"
on public.listings for select to authenticated
using (
  visibility = 'nearby'
  and status = 'available'
  and expires_at > now()
  and public.shares_nearby_with_me(society_id)
);

create policy "linked societies read photos of nearby listings"
on public.listing_photos for select to authenticated
using (
  exists (
    select 1 from public.listings l
    where l.id = listing_id
      and l.society_id = listing_photos.society_id
      and l.visibility = 'nearby'
      and l.status = 'available'
      and l.expires_at > now()
      and public.shares_nearby_with_me(l.society_id)
  )
);

-- True when a Storage path <society_id>/<listing_id>/<file> is a photo of a
-- nearby item the signed-in person may see from a linked society.
create or replace function public.is_nearby_photo_path(p_path text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  _parts text[] := string_to_array(p_path, '/');
  _society uuid;
  _listing uuid;
begin
  if array_length(_parts, 1) <> 3 or _parts[3] = '' then
    return false;
  end if;
  begin
    _society := _parts[1]::uuid;
    _listing := _parts[2]::uuid;
  exception when invalid_text_representation then
    return false;
  end;
  return exists (
    select 1 from public.listings l
    join public.listing_photos ph on ph.listing_id = l.id and ph.storage_path = p_path
    where l.id = _listing
      and l.society_id = _society
      and l.visibility = 'nearby'
      and l.status = 'available'
      and l.expires_at > now()
  ) and public.shares_nearby_with_me(_society);
end
$$;

create policy "linked societies read nearby listing photos"
on storage.objects for select to authenticated
using (bucket_id = 'listing-photos' and public.is_nearby_photo_path(name));

-- --------------------------------------------------------------- grants
revoke execute on function
  public.is_platform_admin(),
  public.request_society(text, text),
  public.platform_society_requests(),
  public.platform_societies(),
  public.approve_society_request(uuid),
  public.reject_society_request(uuid, text),
  public.societies_linked(uuid, uuid),
  public.shares_nearby_with_me(uuid),
  public.society_link_code(uuid),
  public.link_society(uuid, text),
  public.accept_society_link(uuid, uuid),
  public.unlink_society(uuid, uuid),
  public.nearby_societies(uuid),
  public.is_nearby_photo_path(text)
from public, anon;

grant execute on function
  public.is_platform_admin(),
  public.request_society(text, text),
  public.platform_society_requests(),
  public.platform_societies(),
  public.approve_society_request(uuid),
  public.reject_society_request(uuid, text),
  public.shares_nearby_with_me(uuid),
  public.society_link_code(uuid),
  public.link_society(uuid, text),
  public.accept_society_link(uuid, uuid),
  public.unlink_society(uuid, uuid),
  public.nearby_societies(uuid),
  public.is_nearby_photo_path(text)
to authenticated;

-- Only used inside the functions above.
revoke execute on function public.societies_linked(uuid, uuid) from authenticated;
