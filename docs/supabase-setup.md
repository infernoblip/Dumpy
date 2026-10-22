# Setting up Supabase for Dumpy

Supabase is Dumpy's backend: it holds accounts, items and photos. This guide
creates the Supabase project, loads the database rules from this repo, and
checks they work. It takes about 20 minutes. You can do all of it on a phone
(Option 1 in step 2) or from a computer with the Supabase command-line tool
(Option 2).

Nothing here costs money: the free plan is enough for one society.

> **Status (22 Oct 2026): steps 1 to 5 are done.** Claude set them up through
> the Supabase connector. The live project is **dumpy-mumbai** (Mumbai region,
> ref `sfezmqsdzwrjdcqpyhln`). All four migrations are applied and all 78
> isolation tests pass on it. No demo data was loaded. Only **step 6 (sign-in
> settings)** is left for Arihaan, because the connector can't change auth
> settings. The rest of this guide stays here in case the project ever has to
> be rebuilt by hand.

## 1. Create the project

1. Go to https://supabase.com and tap **Start your project**. Sign in with GitHub.
2. If asked, create an organization: any name (for example "Dumpy"), plan **Free**.
3. Tap **New project** and fill in:
   - **Name:** `dumpy`
   - **Database password:** tap **Generate a password**, then save it in your
     password manager. You need it for Option 2 below. Never paste it into a
     chat, pull request or file in the repo.
   - **Region:** **South Asia (Mumbai)**
   - **Plan:** Free
4. Tap **Create new project** and wait about two minutes until the dashboard
   says the project is ready.

Note: on the free plan, Supabase pauses a project after a week with no visits.
If that happens, open the dashboard and tap **Restore project**.

## 2. Load the database rules

The rules are four SQL files in `supabase/migrations/`. They must run in
order, oldest first:

1. `20261022155037_tables.sql`
2. `20261022155058_helper_functions.sql`
3. `20261022155126_row_level_security.sql`
4. `20261022155137_listing_photos_bucket.sql`

Pick one option.

### Option 1: paste them into the SQL Editor (works on a phone)

For each file, in the order above:

1. Open the file on GitHub, then tap **Raw** and copy all of the text.
2. In the Supabase dashboard, open **SQL Editor** (in the left menu) and tap
   **New query** (the **+** button).
3. Paste the text and tap **Run**.
4. It should say **Success. No rows returned**. If you see a red error, stop
   and send the error text in the project thread.

If the editor warns that a query contains "destructive operations" (the files
revoke some default permissions on purpose), tap **Run this query** to go on.

When you use this option, the command-line tool doesn't know these files
already ran. That's fine for now; if you switch to Option 2 later, tell
Claude first so it can mark them as done.

### Option 2: use the Supabase command-line tool (on a computer)

1. Install the tool:
   - **Mac:** `brew install supabase/tap/supabase`
   - **Windows:** install [Scoop](https://scoop.sh), then
     `scoop bucket add supabase https://github.com/supabase/scoop-bucket.git`
     and `scoop install supabase`
   - **Any computer with Node.js 20 or newer:** skip installing and type
     `npx supabase` wherever these steps say `supabase`.
2. Check it works: `supabase --version` prints a version number.
3. Get the repo on your computer and switch to this branch (or `main` once
   it's merged):
   ```
   git clone https://github.com/infernoblip/Dumpy.git
   cd Dumpy
   ```
4. Sign the tool in to your account (a browser window opens):
   ```
   supabase login
   ```
5. Find your project's ID: in the dashboard, **Project Settings → General →
   Project ID** (20 letters, like `abcdefghijklmnopqrst`). Then link the repo
   to it, typing the database password from step 1 when asked:
   ```
   supabase link --project-ref <your project ID>
   ```
6. Push the migrations:
   ```
   supabase db push
   ```
   It lists the four files and asks to apply them. Type `Y`. It should end
   with **Finished supabase db push**.

## 3. Check it worked

1. **Table Editor** (left menu) shows six tables: `societies`, `memberships`,
   `profiles`, `listings`, `listing_photos` and `requests`. None of them is
   marked **Unrestricted** (that label would mean its rules are off).
2. **Storage** shows a bucket called `listing-photos`, marked **Private**.

## 4. Load the demo data (optional)

This adds a made-up "Demo Society" with two demo people and five demo items,
so the pages have something to show while they're being built. Nobody outside
Demo Society can see any of it.

- **SQL Editor:** paste all of `supabase/seed.sql` into a new query and tap **Run**.
- **Command line:** `supabase db push --include-seed`

Before you invite neighbours, remove it by running
`supabase/snippets/remove-demo-data.sql` the same way.

## 5. Run the isolation tests

These prove the rules work: someone in one society can't see or change
another society's items, a person waiting for approval sees nothing, one
neighbour can't edit another's item, and phone numbers, flats and UPI IDs
can't be read directly. The tests add their own test data and undo all of it
when they finish, so they're safe to run on the real project.

1. **SQL Editor → New query**, paste all of `supabase/tests/isolation_test.sql`, tap **Run**.
2. **Pass:** it finishes without a red error.
3. **Fail:** it stops with a red error that starts with `FAIL:` and names the
   rule that broke. Send that line in the project thread.

## 6. Sign-in settings (stage 4 needs these)

1. **Authentication → Sign In / Providers → Email:** check it's turned on.
   It is by default.
2. **Authentication → URL Configuration:**
   - **Site URL:** `https://dumpy.infernicustrap.workers.dev` (change it to
     `https://dumpyscrappingapp.in` once the domain is live).
   - **Redirect URLs:** add `https://dumpy.infernicustrap.workers.dev/**`
     and `http://localhost:8000/**`. Later, add `https://dumpyscrappingapp.in/**`
     and any preview address the pull requests use.

Supabase's built-in email can only send a few sign-in emails per hour.
That's fine for testing; stage 9 sets up a proper email service.

## 7. Send Claude the two public values

Stage 4 needs these two values to connect the website to Supabase. Both are
meant to be public (they ship inside every page), so you can paste them in
the project thread:

- **Project URL:** **Project Settings → Data API** (looks like
  `https://abcdefghijklmnopqrst.supabase.co`)
- **Publishable key:** **Project Settings → API Keys**. Use the key that
  starts with `sb_publishable_`. If your dashboard shows the older layout,
  use the **anon public** key instead.

**Never share** the `service_role` key, the secret key (`sb_secret_...`) or
the database password. They skip every rule in this guide.
