#!/usr/bin/env bash
# Runs the browser tests on this computer, with no Supabase account:
#   * a throwaway Postgres with the migrations (as in supabase/tests/local)
#   * PostgREST in front of it, standing in for Supabase's database API
#   * the site served by python3 -m http.server
#   * Playwright, which sends the pages' Supabase calls to the local copy and
#     fakes the email step (the test "clicks" a sign-in link it makes itself)
#
# Needs: Postgres 15+ binaries, Node.js 18+, python3, curl, and Playwright with
# Chromium (npm i -g playwright && npx playwright install chromium).
# Optional: PLAYWRIGHT_MODULE (path to the playwright package), CHROMIUM_PATH.
#   bash tests/browser/run.sh            (all tests: stages 4, 5, 6, 8 and 9)
#   bash tests/browser/run.sh post.js    (just one)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
PG_BIN="${PG_BIN:-$(dirname "$(command -v initdb 2>/dev/null || ls -d /usr/lib/postgresql/*/bin/initdb | tail -1)")}"
SUPABASE_JS_VERSION="$(grep -o 'supabase-js@[0-9.]*' "$root/index.html" | head -1 | cut -d@ -f2)"
POSTGREST_VERSION=12.2.3
work="$(mktemp -d)"
data="$work/pg"
pgport=54339
run_as=()
if [ "$(id -u)" = 0 ]; then run_as=(sudo -u postgres); fi

pids=()
cleanup() {
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  "${run_as[@]}" "$PG_BIN/pg_ctl" -D "$data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

echo "== downloading supabase-js $SUPABASE_JS_VERSION and PostgREST $POSTGREST_VERSION"
(cd "$work" && npm pack -q "@supabase/supabase-js@$SUPABASE_JS_VERSION" >/dev/null && tar xzf supabase-supabase-js-*.tgz)
# Other libraries the pages load from jsdelivr, at the versions they pin.
for spec in $(grep -ho 'cdn.jsdelivr.net/npm/[^"]*' "$root"/index.html "$root"/pages/*.html | grep -v supabase-js | cut -d/ -f3 | sort -u); do
  mkdir -p "$work/npm/$spec" && (cd "$work/npm/$spec" && npm pack -q "$spec" >/dev/null && tar xzf *.tgz)
done
curl -sSL "https://github.com/PostgREST/postgrest/releases/download/v$POSTGREST_VERSION/postgrest-v$POSTGREST_VERSION-linux-static-x64.tar.xz" | tar xJ -C "$work"

echo "== database"
mkdir -p "$data"; [ "$(id -u)" = 0 ] && chown -R postgres "$work"
"${run_as[@]}" "$PG_BIN/initdb" -D "$data" -U postgres --auth=trust >/dev/null
"${run_as[@]}" "$PG_BIN/pg_ctl" -D "$data" -l "$work/pg.log" -o "-p $pgport -k /tmp -c listen_addresses=127.0.0.1" -w start >/dev/null
q() { psql -h /tmp -p "$pgport" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
q -f "$root/supabase/tests/local/supabase-shim.sql"
for f in "$root"/supabase/migrations/*.sql; do q -f "$f"; done
q -c "create role authenticator login noinherit password 'pw'; grant anon, authenticated to authenticator;"
q -f "$here/fixtures.sql"

echo "== PostgREST on :3000"
cat > "$work/pgrst.conf" <<CONF
db-uri = "postgres://authenticator:pw@127.0.0.1:$pgport/postgres"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "local-test-secret-local-test-secret-0123"
server-port = 3000
CONF
"$work/postgrest" "$work/pgrst.conf" > "$work/pgrst.log" 2>&1 & pids+=($!)

echo "== site on :8000"
(cd "$root" && exec python3 -m http.server 8000 > "$work/http.log" 2>&1) & pids+=($!)
for i in $(seq 1 20); do
  curl -sf -o /dev/null localhost:3000/ && curl -sf -o /dev/null localhost:8000/ && break
  sleep 1
done

tests=("$@")
[ ${#tests[@]} -eq 0 ] && tests=(e2e.js post.js request.js pay.js notify.js)
for t in "${tests[@]}"; do
  echo "== browser test: $t"
  WORK_DIR="$work" PG_PORT="$pgport" node "$here/$t"
done
