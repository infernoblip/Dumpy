# Browser test (stage 4)

`run.sh` checks the sign-in and joining flow end to end in a 360 x 740 phone
viewport, without touching the live Supabase project:

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

The email itself is faked: the test makes a sign-in link the same shape as
Supabase's (`#access_token=...`) with a key known only to the throwaway local
database. Run it with `bash tests/browser/run.sh`; the top of that file lists
what it needs. All test people and items are made up (Demo Society, example.com).
