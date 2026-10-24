# Browser tests

`run.sh` runs eight tests end to end in a 360 x 740 phone viewport, without
touching the live Supabase project. Shared pieces (the stand-in for Supabase,
the checks) are in `lib.js`.

## Stage 4: signing in and joining (`e2e.js`)


1. A signed-out visitor sees the public landing; private pages send them there.
2. Sign in asks Supabase for a magic link to the right address and shows "Check your email".
3. Opening the link signs the person in and asks for their profile.
4. They join with an invite code and see "Waiting for approval".
5. While pending, every app page shows the waiting screen, and reading the
   database directly returns no items, photos, other profiles, society or flats.
6. In a second browser profile, the admin sees their name, tower and flat, and approves them.
7. The new member taps "Check again" and sees the society's items.
8. Sign out returns to the landing.

It also checks for sideways scrolling and tap targets under 44 px, and saves
the screenshots in `docs/screenshots/stage-4/`.

## Stage 5: posting items with photos (`post.js`)

1. The form catches a missing title, category or price before anything is saved.
2. Five camera-sized photos (6 to 9 MB each) are picked: four are kept, one is removed.
3. The first upload is cut off: the form stays filled, the failed photo is marked,
   and Try again finishes without posting the item twice.
4. The database and Storage hold the item with the right owner, society,
   category, condition and price, and 3 photos at `society_id/listing_id/`,
   each about 110 to 150 KB and at most 1280 px on the long edge.
5. Another member sees it in the feed but is refused when they try to edit,
   withdraw, add or remove photos, upload into its folder, delete its files,
   or post in the owner's name.
6. The owner edits it (new title, Free, cover photo removed, a photo added),
   withdraws it (it leaves the feed), and posts it again.

## Stage 6: browsing, asking and handing over (`request.js`)

1. The feed shows 20 items, then Load more until every available item is in, each once.
2. Free, Paid and category chips, and the search box (any case; `%` and `_` are
   plain characters), each show only matching items, also combined.
3. Two neighbours ask for one item (with and without a message). Their flats
   and phones stay hidden; a second request from the same person is refused.
4. The owner sees both in My items, and accepts one. The item is reserved, the
   other request declined, and the pair see each other's tower, flat, WhatsApp
   and Call buttons. The other requester sees "Reserved for someone else" and
   "Gone to someone else", and `get_contact` gives them nothing.
5. Two accepts sent at the same moment: exactly one wins.
6. Cancel reservation puts the item back and reopens the other request; the
   owner accepts that one and marks it handed over (status done).

Screenshots go to `docs/screenshots/stage-6/`.

## Stage 7: delivery (`delivery.js`)

1. Once the owner accepts a request, both sides see a delivery card on the
   item page and in My items, in their own words ("I'll bring it over",
   "I'll collect it", "A neighbour helper brings it").
2. The taker picks a helper, tomorrow 6 to 8 pm, with a ₹30 cash tip note; the
   database stores it as 18:00 Indian time. The owner moves it to 4 to 6 pm,
   and it stays one delivery.
3. A member who is not a helper sees "not signed up as a helper" on the jobs
   page and gets no jobs, even when asking the database directly.
4. A third member switches on "I can help deliver" in Profile, sees the job
   with towers only (no flats or phones), and takes it. Now they see both
   flats with WhatsApp and Call buttons, and nobody else can take it.
5. The taker sees "Helper found" with the helper's name and WhatsApp.
6. The helper taps Mark delivered: the delivery closes and the item is done.

Screenshots go to `docs/screenshots/stage-7/`.

## Stage 8: paying by UPI (`pay.js`)

1. The taker of a paid item gets Pay ₹250, linking to
   `upi://pay?pa=<owner's UPI ID>&pn=<owner>&am=250.00&cu=INR&tn=Dumpy: <title>`.
2. Copy puts the UPI ID on the clipboard (the fallback for iPhone).
3. A QR decoder reads the QR code back as exactly the Pay link. It starts
   folded on a phone and open on a wide screen.
4. Free items show no payment at all; an owner without a UPI ID means "pay in cash".
5. Only the owner can Mark as paid (and undo it); the taker then sees it paid.
6. The profile refuses a UPI ID that doesn't look like name@bank.

Screenshots go to `docs/screenshots/stage-8/`.

## Stage 9: notifications (`notify.js`)

1. Profile: Email updates starts on, shows the address, saves off and on at once, and stays off after a reload.
2. With it off, the owner gets no email row when someone asks; with it on, exactly one, and nobody else.
3. Accepting queues exactly one email, to the chosen requester.
4. Item page: Share on WhatsApp opens `wa.me` with the title and link; More opens
   the phone's share sheet (faked) with the same link; neither shows on a
   reserved or missing item.

Screenshots go to `docs/screenshots/stage-9/`. Sending itself is tested in
`tests/functions/send-email.test.mjs`.

## Stage 10: moderation (`moderation.js`)

1. A neighbour reports two items (a reason is required, a note is optional). The
   owner gets no Report button on their own items and cannot read the reports.
2. The admin sees both in Reported items, hides one in one tap (it leaves the
   feed; the owner sees "Hidden by your admin") and dismisses the other.
3. The admin suspends the neighbour, who lands on the suspended screen and can
   read no items; Restore brings the feed back.
4. An item older than 30 days leaves the feed, the expiry job marks it expired,
   and the owner's Renew puts it back for 30 more days.
5. The Not allowed page, linked from the post form, lists every banned kind of item.

Screenshots go to `docs/screenshots/stage-10/`.

## Stage 12: more societies (`societies.js`)

1. A signed-out visitor opens "Start Dumpy in your society", signs in, sets up a
   profile, comes back to the form, and asks to start "Demo Society Two". The
   join page reminds them it is waiting.
2. A society admin gets no "Run Dumpy" link and the platform page shows them nothing.
3. The platform admin sees the request (name, city, asker, email) and approves it:
   the society exists with its own invite code and the asker is its admin.
4. The new society's feed has only its own items; neither society sees the other.
5. The two admins link with link codes (a wrong code is refused; one side alone shares nothing).
6. Demo Society gets a "Nearby societies" chip showing only the other society's
   nearby item; its page names the society, hides the owner and has no "I want
   this". Asking, reading the owner, members, society-only items, the invite
   code or contacts straight from the database all fail.
7. An owner ticks "Also show to nearby societies" on their item; the other society sees just that one.
8. Someone in both societies switches in Profile; the feed, post form and My items follow.
9. Stopping sharing on one side hides everything again. Turning a request down works.

Screenshots go to `docs/screenshots/stage-12/`.

Storage is faked in `lib.js`, but each upload, read and delete runs in the
local Postgres as the signed-in person, so the real Storage rules from
`supabase/migrations` decide what is allowed. Screenshots go to
`docs/screenshots/stage-5/`.

The email itself is faked: the test makes a sign-in link the same shape as
Supabase's (`#access_token=...`) with a key known only to the throwaway local
database. Run them with `bash tests/browser/run.sh` (or `bash tests/browser/run.sh post.js`
for one); the top of that file lists what it needs. All test people and items are made up (Demo Society, example.com).

## Stage 11: launch (`launch.js`)

1. `manifest.json` has the name, standalone display, theme colour and real
   192 and 512 px PNG icons (plus a maskable one and a 180 px iPhone icon);
   every page links it and loads `js/app.js`.
2. Chrome's own installability check (the one Lighthouse used) finds no
   errors, in a normal (not incognito) profile.
3. The service worker saves pages, CSS and JS, never anything from Supabase
   or a CDN; a new deploy shows straight away; offline, a saved page opens.
4. First visit to the feed shows the "How Dumpy works" card; Got it closes it
   for good, and then the install hint appears: an Install button on Android
   (Chrome's prompt, faked), "tap Share, then Add to Home Screen" on iPhone,
   nothing inside the home-screen app or for signed-out visitors.
5. Signing in with the code from the email: too short, wrong, then right.
6. The Cloudflare beacon loads only with a token and only on the live host,
   and sets no cookies.
7. The poster shows the QR code, the three steps and no society name, and
   prints as exactly one A4 page.

Screenshots go to `docs/screenshots/stage-11/`.
