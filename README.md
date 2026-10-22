# Dumpy

Give away or sell your extra stuff to neighbours.

Dumpy is a mobile-first website for a housing society: residents post items they no longer need, for free or at a low price, and neighbours request them. Delivery happens inside the society, and paid items are settled directly between neighbours by UPI or cash.

## Stack
- Plain HTML, CSS and vanilla JavaScript, with no build step
- Supabase for sign-in, the database and photos
- Cloudflare Pages for hosting

Rules for anyone (or any agent) working on the code are in [CLAUDE.md](CLAUDE.md).

## Layout
```
index.html             Home page
pages/                 Other pages
css/style.css          All styles
js/                    Scripts
assets/                Icons and images
supabase/migrations/   Database schema as SQL
docs/                  Setup guides
```

## Run it locally
You only need Python 3, which most computers already have.

```
python3 -m http.server 8000
```

Open http://localhost:8000 in your browser. To try it on your phone, connect the phone to the same Wi-Fi and open `http://<your computer's local IP>:8000`.

## Hosting
Setup steps for Cloudflare Pages and the custom domain are in [docs/cloudflare-setup.md](docs/cloudflare-setup.md).

**Domain:** the plan is to use `dumpyscrappingapp.in`. It has not been registered yet, so until it is, the site lives at its free Cloudflare address (`https://dumpy.pages.dev` or similar, shown in the Cloudflare dashboard).
