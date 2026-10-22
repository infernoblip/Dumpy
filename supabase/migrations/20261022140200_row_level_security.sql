-- Stage 2: who can see and change what.
--
-- Two layers:
--   1. Table and column privileges decide WHICH columns the website's roles can
--      touch at all. Supabase grants everything by default, so we revoke it all
--      and grant back only what is needed. Signed-out visitors (anon) get
--      nothing.
--   2. Row-level security policies decide WHICH ROWS a signed-in person can
--      see or change. Everything is limited to approved members of the row's
--      society. Pending and suspended members see nothing but their own
--      membership row and profile.

revoke all on table
  public.societies,
  public.memberships,
  public.profiles,
  public.listings,
  public.listing_photos,
  public.requests
from anon, authenticated;

alter table public.societies      enable row level security;
alter table public.memberships    enable row level security;
alter table public.profiles       enable row level security;
alter table public.listings       enable row level security;
alter table public.listing_photos enable row level security;
alter table public.requests       enable row level security;

-- ---------------------------------------------------------------- societies
-- Members read their society. Admins can rename it or change its invite code.
-- New societies are created by Arihaan in the Supabase dashboard (stage 4)
-- and later by a sign-up flow (stage 12), not by plain inserts.
grant select on public.societies to authenticated;
grant update (name, invite_code) on public.societies to authenticated;

create policy "members read their society"
on public.societies for select to authenticated
using (public.is_member(id));

create policy "admins update their society"
on public.societies for update to authenticated
using (public.is_admin(id))
with check (public.is_admin(id));

-- -------------------------------------------------------------- memberships
-- People see their own memberships (so a pending person can be shown "waiting
-- for approval"); admins see and manage everyone in their society. Joining
-- goes through join_society(invite_code), never a plain insert.
grant select on public.memberships to authenticated;
grant update (role, status) on public.memberships to authenticated;
grant delete on public.memberships to authenticated;

create policy "people read their own memberships"
on public.memberships for select to authenticated
using (user_id = auth.uid());

create policy "admins read their society's memberships"
on public.memberships for select to authenticated
using (public.is_admin(society_id));

-- Admins approve, suspend, restore and promote others, but never change their
-- own row, so nobody locks themselves out by accident.
create policy "admins update other memberships"
on public.memberships for update to authenticated
using (public.is_admin(society_id) and user_id <> auth.uid())
with check (public.is_admin(society_id) and user_id <> auth.uid());

-- Admins reject or remove others; people may leave or cancel a request to
-- join, unless they are suspended.
create policy "admins remove other memberships"
on public.memberships for delete to authenticated
using (public.is_admin(society_id) and user_id <> auth.uid());

create policy "people leave a society"
on public.memberships for delete to authenticated
using (user_id = auth.uid() and status <> 'suspended');

-- ----------------------------------------------------------------- profiles
-- Name and tower are visible to neighbours. flat, phone and upi_id are never
-- readable through a plain select, not even your own: use get_my_profile()
-- for yourself, admin_list_members() on the admin page, and the stage 6
-- get_contact() function for the matched pair.
grant select (user_id, display_name, tower, created_at) on public.profiles to authenticated;
grant insert (user_id, display_name, tower, flat, phone, upi_id) on public.profiles to authenticated;
grant update (display_name, tower, flat, phone, upi_id) on public.profiles to authenticated;

create policy "people read profiles they share a society with"
on public.profiles for select to authenticated
using (public.can_see_profile(user_id));

create policy "people create their own profile"
on public.profiles for insert to authenticated
with check (user_id = auth.uid());

create policy "people update their own profile"
on public.profiles for update to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

-- ----------------------------------------------------------------- listings
-- Members see their society's available, reserved and done items. Owners
-- also see their own withdrawn, expired and hidden items; admins see all of
-- their society's items.
grant select on public.listings to authenticated;
grant insert (society_id, owner_id, title, description, category, condition, price_inr, expires_at)
  on public.listings to authenticated;
grant update (title, description, category, condition, price_inr, status, expires_at)
  on public.listings to authenticated;

create policy "members read their society's listings"
on public.listings for select to authenticated
using (
  public.is_member(society_id)
  and (
    status in ('available', 'reserved', 'done')
    or owner_id = auth.uid()
    or public.is_admin(society_id)
  )
);

create policy "members post listings as themselves"
on public.listings for insert to authenticated
with check (
  owner_id = auth.uid()
  and public.is_member(society_id)
  and status = 'available'
);

-- Owners edit their own items, except one an admin has hidden, and cannot
-- hide an item themselves (they withdraw it instead).
create policy "owners update their own listings"
on public.listings for update to authenticated
using (owner_id = auth.uid() and public.is_member(society_id) and status <> 'hidden')
with check (owner_id = auth.uid() and public.is_member(society_id) and status <> 'hidden');

create policy "admins update their society's listings"
on public.listings for update to authenticated
using (public.is_admin(society_id))
with check (public.is_admin(society_id));

-- No deletes from the website: owners set status to withdrawn instead.

-- ----------------------------------------------------------- listing_photos
-- Anyone who can see the listing can see its photos. Only its owner adds,
-- reorders or removes them.
grant select on public.listing_photos to authenticated;
grant insert (listing_id, society_id, storage_path, position) on public.listing_photos to authenticated;
grant update (position) on public.listing_photos to authenticated;
grant delete on public.listing_photos to authenticated;

create policy "people read photos of listings they can see"
on public.listing_photos for select to authenticated
using (
  public.is_member(society_id)
  and exists (select 1 from public.listings l where l.id = listing_id)
);

create policy "owners add photos to their listings"
on public.listing_photos for insert to authenticated
with check (
  public.is_member(society_id)
  and exists (
    select 1 from public.listings l
    where l.id = listing_id and l.society_id = listing_photos.society_id and l.owner_id = auth.uid()
  )
);

create policy "owners reorder photos of their listings"
on public.listing_photos for update to authenticated
using (
  public.is_member(society_id)
  and exists (select 1 from public.listings l where l.id = listing_id and l.owner_id = auth.uid())
)
with check (
  public.is_member(society_id)
  and exists (select 1 from public.listings l where l.id = listing_id and l.owner_id = auth.uid())
);

create policy "owners remove photos of their listings"
on public.listing_photos for delete to authenticated
using (
  public.is_member(society_id)
  and exists (select 1 from public.listings l where l.id = listing_id and l.owner_id = auth.uid())
);

-- ----------------------------------------------------------------- requests
-- Requesters see their own requests; owners see the requests on their items.
grant select on public.requests to authenticated;
grant insert (listing_id, society_id, requester_id, message) on public.requests to authenticated;
grant update (message, status) on public.requests to authenticated;

create policy "requesters read their own requests"
on public.requests for select to authenticated
using (requester_id = auth.uid() and public.is_member(society_id));

create policy "owners read requests on their listings"
on public.requests for select to authenticated
using (
  public.is_member(society_id)
  and exists (select 1 from public.listings l where l.id = listing_id and l.owner_id = auth.uid())
);

-- Ask for an available item that someone else posted.
create policy "members request available items"
on public.requests for insert to authenticated
with check (
  requester_id = auth.uid()
  and status = 'pending'
  and public.is_member(society_id)
  and exists (
    select 1 from public.listings l
    where l.id = listing_id
      and l.society_id = requests.society_id
      and l.status = 'available'
      and l.owner_id <> auth.uid()
  )
);

-- Requesters edit the message or cancel while the request is still pending.
create policy "requesters edit or cancel pending requests"
on public.requests for update to authenticated
using (requester_id = auth.uid() and status = 'pending' and public.is_member(society_id))
with check (requester_id = auth.uid() and status in ('pending', 'cancelled'));

-- Owners decline a pending request. Accepting goes through the stage 6
-- accept_request() function so exactly one request wins.
create policy "owners decline requests on their listings"
on public.requests for update to authenticated
using (
  status = 'pending'
  and public.is_member(society_id)
  and exists (select 1 from public.listings l where l.id = listing_id and l.owner_id = auth.uid())
)
with check (
  status = 'declined'
  and exists (select 1 from public.listings l where l.id = listing_id and l.owner_id = auth.uid())
);

-- No deletes from the website: requests are cancelled or declined instead.
