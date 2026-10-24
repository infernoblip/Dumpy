# Stage 12 setup: more societies

Three things for Arihaan, in this order. Claude can do step 1 through the
Supabase connector once you say go ahead; steps 2 and 3 are yours.

## 1. Apply the database change (needs your OK)

The migration `supabase/migrations/20261024070000_more_societies.sql` adds
society requests, platform admins, society links and `listings.visibility`.
It changes no existing rows except giving each society a `link_code`.

Until it is applied, this pull request's preview site **will not load items**
(the pages ask for the new `visibility` column). Apply it, then test the preview.

After applying, Claude renames the file to the version the live project
records and runs `supabase/tests/societies_test.sql` there (it rolls itself back).

## 2. Make yourself a platform admin

1. Open the Supabase dashboard, project **dumpy-mumbai**.
2. **SQL Editor > New query**.
3. Paste `supabase/snippets/make-platform-admin.sql`.
4. On the line marked `EDIT`, type the email you sign in to Dumpy with.
5. Press **Run**. It should say "Done".
6. On your phone, open Dumpy > **Profile**. You now see **Run Dumpy**.

## 3. Try it with a second test society

1. In a private window, sign in with a second email, set up a profile, and open
   **Profile > Start Dumpy in a new society** (or, signed out, the link on the
   landing page). Ask for a test society, for example "Demo Society Two".
2. On your phone: **Profile > Run Dumpy > Approve**.
3. In the private window, open the start page again and tap **Open**: you are
   its admin, with its own invite code.
4. Optional, nearby sharing: on each society's **Society admin** page, copy the
   **link code**, enter it on the other one's page, and tap **Share with them**.
   Then mark an item **Also show to nearby societies** and look for the
   **Nearby societies** chip on the other society's Home.
5. When done, stop sharing on the admin page. To delete the test society, ask Claude.

New requests do not send you an email yet: check **Run Dumpy** now and then.
