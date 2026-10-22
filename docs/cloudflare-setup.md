# Putting Dumpy online with Cloudflare Pages

These are the steps for Arihaan. They take about 15 minutes, plus waiting time for the domain. You need the Dumpy GitHub repo to exist first.

**Already done (2026-10-22):** the site is live as a Cloudflare Worker at https://dumpy.infernicustrap.workers.dev/. Part A below describes the Pages route; on a Worker the same settings live under the Worker's **Settings**, **Build**. The one step left there is turning on builds for non-production branches so pull requests get preview links.

Cloudflare's menus move around now and then. If a button has a slightly different name, look for the closest match.

## Part A: Connect the repo to Cloudflare Pages

1. Go to https://dash.cloudflare.com and sign up or log in (the free plan is enough).
2. In the left menu, open **Workers & Pages** (on some accounts it is under **Compute**).
3. Click **Create** (or **Create application**), then choose the **Pages** tab, then **Connect to Git** (sometimes called **Import an existing Git repository**).
4. Click **Connect GitHub**. GitHub opens and asks which repos Cloudflare may see. Choose **Only select repositories**, pick the **dumpy** repo, and click **Install & Authorize**.
5. Back in Cloudflare, select the **dumpy** repo and click **Begin setup**.
6. Fill in the build settings exactly like this:
   - **Project name:** `dumpy` (this becomes `dumpy.pages.dev`; if it is taken, Cloudflare adds a few letters, which is fine)
   - **Production branch:** `main`
   - **Framework preset:** `None`
   - **Build command:** leave empty
   - **Build output directory:** `/`
   - **Environment variables:** none
7. Click **Save and Deploy**. After about a minute you get a link like `https://dumpy.pages.dev`.
8. Open that link on your phone. You should see the green Dumpy logo and "Give away or sell your extra stuff to neighbours".

### Turn on preview links for pull requests

9. Open the **dumpy** project, then **Settings**, then **Builds** (older layouts: **Builds & deployments**).
10. Under **Branch control**, keep **Production branch** as `main` and set **Preview branch** to **All non-Production branches**. Make sure **automatic deployments** are on for both.
11. Now every pull request gets its own preview link. Cloudflare posts it as a comment on the pull request on GitHub, and it looks like `https://<branch-name>.dumpy.pages.dev`.

**Check it works (stage 1's "Done when"):** open any small pull request on the repo (Claude can make one for you). Within a couple of minutes a Cloudflare comment with a preview link should appear on it. Open it on your phone.

## Part B: Use the domain dumpyscrappingapp.in

Skip this part if you are happy with the free `pages.dev` address for now. You can do it any time later.

### 1. Check the domain is free and buy it

12. Search for `dumpyscrappingapp.in` at any registrar. Cloudflare Registrar (dash.cloudflare.com, **Domain Registration**, **Register Domains**) sells at cost, but it may not offer `.in` domains. If it does not, use an Indian registrar such as GoDaddy, Hostinger, BigRock or Namecheap. Expect roughly ₹500 to ₹900 for the first year.
13. If the name is already taken, tell Claude. The site keeps working at the `pages.dev` address, and you can pick another name later.

### 2. Move the domain's DNS to Cloudflare (if you bought it elsewhere)

Pages needs the domain's DNS on Cloudflare to serve the bare domain (without `www`). This is free and the domain stays registered where you bought it.

14. In Cloudflare, click **Add a domain** (or **Add a site**), type `dumpyscrappingapp.in`, choose the **Free** plan, and continue. Delete any suggested DNS records it imports; Pages adds its own.
15. Cloudflare shows two **nameservers**, for example `ada.ns.cloudflare.com` and `bob.ns.cloudflare.com`. Copy them.
16. At the registrar where you bought the domain, find **Nameservers** (often under **DNS** or **Manage domain**), choose **Custom nameservers**, delete the old ones, and paste the two Cloudflare ones. Save.
17. Wait. It usually takes under an hour but can take up to 24 hours. Cloudflare emails you when the domain is **Active**.

(If you bought the domain on Cloudflare itself, skip steps 14 to 17; it is already set up.)

### 3. Point the domain at the site

18. Open **Workers & Pages**, then the **dumpy** project, then **Custom domains**, then **Set up a custom domain**.
19. Type `dumpyscrappingapp.in` and click **Continue**, then **Activate domain**. Cloudflare creates the DNS record for you.
20. Repeat for `www.dumpyscrappingapp.in` so both addresses work.
21. Wait for both to show **Active** (a few minutes; the HTTPS certificate is automatic and free).
22. Open `https://dumpyscrappingapp.in` on your phone. You should see the Dumpy placeholder.

### 4. Tell Claude

23. Reply in the project with the final address (the domain, or the `pages.dev` link). Later stages use it for sign-in redirect links and emails.

## If something goes wrong

- **The page shows a 404 or "Nothing is here yet":** check that **Build output directory** is `/` and **Build command** is empty (project **Settings**, **Builds**), then click **Retry deployment** on the latest deployment.
- **No preview link on a pull request:** check step 10, and check that the Cloudflare GitHub app still has access to the dumpy repo (GitHub, **Settings**, **Applications**, **Cloudflare Workers and Pages**, **Configure**).
- **The custom domain is stuck on "Verifying":** the nameserver change in step 16 has not finished yet. Wait a few hours and check again.
