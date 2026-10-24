#!/usr/bin/env bash
# Runs the migrations, the seed and the isolation tests on a throwaway plain
# Postgres, with supabase-shim.sql standing in for Supabase's auth and storage.
# Useful when Docker (and so `supabase start`) is not available.
#
# Needs Postgres 15+ binaries (initdb, pg_ctl, psql) on PATH or in PG_BIN.
#   bash supabase/tests/local/run.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"   # the supabase/ folder
PG_BIN="${PG_BIN:-$(dirname "$(command -v initdb 2>/dev/null || ls -d /usr/lib/postgresql/*/bin/initdb | tail -1)")}"
data="$(mktemp -d)"
port="${PGPORT_TEST:-54329}"
run_as=()
if [ "$(id -u)" = 0 ]; then
  chown -R postgres "$data"
  run_as=(sudo -u postgres)
fi

cleanup() { "${run_as[@]}" "$PG_BIN/pg_ctl" -D "$data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$data"; }
trap cleanup EXIT

"${run_as[@]}" "$PG_BIN/initdb" -D "$data" -U postgres --auth=trust >/dev/null
"${run_as[@]}" "$PG_BIN/pg_ctl" -D "$data" -o "-p $port -k /tmp -c listen_addresses=''" -w start >/dev/null

psql_run() { psql -h /tmp -p "$port" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }

echo "== shim";       psql_run -f "$here/supabase-shim.sql"
for f in "$root"/migrations/*.sql; do
  echo "== migration $(basename "$f")"; psql_run -f "$f"
done
echo "== seed";       psql_run -f "$root/seed.sql"
echo "== seed check"; psql_run -At -c "select 'societies=' || count(*) from public.societies; select 'listings=' || count(*) from public.listings;"
echo "== isolation tests"
psql_run -At -f "$root/tests/isolation_test.sql" 2>&1 | sed 's/^psql:[^:]*:[0-9]*: NOTICE:  /  /' | grep -v '^$'
echo "== delivery tests"
psql_run -At -f "$root/tests/delivery_test.sql" 2>&1 | sed 's/^psql:[^:]*:[0-9]*: NOTICE:  /  /' | grep -v '^$'
echo "== payment tests"
psql_run -At -f "$root/tests/payments_test.sql" 2>&1 | sed 's/^psql:[^:]*:[0-9]*: NOTICE:  /  /' | grep -v '^$'
echo "== notification tests"
psql_run -At -f "$root/tests/notifications_test.sql" 2>&1 | sed 's/^psql:[^:]*:[0-9]*: NOTICE:  /  /' | grep -v '^$'
echo "== moderation tests"
psql_run -At -f "$root/tests/moderation_test.sql" 2>&1 | sed 's/^psql:[^:]*:[0-9]*: NOTICE:  /  /' | grep -v '^$'
echo "== society tests"
psql_run -At -f "$root/tests/societies_test.sql" 2>&1 | sed 's/^psql:[^:]*:[0-9]*: NOTICE:  /  /' | grep -v '^$'
echo "== concurrent accept test"
PSQL_ARGS="-h /tmp -p $port -U postgres -d postgres" bash "$here/concurrent_accept.sh"
echo "== concurrent claim test"
PSQL_ARGS="-h /tmp -p $port -U postgres -d postgres" bash "$here/concurrent_claim.sh"
