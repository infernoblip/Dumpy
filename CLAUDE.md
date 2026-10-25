# Dumpy: rules for agents

Dumpy is a mobile-first website where residents of a housing society give away unwanted items for free or sell them cheaply, with delivery to the taker's flat. It is built in 12 stages; each stage is one branch and one pull request. Follow every rule below.

## Stack
- Use plain HTML, CSS and vanilla JavaScript. Do not add frameworks, bundlers, npm build steps or TypeScript.
- Keep all styles in the one file `css/style.css`. Put scripts in `js/`, extra pages in `pages/`, images and icons in `assets/`.
- The backend is Supabase: Auth (email magic link), Postgres and Storage. Load the Supabase JS client v2 from a CDN with an exact pinned version (for example `@supabase/supabase-js@2.45.4`), never `@2` or `latest`.
- Hosting is Cloudflare (a Worker serving static assets, configured in `wrangler.jsonc`), deployed straight from this repo with no build step. `main` is production at https://dumpy.infernicustrap.workers.dev/; every pull request gets a preview URL. If you add a file to the repo that should not be public on the website, list it in `.assetsignore`.
- Every page links `manifest.json` and the PNG `apple-touch-icon`, and loads `js/app.js` last (service worker, install hint, visit stats). When you add a page or a script, also add it to the `SHELL` list in `sw.js`. The service worker must never cache Supabase or other sites' responses.
- Database changes go in `supabase/migrations/` as SQL files. Never change another stage's tables without saying so in your pull request.

## Mobile first
- Design every page at 360 px wide first, then let it widen.
- Tap targets are at least 44 x 44 px. No sideways scrolling, ever.
- Use the two self-hosted fonts in `assets/fonts/` (Fraunces for titles, Literata for text) through the `--font-display` and `--font-text` tokens in `css/style.css`. Add no other web fonts. Support light and dark mode with `prefers-color-scheme`.
- Motion is decoration: every page must work without `js/motion.js` and with `prefers-reduced-motion: reduce`.
- Check every page you change in a 360 x 740 phone viewport before calling it done.

## Security
- The Supabase anon key is public and ships inside the page. All access control lives in Postgres row-level security policies or security-definer functions, never in page JavaScript.
- Every table carries `society_id`.
- Never commit secrets (service-role keys, API keys, passwords). `.env` files are git-ignored.

## Privacy
- Never write the real society name, flat numbers or any resident's details into code, seed data, commits, tests, screenshots or docs.
- Use "Demo Society" and flats like A-101 for examples and test data.

## Money
- A price of 0 means Free.
- Dumpy never collects or holds money. Paid items are settled between neighbours by UPI or cash.
- Dumpy's only income is a flat delivery fee on helper deliveries, set on Run Dumpy and paid by the taker by UPI straight to the platform UPI ID after delivery. Tips still go straight to helpers.

## Accounts you do not have
- Anything that needs Arihaan's accounts (Cloudflare, Supabase, domain registrar, email provider): do not guess credentials. Write exact step-by-step instructions for Arihaan in the pull request (and in `docs/` if they are long).

## How to work
- Work only on your stage. One branch, one pull request.
- The pull request description lists each sub-goal, shows the stage's "Done when" check passing, and includes a 360 px screenshot of every page you changed.
- If something is not covered here, choose the simplest option and note it in the pull request.

## Running locally
```
python3 -m http.server 8000
```
Then open http://localhost:8000.
