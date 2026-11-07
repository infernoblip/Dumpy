-- Proof of delivery, and both sides confirming it.
--
--   * The helper must add a photo when marking a delivery delivered. The photo
--     shows the item, the flat door or number, and the helper's hand. It is
--     stored in the private delivery-proofs bucket at
--       <society_id>/<delivery_id>/<file>
--     and only the helper, the seller, the buyer and the society's admins can
--     read it.
--   * The seller confirms the helper picked the item up (confirm_pickup).
--   * After delivery the buyer confirms they received it (confirm_received).
--     If they say no, a "delivery problem" opens: the helper and the society's
--     admins are told (email), the buyer gets the admins' and seller's phone
--     numbers, the helper must confirm again that they delivered it
--     (helper_reconfirm_delivery), and a society admin decides
--     (resolve_delivery_problem). "Delivered" needs the helper's second
--     confirmation; "not delivered" also waives Dumpy's delivery fee.
--
-- Changes to other stages:
--   deliveries (stage 7): new columns proof_path, pickup_confirmed_at,
--     received_at, problem_at, helper_reconfirmed_at, problem_outcome,
--     problem_resolved_at, problem_resolved_by.
--   mark_delivered (stage 7): takes the photo's path; the helper must give one.
--   my_delivery_jobs (stage 7) and get_delivery (20261107090000): return the
--     new columns.
--   notifications (stage 9): two new kinds, delivery_problem and
--     delivery_problem_resolved (the send-email function needs redeploying
--     to word them).

-- ------------------------------------------------------------ columns
alter table public.deliveries
  add column proof_path text,
  add column pickup_confirmed_at timestamptz,
  add column received_at timestamptz,
  add column problem_at timestamptz,
  add column helper_reconfirmed_at timestamptz,
  add column problem_outcome text check (problem_outcome in ('delivered', 'not_delivered')),
  add column problem_resolved_at timestamptz,
  add column problem_resolved_by uuid references auth.users (id) on delete set null;

create index deliveries_problem_idx on public.deliveries (society_id, problem_at) where problem_at is not null;

-- ------------------------------------------------------------- bucket
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('delivery-proofs', 'delivery-proofs', false, 2 * 1024 * 1024, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- The delivery a path <society_id>/<delivery_id>/<file> points at, or null.
create or replace function public.delivery_of_proof_path(p_path text)
returns public.deliveries
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  _parts text[] := string_to_array(p_path, '/');
  _d public.deliveries;
begin
  if array_length(_parts, 1) <> 3 or _parts[3] = '' then
    return null;
  end if;
  begin
    select * into _d from public.deliveries d
    where d.id = _parts[2]::uuid and d.society_id = _parts[1]::uuid;
  exception when invalid_text_representation then
    return null;
  end;
  return _d;
end
$$;

-- The helper uploads the photo while the job is theirs.
create or replace function public.can_upload_delivery_proof(p_path text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  _d public.deliveries := public.delivery_of_proof_path(p_path);
begin
  return _d.id is not null and _d.status = 'claimed' and _d.helper_id = auth.uid()
     and public.is_member(_d.society_id);
end
$$;

-- The helper, the seller, the buyer and the society's admins see the photo.
create or replace function public.can_read_delivery_proof(p_path text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  _d public.deliveries := public.delivery_of_proof_path(p_path);
begin
  if _d.id is null then
    return false;
  end if;
  return _d.helper_id = auth.uid()
      or public.is_delivery_party(_d.listing_id)
      or public.is_admin(_d.society_id);
end
$$;

create policy "helpers upload delivery proof"
on storage.objects for insert to authenticated
with check (bucket_id = 'delivery-proofs' and public.can_upload_delivery_proof(name));

create policy "the pair, helper and admins read delivery proof"
on storage.objects for select to authenticated
using (bucket_id = 'delivery-proofs' and public.can_read_delivery_proof(name));

-- ------------------------------------------------------- mark_delivered
-- As in stage 7, plus: the helper must give the path of the photo they
-- uploaded. (The seller can still mark it delivered themselves, without one.)
drop function public.mark_delivered(uuid);
create function public.mark_delivered(p_delivery_id uuid, p_proof_path text default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _d public.deliveries;
  _listing public.listings;
  _proof text := nullif(btrim(coalesce(p_proof_path, '')), '');
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
  if _d.helper_id = auth.uid() then
    if _proof is null then
      raise exception 'Add a photo of the item at the flat door, with your hand in it' using errcode = '22023';
    end if;
    if _proof not like _d.society_id || '/' || _d.id || '/%'
       or not exists (select 1 from storage.objects o where o.bucket_id = 'delivery-proofs' and o.name = _proof) then
      raise exception 'The photo did not upload. Try again.' using errcode = '22023';
    end if;
  end if;

  update public.deliveries
  set status = 'delivered', proof_path = coalesce(_proof, proof_path), updated_at = now()
  where id = _d.id;
  update public.listings set status = 'done' where id = _listing.id;
end
$$;

-- -------------------------------------------------------- confirm_pickup
-- The seller confirms the helper picked the item up.
create or replace function public.confirm_pickup(p_delivery_id uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _d public.deliveries;
  _at timestamptz;
begin
  select * into _d from public.deliveries where id = p_delivery_id for update;
  if _d.id is null or not public.is_member(_d.society_id)
     or not exists (select 1 from public.listings l where l.id = _d.listing_id and l.owner_id = auth.uid()) then
    raise exception 'Only the seller can confirm the pickup' using errcode = '42501';
  end if;
  if _d.mode <> 'helper' or _d.helper_id is null or _d.status not in ('claimed', 'delivered') then
    raise exception 'No helper has this delivery' using errcode = '55000';
  end if;
  update public.deliveries set pickup_confirmed_at = coalesce(pickup_confirmed_at, now())
  where id = _d.id returning pickup_confirmed_at into _at;
  return _at;
end
$$;

-- ------------------------------------------------------ confirm_received
-- The buyer says whether they got the item a helper delivered. "No" opens a
-- delivery problem and tells the helper and the society's admins. "Yes" closes
-- an open problem too (the buyer found it after all).
create or replace function public.confirm_received(p_delivery_id uuid, p_received boolean)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _d public.deliveries;
  _taker uuid;
  _admin uuid;
begin
  select * into _d from public.deliveries where id = p_delivery_id for update;
  select p.taker_id into _taker from public.delivery_pair(_d.listing_id) p;
  if _d.id is null or _taker is distinct from auth.uid() or not public.is_member(_d.society_id) then
    raise exception 'Only the person the item went to can confirm this' using errcode = '42501';
  end if;
  if _d.status <> 'delivered' or _d.helper_id is null then
    raise exception 'Only a delivery a helper marked delivered can be confirmed' using errcode = '55000';
  end if;
  if _d.problem_outcome is not null then
    raise exception 'Your society admin has already decided this delivery' using errcode = '55000';
  end if;

  if p_received then
    update public.deliveries
    set received_at = coalesce(received_at, now()),
        problem_outcome = case when problem_at is not null then 'delivered' end,
        problem_resolved_at = case when problem_at is not null then now() end,
        problem_resolved_by = case when problem_at is not null then auth.uid() end
    where id = _d.id;
    return 'received';
  end if;

  if _d.received_at is not null then
    raise exception 'You already said you received it. Call your society admin if something is wrong.' using errcode = '55000';
  end if;
  if _d.problem_at is not null then
    return 'problem';
  end if;
  update public.deliveries set problem_at = now() where id = _d.id;
  perform public.queue_notification('delivery_problem', _d.listing_id, _d.helper_id, auth.uid(), null, _d.id);
  for _admin in
    select m.user_id from public.memberships m
    where m.society_id = _d.society_id and m.role = 'admin' and m.status = 'approved'
      and m.user_id <> _d.helper_id
  loop
    perform public.queue_notification('delivery_problem', _d.listing_id, _admin, auth.uid(), null, _d.id);
  end loop;
  return 'problem';
end
$$;

-- For the buyer once they report a problem: who to call. The society's admins
-- and the seller, with phone numbers.
create or replace function public.delivery_problem_contacts(p_listing_id uuid)
returns table (role text, display_name text, tower text, phone text)
language sql
stable
security definer
set search_path = ''
as $$
  with d as (
    select d.*, l.owner_id from public.deliveries d
    join public.listings l on l.id = d.listing_id
    where d.listing_id = p_listing_id and d.problem_at is not null
      and (select p.taker_id from public.delivery_pair(p_listing_id) p) = auth.uid()
      and public.is_member(d.society_id)
    order by d.problem_at desc limit 1
  )
  select 'admin', p.display_name, p.tower, p.phone
  from d join public.memberships m on m.society_id = d.society_id and m.role = 'admin' and m.status = 'approved'
  join public.profiles p on p.user_id = m.user_id
  union all
  select 'seller', p.display_name, p.tower, p.phone
  from d join public.profiles p on p.user_id = d.owner_id
$$;

-- --------------------------------------------- helper_reconfirm_delivery
-- The helper's second confirmation that they delivered it.
create or replace function public.helper_reconfirm_delivery(p_delivery_id uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _d public.deliveries;
  _at timestamptz;
begin
  select * into _d from public.deliveries where id = p_delivery_id for update;
  if _d.id is null or _d.helper_id is distinct from auth.uid() or not public.is_member(_d.society_id) then
    raise exception 'Only the helper can confirm this' using errcode = '42501';
  end if;
  if _d.problem_at is null or _d.problem_outcome is not null then
    raise exception 'There is no open problem with this delivery' using errcode = '55000';
  end if;
  update public.deliveries set helper_reconfirmed_at = coalesce(helper_reconfirmed_at, now())
  where id = _d.id returning helper_reconfirmed_at into _at;
  return _at;
end
$$;

-- --------------------------------------------- resolve_delivery_problem
-- A society admin decides, after talking to everyone. "delivered" needs the
-- helper's second confirmation first. "not_delivered" also waives Dumpy's fee.
create or replace function public.resolve_delivery_problem(p_delivery_id uuid, p_outcome text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _d public.deliveries;
  _owner uuid;
  _taker uuid;
begin
  select * into _d from public.deliveries where id = p_delivery_id for update;
  if _d.id is null or not public.is_admin(_d.society_id) then
    raise exception 'Only a society admin can decide this' using errcode = '42501';
  end if;
  if p_outcome is null or p_outcome not in ('delivered', 'not_delivered') then
    raise exception 'Choose delivered or not delivered' using errcode = '22023';
  end if;
  if _d.problem_at is null or _d.problem_outcome is not null then
    raise exception 'There is no open problem with this delivery' using errcode = '55000';
  end if;
  if p_outcome = 'delivered' and _d.helper_reconfirmed_at is null then
    raise exception 'The helper has to confirm again first' using errcode = '55000';
  end if;

  update public.deliveries
  set problem_outcome = p_outcome, problem_resolved_at = now(), problem_resolved_by = auth.uid(),
      fee_waived = case when p_outcome = 'not_delivered' and fee_inr > 0 then true else fee_waived end
  where id = _d.id;

  select p.owner_id, p.taker_id into _owner, _taker from public.delivery_pair(_d.listing_id) p;
  perform public.queue_notification('delivery_problem_resolved', _d.listing_id, _owner, auth.uid(), null, _d.id);
  perform public.queue_notification('delivery_problem_resolved', _d.listing_id, _taker, auth.uid(), null, _d.id);
  perform public.queue_notification('delivery_problem_resolved', _d.listing_id, _d.helper_id, auth.uid(), null, _d.id);
end
$$;

-- ------------------------------------------- society_delivery_problems
-- For society admins: delivery problems (open ones, and ones decided in the
-- last 7 days), with everyone's name, flat and phone and the photo.
create or replace function public.society_delivery_problems(p_society_id uuid)
returns table (
  id uuid,
  listing_id uuid,
  title text,
  slot_start timestamptz,
  problem_at timestamptz,
  helper_reconfirmed_at timestamptz,
  problem_outcome text,
  proof_path text,
  helper_name text, helper_tower text, helper_flat text, helper_phone text,
  seller_name text, seller_tower text, seller_flat text, seller_phone text,
  buyer_name text, buyer_tower text, buyer_flat text, buyer_phone text
)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, l.id, l.title, d.slot_start, d.problem_at, d.helper_reconfirmed_at, d.problem_outcome, d.proof_path,
         ph.display_name, ph.tower, ph.flat, ph.phone,
         po.display_name, po.tower, po.flat, po.phone,
         pt.display_name, pt.tower, pt.flat, pt.phone
  from public.deliveries d
  join public.listings l on l.id = d.listing_id
  left join public.requests r on r.listing_id = l.id and r.status = 'accepted'
  left join public.profiles ph on ph.user_id = d.helper_id
  left join public.profiles po on po.user_id = l.owner_id
  left join public.profiles pt on pt.user_id = r.requester_id
  where d.society_id = p_society_id
    and public.is_admin(p_society_id)
    and d.problem_at is not null
    and (d.problem_outcome is null or d.problem_resolved_at > now() - interval '7 days')
  order by (d.problem_outcome is null) desc, d.problem_at desc
$$;

-- ------------------------------------------------------- my_delivery_jobs
-- As in stage 7, plus the photo, pickup and problem columns. While a problem
-- is open the helper still sees both flats and phones.
drop function public.my_delivery_jobs(uuid);
create function public.my_delivery_jobs(p_society_id uuid)
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
  drop_phone text,
  proof_path text,
  pickup_confirmed_at timestamptz,
  received_at timestamptz,
  problem_at timestamptz,
  helper_reconfirmed_at timestamptz,
  problem_outcome text
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
         case when live then pt.flat end, case when live then pt.phone end,
         d.proof_path, d.pickup_confirmed_at, d.received_at, d.problem_at, d.helper_reconfirmed_at, d.problem_outcome
  from public.deliveries d
  cross join lateral (select d.status = 'claimed' or (d.problem_at is not null and d.problem_outcome is null) as live) s
  join public.listings l on l.id = d.listing_id
  left join public.requests r on r.listing_id = l.id and r.status = 'accepted'
  left join public.profiles po on po.user_id = l.owner_id
  left join public.profiles pt on pt.user_id = r.requester_id
  where d.society_id = p_society_id
    and d.helper_id = auth.uid()
    and public.is_member(p_society_id)
    and (d.status = 'claimed' or d.updated_at > now() - interval '7 days'
         or (d.problem_at is not null and (d.problem_outcome is null or d.problem_resolved_at > now() - interval '7 days')))
  order by (d.problem_at is not null and d.problem_outcome is null) desc, (d.status = 'claimed') desc, d.slot_start
$$;

-- ----------------------------------------------------------- get_delivery
-- As in 20261107090000, plus the helper's name and tower whenever a helper has
-- it, the photo and the confirmations.
drop function public.get_delivery(uuid);
create function public.get_delivery(p_listing_id uuid)
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
  updated_at timestamptz,
  fee_inr integer,
  fee_status text,
  fee_ref text,
  fee_i_pay boolean,
  fee_upi_id text,
  fee_payee_name text,
  fee_upi_business boolean,
  fee_merchant_code text,
  fee_via_seller boolean,
  proof_path text,
  pickup_confirmed_at timestamptz,
  received_at timestamptz,
  problem_at timestamptz,
  helper_reconfirmed_at timestamptz,
  problem_outcome text
)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.mode, d.slot_start, d.slot_end, d.tip_note, d.status,
         h.display_name, h.tower,
         case when d.status = 'claimed' or (d.problem_at is not null and d.problem_outcome is null) then h.phone end,
         d.updated_at,
         d.fee_inr,
         public.delivery_fee_status(d),
         public.delivery_fee_ref(d.id),
         d.fee_payer_id = auth.uid(),
         case when pay.ok then s.fee_upi_id end,
         case when pay.ok then s.fee_payee_name end,
         case when pay.ok then s.fee_upi_business end,
         case when pay.ok then s.fee_merchant_code end,
         d.fee_payer_id is not null and d.fee_payer_id = l.owner_id,
         d.proof_path, d.pickup_confirmed_at, d.received_at, d.problem_at, d.helper_reconfirmed_at, d.problem_outcome
  from public.deliveries d
  join public.listings l on l.id = d.listing_id
  cross join lateral (
    select d.fee_payer_id = auth.uid() and public.delivery_fee_status(d) in ('due', 'marked') as ok
  ) pay
  left join public.profiles h on h.user_id = d.helper_id and d.status in ('claimed', 'delivered')
  left join public.platform_settings s on s.id
  where d.listing_id = p_listing_id
    and d.status in ('open', 'claimed', 'delivered')
    and public.is_delivery_party(p_listing_id)
  order by (d.status in ('open', 'claimed')) desc, d.updated_at desc
  limit 1
$$;

-- --------------------------------------------------------- notifications
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check check (kind in
  ('request_new', 'request_accepted', 'request_declined', 'delivery_claimed', 'delivered',
   'delivery_problem', 'delivery_problem_resolved'));

-- --------------------------------------------------------------- grants
revoke execute on function
  public.delivery_of_proof_path(text),
  public.can_upload_delivery_proof(text),
  public.can_read_delivery_proof(text),
  public.mark_delivered(uuid, text),
  public.confirm_pickup(uuid),
  public.confirm_received(uuid, boolean),
  public.delivery_problem_contacts(uuid),
  public.helper_reconfirm_delivery(uuid),
  public.resolve_delivery_problem(uuid, text),
  public.society_delivery_problems(uuid),
  public.my_delivery_jobs(uuid),
  public.get_delivery(uuid)
from public, anon;
-- The storage policies call these as the signed-in person.
grant execute on function
  public.can_upload_delivery_proof(text),
  public.can_read_delivery_proof(text),
  public.mark_delivered(uuid, text),
  public.confirm_pickup(uuid),
  public.confirm_received(uuid, boolean),
  public.delivery_problem_contacts(uuid),
  public.helper_reconfirm_delivery(uuid),
  public.resolve_delivery_problem(uuid, text),
  public.society_delivery_problems(uuid),
  public.my_delivery_jobs(uuid),
  public.get_delivery(uuid)
to authenticated;
revoke execute on function public.delivery_of_proof_path(text) from authenticated;
