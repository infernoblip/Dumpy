-- Business UPI ID for the Dumpy delivery fee.
--
-- Google Pay refuses payment links (upi://pay with the amount filled in) that
-- pay a personal UPI ID. A business (merchant) UPI ID, such as one from the
-- PhonePe Business app, is allowed. When the platform admin marks the fee UPI
-- ID as a business one, the fee box opens the taker's UPI app with the amount
-- and the reference filled in, in one tap. A personal UPI ID keeps the
-- copy-and-paste steps.
--
-- Changes the delivery fee migration (20261025140000):
--   * platform_settings gets fee_upi_business and fee_merchant_code (the
--     4-digit merchant category code from the business QR code, optional)
--   * platform_fee_settings, platform_set_fee_settings and get_delivery are
--     replaced to read and write them

alter table public.platform_settings
  add column fee_upi_business boolean not null default false,
  add column fee_merchant_code text check (fee_merchant_code ~ '^[0-9]{4}$');

-- ------------------------------------------------- platform: the settings
drop function public.platform_fee_settings();
create function public.platform_fee_settings()
returns table (delivery_fee_inr integer, fee_upi_id text, fee_payee_name text, updated_at timestamptz,
               fee_upi_business boolean, fee_merchant_code text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Only the people who run Dumpy can see this' using errcode = '42501';
  end if;
  return query select s.delivery_fee_inr, s.fee_upi_id, s.fee_payee_name, s.updated_at,
                      s.fee_upi_business, s.fee_merchant_code
               from public.platform_settings s where s.id;
end
$$;

drop function public.platform_set_fee_settings(integer, text, text);
create function public.platform_set_fee_settings(
  p_fee integer,
  p_upi_id text,
  p_payee_name text,
  p_business boolean default false,
  p_merchant_code text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _upi text := nullif(btrim(coalesce(p_upi_id, '')), '');
  _name text := coalesce(nullif(btrim(coalesce(p_payee_name, '')), ''), 'Dumpy');
  _mc text := nullif(btrim(coalesce(p_merchant_code, '')), '');
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
  if _mc is not null and _mc !~ '^[0-9]{4}$' then
    raise exception 'The merchant code is 4 digits' using errcode = '22023';
  end if;
  update public.platform_settings
  set delivery_fee_inr = p_fee, fee_upi_id = _upi, fee_payee_name = _name,
      fee_upi_business = coalesce(p_business, false) and _upi is not null,
      fee_merchant_code = case when coalesce(p_business, false) then _mc end,
      updated_at = now()
  where id;
end
$$;

-- ----------------------------------------------------------- get_delivery
-- As in 20261025140000, plus whether the fee UPI ID is a business one and its
-- merchant code (both only for the payer while the fee is due or marked).
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
  fee_merchant_code text
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
         case when pay.ok then s.fee_merchant_code end
  from public.deliveries d
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

-- --------------------------------------------------------------- grants
revoke execute on function
  public.platform_fee_settings(),
  public.platform_set_fee_settings(integer, text, text, boolean, text),
  public.get_delivery(uuid)
from public, anon;
grant execute on function
  public.platform_fee_settings(),
  public.platform_set_fee_settings(integer, text, text, boolean, text),
  public.get_delivery(uuid)
to authenticated;
