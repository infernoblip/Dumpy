#!/usr/bin/env bash
# Stage 7 race test: two helpers tap Claim on the same delivery job at the same
# moment. Exactly one must end up holding it. Like concurrent_accept.sh, this
# needs separate database connections; run.sh calls it with PSQL_ARGS set.
set -euo pipefail
PSQL=(psql ${PSQL_ARGS:?} -v ON_ERROR_STOP=1 -qAt)
rounds=${ROUNDS:-25}
soc=7e570000-0000-4000-8000-00000000dddd
owner=7e570000-0000-4000-8000-0000000000d1
taker=7e570000-0000-4000-8000-0000000000d2
help1=7e570000-0000-4000-8000-0000000000d3
help2=7e570000-0000-4000-8000-0000000000d4

"${PSQL[@]}" <<SQL
insert into auth.users (id, aud, role, email) values
  ('$owner', 'authenticated', 'authenticated', 'race.owner@example.com'),
  ('$taker', 'authenticated', 'authenticated', 'race.taker@example.com'),
  ('$help1', 'authenticated', 'authenticated', 'race.helper1@example.com'),
  ('$help2', 'authenticated', 'authenticated', 'race.helper2@example.com');
insert into public.societies (id, name, invite_code) values ('$soc', 'Race Society', 'RACEDDDD');
insert into public.memberships (user_id, society_id, status) values
  ('$owner', '$soc', 'approved'), ('$taker', '$soc', 'approved'),
  ('$help1', '$soc', 'approved'), ('$help2', '$soc', 'approved');
insert into public.delivery_helpers (society_id, user_id) values ('$soc', '$help1'), ('$soc', '$help2');
insert into public.listings (id, society_id, owner_id, title, status)
  select ('7e570000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, '$soc', '$owner', 'race item ' || n, 'reserved'
  from generate_series(1, $rounds) n;
insert into public.requests (listing_id, society_id, requester_id, status)
  select ('7e570000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, '$soc', '$taker', 'accepted'
  from generate_series(1, $rounds) n;
insert into public.deliveries (id, listing_id, society_id, mode, slot_start, slot_end)
  select ('7e570002-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
         ('7e570000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, '$soc', 'helper',
         now() + interval '1 day', now() + interval '1 day 2 hours'
  from generate_series(1, $rounds) n;
SQL

claim() { # helper id, delivery id
  "${PSQL[@]}" -c "begin; set local role authenticated;
    select set_config('request.jwt.claims', '{\"sub\":\"$1\",\"role\":\"authenticated\"}', true);
    select public.claim_delivery('$2'); commit;" >/dev/null 2>&1 && echo won || echo lost
}

out="$(mktemp)"
for n in $(seq 1 "$rounds"); do
  id="7e570002-0000-4000-8000-$(printf '%012d' "$n")"
  claim "$help1" "$id" >>"$out" &
  claim "$help2" "$id" >>"$out" &
done
wait

won=$(grep -c won "$out" || true); lost=$(grep -c lost "$out" || true); rm -f "$out"
bad=$("${PSQL[@]}" -c "select count(*) from public.deliveries where society_id = '$soc'
  and (status <> 'claimed' or helper_id not in ('$help1', '$help2'))")
echo "  $rounds jobs, two claims at once on each: $won won, $lost refused, $bad jobs in a bad state"
"${PSQL[@]}" -c "delete from public.societies where id = '$soc'; delete from auth.users where id in ('$owner', '$taker', '$help1', '$help2');"
if [ "$won" = "$rounds" ] && [ "$lost" = "$rounds" ] && [ "$bad" = 0 ]; then
  echo "  ok - two helpers claiming at the same moment leave exactly one holding the job"
else
  echo "FAIL: two helpers claiming at the same moment did not leave exactly one holding the job"; exit 1
fi
