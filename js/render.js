/* Renders Dumpy pages from data. Stage 3 feeds it js/mock.js; later stages
   can call the same functions with rows from Supabase.
   Each page sets <body data-page="..."> and data-root ("" or "../"). */
(function () {
  var D = window.DUMPY_MOCK;
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
    pending: "Waiting", accepted: "Accepted", declined: "Declined", cancelled: "Cancelled"
  };
  function statusPill(status) {
    return '<span class="status status--' + esc(status) + '">' + esc(STATUS_LABEL[status] || status) + "</span>";
  }

  function photo(path, alt, eager) {
    return '<img src="' + esc(url(path)) + '" alt="' + esc(alt) + '" width="400" height="400"' +
      (eager ? ' fetchpriority="high"' : ' loading="lazy"') + ' decoding="async">';
  }

  function findListing(id) {
    for (var i = 0; i < D.listings.length; i++) if (D.listings[i].id === id) return D.listings[i];
    return null;
  }

  /* ---------- Item card (feed) ---------- */
  function itemCard(l, index) {
    return '<li><a class="item-card" href="' + url("pages/item.html?id=" + encodeURIComponent(l.id)) + '">' +
      '<div class="item-card__photo">' + photo(l.photos[0], "", index < 4) + priceBadge(l.price_inr) + "</div>" +
      '<div class="item-card__body">' +
        '<h2 class="item-card__title">' + esc(l.title) + "</h2>" +
        '<p class="item-card__meta">' + esc(l.owner.tower) + " · " + timeAgo(l.created_at) + "</p>" +
      "</div></a></li>";
  }

  /* ---------- Home feed ---------- */
  function initFeed() {
    var grid = $("#feed");
    var search = $("#search");
    var chips = $("#chips");
    var meta = $("#feed-meta");
    var filter = "All";

    var labels = ["All", "Free", "Paid"].concat(D.categories);
    chips.innerHTML = labels.map(function (c) {
      return '<button type="button" class="chip" aria-pressed="' + (c === "All") + '" data-filter="' + esc(c) + '">' + esc(c) + "</button>";
    }).join("");

    function draw() {
      var q = search.value.trim().toLowerCase();
      var items = D.listings.filter(function (l) {
        if (l.status !== "available") return false;
        if (q && l.title.toLowerCase().indexOf(q) === -1) return false;
        if (filter === "Free") return l.price_inr === 0;
        if (filter === "Paid") return l.price_inr > 0;
        if (filter !== "All") return l.category === filter;
        return true;
      }).sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; });

      meta.textContent = items.length + (items.length === 1 ? " item" : " items") + " in " + D.society.name;
      grid.innerHTML = items.length
        ? items.map(itemCard).join("")
        : '<li class="empty" style="grid-column:1/-1"><p>Nothing here yet.</p><a class="btn btn--primary" href="pages/post.html">Post an item</a></li>';
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
    draw();
  }

  /* ---------- Item page ---------- */
  function initItem() {
    var id = new URLSearchParams(location.search).get("id") || "l-1";
    var l = findListing(id);
    var main = $("#item");
    if (!l) {
      main.innerHTML = '<div class="empty"><p>This item is no longer listed.</p><a class="btn btn--primary" href="../index.html">Back to Home</a></div>';
      $("#action-bar").hidden = true;
      return;
    }
    document.title = l.title + " · Dumpy";

    var slides = l.photos.map(function (p, i) {
      return '<figure class="gallery__slide">' + photo(p, l.title + ", photo " + (i + 1) + " of " + l.photos.length, i === 0) + "</figure>";
    }).join("");
    var dots = l.photos.length > 1
      ? '<div class="gallery__dots" aria-hidden="true">' + l.photos.map(function (_, i) {
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
        "<div><dt>Condition</dt><dd>" + esc(l.condition) + "</dd></div>" +
        "<div><dt>Category</dt><dd>" + esc(l.category) + "</dd></div>" +
        "<div><dt>Pick up from</dt><dd>" + esc(l.owner.tower) + "</dd></div>" +
        "<div><dt>Posted</dt><dd>" + timeAgo(l.created_at) + "</dd></div>" +
      "</dl>" +
      '<section class="section stack-sm" aria-labelledby="about-h">' +
        '<h2 id="about-h">About this item</h2><p>' + esc(l.description) + "</p>" +
      "</section>" +
      '<section class="section stack-sm" aria-labelledby="owner-h">' +
        '<h2 id="owner-h">Posted by</h2>' +
        '<div class="person"><span class="avatar" aria-hidden="true">' + initial(l.owner.display_name) + "</span>" +
        '<div><p class="person__name">' + esc(l.owner.display_name) + '</p><p class="person__meta">' + esc(l.owner.tower) + "</p></div></div>" +
        '<p class="small muted">Flat number and phone are shared only after the owner accepts your request.</p>' +
      "</section>" +
      '<section class="section"><div class="notice">' + ICON_INFO +
        "<p>" + (l.price_inr === 0
          ? "This item is free. Delivery can be by the owner, by you, or by a society helper."
          : "Pay the owner directly by UPI or cash at handover. Dumpy never holds money.") + "</p></div></section>";

    // Gallery dots follow the swipe.
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

    // Action button and request sheet.
    var btn = $("#want-btn");
    var sheet = $("#request-sheet");
    $("#action-price").textContent = priceText(l.price_inr);
    if (l.status !== "available") {
      btn.textContent = l.status === "reserved" ? "Reserved for someone" : "No longer available";
      btn.disabled = true;
      return;
    }
    $("#sheet-title").textContent = "Ask for “" + l.title + "”";
    btn.addEventListener("click", function () {
      if (sheet.showModal) sheet.showModal(); else sheet.setAttribute("open", "");
    });
    $("#sheet-cancel").addEventListener("click", function () { sheet.close(); });
    $("#request-form").addEventListener("submit", function (e) {
      e.preventDefault();
      sheet.close();
      btn.textContent = "Request sent";
      btn.disabled = true;
      $("#sent-note").hidden = false;
    });
  }

  /* ---------- My items ---------- */
  function initMyItems() {
    var mine = D.listings.filter(function (l) { return l.owner_id === D.me.user_id; });
    var myRequests = D.requests.filter(function (r) { return r.requester_id === D.me.user_id; });

    $("#listings").innerHTML = mine.length ? mine.map(function (l) {
      var reqs = D.requests.filter(function (r) { return r.listing_id === l.id; });
      var actions = "";
      if (l.status === "available") {
        actions = '<div class="btn-row"><a class="btn btn--outline btn--sm" href="post.html?edit=' + esc(l.id) + '">Edit</a>' +
          '<button type="button" class="btn btn--danger btn--sm">Withdraw</button></div>';
      } else if (l.status === "reserved") {
        actions = '<div class="btn-row"><button type="button" class="btn btn--primary btn--sm">Mark handed over</button>' +
          '<button type="button" class="btn btn--outline btn--sm">Cancel reservation</button></div>';
      }
      var reqHTML = "";
      if (reqs.length && l.status !== "done") {
        reqHTML = '<div class="requests"><p class="requests__title">' + reqs.length + (reqs.length === 1 ? " request" : " requests") + "</p>" +
          reqs.map(function (r) {
            return '<div class="request"><div class="person"><span class="avatar" aria-hidden="true">' + initial(r.requester.display_name) + "</span>" +
              '<div class="row-card__main"><p class="person__name">' + esc(r.requester.display_name) +
              ' <span class="person__meta">· ' + esc(r.requester.tower) + " · " + timeAgo(r.created_at) + "</span></p>" +
              (r.message ? '<p class="request__msg">“' + esc(r.message) + "”</p>" : "") +
              (r.status === "pending"
                ? '<div class="btn-row"><button type="button" class="btn btn--primary btn--sm">Accept</button></div>'
                : statusPill(r.status)) +
              "</div></div></div>";
          }).join("") + "</div>";
      }
      return '<li class="row-card"><div class="row-card__top">' +
        '<a class="row-card__thumb" href="item.html?id=' + esc(l.id) + '" tabindex="-1" aria-hidden="true">' + photo(l.photos[0], "") + "</a>" +
        '<div class="row-card__main"><a class="row-card__title" href="item.html?id=' + esc(l.id) + '"><span>' + esc(l.title) + "</span></a>" +
        '<p class="row-card__meta">' + priceText(l.price_inr) + " · posted " + timeAgo(l.created_at) + "</p>" +
        statusPill(l.status) + "</div></div>" + actions + reqHTML + "</li>";
    }).join("") : '<li class="empty"><p>You have not posted anything yet.</p><a class="btn btn--primary" href="post.html">Post an item</a></li>';

    $("#my-requests").innerHTML = myRequests.length ? myRequests.map(function (r) {
      var l = findListing(r.listing_id);
      return '<li class="row-card"><div class="row-card__top">' +
        '<a class="row-card__thumb" href="item.html?id=' + esc(l.id) + '" tabindex="-1" aria-hidden="true">' + photo(l.photos[0], "") + "</a>" +
        '<div class="row-card__main"><a class="row-card__title" href="item.html?id=' + esc(l.id) + '"><span>' + esc(l.title) + "</span></a>" +
        '<p class="row-card__meta">' + priceText(l.price_inr) + " · " + esc(l.owner.display_name) + ", " + esc(l.owner.tower) + "</p>" +
        statusPill(r.status) + "</div></div></li>";
    }).join("") : '<li class="empty"><p>You have not asked for anything yet.</p><a class="btn btn--primary" href="../index.html">Browse items</a></li>';

    // Tabs
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

  /* ---------- Post ---------- */
  function initPost() {
    var editId = new URLSearchParams(location.search).get("edit");
    var cat = $("#category");
    cat.innerHTML = '<option value="">Choose one</option>' + D.categories.map(function (c) {
      return "<option>" + esc(c) + "</option>";
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

    // Photo previews. Stage 5 adds shrinking and upload.
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

    if (editId) {
      var l = findListing(editId);
      if (l) {
        $("#post-title").textContent = "Edit item";
        $("#post-submit").textContent = "Save changes";
        $("#title").value = l.title;
        $("#description").value = l.description;
        cat.value = l.category;
        var cond = document.querySelector('input[name="condition"][value="' + l.condition + '"]');
        if (cond) cond.checked = true;
        free.checked = l.price_inr === 0;
        if (l.price_inr > 0) price.value = l.price_inr;
        l.photos.forEach(function (p) {
          var li = document.createElement("li");
          li.className = "photo-slot photo-slot--preview";
          li.innerHTML = photo(p, "");
          picker.insertBefore(li, addSlot);
        });
      }
    }
    syncPrice();

    $("#post-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var done = $("#post-done");
      done.hidden = false;
      done.focus();
    });
  }

  /* ---------- Profile ---------- */
  function initProfile() {
    var m = D.me;
    $("#profile-name").textContent = m.display_name;
    $("#profile-where").textContent = m.tower + ", " + m.flat + " · " + D.society.name;
    $("#profile-avatar").textContent = m.display_name.charAt(0);
    $("#display_name").value = m.display_name;
    $("#tower").value = m.tower;
    $("#flat").value = m.flat;
    $("#phone").value = m.phone;
    $("#upi_id").value = m.upi_id;
    $("#helper").checked = m.can_help_deliver;
    $("#emails").checked = m.emails_on;
    $("#email-shown").textContent = m.email;
    $("#admin-link").hidden = m.role !== "admin";
    $("#profile-form").addEventListener("submit", function (e) {
      e.preventDefault();
      $("#saved-note").hidden = false;
    });
  }

  /* ---------- Sign in and join ---------- */
  function initSignIn() {
    $("#sign-in-form").addEventListener("submit", function (e) {
      e.preventDefault();
      $("#sent-email").textContent = $("#email").value;
      $("#step-form").hidden = true;
      $("#step-sent").hidden = false;
      $("#step-sent h1").focus();
    });
    $("#use-other").addEventListener("click", function () {
      $("#step-sent").hidden = true;
      $("#step-form").hidden = false;
      $("#email").focus();
    });
  }

  function initJoin() {
    $("#join-form").addEventListener("submit", function (e) {
      e.preventDefault();
      $("#step-form").hidden = true;
      $("#step-wait").hidden = false;
      $("#step-wait h1").focus();
    });
  }

  var ICON_INFO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>';

  var pages = {
    feed: initFeed, item: initItem, "my-items": initMyItems, post: initPost,
    profile: initProfile, "sign-in": initSignIn, join: initJoin
  };
  if (pages[body.dataset.page]) pages[body.dataset.page]();

  // Shared helpers for later stages.
  window.DumpyRender = { esc: esc, timeAgo: timeAgo, rupees: rupees, priceBadge: priceBadge, itemCard: itemCard, statusPill: statusPill };
})();
