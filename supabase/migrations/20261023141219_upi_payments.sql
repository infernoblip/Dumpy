-- Stage 8: paying for cheap items by UPI or cash.
--
-- Dumpy never touches money. The taker pays the owner straight from their own
-- UPI app (or in cash), using the owner's UPI ID that get_contact (stage 6)
-- already hands to the accepted requester of a paid item. The only thing
-- stored is whether the owner has marked the item as paid.
--
-- Change to a stage 2 table: requests gets one column, paid_at. It sits on the
-- accepted request rather than the listing, so only the matched pair can read
-- it (the existing select policies on requests), and a cancelled reservation
-- leaves the next taker starting unpaid.
--
-- Nobody can write paid_at with a plain update (the update grant on requests
-- stays limited to message and status). It changes only through
-- set_paid(listing_id, paid), which only the item's owner may call.

alter table public.requests add column paid_at timestamptz;

comment on column public.requests.paid_at is
  'When the owner marked this accepted request as paid (stage 8). Null = not paid. Nothing else about the payment is stored.';

-- ---------------------------------------------------------------- set_paid
-- Owner only, for a paid item that is reserved or handed over. Marks (or
-- unmarks) the accepted request as paid. Returns the new paid_at.
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

  update public.requests
  set paid_at = case when p_paid then coalesce(paid_at, now()) end
  where listing_id = _listing.id and status = 'accepted'
  returning paid_at into _paid_at;

  return _paid_at;
end
$$;

revoke execute on function public.set_paid(uuid, boolean) from public, anon;
grant execute on function public.set_paid(uuid, boolean) to authenticated;
