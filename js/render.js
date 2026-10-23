/* Draws Dumpy pages. Each page sets <body data-page="..."> and data-root
   ("" or "../"). Pages wait for js/auth.js (Dumpy.ready) and read data
   through js/data.js. */
(function () {
  var Dumpy = window.Dumpy;
  var body = document.body;
  var ROOT = body.dataset.root || "";

  /* ---------- Helpers ---------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function $(sel) { return document.querySelector(sel); }
  function url(path) { return ROOT + path; }
  function rupees(n) { return "₹" + Number(n).toLocaleString("en-IN"); }
  function initial(name) { return esc((name || "?").charAt(0).toUpperCase()); }
  function db() { return Dumpy.db; }

  function timeAgo(iso) {
    var mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + (mins === 1 ? " minute ago" : " minutes ago");
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + (hrs === 1 ? " hour ago" : " hours ago");
    var days = Math.round(hrs / 24);
    if (days < 30) return days + (days === 1 ? " day ago" : " days ago");
    var months = Math.round(days / 30);
    return months + (months === 1 ? " month ago" : " months ago");
  }

  function priceBadge(price) {
    return price === 0
      ? '<span class="badge badge--free">Free</span>'
      : '<span class="badge badge--price">' + rupees(price) + "</span>";
  }
  function priceText(price) { return price === 0 ? "Free" : rupees(price); }

  var STATUS_LABEL = {
    available: "Available", reserved: "Reserved", done: "Handed over",
    withdrawn: "Withdrawn", hidden: "Hidden", expired: "Expired",
    pending: "Waiting", accepted: "Accepted", declined: "Declined", cancelled: "Cancelled",
    approved: "Member", suspended: "Suspended", admin: "Admin"
  };
  function statusPill(status) {
    return '<span class="status status--' + esc(status) + '">' + esc(STATUS_LABEL[status] || status) + "</span>";
  }

  // Signed photo URLs are absolute; anything else is a path from the site root.
  function photo(src, alt, eager) {
    if (!src) return '<span class="photo-none" aria-hidden="true">' + ICON_BOX + "</span>";
    var full = /^(https?:|blob:|data:)/.test(src) ? src : url(src);
    return '<img src="' + esc(full) + '" alt="' + esc(alt) + '" width="400" height="400"' +
      (eager ? ' fetchpriority="high"' : ' loading="lazy"') + ' decoding="async">';
  }

  // "B" -> "Tower B"; leaves "Tower B" or "Wing 2" as typed.
  function tower(t) {
    t = (t || "").trim();
    return !t || /^(tower|wing|block|building)\b/i.test(t) ? t : "Tower " + t;
  }

  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }

  // Friendly text for errors from Supabase.
  function problem(err) {
    var msg = (err && err.message) || "";
    if (/fetch|network/i.test(msg)) return "Could not reach Dumpy. Check your internet connection and try again.";
    if (/rate limit|too many|security purposes/i.test(msg)) return "Too many tries. Wait a minute and try again.";
    return msg || "Something went wrong. Please try again.";
  }

  function setBusy(btn, busy, text) {
    if (!btn) return;
    if (busy) { btn.dataset.label = btn.textContent; btn.textContent = text || "Please wait…"; btn.disabled = true; }
    else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
  }

  // Show one step of a page; move focus to its heading when it replaced another step.
  function showStep(id, quiet) {
    document.querySelectorAll("[data-step]").forEach(function (el) { el.hidden = el.id !== id; });
    var h = document.querySelector("#" + id + " h1");
    if (h && !quiet) { h.setAttribute("tabindex", "-1"); h.focus(); }
  }

  function wireSignOut() {
    document.querySelectorAll("[data-sign-out]").forEach(function (b) {
      b.addEventListener("click", function (e) { e.preventDefault(); Dumpy.signOut(); });
    });
  }

  /* ---------- Item card (feed) ---------- */
  function itemCard(l, index) {
    return '<li><a class="item-card" href="' + url("pages/item.html?id=" + encodeURIComponent(l.id)) + '">' +
      '<div class="item-card__photo">' + photo(l.photos[0], "", index < 4) + priceBadge(l.price_inr) + "</div>" +
      '<div class="item-card__body">' +
        '<h2 class="item-card__title">' + esc(l.title) + "</h2>" +
        '<p class="item-card__meta">' + (l.owner.tower ? esc(tower(l.owner.tower)) + " · " : "") + timeAgo(l.created_at) + "</p>" +
      "</div></a></li>";
  }

  /* ---------- Home: public landing or feed ---------- */
  async function initHome(state) {
    if (state.status === "signed-out") {
      body.dataset.view = "landing";
      body.classList.remove("has-nav");
      $("#main").hidden = true;
      $("#landing").hidden = false;
      return;
    }
    $("#society-name").textContent = state.society.society_name;

    var grid = $("#feed");
    var search = $("#search");
    var chips = $("#chips");
    var meta = $("#feed-meta");
    var filter = "all";
    var items = [];

    var options = [["all", "All"], ["free", "Free"], ["paid", "Paid"]].concat(Dumpy.data.CATEGORIES);
    chips.innerHTML = options.map(function (c) {
      return '<button type="button" class="chip" aria-pressed="' + (c[0] === "all") + '" data-filter="' + esc(c[0]) + '">' + esc(c[1]) + "</button>";
    }).join("");

    function draw() {
      var q = search.value.trim().toLowerCase();
      var shown = items.filter(function (l) {
        if (q && l.title.toLowerCase().indexOf(q) === -1) return false;
        if (filter === "free") return l.price_inr === 0;
        if (filter === "paid") return l.price_inr > 0;
        if (filter !== "all") return l.category === filter;
        return true;
      });
      meta.textContent = plural(shown.length, "item", "items") + " in " + state.society.society_name;
      grid.innerHTML = shown.length
        ? shown.map(itemCard).join("")
        : '<li class="empty" style="grid-column:1/-1"><p>' + (items.length ? "Nothing matches." : "Nothing here yet. Be the first to post something.") +
          '</p><a class="btn btn--primary" href="pages/post.html">Post an item</a></li>';
    }

    chips.addEventListener("click", function (e) {
      var b = e.target.closest(".chip");
      if (!b) return;
      filter = b.dataset.filter;
      chips.querySelectorAll(".chip").forEach(function (c) { c.setAttribute("aria-pressed", String(c === b)); });
      draw();
    });
    search.addEventListener("input", draw);
    $("#search-form").addEventListener("submit", function (e) { e.preventDefault(); search.blur(); });

    meta.textContent = "Loading items…";
    try {
      items = await Dumpy.data.feed(state.society.society_id);
      draw();
    } catch (err) {
      meta.textContent = problem(err);
    }
  }

  /* ---------- Item page ---------- */
  async function initItem(state) {
    var id = new URLSearchParams(location.search).get("id");
    var main = $("#item");
    var l = null;
    try { l = await Dumpy.data.listing(id); } catch (err) { console.error(err); }
    if (!l) {
      main.innerHTML = '<div class="empty"><p>This item is no longer listed.</p><a class="btn btn--primary" href="../index.html">Back to Home</a></div>';
      $("#action-bar").hidden = true;
      return;
    }
    document.title = l.title + " · Dumpy";

    var pics = l.photos.length ? l.photos : [null];
    var slides = pics.map(function (p, i) {
      return '<figure class="gallery__slide">' + photo(p, l.title + ", photo " + (i + 1) + " of " + pics.length, i === 0) + "</figure>";
    }).join("");
    var dots = pics.length > 1
      ? '<div class="gallery__dots" aria-hidden="true">' + pics.map(function (_, i) {
          return '<span' + (i === 0 ? ' aria-current="true"' : "") + "></span>";
        }).join("") + "</div>"
      : "";

    main.innerHTML =
      '<div class="gallery" aria-label="Photos">' +
        '<div class="gallery__track" id="gallery-track" tabindex="0" aria-label="Photos, swipe for more">' + slides + "</div>" + dots +
      "</div>" +
      '<div class="item-head">' +
        "<h1>" + esc(l.title) + "</h1>" +
        '<p class="item-head__price">' + (l.price_inr === 0 ? '<span class="badge badge--free">Free</span>' : rupees(l.price_inr)) + "</p>" +
      "</div>" +
      '<dl class="facts">' +
        "<div><dt>Condition</dt><dd>" + esc(l.condition_label) + "</dd></div>" +
        "<div><dt>Category</dt><dd>" + esc(l.category_label) + "</dd></div>" +
        "<div><dt>Pick up from</dt><dd>" + esc(tower(l.owner.tower) || "Ask the owner") + "</dd></div>" +
        "<div><dt>Posted</dt><dd>" + timeAgo(l.created_at) + "</dd></div>" +
      "</dl>" +
      (l.description ? '<section class="section stack-sm" aria-labelledby="about-h">' +
        '<h2 id="about-h">About this item</h2><p>' + esc(l.description) + "</p></section>" : "") +
      '<section class="section stack-sm" aria-labelledby="owner-h">' +
        '<h2 id="owner-h">Posted by</h2>' +
        '<div class="person"><span class="avatar" aria-hidden="true">' + initial(l.owner.display_name) + "</span>" +
        '<div><p class="person__name">' + esc(l.owner.display_name) + '</p><p class="person__meta">' + esc(tower(l.owner.tower)) + "</p></div></div>" +
        '<p class="small muted">Flat number and phone are shared only after the owner accepts your request.</p>' +
      "</section>" +
      '<section class="section"><div class="notice">' + ICON_INFO +
        "<p>" + (l.price_inr === 0
          ? "This item is free. Delivery can be by the owner, by you, or by a society helper."
          : "Pay the owner directly by UPI or cash at handover. Dumpy never holds money.") + "</p></div></section>";

    var track = $("#gallery-track");
    var dotEls = main.querySelectorAll(".gallery__dots span");
    if (dotEls.length) {
      track.addEventListener("scroll", function () {
        var i = Math.round(track.scrollLeft / track.clientWidth);
        dotEls.forEach(function (d, j) {
          if (i === j) d.setAttribute("aria-current", "true"); else d.removeAttribute("aria-current");
        });
      }, { passive: true });
    }

    // Asking for items goes live in stage 6.
    var btn = $("#want-btn");
    $("#action-price").textContent = priceText(l.price_inr);
    if (l.owner_id === state.user.id) btn.textContent = "This is your item";
    else if (l.status !== "available") btn.textContent = l.status === "reserved" ? "Reserved for someone" : "No longer available";
    else btn.textContent = "Requests open soon";
    btn.disabled = true;
  }

  /* ---------- My items ---------- */
  async function initMyItems(state) {
    var list = $("#listings");
    var mineReq = $("#my-requests");
    wireTabs();
    list.innerHTML = '<li class="empty"><p>Loading…</p></li>';
    var d;
    try {
      d = await Dumpy.data.myItems(state.user.id, state.society.society_id);
    } catch (err) {
      list.innerHTML = '<li class="empty"><p>' + esc(problem(err)) + "</p></li>";
      return;
    }

    list.innerHTML = d.listings.length ? d.listings.map(function (l) {
      var reqs = d.incoming.filter(function (r) { return r.listing_id === l.id; });
      var reqHTML = "";
      if (reqs.length && l.status !== "done") {
        reqHTML = '<div class="requests"><p class="requests__title">' + plural(reqs.length, "request", "requests") + "</p>" +
          reqs.map(function (r) {
            return '<div class="request"><div class="person"><span class="avatar" aria-hidden="true">' + initial(r.requester.display_name) + "</span>" +
              '<div class="row-card__main"><p class="person__name">' + esc(r.requester.display_name) +
              ' <span class="person__meta">· ' + esc(tower(r.requester.tower)) + " · " + timeAgo(r.created_at) + "</span></p>" +
              (r.message ? '<p class="request__msg">“' + esc(r.message) + "”</p>" : "") +
              statusPill(r.status) + "</div></div></div>";
          }).join("") + "</div>";
      }
      return '<li class="row-card"><div class="row-card__top">' +
        '<a class="row-card__thumb" href="item.html?id=' + esc(l.id) + '" tabindex="-1" aria-hidden="true">' + photo(l.photos[0], "") + "</a>" +
        '<div class="row-card__main"><a class="row-card__title" href="item.html?id=' + esc(l.id) + '"><span>' + esc(l.title) + "</span></a>" +
        '<p class="row-card__meta">' + priceText(l.price_inr) + " · posted " + timeAgo(l.created_at) + "</p>" +
        statusPill(l.status) + "</div></div>" + reqHTML + "</li>";
    }).join("") : '<li class="empty"><p>You have not posted anything yet.</p><a class="btn btn--primary" href="post.html">Post an item</a></li>';

    var asked = d.outgoing.filter(function (r) { return r.listing; });
    mineReq.innerHTML = asked.length ? asked.map(function (r) {
      var l = r.listing;
      return '<li class="row-card"><div class="row-card__top">' +
        '<a class="row-card__thumb" href="item.html?id=' + esc(l.id) + '" tabindex="-1" aria-hidden="true">' + photo(l.photos[0], "") + "</a>" +
        '<div class="row-card__main"><a class="row-card__title" href="item.html?id=' + esc(l.id) + '"><span>' + esc(l.title) + "</span></a>" +
        '<p class="row-card__meta">' + priceText(l.price_inr) + " · " + esc(l.owner.display_name) + (l.owner.tower ? ", " + esc(tower(l.owner.tower)) : "") + "</p>" +
        statusPill(r.status) + "</div></div></li>";
    }).join("") : '<li class="empty"><p>You have not asked for anything yet.</p><a class="btn btn--primary" href="../index.html">Browse items</a></li>';
  }

  function wireTabs() {
    var tabs = document.querySelectorAll('[role="tab"]');
    function select(tab) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute("aria-selected", String(on));
        t.tabIndex = on ? 0 : -1;
        document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
      });
    }
    tabs.forEach(function (t, i) {
      t.addEventListener("click", function () { select(t); });
      t.addEventListener("keydown", function (e) {
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          var next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
          select(next); next.focus();
        }
      });
    });
    if (location.hash === "#requests") select(tabs[1]);
  }

  /* ---------- Post (goes live in stage 5) ---------- */
  function initPost() {
    var cat = $("#category");
    cat.innerHTML = '<option value="">Choose one</option>' + Dumpy.data.CATEGORIES.map(function (c) {
      return '<option value="' + esc(c[0]) + '">' + esc(c[1]) + "</option>";
    }).join("");

    var free = $("#free");
    var price = $("#price");
    var priceField = $("#price-field");
    function syncPrice() {
      priceField.hidden = free.checked;
      price.required = !free.checked;
      if (free.checked) price.value = "";
    }
    free.addEventListener("change", syncPrice);
    syncPrice();

    var picker = $("#photo-picker");
    var input = $("#photos");
    var addSlot = $("#photo-add");
    var hint = $("#photo-hint");
    input.addEventListener("change", function () {
      picker.querySelectorAll(".photo-slot--preview").forEach(function (n) { n.remove(); });
      Array.prototype.slice.call(input.files, 0, 4).forEach(function (f) {
        var li = document.createElement("li");
        li.className = "photo-slot photo-slot--preview";
        var img = document.createElement("img");
        img.alt = "";
        img.src = URL.createObjectURL(f);
        li.appendChild(img);
        picker.insertBefore(li, addSlot);
      });
      hint.textContent = input.files.length > 4 ? "Only the first 4 photos are kept." : input.files.length + " of 4 photos added.";
    });

    $("#post-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var done = $("#post-done");
      done.hidden = false;
      done.focus();
    });
  }

  /* ---------- Profile (also first-time setup) ---------- */
  var PHONE_RE = /^\+?[0-9]{10,13}$/;
  var UPI_RE = /^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9.]{1,63}$/;

  function initProfile(state) {
    var p = state.profile || {};
    var setup = state.status !== "member";
    body.dataset.setup = String(setup);
    if (setup) {
      body.classList.remove("has-nav");
      $("#page-title").textContent = state.profile ? "Your profile" : "Set up your profile";
      $("#setup-lead").hidden = !!state.profile;
      $("#profile-submit").textContent = state.profile ? "Save" : "Continue";
    }

    function summary() {
      $("#profile-name").textContent = p.display_name || "";
      $("#profile-where").textContent = [tower(p.tower), p.flat, state.society && state.society.society_name]
        .filter(Boolean).join(" · ");
      $("#profile-avatar").textContent = (p.display_name || "?").charAt(0).toUpperCase();
    }
    if (p.display_name) summary(); else $("#profile-person").hidden = true;

    $("#display_name").value = p.display_name || "";
    $("#tower").value = p.tower || "";
    $("#flat").value = p.flat || "";
    $("#phone").value = p.phone || "";
    $("#upi_id").value = p.upi_id || "";
    $("#email-shown").textContent = state.user.email || "";
    $("#signed-email").textContent = state.user.email || "";
    $("#admin-link").hidden = !(state.society && state.society.role === "admin");
    $("#join-link").hidden = setup;
    wireSignOut();

    var form = $("#profile-form");
    var note = $("#saved-note");
    var err = $("#profile-error");
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      note.hidden = true;
      err.hidden = true;

      var row = {
        display_name: $("#display_name").value.trim(),
        tower: $("#tower").value.trim(),
        flat: $("#flat").value.trim().toUpperCase(),
        phone: $("#phone").value.replace(/[\s()-]/g, "") || null,
        upi_id: $("#upi_id").value.trim() || null
      };
      var bad = null;
      if (!row.display_name) bad = ["display_name", "Enter the name neighbours will see."];
      else if (!row.tower) bad = ["tower", "Enter your tower or wing."];
      else if (!row.flat) bad = ["flat", "Enter your flat number."];
      else if (row.phone && !PHONE_RE.test(row.phone)) bad = ["phone", "Enter a 10-digit mobile number, or leave it empty."];
      else if (row.upi_id && !UPI_RE.test(row.upi_id)) bad = ["upi_id", "A UPI ID looks like name@bank. Check it, or leave it empty."];
      if (bad) {
        err.querySelector("span").textContent = bad[1];
        err.hidden = false;
        $("#" + bad[0]).focus();
        return;
      }

      var btn = $("#profile-submit");
      setBusy(btn, true, "Saving…");
      // flat, phone and UPI ID can't be read back, so never ask for the row back.
      var res = state.profile
        ? await db().from("profiles").update(row).eq("user_id", state.user.id)
        : await db().from("profiles").insert(Object.assign({ user_id: state.user.id }, row));
      setBusy(btn, false);
      if (res.error) {
        err.querySelector("span").textContent = problem(res.error);
        err.hidden = false;
        return;
      }
      if (setup) { await Dumpy.goHome(); return; }
      state.profile = p = Object.assign({}, p, row);
      $("#profile-person").hidden = false;
      summary();
      note.hidden = false;
    });
  }

  /* ---------- Sign in ---------- */
  function initSignIn() {
    var params = new URLSearchParams(location.search);
    if (params.get("link") === "expired") $("#link-expired").hidden = false;

    var form = $("#sign-in-form");
    var err = $("#sign-in-error");
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      err.hidden = true;
      var email = $("#email").value.trim();
      if (!email) { $("#email").focus(); return; }
      var btn = form.querySelector("button[type=submit]");
      setBusy(btn, true, "Sending…");
      var res = await db().auth.signInWithOtp({
        email: email,
        options: { emailRedirectTo: new URL(ROOT || "./", location.href).href }
      });
      setBusy(btn, false);
      if (res.error) {
        err.querySelector("span").textContent = problem(res.error);
        err.hidden = false;
        return;
      }
      $("#sent-email").textContent = email;
      showStep("step-sent");
    });
    $("#use-other").addEventListener("click", function () {
      showStep("step-form");
      $("#email").focus();
    });
  }

  /* ---------- Join, and the waiting screen ---------- */
  function initJoin(state) {
    var waiting = state.memberships.filter(function (m) { return m.status === "pending"; })[0];
    var suspended = state.memberships.filter(function (m) { return m.status === "suspended"; })[0];
    $("#signed-in-as").textContent = state.user.email || "";
    wireSignOut();

    if (state.status === "member") {
      $("#join-lead").textContent = "Have an invite code for another society? Enter it here.";
      $("#join-back").hidden = false;
    }

    if (state.status === "pending" || (state.status === "member" && waiting && /[?&]waiting=1/.test(location.search))) {
      $("#wait-society").textContent = waiting.society_name;
      showStep("step-wait", true);
      $("#cancel-request").addEventListener("click", async function () {
        if (!confirm("Cancel your request to join " + waiting.society_name + "?")) return;
        var btn = this;
        setBusy(btn, true, "Cancelling…");
        var res = await db().from("memberships").delete()
          .eq("user_id", state.user.id).eq("society_id", waiting.society_id);
        if (res.error) { setBusy(btn, false); alert(problem(res.error)); return; }
        await Dumpy.goHome();
      });
    } else if (state.status === "suspended") {
      $("#susp-society").textContent = suspended.society_name;
      showStep("step-suspended", true);
    } else {
      showStep("step-form", true);
    }

    document.querySelectorAll("[data-check-again]").forEach(function (b) {
      b.addEventListener("click", async function () {
        setBusy(b, true, "Checking…");
        await Dumpy.goHome();
      });
    });

    var form = $("#join-form");
    var err = $("#join-error");
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      err.hidden = true;
      var code = $("#code").value.replace(/\s+/g, "").toUpperCase();
      if (!code) { $("#code").focus(); return; }
      var btn = form.querySelector("button[type=submit]");
      setBusy(btn, true, "Joining…");
      var res = await db().rpc("join_society", { p_invite_code: code });
      setBusy(btn, false);
      if (res.error) {
        err.querySelector("span").textContent = res.error.code === "P0002"
          ? "That code doesn't match any society. Check it with your society admin."
          : problem(res.error);
        err.hidden = false;
        $("#code").focus();
        return;
      }
      var row = res.data && res.data[0];
      if (row && row.status === "approved") {
        Dumpy.chooseSociety(row.society_id);
        location.replace("../index.html");
      } else {
        location.replace("join.html?waiting=1");
      }
    });
  }

  /* ---------- Admin ---------- */
  async function initAdmin(state) {
    var sid = state.society.society_id;
    $("#admin-society").textContent = state.society.society_name;

    // Invite code
    var soc = await db().from("societies").select("invite_code").eq("id", sid).single();
    if (!soc.error) $("#invite-code").textContent = soc.data.invite_code;
    $("#copy-code").addEventListener("click", async function () {
      var code = $("#invite-code").textContent;
      try { await navigator.clipboard.writeText(code); this.textContent = "Copied"; }
      catch (e) { this.textContent = "Copy failed"; }
      var b = this;
      setTimeout(function () { b.textContent = "Copy"; }, 2000);
    });

    async function load() {
      var res = await db().rpc("admin_list_members", { p_society_id: sid });
      if (res.error) {
        $("#pending").innerHTML = '<li class="empty"><p>' + esc(problem(res.error)) + "</p></li>";
        return;
      }
      var rows = res.data || [];
      var pending = rows.filter(function (m) { return m.status === "pending"; });
      var members = rows.filter(function (m) { return m.status !== "pending"; });

      $("#pending-count").textContent = pending.length ? pending.length + " new" : "";
      $("#pending-count").hidden = !pending.length;
      $("#pending").innerHTML = pending.length ? pending.map(function (m) {
        return '<li class="row-card" data-user="' + esc(m.user_id) + '" data-name="' + esc(m.display_name || "this person") + '">' +
          '<div class="person"><span class="avatar" aria-hidden="true">' + initial(m.display_name) + "</span>" +
          '<div class="row-card__main"><p class="person__name">' + esc(m.display_name || "No name yet") + "</p>" +
          '<p class="person__meta">' + esc(whereText(m)) + " · asked " + timeAgo(m.requested_at) + "</p></div></div>" +
          '<div class="btn-row"><button type="button" class="btn btn--primary btn--sm" data-act="approve">Approve</button>' +
          '<button type="button" class="btn btn--danger btn--sm" data-act="reject">Reject</button></div></li>';
      }).join("") : '<li class="card-box empty"><p>Nobody is waiting. Share the invite code above with neighbours.</p></li>';

      $("#member-count").textContent = plural(members.length, "member", "members");
      $("#members").innerHTML = members.map(function (m) {
        return '<li class="row-card"><div class="person"><span class="avatar" aria-hidden="true">' + initial(m.display_name) + "</span>" +
          '<div class="row-card__main"><p class="person__name">' + esc(m.display_name || "No name yet") +
          (m.user_id === state.user.id ? ' <span class="person__meta">(you)</span>' : "") + "</p>" +
          '<p class="person__meta">' + esc(whereText(m)) + "</p></div>" +
          statusPill(m.status === "approved" ? (m.role === "admin" ? "admin" : "approved") : m.status) + "</div></li>";
      }).join("");
    }

    function whereText(m) {
      return [tower(m.tower), m.flat].filter(Boolean).join(", ") || "No flat given";
    }

    $("#pending").addEventListener("click", async function (e) {
      var btn = e.target.closest("button[data-act]");
      if (!btn) return;
      var li = btn.closest("[data-user]");
      var userId = li.dataset.user;
      var approve = btn.dataset.act === "approve";
      if (!approve && !confirm("Reject " + li.dataset.name + "'s request to join?")) return;
      li.querySelectorAll("button").forEach(function (b) { b.disabled = true; });
      setBusy(btn, true, approve ? "Approving…" : "Rejecting…");
      var q = db().from("memberships");
      var res = approve
        ? await q.update({ status: "approved" }).eq("society_id", sid).eq("user_id", userId).select("user_id")
        : await q.delete().eq("society_id", sid).eq("user_id", userId).select("user_id");
      if (res.error || !res.data || !res.data.length) {
        alert(res.error ? problem(res.error) : "That did not work. Reload the page and try again.");
      }
      await load();
    });

    await load();
  }

  var ICON_INFO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>';
  var ICON_BOX = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="m3 7.5 9 4.5 9-4.5M12 12v9"/></svg>';

  var pages = {
    feed: initHome, item: initItem, "my-items": initMyItems, post: initPost,
    profile: initProfile, "sign-in": initSignIn, join: initJoin, admin: initAdmin
  };
  var init = pages[body.dataset.page];
  if (init && Dumpy.ready) {
    Dumpy.ready.then(init).catch(function (err) { console.error(err); });
  }

  // Shared helpers for later stages.
  Dumpy.render = { esc: esc, timeAgo: timeAgo, rupees: rupees, priceBadge: priceBadge, itemCard: itemCard, statusPill: statusPill, photo: photo, problem: problem };
})();
