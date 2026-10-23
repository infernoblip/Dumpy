# Stage 9 setup: email notifications

Dumpy emails people when someone asks for their item, when they are picked
(or not), and when a delivery is claimed or done. This page says how to switch
it on for the live project. You need your Supabase login and one email
account. No passwords or keys go into the repo.

## How it works (one paragraph)

When a request or delivery changes, the database writes a row in the
`notifications` table for each person who should hear about it, unless their
**Email updates** switch (Profile page) is off. Each new row makes the
database call the `send-email` Edge Function, which sends one plain email with
a link back to the item and marks the row `sent` (or `failed`, with the
reason). A row can only be sent once.

## Part A: database and function (Claude can do this for you)

These need the Supabase connector, so Claude does them once you say go ahead
in the project thread:

1. Apply the migration `supabase/migrations/*_notifications.sql`.
2. Deploy the Edge Function `supabase/functions/send-email` with
   **Verify JWT turned off** (the database calls it, not a signed-in person).
3. Tell the database where the function lives, in the SQL Editor:

   ```sql
   select vault.create_secret(
     'https://sfezmqsdzwrjdcqpyhln.supabase.co/functions/v1/send-email',
     'send_email_url');
   ```

## Part B: choose how emails are sent (you do this)

Pick **one**. Gmail works today; Resend needs your own domain before it can
email neighbours.

### Option 1: Gmail (recommended until the domain exists)

You already made a Google app password for sign-in emails in stage 4. You can
reuse it or make a new one at https://myaccount.google.com/apppasswords.

1. Open https://supabase.com/dashboard/project/sfezmqsdzwrjdcqpyhln/functions/secrets
2. Add these secrets (Name, then Value), then press **Save**:

   | Name | Value |
   |---|---|
   | `SMTP_HOST` | `smtp.gmail.com` |
   | `SMTP_PORT` | `465` |
   | `SMTP_USER` | your Gmail address |
   | `SMTP_PASS` | the 16-letter app password, without spaces |
   | `EMAIL_FROM` | `Dumpy <your Gmail address>` |

Gmail lets you send about 500 emails a day, which is plenty for one society.
Use port 465: Supabase blocks 587.

### Option 2: Resend

1. Sign up at https://resend.com and open **API Keys** > **Create API key**
   (permission: Sending access). Copy the key (starts with `re_`).
2. Add the secret `RESEND_API_KEY` with that key at
   https://supabase.com/dashboard/project/sfezmqsdzwrjdcqpyhln/functions/secrets
3. **Before you have a domain**, Resend only delivers to the address you signed
   up with, from `onboarding@resend.dev`. That is enough to test, not to
   email neighbours.
4. **Once dumpyscrappingapp.in is registered on Cloudflare:**
   1. In Resend, **Domains** > **Add domain** > `dumpyscrappingapp.in`, region
      Mumbai (ap-south-1) if offered.
   2. Resend shows a few DNS records (TXT for SPF and DKIM, one MX). In the
      Cloudflare dashboard, open the domain > **DNS** > **Records** and add each
      one exactly as shown, with the proxy turned **off** (grey cloud).
   3. Back in Resend press **Verify**. It can take a few minutes.
   4. Add the secret `EMAIL_FROM` = `Dumpy <notify@dumpyscrappingapp.in>`.

If both are set, Resend is used.

### Optional

`SITE_URL`: the website address used in email links. Leave it unset to use
https://dumpy.infernicustrap.workers.dev; set it to
`https://dumpyscrappingapp.in` once the domain points at the site.

## Part C: try it (the stage's "Done when" check)

Use two accounts (a private window for the second one, so Gmail's in-app
browser doesn't mix them up).

1. Account 1 posts a test item. Account 2 taps **I want this**.
   Account 1 gets one email: "... asked for your ...".
2. Account 1 accepts in My items. Account 2 gets one email: "... picked you for ...".
   Anyone else who had asked gets "... went to someone else".
3. Account 1 turns **Email updates** off on the Profile page. Account 2 asks
   for another of Account 1's items: no email arrives.
4. On a phone, open an available item and tap **Share on WhatsApp**: WhatsApp
   opens with the item's title and link. **More** opens the phone's share sheet.

To see what was sent, run this in the SQL Editor:

```sql
select created_at, kind, status, error
from public.notifications
order by created_at desc
limit 20;
```

`pending` for long means the function wasn't reached (check Part A step 3);
`failed` shows the email provider's reason.

## Turning emails off for everyone

Delete the Vault secret `send_email_url` (Project Settings > Vault). Rows are
still recorded as `pending` but nothing is sent.
