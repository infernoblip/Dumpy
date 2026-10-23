# Browser tests

`run.sh` runs four tests end to end in a 360 x 740 phone viewport, without
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

Storage is faked in `lib.js`, but each upload, read and delete runs in the
local Postgres as the signed-in person, so the real Storage rules from
`supabase/migrations` decide what is allowed. Screenshots go to
`docs/screenshots/stage-5/`.

The email itself is faked: the test makes a sign-in link the same shape as
Supabase's (`#access_token=...`) with a key known only to the throwaway local
database. Run them with `bash tests/browser/run.sh` (or `bash tests/browser/run.sh post.js`
for one); the top of that file lists what it needs. All test people and items are made up (Demo Society, example.com).
