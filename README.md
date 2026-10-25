# Dumpy

Give away or sell your extra stuff to neighbours.

Dumpy is a mobile-first website for a housing society: residents post items they no longer need, for free or at a low price, and neighbours request them. Delivery happens inside the society, and paid items are settled directly between neighbours by UPI or cash.

## Stack
- Plain HTML, CSS and vanilla JavaScript, with no build step
- Supabase for sign-in, the database and photos
- Cloudflare Workers (static assets) for hosting

Rules for anyone (or any agent) working on the code are in [CLAUDE.md](CLAUDE.md).

## Layout
```
index.html             Home page
pages/                 Other pages
css/style.css          All styles
js/config.js           Public Supabase URL and publishable key
js/supabase.js         The one shared Supabase client
js/auth.js             Page guard: signed out, waiting for approval, member or admin
js/data.js             Reads items, photos and people from Supabase
js/render.js           Draws every page
js/motion.js           Page-change and button animations (decoration only)
assets/                Icons and images
assets/fonts/          Fraunces and Literata, self-hosted (SIL Open Font License)
supabase/              Database schema, rules, tests and one-off SQL snippets
tests/browser/         End-to-end browser test of sign-in and joining
docs/                  Setup guides
```

## Pages
| Page | File |
|---|---|
| Home feed | `index.html` |
| Item | `pages/item.html?id=<listing id>` |
| Post an item | `pages/post.html` |
| My items | `pages/my-items.html` |
| Profile | `pages/profile.html` |
| Sign in | `pages/sign-in.html` |
| Join a society | `pages/join.html` |
| Society admin | `pages/admin.html` |

Every page is designed at 360 px wide first. Screenshots are in `docs/screenshots/`.

## Run it locally
You only need Python 3, which most computers already have.

```
python3 -m http.server 8000
```

Open http://localhost:8000 in your browser. The pages talk to the live Supabase project, and sign-in links can come back to `http://localhost:8000`. To try it on your phone, connect the phone to the same Wi-Fi and open `http://<your computer's local IP>:8000`.

## How people get in
1. Sign in with their email (a magic link, no password).
2. Fill in name, tower and flat.
3. Enter their society's invite code, then wait.
4. A society admin approves them on **Profile → Society admin**, and they see the society's items.

First-time setup of the real society is in [docs/stage-4-setup.md](docs/stage-4-setup.md).

## Hosting
Setup steps for Cloudflare Pages and the custom domain are in [docs/cloudflare-setup.md](docs/cloudflare-setup.md).

**Live now:** https://dumpy.infernicustrap.workers.dev/ (Cloudflare, deployed from `main`).

**Domain:** the plan is to use `dumpyscrappingapp.in`. It has not been registered yet, so until it is, the site stays on the free Cloudflare address above.
