# Stage 11 setup: launch Dumpy in your society

Stage 11 makes Dumpy an app neighbours can put on their home screen, adds a
poster for the notice board, and gets visit stats ready. Three things need
your accounts. Together they take about 15 minutes. Nothing here needs a
database change.

## 1. Add the sign-in code to the emails (Supabase, 5 minutes)

**Why:** on iPhone, an app added to the home screen keeps its own sign-in,
separate from Safari. Tapping the link in the email opens Safari, so the
home-screen app would stay signed out. Typing a code from the same email
fixes that. The sign-in page now has a box for it; the email just has to
show the code.

1. Supabase dashboard → project **dumpy-mumbai** → **Authentication → Emails → Templates**.
2. Open **Magic Link**. In the message body, add this line under the link and
   tap **Save**:

   ```html
   <p>Or type this code in Dumpy: <strong>{{ .Token }}</strong></p>
   ```

3. Open **Confirm signup** (the email a brand-new person gets the first time)
   and add the same line. **Save**.
4. Check: on the website tap **Sign in**, send yourself a link, and look for a
   6-digit code in the email. Type it in **Or type the code from the email**.
   You should land on the home feed.

The code works once and expires with the link (one hour by default).

## 2. Turn on visit stats (Cloudflare Web Analytics, 5 minutes)

Cloudflare Web Analytics counts visits and pages without cookies and without
tracking people across sites, so no cookie banner is needed. The site only
loads it on the live address, never on pull request previews or your own
computer.

1. Cloudflare dashboard → **Analytics & Logs → Web Analytics** (or type
   `Web Analytics` in the dashboard's search bar).
2. Tap **Add a site**. Hostname: `dumpy.infernicustrap.workers.dev`. If it asks
   how to set it up, choose the **JavaScript snippet** (manual) option:
   automatic setup only works for domains whose DNS is on Cloudflare.
3. Cloudflare shows a snippet like
   `<script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "0123abcd..."}'></script>`.
   Copy only the token: the letters and numbers inside `"token": "..."`.
4. Paste the token in the project thread and Claude adds it, or do it
   yourself on GitHub: open `js/config.js`, tap the pencil, put the token
   between the quotes of `analyticsToken: ""`, and commit to `main`.

The token is not a secret: it ships inside every page by design.

Visits show up in **Web Analytics** a few minutes after someone opens the
site. If you move to `dumpyscrappingapp.in` later, add that hostname as a new
site and change `siteUrl` in `js/config.js`.

## 3. Print the poster

1. On the website: **Profile → Society admin → Print a poster** (or open
   `/pages/poster.html`).
2. Tap **Print**. On a phone this opens the print screen; you can also save
   it as a PDF and print it at a shop.
3. Paper **A4**, scale **100%** (or "Actual size"), margins **None** or
   **Default**. Turn on **Background graphics** if the green boxes come out
   white. It fits one page.
4. With a pen, write your society's name and the invite code (shown on the
   admin page) in the two dashed boxes. The poster never prints the society
   name by itself.

The QR code opens `https://dumpy.infernicustrap.workers.dev/`. Point your phone
camera at it once to check before you put it up.

## 4. Try installing it

**Android (Chrome):** open the site and sign in. On the home feed, after the
"How Dumpy works" card, an **Add Dumpy to your home screen** card appears:
tap **Install**. (Or Chrome menu **⋮ → Add to Home screen / Install app**.)
The Dumpy icon appears on the home screen and opens without the browser bar.

**iPhone (Safari):** open the site and sign in. The card says **tap Share,
then Add to Home Screen**. Do that, then open Dumpy from the home screen. It
asks you to sign in once more: send the link, then type the **code** from the
email (step 1 above must be done).

## 5. Launch checklist

The plan's finish line for this stage is **10 households signed up and at
least 5 items changed hands**.

1. Before the poster goes up, ask 3 to 5 friends in the society to sign in and
   post a couple of things each, so the feed isn't empty on day one (the plan
   aims for about 20 items).
2. Put up the poster near the lifts, the gate and the notice board, and share
   the link in the society WhatsApp group.
3. Approve people on **Profile → Society admin** as they ask to join.
4. To see progress, paste `supabase/snippets/launch-progress.sql` into the
   Supabase **SQL Editor** and tap **Run**. It shows, per society, households
   signed up, people waiting for approval, items posted, and items that changed
   hands. It changes nothing.
