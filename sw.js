/* Dumpy service worker: keeps a copy of the site's own files (pages, CSS, JS,
   icons) so repeat visits and the home-screen app open quickly, and still open
   on a weak connection.

   Rules:
   - Only this site's own files are handled. Requests to Supabase (data,
     sign-in, photos) and to CDNs are never touched or cached here.
   - Network first: the newest deploy always wins when the network answers.
     The saved copy is used when the network fails or takes over 3 seconds.
     (There is no build step, so file names carry no version; serving saved
     copies first could mix an old script with a new page.)
   - Pages are saved under one name with and without ".html", and without
     their ?query, because the host redirects /pages/item.html to /pages/item
     and the query only carries data such as an item id. */
var CACHE = "dumpy-shell-v4";
var WAIT_MS = 3000;

var SHELL = [
  "./",
  "pages/item.html",
  "pages/post.html",
  "pages/my-items.html",
  "pages/profile.html",
  "pages/sign-in.html",
  "pages/join.html",
  "pages/jobs.html",
  "pages/admin.html",
  "pages/not-allowed.html",
  "pages/poster.html",
  "pages/start.html",
  "pages/platform.html",
  "css/style.css",
  "js/config.js",
  "js/supabase.js",
  "js/auth.js",
  "js/data.js",
  "js/render.js",
  "js/post.js",
  "js/photos.js",
  "js/pay.js",
  "js/fees.js",
  "js/delivery.js",
  "js/notify.js",
  "js/moderation.js",
  "js/app.js",
  "js/poster.js",
  "js/societies.js",
  "js/motion.js",
  "manifest.json",
  "assets/favicon.svg",
  "assets/icon-192.png",
  "assets/apple-touch-icon.png",
  "assets/fonts/literata.woff2",
  "assets/fonts/fraunces.woff2",
  "assets/fonts/fraunces-italic.woff2"
];

// One cache name per file: drop the query, "index.html" and ".html".
function keyFor(url) {
  var u = new URL(url, self.location.href);
  var p = u.pathname.replace(/index\.html$/, "").replace(/\.html$/, "");
  return u.origin + p;
}

// A redirected response can't be handed back for a page load, so save a
// plain copy of it instead.
function plain(res) {
  if (!res.redirected) return Promise.resolve(res);
  return res.blob().then(function (body) {
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  });
}

function save(url, res) {
  if (!res || !res.ok || res.type !== "basic") return Promise.resolve();
  return plain(res).then(function (copy) {
    return caches.open(CACHE).then(function (c) { return c.put(keyFor(url), copy); });
  });
}

self.addEventListener("install", function (event) {
  event.waitUntil(
    // Save each file on its own, so one missing file doesn't stop the rest.
    Promise.all(SHELL.map(function (path) {
      var url = new URL(path, self.location.href).href;
      return fetch(url, { cache: "no-cache" })
        .then(function (res) { return save(url, res); })
        .catch(function () { /* offline while installing: saved later */ });
    })).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (names) {
        return Promise.all(names.filter(function (n) {
          return n.indexOf("dumpy-") === 0 && n !== CACHE;
        }).map(function (n) { return caches.delete(n); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

function offlinePage() {
  return new Response(
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="color-scheme" content="light dark"><title>Offline · Dumpy</title>' +
    "<style>body{margin:0;padding:32px 20px;background:#f3ebdc;color:#1e2b23;font:17px/1.55 Georgia,serif;text-align:center}" +
    "h1{font-style:italic;font-weight:600;color:#2e5a44}" +
    "a{display:inline-block;min-height:44px;margin-top:8px;padding:11px 22px;border-radius:14px;background:#2e5a44;color:#fbf6ec;text-decoration:none;box-sizing:border-box}" +
    "@media (prefers-color-scheme:dark){body{background:#121a15;color:#efe6d2}h1{color:#a9cf9f}a{background:#a9cf9f;color:#13201a}}</style>" +
    "<h1>You're offline</h1><p>Dumpy needs the internet to show items. Check your connection and try again.</p>" +
    '<p><a href="/">Try again</a></p></html>',
    { status: 503, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET" || req.headers.has("range")) return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase, CDNs: hands off
  if (url.pathname === new URL("sw.js", self.location.href).pathname) return;

  var isPage = req.mode === "navigate";
  var network = fetch(req);
  // Save what the network sends, even if the saved copy answered first.
  // A page load that was redirected comes back as an opaque redirect: the
  // browser follows it, and the page it lands on is saved instead.
  event.waitUntil(network.then(function (res) { return save(req.url, res.clone()); }).catch(function () {}));

  event.respondWith(new Promise(function (resolve) {
    var done = false;
    function answer(res) { if (!done && res) { done = true; resolve(res); } }
    function saved() { return caches.open(CACHE).then(function (c) { return c.match(keyFor(req.url)); }); }

    var timer = setTimeout(function () { saved().then(answer); }, WAIT_MS);
    network.then(function (res) { clearTimeout(timer); answer(res); }, function () {
      clearTimeout(timer);
      saved().then(function (res) {
        if (res) return answer(res);
        if (isPage) return answer(offlinePage());
        answer(Response.error());
      });
    });
    // If the saved copy was missing at 3 seconds, keep waiting for the network.
  }));
});
