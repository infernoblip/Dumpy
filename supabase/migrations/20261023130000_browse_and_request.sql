-- Stage 6: asking for items, and handing each one to exactly one person.
--
-- Adds four functions the website calls and one guard on listings:
--   accept_request(request_id)       owner picks one request: it is accepted, the
--                                    other pending ones are declined, the item
--                                    becomes reserved. One transaction.
--   mark_handed_over(listing_id)     owner: reserved -> done
--   cancel_reservation(listing_id)   owner: reserved -> available; the accepted
--                                    request is cancelled and the requests that
--                                    were declined when it was accepted are
--                                    pending again, so the owner can pick again
--   get_contact(listing_id)          the other person's name, tower, flat and
--                                    phone, only for the owner and the accepted
--                                    requester of a reserved or handed-over item
--
-- Change to a stage 2 table: listings gets a trigger so a plain update can no
-- longer move an item into or out of "reserved" or "done". Those moves only
-- happen through the functions above, so an item's status and its accepted
-- request always agree. Admins can still hide any item.

-- --------------------------------------------------------------- guard
create or replace function public.guard_listing_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status
     and new.status <> 'hidden'
     and (old.status in ('reserved', 'done') or new.status in ('reserved', 'done'))
     and current_user in ('authenticated', 'anon') then
    raise exception 'Reserve and hand over items with accept_request, mark_handed_over or cancel_reservation'
      using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger listings_guard_status
before update of status on public.listings
for each row execute function public.guard_listing_status();

-- --------------------------------------------------------- accept_request
create or replace function public.accept_request(p_request_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _req public.requests;
  _listing public.listings;
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;

  -- Lock the listing: a second accept for the same item waits here until the
  -- first one commits, then sees the item is already reserved.
  select l.* into _listing from public.listings l
  where l.id = (select r.listing_id from public.requests r where r.id = p_request_id)
  for update;

  -- Read the request after the lock, so a cancel that just happened is seen.
  select * into _req from public.requests where id = p_request_id;

  if _req.id is null or _listing.id is null
     or _listing.owner_id <> auth.uid()
     or not public.is_member(_listing.society_id) then
    raise exception 'Only the item''s owner can accept a request' using errcode = '42501';
  end if;

  if _listing.status <> 'available' then
    raise exception 'This item is no longer available' using errcode = '55000';
  end if;

  if _req.status <> 'pending' then
    raise exception 'That request was cancelled' using errcode = '55000';
  end if;

  if not exists (
    select 1 from public.memberships m
    where m.user_id = _req.requester_id and m.society_id = _listing.society_id and m.status = 'approved'
  ) then
    raise exception 'That person is no longer a member of your society' using errcode = '55000';
  end if;

  update public.requests set status = 'accepted' where id = _req.id;
  update public.requests set status = 'declined'
  where listing_id = _listing.id and status = 'pending' and id <> _req.id;
  update public.listings set status = 'reserved' where id = _listing.id;
end
$$;

-- ------------------------------------------------------- mark_handed_over
create or replace function public.mark_handed_over(p_listing_id uuid)
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
  if _listing.status <> 'reserved' then
    raise exception 'This item is not reserved' using errcode = '55000';
  end if;

  update public.listings set status = 'done' where id = _listing.id;
end
$$;

-- ----------------------------------------------------- cancel_reservation
create or replace function public.cancel_reservation(p_listing_id uuid)
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
  if _listing.status <> 'reserved' then
    raise exception 'This item is not reserved' using errcode = '55000';
  end if;

  update public.requests set status = 'cancelled'
  where listing_id = _listing.id and status = 'accepted';
  -- The website has no Decline button, so every declined request on this item
  -- was declined when the cancelled one was accepted: give them back their turn.
  update public.requests set status = 'pending'
  where listing_id = _listing.id and status = 'declined';
  update public.listings set status = 'available' where id = _listing.id;
end
$$;

-- ------------------------------------------------------------ get_contact
-- The owner gets the accepted requester's details; the accepted requester gets
-- the owner's. Everyone else, and anyone once the reservation is cancelled,
-- gets no rows. upi_id is only ever the owner's (the taker pays the owner;
-- stage 8 uses it), and only for a paid item.
create or replace function public.get_contact(p_listing_id uuid)
returns table (
  user_id uuid,
  is_owner boolean,
  display_name text,
  tower text,
  flat text,
  phone text,
  upi_id text
)
language sql
stable
security definer
set search_path = ''
as $$
  with pair as (
    select l.owner_id, r.requester_id, l.price_inr
    from public.listings l
    join public.requests r on r.listing_id = l.id and r.status = 'accepted'
    where l.id = p_listing_id
      and l.status in ('reserved', 'done')
      and public.is_member(l.society_id)
      and auth.uid() in (l.owner_id, r.requester_id)
  )
  select p.user_id,
         p.user_id = pair.owner_id,
         p.display_name, p.tower, p.flat, p.phone,
         case when p.user_id = pair.owner_id and pair.price_inr > 0 then p.upi_id end
  from pair
  join public.profiles p
    on p.user_id = case when auth.uid() = pair.owner_id then pair.requester_id else pair.owner_id end
$$;

-- --------------------------------------------------------------- grants
revoke execute on function
  public.guard_listing_status(),
  public.accept_request(uuid),
  public.mark_handed_over(uuid),
  public.cancel_reservation(uuid),
  public.get_contact(uuid)
from public, anon;

grant execute on function
  public.accept_request(uuid),
  public.mark_handed_over(uuid),
  public.cancel_reservation(uuid),
  public.get_contact(uuid)
to authenticated;

revoke execute on function public.guard_listing_status() from authenticated;
