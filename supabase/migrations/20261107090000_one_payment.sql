-- One payment for the item and the delivery fee.
--
-- Before: after a helper delivery the taker paid the seller for the item and,
-- separately, paid Dumpy's delivery fee to the platform UPI ID.
-- Now: when the item has a price and is not paid for yet at booking time, the
-- taker pays the seller the price plus the fee in one UPI payment, and the
-- seller passes the fee on to Dumpy (same "I've paid" and confirm steps as
-- before, with the seller as the payer). Free items, and items already paid
-- for, keep the old way: the taker pays the fee to Dumpy.
--
-- The seller pays Dumpy first. Until a platform admin confirms the seller's
-- fee arrived (or waives it), the seller cannot be paid through Dumpy:
-- get_contact hides the seller's UPI ID from the taker, and the seller cannot
-- mark the item paid.
--
-- Dumpy still never holds money: both payments go person to person by UPI.
--
-- Changes the delivery fee functions (20261025140000 and 20261026120000):
--   * arrange_delivery picks who pays the fee (the seller or the taker) and
--     refuses a new helper booking while that person owes an earlier fee
--   * get_delivery also returns fee_via_seller
--   * new seller_fee_pending(listing): a helper delivery whose fee the seller
--     pays, and which Dumpy has not confirmed or waived yet
--   * get_contact (stage 6) hides the seller's UPI ID while that is true
--   * set_paid (stage 8) refuses to mark the item paid while that is true
-- No table changes. Run 20261026120000_business_upi.sql first.

-- ------------------------------------------------------- arrange_delivery
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
  _taker uuid;
  _fee integer := 0;
  _payer uuid;
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

  select p.taker_id into _taker from public.delivery_pair(p_listing_id) p;

  if p_mode = 'helper' then
    if _live.id is not null and _live.mode = 'helper' then
      _fee := _live.fee_inr;              -- already booked: keep its fee and who pays it
      _payer := _live.fee_payer_id;
    else
      _fee := public.current_delivery_fee();
      -- A paid item that is not paid for yet: the taker pays the seller the
      -- price and the fee in one payment, and the seller passes the fee on.
      -- Otherwise (a free item, or one already paid for) the taker pays it.
      if _listing.price_inr > 0 and not exists (
        select 1 from public.requests r
        where r.listing_id = p_listing_id and r.status = 'accepted' and r.paid_at is not null
      ) then
        _payer := _listing.owner_id;
      else
        _payer := _taker;
      end if;
      if _fee > 0 and public.has_unpaid_delivery_fee(_payer) then
        if _payer = _listing.owner_id then
          raise exception 'The seller has an unpaid Dumpy delivery fee from an earlier delivery. Once it is paid, a helper can be booked again.'
            using errcode = '55000';
        end if;
        raise exception 'There is an unpaid Dumpy delivery fee from an earlier delivery. Once it is paid, you can book a helper again.'
          using errcode = '55000';
      end if;
    end if;
  end if;

  if _live.id is not null then
    update public.deliveries
    set mode = p_mode, slot_start = p_slot_start, slot_end = p_slot_start + interval '2 hours',
        tip_note = _tip, fee_inr = _fee, fee_payer_id = case when _fee > 0 then _payer end,
        updated_at = now()
    where id = _live.id;
    return _live.id;
  end if;

  insert into public.deliveries (listing_id, society_id, mode, slot_start, slot_end, tip_note, created_by,
                                 fee_inr, fee_payer_id)
  values (p_listing_id, _listing.society_id, p_mode, p_slot_start, p_slot_start + interval '2 hours', _tip, auth.uid(),
          _fee, case when _fee > 0 then _payer end)
  returning id into _id;
  return _id;
end
$$;

-- ----------------------------------------------------------- get_delivery
-- As in 20261026120000, plus fee_via_seller: the fee is paid by the seller,
-- who collects it from the taker together with the item price.
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
  fee_via_seller boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.mode, d.slot_start, d.slot_end, d.tip_note, d.status,
         h.display_name, h.tower,
         case when d.status = 'claimed' then h.phone end,
         d.updated_at,
         d.fee_inr,
         public.delivery_fee_status(d),
         public.delivery_fee_ref(d.id),
         d.fee_payer_id = auth.uid(),
         case when pay.ok then s.fee_upi_id end,
         case when pay.ok then s.fee_payee_name end,
         case when pay.ok then s.fee_upi_business end,
         case when pay.ok then s.fee_merchant_code end,
         d.fee_payer_id is not null and d.fee_payer_id = l.owner_id
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

-- ---------------------------------------------------- seller_fee_pending
create or replace function public.seller_fee_pending(p_listing_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.deliveries d
    join public.listings l on l.id = d.listing_id
    where d.listing_id = p_listing_id
      and d.mode = 'helper' and d.fee_inr > 0
      and d.status in ('open', 'claimed', 'delivered')
      and d.fee_payer_id = l.owner_id
      and public.delivery_fee_status(d) not in ('confirmed', 'waived', 'none')
  )
$$;

-- ------------------------------------------------------------ get_contact
-- As in stage 6, but the seller's UPI ID stays hidden from the taker while the
-- seller still owes Dumpy the delivery fee (seller_fee_pending).
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
         case when p.user_id = pair.owner_id and pair.price_inr > 0
                   and not public.seller_fee_pending(p_listing_id) then p.upi_id end
  from pair
  join public.profiles p
    on p.user_id = case when auth.uid() = pair.owner_id then pair.requester_id else pair.owner_id end
$$;

-- --------------------------------------------------------------- set_paid
-- As in stage 8, but the seller cannot mark the item paid while they still
-- owe Dumpy the delivery fee.
create or replace function public.set_paid(p_listing_id uuid, p_paid boolean)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _listing public.listings;
  _paid_at timestamptz;
begin
  select * into _listing from public.listings where id = p_listing_id for update;

  if _listing.id is null or _listing.owner_id is distinct from auth.uid()
     or not public.is_member(_listing.society_id) then
    raise exception 'Only the item''s owner can do this' using errcode = '42501';
  end if;
  if _listing.price_inr = 0 then
    raise exception 'Free items have nothing to pay' using errcode = '55000';
  end if;
  if _listing.status not in ('reserved', 'done') then
    raise exception 'This item has not been given to anyone yet' using errcode = '55000';
  end if;
  if p_paid and public.seller_fee_pending(p_listing_id) then
    raise exception 'Pay Dumpy''s delivery fee first. Once Dumpy confirms it, the taker can pay you.' using errcode = '55000';
  end if;

  update public.requests
  set paid_at = case when p_paid then coalesce(paid_at, now()) end
  where listing_id = _listing.id and status = 'accepted'
  returning paid_at into _paid_at;

  return _paid_at;
end
$$;

-- --------------------------------------------------------------- grants
revoke execute on function public.get_delivery(uuid), public.get_contact(uuid), public.set_paid(uuid, boolean),
  public.seller_fee_pending(uuid) from public, anon;
grant execute on function public.get_delivery(uuid), public.get_contact(uuid), public.set_paid(uuid, boolean)
  to authenticated;
