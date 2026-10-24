/* Things that make Dumpy feel like an app, loaded last on every page:
   1. the service worker (sw.js), for fast repeat loads
   2. Cloudflare Web Analytics, only once a token is set in js/config.js,
      and only on the live site (not previews or localhost)
   3. on the home feed: a first-visit tip card, then an "Add to home screen"
      hint (Android's install prompt, or the Share tip on iPhone).
   None of this is access control: it only decides what to show. */
(function () {
  var body = document.body;
  var ROOT = body.dataset.root || "";
  var cfg = window.DUMPY_CONFIG || {};

  function stored(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function store(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* private mode */ } }

  /* ---------- 1. Service worker ---------- */
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register(ROOT + "sw.js").catch(function (err) { console.error(err); });
    });
  }

  /* ---------- 2. Visit stats (no cookies) ---------- */
  function liveSite() {
    try { return !!cfg.siteUrl && new URL(cfg.siteUrl).hostname === location.hostname; } catch (e) { return false; }
  }
  if (cfg.analyticsToken && liveSite()) {
    var beacon = document.createElement("script");
    beacon.defer = true;
    beacon.src = "https://static.cloudflareinsights.com/beacon.min.js";
    beacon.setAttribute("data-cf-beacon", JSON.stringify({ token: cfg.analyticsToken }));
    document.head.appendChild(beacon);
  }

  /* ---------- 3. Home feed: tip card and install hint ---------- */
  var TIP_KEY = "dumpy.tipSeen";
  var INSTALL_KEY = "dumpy.installHint";
  var tip = document.getElementById("tip-card");
  var hint = document.getElementById("install-hint");

  var standalone = (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
  var ua = navigator.userAgent || "";
  var isIos = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);

  // Android (Chrome, Edge, Samsung Internet) offers its own install prompt.
  // Hold on to it so the hint's Install button can open it.
  var installEvent = null;
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    installEvent = e;
    maybeShowHint();
  });
  window.addEventListener("appinstalled", function () {
    installEvent = null;
    store(INSTALL_KEY, "installed");
    if (hint) hint.hidden = true;
  });

  var member = false;

  function maybeShowHint() {
    if (!hint || !member || standalone || stored(INSTALL_KEY)) return;
    if (tip && !tip.hidden) return; // one card at a time: the tip comes first
    if (!installEvent && !isIos) return;

    hint.innerHTML =
      '<svg class="install-hint__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/></svg>' +
      '<p class="install-hint__text"></p>' +
      '<div class="install-hint__actions"></div>';
    var text = hint.querySelector(".install-hint__text");
    var actions = hint.querySelector(".install-hint__actions");

    if (installEvent) {
      text.innerHTML = "<strong>Add Dumpy to your home screen</strong> to open it like an app.";
      var install = document.createElement("button");
      install.type = "button";
      install.className = "btn btn--primary btn--sm";
      install.textContent = "Install";
      install.addEventListener("click", async function () {
        var ev = installEvent;
        if (!ev) return;
        installEvent = null;
        ev.prompt();
        try {
          var choice = await ev.userChoice;
          if (choice && choice.outcome === "accepted") store(INSTALL_KEY, "installed");
        } catch (e) { /* ignore */ }
        hint.hidden = true;
      });
      actions.appendChild(install);
    } else {
      text.innerHTML = "<strong>Add Dumpy to your home screen:</strong> tap Share " +
        '<svg class="install-hint__share" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="(the square with an arrow)"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>' +
        ", then <strong>Add to Home Screen</strong>.";
    }

    var later = document.createElement("button");
    later.type = "button";
    later.className = "btn btn--outline btn--sm";
    later.textContent = "Not now";
    later.addEventListener("click", function () {
      store(INSTALL_KEY, "dismissed");
      hint.hidden = true;
    });
    actions.appendChild(later);
    hint.hidden = false;
  }

  function showTip() {
    if (!tip || stored(TIP_KEY)) return;
    tip.hidden = false;
    var done = tip.querySelector("[data-tip-done]");
    if (done) done.addEventListener("click", function () {
      store(TIP_KEY, "1");
      tip.hidden = true;
      maybeShowHint();
    });
  }

  // Only approved members see the feed, so only they get these cards.
  if ((tip || hint) && window.Dumpy && window.Dumpy.ready) {
    window.Dumpy.ready.then(function (state) {
      if (!state || state.status !== "member") return;
      member = true;
      showTip();
      maybeShowHint();
    });
  }
})();
