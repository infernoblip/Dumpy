/* Page guard: works out who is visiting and sends them to the right page.
   This only decides what to SHOW. What people can READ or CHANGE is enforced
   by the database rules, so a visitor who skips this script still gets nothing.

   Each page sets <body data-access="...">:
     public   sign-in page: anyone; signed-in people are sent on
     landing  home page: signed-out visitors see the public landing,
              approved members see the feed
     account  profile page: anyone signed in (also used to set up a profile)
     join     join page: signed in with a profile
     member   app pages: approved members only
     admin    admin page: approved admins only

   Pages wait for Dumpy.ready, which resolves to the visitor's state:
     { status, user, profile, memberships, society }
   status is one of: signed-out, no-profile, no-society, pending, suspended, member */
(function () {
  var Dumpy = (window.Dumpy = window.Dumpy || {});
  var db = Dumpy.db;
  var body = document.body;
  var ROOT = body.dataset.root || "";
  var ACCESS = body.dataset.access || "member";
  var SOCIETY_KEY = "dumpy.society";

  body.dataset.auth = "loading";

  // Where each kind of visitor belongs.
  var HOME = {
    "signed-out": "index.html",
    "no-profile": "pages/profile.html",
    "no-society": "pages/join.html",
    pending: "pages/join.html",
    suspended: "pages/join.html",
    member: "index.html"
  };

  function go(path) {
    location.replace(ROOT + path);
    return new Promise(function () {}); // never resolves: the page is leaving
  }

  function storedSociety() {
    try { return localStorage.getItem(SOCIETY_KEY); } catch (e) { return null; }
  }

  async function loadState() {
    var res = await db.auth.getSession();
    var session = res.data && res.data.session;
    if (!session) return { status: "signed-out" };

    var both = await Promise.all([db.rpc("get_my_profile"), db.rpc("my_memberships")]);
    if (both[0].error) throw both[0].error;
    if (both[1].error) throw both[1].error;

    var profile = (both[0].data && both[0].data[0]) || null;
    var memberships = both[1].data || [];
    var approved = memberships.filter(function (m) { return m.status === "approved"; });
    var wanted = storedSociety();
    var society = approved.filter(function (m) { return m.society_id === wanted; })[0] || approved[0] || null;

    var status;
    if (!profile) status = "no-profile";
    else if (society) status = "member";
    else if (memberships.some(function (m) { return m.status === "pending"; })) status = "pending";
    else if (memberships.some(function (m) { return m.status === "suspended"; })) status = "suspended";
    else status = "no-society";

    return { status: status, user: session.user, profile: profile, memberships: memberships, society: society };
  }

  // Decide whether this page may be shown; if not, send the visitor on.
  function route(state) {
    var s = state.status;
    switch (ACCESS) {
      case "public":
        return s === "signed-out" ? state : go(HOME[s]);
      case "landing":
        return s === "signed-out" || s === "member" ? state : go(HOME[s]);
      case "account":
        return s === "signed-out" ? go(HOME[s]) : state;
      case "join":
        return s === "signed-out" || s === "no-profile" ? go(HOME[s]) : state;
      case "admin":
        if (s !== "member") return go(HOME[s]);
        return state.society.role === "admin" ? state : go("pages/profile.html");
      default: // member
        return s === "member" ? state : go(HOME[s]);
    }
  }

  function showError(message, retry) {
    body.dataset.auth = "error";
    var box = document.createElement("div");
    box.className = "boot-error";
    box.setAttribute("role", "alert");
    box.innerHTML = "<p></p>";
    box.firstChild.textContent = message;
    if (retry) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "btn btn--primary";
      b.textContent = "Try again";
      b.addEventListener("click", function () { location.reload(); });
      box.appendChild(b);
    }
    body.appendChild(box);
  }

  // A sign-in link that has expired or was already used comes back with
  // #error=...&error_code=otp_expired. Send the visitor to sign in again.
  var hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get("error_code") || hash.get("error")) {
    if (ACCESS !== "public") {
      Dumpy.ready = go("pages/sign-in.html?link=expired");
      return;
    }
    history.replaceState(null, "", location.pathname + location.search);
  }

  if (!db) {
    showError("Dumpy could not load. Check your internet connection and try again.", true);
    Dumpy.ready = new Promise(function () {});
    return;
  }

  Dumpy.ready = loadState()
    .then(route)
    .then(function (state) {
      Dumpy.state = state;
      // supabase-js leaves a bare "#" after reading the sign-in link; tidy it.
      if (/#$/.test(location.href)) history.replaceState(null, "", location.pathname + location.search);
      body.dataset.auth = "ready";
      body.dataset.status = state.status;
      return state;
    })
    .catch(function (err) {
      console.error(err);
      showError("Dumpy could not reach its server. Check your internet connection and try again.", true);
      return new Promise(function () {});
    });

  // Remember which society the visitor is looking at (stage 12 adds a switcher).
  Dumpy.chooseSociety = function (id) {
    try { localStorage.setItem(SOCIETY_KEY, id); } catch (e) { /* private mode */ }
  };

  // Send the visitor wherever their state says they belong.
  Dumpy.goHome = async function () {
    var state = await loadState();
    return go(HOME[state.status]);
  };

  var leaving = false;
  Dumpy.signOut = async function () {
    leaving = true;
    try { await db.auth.signOut(); } catch (e) { /* still leave */ }
    try { localStorage.removeItem(SOCIETY_KEY); } catch (e) { /* ignore */ }
    location.replace(ROOT + "index.html");
  };

  // Signed out in another tab: leave private pages.
  db.auth.onAuthStateChange(function (event) {
    if (event === "SIGNED_OUT" && !leaving && ACCESS !== "public" && body.dataset.status !== "signed-out") {
      location.replace(ROOT + "index.html");
    }
  });
})();
