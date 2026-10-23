#!/usr/bin/env bash
# Stage 6 race test: the owner presses Accept on two different requests for the
# same item at the same moment (two phones, a double tap). Exactly one must win.
# Real concurrency needs separate database connections, so this runs from the
# shell rather than inside isolation_test.sql. run.sh calls it; it expects the
# migrations to be applied and psql_run-style access via PSQL_ARGS.
set -euo pipefail
PSQL=(psql ${PSQL_ARGS:?} -v ON_ERROR_STOP=1 -qAt)
rounds=${ROUNDS:-25}
soc=7e570000-0000-4000-8000-00000000cccc
owner=7e570000-0000-4000-8000-0000000000c1
asker1=7e570000-0000-4000-8000-0000000000c2
asker2=7e570000-0000-4000-8000-0000000000c3

"${PSQL[@]}" <<SQL
insert into auth.users (id, aud, role, email) values
  ('$owner', 'authenticated', 'authenticated', 'race.owner@example.com'),
  ('$asker1', 'authenticated', 'authenticated', 'race.one@example.com'),
  ('$asker2', 'authenticated', 'authenticated', 'race.two@example.com');
insert into public.societies (id, name, invite_code) values ('$soc', 'Race Society', 'RACECCCC');
insert into public.memberships (user_id, society_id, status) values
  ('$owner', '$soc', 'approved'), ('$asker1', '$soc', 'approved'), ('$asker2', '$soc', 'approved');
insert into public.listings (id, society_id, owner_id, title)
  select ('7e570000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, '$soc', '$owner', 'race item ' || n
  from generate_series(1, $rounds) n;
insert into public.requests (id, listing_id, society_id, requester_id)
  select ('7e570001-000' || k || '-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
         ('7e570000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, '$soc',
         case k when 1 then '$asker1'::uuid else '$asker2'::uuid end
  from generate_series(1, $rounds) n, generate_series(1, 2) k;
SQL

accept() { # request id
  "${PSQL[@]}" -c "begin; set local role authenticated;
    select set_config('request.jwt.claims', '{\"sub\":\"$owner\",\"role\":\"authenticated\"}', true);
    select public.accept_request('$1'); commit;" >/dev/null 2>&1 && echo won || echo lost
}

out="$(mktemp)"
for n in $(seq 1 "$rounds"); do
  id=$(printf '%012d' "$n")
  accept "7e570001-0001-4000-8000-$id" >>"$out" &
  accept "7e570001-0002-4000-8000-$id" >>"$out" &
done
wait

won=$(grep -c won "$out" || true); lost=$(grep -c lost "$out" || true); rm -f "$out"
bad=$("${PSQL[@]}" -c "select count(*) from public.listings l where l.society_id = '$soc' and (l.status <> 'reserved'
  or (select count(*) from public.requests r where r.listing_id = l.id and r.status = 'accepted') <> 1
  or (select count(*) from public.requests r where r.listing_id = l.id and r.status = 'declined') <> 1)")
echo "  $rounds items, two accepts at once on each: $won won, $lost refused, $bad items in a bad state"
"${PSQL[@]}" -c "delete from public.societies where id = '$soc'; delete from auth.users where id in ('$owner', '$asker1', '$asker2');"
if [ "$won" = "$rounds" ] && [ "$lost" = "$rounds" ] && [ "$bad" = 0 ]; then
  echo "  ok - two accepts at the same moment leave exactly one accepted request"
else
  echo "FAIL: two accepts at the same moment did not leave exactly one accepted request"; exit 1
fi
