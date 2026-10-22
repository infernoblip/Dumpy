# Stage 4 setup: sign-in and your society

Stage 4 lets neighbours sign in with their email, join your society with an
invite code, and wait for an admin (you) to approve them. Four things need
your Supabase account. Do them in order; together they take about 20 minutes.

## 1. Add the new database function (done)

Stage 4 adds one small function, `my_memberships()`, that every page uses to
decide what to show. It changes no tables. Claude added it to the live project
through the Supabase connector on 22 Oct 2026, as migration
`20261022162744_my_memberships.sql`. Nothing to do here. If the project is
ever rebuilt by hand, paste that file into **SQL Editor → New query** and run it.

## 2. Let sign-in emails reach everyone

Supabase's built-in email only sends to members of your Supabase team (so,
you), and only a few per hour. Neighbours would never get their link. Connect
an email account to send from. The simplest option today is a Gmail account
made just for Dumpy (for example `dumpy.yoursociety@gmail.com`); stage 9 can
move to a proper service on your own domain later.

1. Create the Gmail account (or use one you already have for this).
2. In that Google account: **Manage your Google Account → Security**. Turn on
   **2-Step Verification** if it isn't on.
3. Still under Security, search for **App passwords**. Create one named
   `Dumpy`. Google shows a 16-letter password once: copy it.
   Never paste it into the project thread, a pull request, or the repo.
4. Supabase dashboard → **Authentication → Emails** → **SMTP Settings** tab →
   turn on **Enable Custom SMTP** and fill in:
   - **Sender email:** the Gmail address
   - **Sender name:** `Dumpy`
   - **Host:** `smtp.gmail.com`
   - **Port:** `465`
   - **Username:** the Gmail address
   - **Password:** the 16-letter app password
5. Tap **Save changes**.
6. Optional but friendly: **Authentication → Emails → Templates → Magic Link**.
   Change the subject to `Your Dumpy sign-in link` and save.

Gmail lets this send about 500 emails a day, which is plenty for one society.

## 3. Preview links (only for testing a pull request)

Your redirect list already has the live site and `http://localhost:8000`.
Sign-in links asked for from a pull request's preview address come back to the
live site instead, unless you also add previews:

- **Authentication → URL Configuration → Redirect URLs → Add URL:**
  `https://*-dumpy.infernicustrap.workers.dev/**`

## 4. Make yourself the first admin

1. On your phone, open the site, tap **Sign in**, enter your email, and tap the
   link in the email.
2. Fill in your name, tower and flat, and tap **Continue**. You land on
   "Join your society". Leave it there.
3. Supabase dashboard → **SQL Editor → New query**. Paste all of
   `supabase/snippets/create-society.sql`. On the two lines marked `EDIT`, type
   your society's name and the email you just signed in with. Tap **Run**.
4. It answers `Done. You are the admin of ... Invite code: XXXXXXXX`.
   The society name stays in your Supabase project; it is never written into
   the repo.
5. Back on your phone, reload the page. You now see the (empty) home feed.
   **Profile → Society admin** shows the invite code with a **Copy** button.

## 5. Try it with a second person

1. Give the invite code to someone (or use a second email in a private browser
   window).
2. They sign in, fill in their profile, enter the code, and see
   **Waiting for approval**. Opening any other page shows the same screen.
3. On **Profile → Society admin** you see their name, tower and flat under
   **Waiting to join**. Tap **Approve** (or **Reject**).
4. They tap **Check again** and see the society's items.

## Good to know

- Anyone with the invite code can ask to join, but nobody sees anything until an
  admin approves them. Admins see each person's flat so they can check it.
- To change the invite code later, run this in the SQL Editor (use your
  society's name):
  `update public.societies set invite_code = public.generate_invite_code() where name = 'Your society name' returning invite_code;`
- Posting items opens in stage 5, and asking for items in stage 6.
