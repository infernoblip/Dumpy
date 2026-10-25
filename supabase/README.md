# Dumpy database

Everything the website stores lives in Supabase Postgres, guarded by
row-level security. The website only ever uses the public publishable/anon
key, so **these rules are the only thing standing between residents and each
other's data**. Read this before writing code that talks to Supabase.

Setup steps for the real project are in [docs/supabase-setup.md](../docs/supabase-setup.md).

## Live project

- Supabase project **dumpy-mumbai**, region Mumbai (`ap-south-1`), ref `sfezmqsdzwrjdcqpyhln`
- Project URL: `https://sfezmqsdzwrjdcqpyhln.supabase.co`
- Publishable key (public, safe in page code): `sb_publishable_5V49nQQ2FYSsdRDt8kR6iQ_688LWupD`
- Claude manages it through the Supabase connector (MCP). Migrations applied that way are stamped with the time they ran, so **name each migration file with the version the project records** (`list_migrations`), or the CLI's `db push` will try to run it again.
- The security advisor warns that signed-in users can call the `SECURITY DEFINER` helpers (`is_member`, `join_society`, `my_memberships`, ...). That's intended: each one only answers about the caller (`auth.uid()`).

## Files

```
migrations/            Schema, functions and rules, applied oldest first
seed.sql               Demo Society, two demo people, five demo items
snippets/              One-off SQL for the dashboard (create-society.sql, make-platform-admin.sql, remove-demo-data.sql)
tests/isolation_test.sql   Proves the rules (runs in one transaction, rolled back)
tests/delivery_test.sql    Proves the stage 7 delivery rules (same way)
tests/delivery_fee_test.sql  Proves the delivery fee rules (same way)
tests/payments_test.sql    Stage 8 payment rules, same way
tests/notifications_test.sql   Proves who gets which email (stage 9, rolled back)
tests/societies_test.sql   New societies and nearby sharing (stage 12, rolled back)
functions/send-email/  Edge Function that sends notification emails (stage 9)
tests/local/           Runs everything on plain Postgres without Docker
config.toml            Local Supabase CLI settings (not used by the live project)
```

## Tables

Every row belongs to a society, directly (`society_id`) or through its
listing. `profiles` is per person, because one person can belong to several
societies.

| Table | What it holds | Who can read | Who can change |
|---|---|---|---|
| `societies` | name, `invite_code`, `city`, private `link_code` | approved members (not `link_code`: use `society_link_code`) | admins: name, invite code |
| `society_requests` | someone asking to start Dumpy in their society: name, city, their email, status pending/approved/rejected, note (stage 12) | the asker | only through the functions below; the asker can withdraw a pending one |
| `platform_admins` | the people who run Dumpy and approve new societies (stage 12) | nobody (use `is_platform_admin()`) | only by hand in the dashboard (`snippets/make-platform-admin.sql`) |
| `society_links` | society A agreed to share nearby items with society B; sharing is on only when both rows exist (stage 12) | nobody (use `nearby_societies`) | only through the link functions |
| `memberships` | person, society, `role` member/admin, `status` pending/approved/suspended | yourself; admins of that society | admins (not their own row); you can leave unless suspended |
| `profiles` | `display_name`, `tower`, and private `flat`, `phone`, `upi_id`, `email_notifications` | name and tower: neighbours in an approved society, and admins of a society you asked to join | yourself |
| `listings` | title, description, category, condition, `price_inr` (0 = Free), status, `expires_at`, `visibility` society/nearby (stage 12) | approved members: available, reserved, done; also the owner and admins: withdrawn, expired, hidden; members of a linked society: available `nearby` items only | owner (cannot hide, cannot edit a hidden item); admins |
| `listing_photos` | `storage_path`, `position` | anyone who can see the listing | listing owner |
| `requests` | requester, message, status, `paid_at` (stage 8: owner marked it paid) | requester; listing owner | requester: edit message or cancel while pending; owner: decline |
| `notifications` | one row per email: recipient, `kind`, item, `status` pending/sending/sent/failed/skipped (stage 9) | nobody on the website | only the database's triggers and the `send-email` function |
| `reports` | item, reporter, `reason` not_allowed/spam/offensive/other, optional `note`, `status` open/actioned/dismissed | the reporter; admins of that society (never the item's owner) | members: file one report per item on someone else's available or reserved item; admins: close through `resolve_reports` |

Nothing is ever deleted from the website except photos and memberships.
Listings are withdrawn, requests are cancelled or declined.

Signed-out visitors (`anon`) can read and call nothing.

### Allowed values

- `listings.category`: `furniture`, `electronics`, `kitchen`, `books`, `clothes`, `kids`, `other`
- `listings.condition`: `like_new`, `good`, `used`, `for_parts`
- `listings.status`: `available`, `reserved`, `done`, `withdrawn`, `hidden`, `expired`
- `requests.status`: `pending`, `accepted`, `declined`, `cancelled`

Show them to people with friendly labels ("Like new", "For parts"); store the values above.

## Private fields: flat, phone, UPI ID

`profiles.flat`, `profiles.phone` and `profiles.upi_id` have **no select
permission at all**, not even for the person they belong to. So:

- `supabase.from('profiles').select('*')` fails. Always list columns:
  `.select('user_id, display_name, tower')`.
- After an insert or update on `profiles`, don't ask for the row back with
  `.select()` unless you list only public columns.
- Your own full profile: `supabase.rpc('get_my_profile')`.
- Admin page: `supabase.rpc('admin_list_members', { p_society_id })` returns
  name, tower, flat, role and status for everyone in the society, and nothing
  for non-admins.
- The matched pair's contact details: `supabase.rpc('get_contact', { p_listing_id })`.

## Functions the website calls

| Function | Use |
|---|---|
| `my_memberships()` | Your own memberships with each society's name, including ones still pending (stage 4; the page guard calls it on every page) |
| `join_society(p_invite_code)` | Creates a pending membership. Returns `society_id, status`. Wrong code raises an error. Case and spaces don't matter. |
| `get_my_profile()` | Your own profile with private fields |
| `admin_list_members(p_society_id)` | Admin page member list |
| `is_member(society_id)`, `is_admin(society_id)` | True for the signed-in person's approved membership; mainly for policies |
| `accept_request(p_request_id)` | Owner only, item must be available: accepts that request, declines the other pending ones, sets the item to `reserved`. Locks the item first, so two accepts at once leave exactly one winner (stage 6) |
| `mark_handed_over(p_listing_id)` | Owner only: `reserved` to `done` (stage 6) |
| `cancel_reservation(p_listing_id)` | Owner only: `reserved` to `available`; the accepted request becomes `cancelled` and the declined ones `pending` again (stage 6) |
| `resolve_reports(p_listing_id, p_hide)` | Admin of the item's society only. `p_hide` true hides the item and marks its open reports `actioned`; false marks them `dismissed` and leaves the item up (stage 10) |
| `renew_listing(p_listing_id)` | Owner only: an `expired` or `withdrawn` item goes back to `available` for 30 more days, dated by the database clock (stage 10) |
| `get_contact(p_listing_id)` | The other person's name, tower, flat and phone, for the owner and the accepted requester of a reserved or handed-over item; nobody else gets a row. `upi_id` is filled only when the other person is the owner of a paid item (stage 8 uses it) |
| `set_paid(p_listing_id, p_paid)` | Owner only, paid item that is reserved or handed over: marks the accepted request paid (`requests.paid_at`) or not. Returns the new `paid_at`. Nothing else about a payment is stored (stage 8) |

### More societies (stage 12)

| Function | Use |
|---|---|
| `request_society(p_name, p_city)` | Signed in with a profile: ask to start Dumpy in a society. Stores the sign-in email. At most 3 waiting per person |
| `is_platform_admin()` | True for the people who run Dumpy |
| `platform_society_requests()`, `platform_societies()` | Platform admins only: every request (with the asker's name), every society (name, city) |
| `approve_society_request(p_request_id)` | Platform admin: creates the society with a fresh invite code and makes the asker its approved admin. Returns `society_id, invite_code` |
| `reject_society_request(p_request_id, p_note)` | Platform admin: turns it down; the asker sees the note |
| `society_link_code(p_society_id)` | Admin: the code to give a nearby society's admin. It links societies, never lets anyone join |
| `link_society(p_society_id, p_link_code)` | Admin: ask to share with that society (or agree, if they asked first) |
| `accept_society_link(p_society_id, p_other_id)` | Admin: agree to a society that asked |
| `unlink_society(p_society_id, p_other_id)` | Admin: stop sharing, decline, or withdraw. Removes both directions |
| `nearby_societies(p_society_id)` | Members: linked societies (`linked`); admins also see `asked` and `asking` |

A member of a linked society sees, through row-level security, only listings
with `visibility = 'nearby'` that are available and in date, plus their photo
rows and files. Nothing else crosses: not memberships, profiles, requests,
reports, deliveries or contacts, and they cannot request, report or edit those
items. Pick the society with `Dumpy.chooseSociety(id)` (the Profile switcher);
every page uses `Dumpy.state.society`.

### Moderation and expiry (stage 10)

- Suspending is a plain update of `memberships.status` to `suspended` (and back to `approved`) by an admin. Every rule calls `is_member()`, which only counts approved members, so a suspended person sees nothing straight away.
- `expires_at` is capped at 30 days from now for anything the website writes.
- `expire_old_listings()` marks available items `expired` once `expires_at` has passed. pg_cron runs it every hour as job `dumpy-expire-listings`. Only the database itself may call it.
- `tests/moderation_test.sql` proves these rules; run it like `isolation_test.sql`.

Asking for an item is a plain insert into `requests` (one per person per
item; only available items posted by someone else). Moving an item into or
out of `reserved` or `done` is **not** a plain update: a trigger refuses it,
so the item's status and its accepted request always agree. Use the three
functions above. Admins can still hide any item.

## Emails (stage 9)

Triggers on `requests` (and on stage 7's `deliveries`) add a row to
`notifications` for each person who should hear about a change, skipping
anyone whose `profiles.email_notifications` is false or who is no longer an
approved member. Each new row calls the `send-email` Edge Function
(`supabase/functions/send-email`) through `pg_net`, at the address stored in
the Vault secret `send_email_url`. The function calls `claim_notification(id)`
(pending to sending, once only) and `finish_notification(id, error)`; both
are for the service role only. The website just flips
`profiles.email_notifications` (Profile page). Setup: [docs/stage-9-setup.md](../docs/stage-9-setup.md).

A table that should send emails gets a trigger that calls
`public.queue_notification(kind, listing_id, recipient_id, actor_id, request_id, delivery_id)`;
add the new `kind` to the check on `notifications.kind` and to `buildEmail` in
the function's `handler.js`.

## Photos

Bucket `listing-photos`, private, 2 MB per file, JPEG/PNG/WebP only.
Path: `<society_id>/<listing_id>/<file name>`, exactly three parts. Only the
listing's owner can upload there; approved members of the society can read.
Insert a `listing_photos` row with the same `storage_path` after each upload.
Show photos with `createSignedUrl` (the bucket has no public URLs).

## Changing the database

- Add a new file in `migrations/` named `YYYYMMDDHHMMSS_what_it_does.sql`. Never edit a migration that has already been applied to the live project.
- For a new table: give it `society_id`, `revoke all ... from anon, authenticated`, grant only the columns needed, `enable row level security`, and write policies that call `is_member` / `is_admin`.
- Add tests for the new rules to `tests/isolation_test.sql`.
- Never put the real society name, flats or residents in migrations, seed or tests.

## Running the tests

- **On the live project:** paste `tests/isolation_test.sql` into the SQL
  Editor and run it. No error means pass.
- **Locally with Docker:** `supabase start`, then `supabase db reset` (applies
  migrations and seed), then
  `psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/isolation_test.sql`.
- **Notifications:** `tests/notifications_test.sql` runs the same way
  (SQL Editor or psql) and is part of `tests/local/run.sh`. The function's own
  tests: `node tests/functions/send-email.test.mjs` (from the repo root).
- **Locally without Docker:** `bash supabase/tests/local/run.sh` needs only
  Postgres 15+ installed. It starts a throwaway database, adds a small
  stand-in for Supabase's `auth` and `storage` schemas, then applies the
  migrations, the seed and the tests.
