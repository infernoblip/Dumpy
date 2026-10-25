-- Delivery fee: how Dumpy earns.
--
-- When a neighbour helper brings an item ("helper" delivery, stage 7), the
-- taker pays Dumpy a small flat fee by UPI to the platform's own UPI ID. Any
-- tip for the helper stays exactly as before: whatever the pair agrees,
-- settled directly with the helper. Owner-delivers and taker-collects stay
-- free.
--
-- Dumpy still never holds money: the taker pays straight from their own UPI
-- app (the stage 8 Pay link and QR, pointed at the platform's UPI ID). The fee
-- is owed only once a helper has actually delivered the item, so a cancelled
-- delivery never needs a refund. The fee is copied onto the delivery when it
-- is booked, so changing the amount later never changes a booked delivery.
--
-- The fee is off until a platform admin sets both an amount and a UPI ID on
-- the Run Dumpy page.
--
-- New table (no society_id: like platform_admins, it belongs to Dumpy itself,
-- not to a society):
--   platform_settings     one row: delivery fee amount, the UPI ID it is
--                         paid to, and the name shown in UPI apps
--
-- Change to a stage 7 table: deliveries gets five fee columns (amount, who
-- pays, when they marked it paid, when a platform admin confirmed it, waived).
-- Changes to stage 7 functions: arrange_delivery copies the fee onto helper
-- deliveries and refuses a new helper booking while the taker has an unpaid
-- fee; get_delivery returns the fee details.
--
-- New functions:
--   delivery_fee()                         anyone signed in: today's fee (0 = off)
--   mark_delivery_fee_paid(delivery)       the taker: "I've paid"
--   platform_fee_settings()                platform admin: read the settings
--   platform_set_fee_settings(fee, upi, name)  platform admin: change them
--   platform_delivery_fees()               platform admin: the fee ledger
--   platform_delivery_fee_totals()         platform admin: sums by state
--   platform_settle_delivery_fee(delivery, action)
--                                          platform admin: confirm received,
--                                          mark not received, or waive

-- ------------------------------------------------------- platform settings
create table public.platform_settings (
  id boolean primary key default true check (id),
  delivery_fee_inr integer not null default 0 check (delivery_fee_inr between 0 and 500),
  fee_upi_id text check (fee_upi_id ~ '^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9.]{1,63}$'),
  fee_payee_name text not null default 'Dumpy' check (char_length(fee_payee_name) between 1 and 50),
  updated_at timestamptz not null default now()
);
insert into public.platform_settings (id) values (true);
-- Nobody reads or writes this table from the website; the functions below do.
revoke all on table public.platform_settings from anon, authenticated;
alter table public.platform_settings enable row level security;

-- ----------------------------------------------------- deliveries: the fee
alter table public.deliveries
  add column fee_inr integer not null default 0 check (fee_inr between 0 and 500),
  add column fee_payer_id uuid references auth.users (id) on delete set null,
  add column fee_marked_paid_at timestamptz,
  add column fee_confirmed_at timestamptz,
  add column fee_waived boolean not null default false,
  add constraint deliveries_fee_helper_only check (mode = 'helper' or fee_inr = 0);

comment on column public.deliveries.fee_inr is
  'Dumpy''s delivery fee for this helper delivery, copied from platform_settings when booked. 0 = no fee.';

create index deliveries_fee_payer_idx on public.deliveries (fee_payer_id) where fee_inr > 0;

-- Where a delivery's fee stands:
--   none       no fee (not a helper delivery, fee was off, or no helper did it)
--   upcoming   booked, not delivered yet: nothing to pay yet
--   due        delivered by a helper, not paid
--   marked     the taker says they paid; waiting for a platform admin to check
--   confirmed  a platform admin saw the money arrive
--   waived     a platform admin let it go
create or replace function public.delivery_fee_status(p public.deliveries)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p.fee_inr = 0 or p.mode <> 'helper' then 'none'
    when p.status in ('open', 'claimed') then 'upcoming'
    when p.status <> 'delivered' or p.helper_id is null then 'none'
    when p.fee_waived then 'waived'
    when p.fee_confirmed_at is not null then 'confirmed'
    when p.fee_marked_paid_at is not null then 'marked'
    else 'due'
  end
$$;

-- A short code for the fee, put in the UPI payment note so the platform admin
-- can match money in their bank app to the delivery.
create or replace function public.delivery_fee_ref(p_delivery_id uuid)
returns text
language sql
immutable
set search_path = ''
as $$
  select 'DLV-' || upper(left(replace(p_delivery_id::text, '-', ''), 6))
$$;

-- Today's fee: the amount, but only once a UPI ID is set to receive it.
create or replace function public.current_delivery_fee()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select case when s.fee_upi_id is not null then s.delivery_fee_inr else 0 end
                   from public.platform_settings s where s.id), 0)
$$;

-- For the delivery form: the fee a helper delivery booked now would carry.
create or replace function public.delivery_fee()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select public.current_delivery_fee()
$$;

-- True when this person has a delivered fee they have not paid (or marked paid).
create or replace function public.has_unpaid_delivery_fee(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.deliveries d
    where d.fee_payer_id = p_user_id and d.fee_inr > 0
      and public.delivery_fee_status(d) = 'due'
  )
$$;

-- ------------------------------------------------------- arrange_delivery
-- As in stage 7, plus: a helper delivery carries today's fee, paid by the
-- taker. Changing an already-booked helper delivery keeps the fee it was
-- booked with. A new helper booking is refused while the taker still owes a
-- fee from an earlier delivery.
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
      _fee := _live.fee_inr;              -- already booked: keep its fee
    else
      _fee := public.current_delivery_fee();
      if _fee > 0 and public.has_unpaid_delivery_fee(_taker) then
        raise exception 'There is an unpaid Dumpy delivery fee from an earlier delivery. Once it is paid, you can book a helper again.'
          using errcode = '55000';
      end if;
    end if;
  end if;

  if _live.id is not null then
    update public.deliveries
    set mode = p_mode, slot_start = p_slot_start, slot_end = p_slot_start + interval '2 hours',
        tip_note = _tip, fee_inr = _fee, fee_payer_id = case when _fee > 0 then _taker end,
        updated_at = now()
    where id = _live.id;
    return _live.id;
  end if;

  insert into public.deliveries (listing_id, society_id, mode, slot_start, slot_end, tip_note, created_by,
                                 fee_inr, fee_payer_id)
  values (p_listing_id, _listing.society_id, p_mode, p_slot_start, p_slot_start + interval '2 hours', _tip, auth.uid(),
          _fee, case when _fee > 0 then _taker end)
  returning id into _id;
  return _id;
end
$$;

-- ----------------------------------------------------------- get_delivery
-- As in stage 7, plus the fee. The UPI ID to pay it to is given only to the
-- person who pays, while it is due or marked paid.
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
  fee_payee_name text
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
         case when d.fee_payer_id = auth.uid() and public.delivery_fee_status(d) in ('due', 'marked')
              then s.fee_upi_id end,
         case when d.fee_payer_id = auth.uid() and public.delivery_fee_status(d) in ('due', 'marked')
              then s.fee_payee_name end
  from public.deliveries d
  left join public.profiles h on h.user_id = d.helper_id and d.status in ('claimed', 'delivered')
  left join public.platform_settings s on s.id
  where d.listing_id = p_listing_id
    and d.status in ('open', 'claimed', 'delivered')
    and public.is_delivery_party(p_listing_id)
  order by (d.status in ('open', 'claimed')) desc, d.updated_at desc
  limit 1
$$;

-- ------------------------------------------------- mark_delivery_fee_paid
-- The taker says they paid the fee. A platform admin confirms it later, after
-- checking their UPI app. Marking does not touch updated_at, which stage 7
-- uses for the order of deliveries.
create or replace function public.mark_delivery_fee_paid(p_delivery_id uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _d public.deliveries;
begin
  select * into _d from public.deliveries where id = p_delivery_id for update;
  if _d.id is null or _d.fee_payer_id is distinct from auth.uid() or not public.is_member(_d.society_id) then
    raise exception 'Only the person who pays this fee can mark it paid' using errcode = '42501';
  end if;
  if public.delivery_fee_status(_d) = 'marked' then
    return _d.fee_marked_paid_at;
  end if;
  if public.delivery_fee_status(_d) <> 'due' then
    raise exception 'This fee has nothing to pay right now' using errcode = '55000';
  end if;
  update public.deliveries set fee_marked_paid_at = now() where id = _d.id
  returning fee_marked_paid_at into _d.fee_marked_paid_at;
  return _d.fee_marked_paid_at;
end
$$;

-- ------------------------------------------------- platform: the settings
create or replace function public.platform_fee_settings()
returns table (delivery_fee_inr integer, fee_upi_id text, fee_payee_name text, updated_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Only the people who run Dumpy can see this' using errcode = '42501';
  end if;
  return query select s.delivery_fee_inr, s.fee_upi_id, s.fee_payee_name, s.updated_at
               from public.platform_settings s where s.id;
end
$$;

create or replace function public.platform_set_fee_settings(p_fee integer, p_upi_id text, p_payee_name text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _upi text := nullif(btrim(coalesce(p_upi_id, '')), '');
  _name text := coalesce(nullif(btrim(coalesce(p_payee_name, '')), ''), 'Dumpy');
begin
  if not public.is_platform_admin() then
    raise exception 'Only the people who run Dumpy can change this' using errcode = '42501';
  end if;
  if p_fee is null or p_fee < 0 or p_fee > 500 then
    raise exception 'The fee is a whole number of rupees from 0 to 500' using errcode = '22023';
  end if;
  if _upi is not null and _upi !~ '^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9.]{1,63}$' then
    raise exception 'That does not look like a UPI ID (name@bank)' using errcode = '22023';
  end if;
  if p_fee > 0 and _upi is null then
    raise exception 'Add the UPI ID the fee is paid to' using errcode = '22023';
  end if;
  if char_length(_name) > 50 then
    raise exception 'Keep the name under 50 characters' using errcode = '22023';
  end if;
  update public.platform_settings
  set delivery_fee_inr = p_fee, fee_upi_id = _upi, fee_payee_name = _name, updated_at = now()
  where id;
end
$$;

-- ---------------------------------------------------- platform: the ledger
-- Every helper delivery that was delivered with a fee, newest first, with
-- "marked paid" ones (waiting to be checked) on top. Names only: no flats or
-- phones.
create or replace function public.platform_delivery_fees(p_limit integer default 100)
returns table (
  id uuid,
  fee_ref text,
  society_name text,
  title text,
  payer_name text,
  helper_name text,
  fee_inr integer,
  fee_status text,
  delivered_at timestamptz,
  fee_marked_paid_at timestamptz,
  fee_confirmed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Only the people who run Dumpy can see this' using errcode = '42501';
  end if;
  return query
  select d.id, public.delivery_fee_ref(d.id), so.name, l.title, pp.display_name, ph.display_name,
         d.fee_inr, public.delivery_fee_status(d), d.updated_at, d.fee_marked_paid_at, d.fee_confirmed_at
  from public.deliveries d
  join public.societies so on so.id = d.society_id
  join public.listings l on l.id = d.listing_id
  left join public.profiles pp on pp.user_id = d.fee_payer_id
  left join public.profiles ph on ph.user_id = d.helper_id
  where d.fee_inr > 0 and public.delivery_fee_status(d) in ('due', 'marked', 'confirmed', 'waived')
  order by case public.delivery_fee_status(d) when 'marked' then 0 when 'due' then 1 else 2 end,
           d.updated_at desc
  limit greatest(1, least(coalesce(p_limit, 100), 500));
end
$$;

create or replace function public.platform_delivery_fee_totals()
returns table (due_inr bigint, marked_inr bigint, confirmed_inr bigint, waived_inr bigint, upcoming_inr bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Only the people who run Dumpy can see this' using errcode = '42501';
  end if;
  return query
  select coalesce(sum(d.fee_inr) filter (where s.st = 'due'), 0)::bigint,
         coalesce(sum(d.fee_inr) filter (where s.st = 'marked'), 0)::bigint,
         coalesce(sum(d.fee_inr) filter (where s.st = 'confirmed'), 0)::bigint,
         coalesce(sum(d.fee_inr) filter (where s.st = 'waived'), 0)::bigint,
         coalesce(sum(d.fee_inr) filter (where s.st = 'upcoming'), 0)::bigint
  from public.deliveries d
  cross join lateral (select public.delivery_fee_status(d) as st) s
  where d.fee_inr > 0;
end
$$;

-- confirm   the money arrived
-- unpaid    it did not arrive: back to due (the taker sees Pay again)
-- waive     let it go
create or replace function public.platform_settle_delivery_fee(p_delivery_id uuid, p_action text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _d public.deliveries;
begin
  if not public.is_platform_admin() then
    raise exception 'Only the people who run Dumpy can do this' using errcode = '42501';
  end if;
  select * into _d from public.deliveries where id = p_delivery_id for update;
  if _d.id is null or public.delivery_fee_status(_d) not in ('due', 'marked', 'confirmed', 'waived') then
    raise exception 'This delivery has no fee to settle' using errcode = '55000';
  end if;
  if p_action = 'confirm' then
    update public.deliveries
    set fee_marked_paid_at = coalesce(fee_marked_paid_at, now()), fee_confirmed_at = now(), fee_waived = false
    where id = _d.id returning * into _d;
  elsif p_action = 'unpaid' then
    update public.deliveries
    set fee_marked_paid_at = null, fee_confirmed_at = null, fee_waived = false
    where id = _d.id returning * into _d;
  elsif p_action = 'waive' then
    update public.deliveries set fee_waived = true where id = _d.id returning * into _d;
  else
    raise exception 'Choose confirm, unpaid or waive' using errcode = '22023';
  end if;
  return public.delivery_fee_status(_d);
end
$$;

-- --------------------------------------------------------------- grants
revoke execute on function
  public.delivery_fee_status(public.deliveries),
  public.delivery_fee_ref(uuid),
  public.current_delivery_fee(),
  public.delivery_fee(),
  public.has_unpaid_delivery_fee(uuid),
  public.get_delivery(uuid),
  public.mark_delivery_fee_paid(uuid),
  public.platform_fee_settings(),
  public.platform_set_fee_settings(integer, text, text),
  public.platform_delivery_fees(integer),
  public.platform_delivery_fee_totals(),
  public.platform_settle_delivery_fee(uuid, text)
from public, anon;

grant execute on function
  public.delivery_fee(),
  public.get_delivery(uuid),
  public.mark_delivery_fee_paid(uuid),
  public.platform_fee_settings(),
  public.platform_set_fee_settings(integer, text, text),
  public.platform_delivery_fees(integer),
  public.platform_delivery_fee_totals(),
  public.platform_settle_delivery_fee(uuid, text)
to authenticated;
-- Only the functions above use these. Supabase's default privileges grant
-- execute to authenticated, so take it back. (delivery_fee_status and
-- delivery_fee_ref only read their argument, but there is no need to expose
-- them; has_unpaid_delivery_fee would say whether someone owes a fee.)
revoke execute on function
  public.current_delivery_fee(),
  public.has_unpaid_delivery_fee(uuid)
from authenticated;
grant execute on function public.delivery_fee_status(public.deliveries), public.delivery_fee_ref(uuid) to authenticated;
