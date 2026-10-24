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
    pending: "Waiting", accepted: "Reserved for you", declined: "Not picked", cancelled: "Cancelled",
    gone: "Gone to someone else",
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
        '<p class="item-card__meta">' + (l.from ? esc(l.from) + " · " : l.owner.tower ? esc(tower(l.owner.tower)) + " · " : "") + timeAgo(l.created_at) + "</p>" +
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

    // Societies that share items with this one (stage 12): a "Nearby" chip
    // shows their items marked for nearby societies.
    var nearby = [];
    try {
      nearby = (await Dumpy.data.nearbySocieties(state.society.society_id))
        .filter(function (n) { return n.status === "linked"; });
    } catch (err) { console.error(err); }
    var nearbyName = {};
    nearby.forEach(function (n) { nearbyName[n.society_id] = n.name; });

    var options = [["all", "All"], ["free", "Free"], ["paid", "Paid"]]
      .concat(nearby.length ? [["nearby", "Nearby societies"]] : [])
      .concat(Dumpy.data.CATEGORIES);
    chips.innerHTML = options.map(function (c) {
      return '<button type="button" class="chip" aria-pressed="' + (c[0] === "all") + '" data-filter="' + esc(c[0]) + '">' + esc(c[1]) + "</button>";
    }).join("");

    var more = $("#load-more");
    var wanted = 0; // bumps on every new search or filter, so late answers are ignored
    var shown = 0;

    // Load the first page (fresh) or the next one (append).
    async function load(append) {
      var ticket = append ? wanted : ++wanted;
      var q = search.value.trim();
      if (!append) { shown = 0; meta.textContent = "Loading items…"; }
      more.disabled = true;
      more.textContent = "Loading…";
      var page;
      try {
        page = await Dumpy.data.feed(state.society.society_id, {
          filter: filter, q: q, offset: shown,
          nearby: nearby.map(function (n) { return n.society_id; })
        });
      } catch (err) {
        if (ticket !== wanted) return;
        more.disabled = false;
        more.textContent = "Load more";
        meta.textContent = problem(err);
        return;
      }
      if (ticket !== wanted) return;
      more.disabled = false;
      more.textContent = "Load more";
      page.items.forEach(function (l) {
        if (l.society_id !== state.society.society_id) l.from = nearbyName[l.society_id] || "Nearby society";
      });
      var html = page.items.map(function (l, i) { return itemCard(l, shown + i); }).join("");
      shown += page.items.length;
      if (append) grid.insertAdjacentHTML("beforeend", html);
      else if (shown) grid.innerHTML = html;
      else {
        var filtered = q || filter !== "all";
        grid.innerHTML = '<li class="empty" style="grid-column:1/-1"><p>' +
          (filter === "nearby" && !q ? "Nearby societies have not shared anything right now." :
           filtered ? "Nothing matches. Try another word or filter." : "Nothing here yet. Be the first to post something.") +
          '</p><a class="btn btn--primary" href="pages/post.html">Post an item</a></li>';
      }
      more.hidden = !page.more;
      meta.textContent = shown
        ? (page.more ? "Newest " + shown + " items" : plural(shown, "item", "items")) + (q ? " matching “" + q + "”" : "") +
          (filter === "nearby" ? " from nearby societies" : " in " + state.society.society_name)
        : "";
    }

    chips.addEventListener("click", function (e) {
      var b = e.target.closest(".chip");
      if (!b || b.dataset.filter === filter) return;
      filter = b.dataset.filter;
      chips.querySelectorAll(".chip").forEach(function (c) { c.setAttribute("aria-pressed", String(c === b)); });
      load(false);
    });
    var typing = null;
    search.addEventListener("input", function () {
      clearTimeout(typing);
      typing = setTimeout(function () { load(false); }, 300);
    });
    $("#search-form").addEventListener("submit", function (e) {
      e.preventDefault();
      clearTimeout(typing);
      search.blur();
      load(false);
    });
    more.addEventListener("click", function () { load(true); });

    await load(false);
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

    var params = new URLSearchParams(location.search);
    if (params.get("posted") || params.get("saved")) {
      var note = $("#posted-note");
      note.querySelector("span").textContent = params.get("posted")
        ? "Your item is posted. Neighbours in your society can see it now."
        : "Changes saved.";
      note.hidden = false;
      history.replaceState(null, "", "item.html?id=" + encodeURIComponent(l.id));
    }

    var btn = $("#want-btn");
    $("#action-price").textContent = priceText(l.price_inr);
    var head = main.querySelector(".item-head");
    var ownerSection = main.querySelector('[aria-labelledby="owner-h"]');

    // An item a nearby society shared (stage 12): look, but no asking. Requests,
    // names and flats stay inside each society.
    var inMySociety = state.memberships.some(function (m) { return m.society_id === l.society_id && m.status === "approved"; });
    if (!inMySociety) {
      var from = "a nearby society";
      try {
        var linked = await Dumpy.data.nearbySocieties(state.society.society_id);
        linked.forEach(function (n) { if (n.society_id === l.society_id) from = n.name; });
      } catch (e2) { console.error(e2); }
      var pick = main.querySelectorAll(".facts > div")[2];
      if (pick) pick.querySelector("dd").textContent = from;
      ownerSection.outerHTML = '<section class="section stack-sm" aria-labelledby="owner-h">' +
        '<h2 id="owner-h">From a nearby society</h2>' +
        '<div class="person"><span class="avatar" aria-hidden="true">' + initial(from) + "</span>" +
        '<div><p class="person__name">' + esc(from) + '</p><p class="person__meta">Shares items with ' + esc(state.society.society_name) + "</p></div></div>" +
        '<p class="small muted">Requests stay inside each society, so you can\'t ask for this on Dumpy. If you know someone in ' + esc(from) +
        ", they can ask for it for you.</p></section>";
      var info = main.querySelector(".section:last-child .notice p");
      if (info) info.textContent = "Only members of " + from + " can ask for this item. Dumpy never holds money.";
      btn.textContent = "In a nearby society";
      btn.disabled = true;
      return;
    }

    if (l.owner_id === state.user.id) {
      if (l.status !== "available") head.insertAdjacentHTML("beforeend", statusPill(l.status));
      if (l.status === "hidden") { btn.textContent = "Hidden by your admin"; btn.disabled = true; return; }

      if (l.status === "reserved" || l.status === "done") {
        var c = await Dumpy.data.contact(l.id).catch(function () { return null; });
        if (Dumpy.pay) await Dumpy.pay.loadStatus([l]);
        ownerSection.outerHTML = contactCard(c, l, true);
        if (l.status === "done") { btn.textContent = "Handed over"; btn.disabled = true; return; }
        btn.textContent = "Mark handed over";
        btn.dataset.act = "handed";
        main.querySelector(".contact").insertAdjacentHTML("beforeend",
          '<button type="button" class="btn btn--danger btn--block" data-act="cancel">Cancel reservation</button>');
        var act = async function (e) {
          var b = e.currentTarget;
          if (await ownerAct(b.dataset.act, l, c && c.display_name, b)) location.reload();
        };
        btn.addEventListener("click", act);
        main.querySelector('.contact [data-act="cancel"]').addEventListener("click", act);
        mountDelivery(main);
        return;
      }

      // Available (or withdrawn): edit it here; pick a requester in My items.
      var edit = document.createElement("a");
      edit.className = btn.className;
      edit.id = "edit-btn";
      edit.href = "post.html?id=" + encodeURIComponent(l.id);
      edit.textContent = "Edit item";
      btn.replaceWith(edit);
      if (l.status === "available") {
        var waiting = (await Dumpy.data.requestsOn(l.id).catch(function () { return []; }))
          .filter(function (r) { return r.status === "pending"; }).length;
        if (waiting) {
          head.insertAdjacentHTML("afterend", '<a class="notice notice--link" href="my-items.html">' + ICON_INFO +
            "<span>" + plural(waiting, "neighbour has", "neighbours have") + " asked for this. Choose who gets it in My items.</span></a>");
        }
      }
      return;
    }

    // Someone else's item.
    if (Dumpy.moderation) Dumpy.moderation.reportLink(l, state);
    var mine = await Dumpy.data.myRequest(l.id, state.user.id).catch(function () { return null; });
    var accepted = mine && mine.status === "accepted";
    if (accepted && (l.status === "reserved" || l.status === "done")) {
      head.insertAdjacentHTML("beforeend", statusPill(l.status === "done" ? "done" : "accepted"));
      var oc = await Dumpy.data.contact(l.id).catch(function () { return null; });
      if (Dumpy.pay) await Dumpy.pay.loadStatus([l]);
      ownerSection.outerHTML = contactCard(oc, l, false);
      mountDelivery(main);
      btn.textContent = l.status === "done" ? "Handed over to you" : "Reserved for you";
      btn.disabled = true;
      return;
    }
    if (l.status === "reserved") { btn.textContent = "Reserved for someone else"; btn.disabled = true; return; }
    if (l.status !== "available") { btn.textContent = "No longer available"; btn.disabled = true; return; }
    if (mine) {
      if (mine.status === "pending") $("#sent-note").hidden = false;
      btn.textContent = mine.status === "pending" ? "Request sent"
        : mine.status === "cancelled" ? "Your reservation was cancelled" : "The owner picked someone else";
      btn.disabled = true;
      return;
    }

    // "I want this": a short optional message, then the request.
    var sheet = $("#request-sheet");
    var form = $("#request-form");
    var err = $("#request-error");
    btn.addEventListener("click", function () {
      err.hidden = true;
      if (sheet.showModal) sheet.showModal(); else sheet.setAttribute("open", "");
      $("#request-msg").focus();
    });
    $("#sheet-cancel").addEventListener("click", function () { sheet.close(); });
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      err.hidden = true;
      var send = form.querySelector("button[type=submit]");
      setBusy(send, true, "Sending…");
      try {
        await Dumpy.data.requestItem(l, state.user.id, $("#request-msg").value.trim());
      } catch (ex) {
        setBusy(send, false);
        err.querySelector("span").textContent = problem(ex);
        err.hidden = false;
        return;
      }
      setBusy(send, false);
      sheet.close();
      btn.textContent = "Request sent";
      btn.disabled = true;
      $("#sent-note").hidden = false;
    });
  }

  /* ---------- Requests and handover (shared by the item page and My items) ---------- */

  // Indian mobile number for a wa.me link: digits only, with the 91 country code.
  function waNumber(phone) {
    var d = String(phone || "").replace(/\D/g, "");
    if (d.length === 11 && d.charAt(0) === "0") d = d.slice(1);
    if (d.length === 10) d = "91" + d;
    return d.length >= 11 ? d : null;
  }

  // The matched pair's contact details. c comes from get_contact (null when
  // the database gave nothing back).
  function contactCard(c, l, ownerView) {
    var title = ownerView ? (l.status === "done" ? "Handed over to" : "Reserved for") : "Contact the owner";
    var hid = "contact-h-" + esc(l.id);
    if (!c) {
      return '<section class="section stack-sm contact" aria-labelledby="' + hid + '"><h2 id="' + hid + '">' + title + "</h2>" +
        '<p class="muted">Contact details could not be loaded. Reload the page to try again.</p></section>';
    }
    var where = [tower(c.tower), c.flat ? "Flat " + c.flat : ""].filter(Boolean).join(" · ");
    var wa = waNumber(c.phone);
    var text = "Hi " + c.display_name + ", this is about “" + l.title + "” on Dumpy.";
    var buttons = wa
      ? '<div class="btn-row">' +
          '<a class="btn btn--primary" href="https://wa.me/' + wa + "?text=" + encodeURIComponent(text) + '" target="_blank" rel="noopener">' + ICON_CHAT + "WhatsApp</a>" +
          '<a class="btn btn--outline" href="tel:+' + wa + '">' + ICON_PHONE + "Call</a></div>"
      : '<p class="small muted">' + esc(c.display_name) + " has not added a phone number. " +
          (c.flat ? "Knock at flat " + esc(c.flat) + "." : "Ask your society admin how to reach them.") + "</p>";
    var hint = l.status === "done" ? "" : "Agree with " + esc(c.display_name) + " how and when it reaches " +
      (ownerView ? "their" : "your") + " flat.";
    // Stage 7: js/delivery.js fills this with the delivery plan.
    var delivery = l.status === "reserved"
      ? '<div data-delivery-for="' + esc(l.id) + '" data-role="' + (ownerView ? "owner" : "taker") + '" data-other="' + esc(c.display_name) + '"></div>'
      : "";
    return '<section class="section stack-sm contact" aria-labelledby="' + hid + '"><h2 id="' + hid + '">' + title + "</h2>" +
      '<div class="person"><span class="avatar" aria-hidden="true">' + initial(c.display_name) + "</span>" +
      '<div><p class="person__name">' + esc(c.display_name) + '</p><p class="person__meta">' + esc(where) + "</p></div></div>" +
      buttons + (hint ? '<p class="small muted">' + hint + "</p>" : "") +
      (Dumpy.pay ? Dumpy.pay.card(l, c, ownerView) : "") + delivery + "</section>";
  }

  function mountDelivery(root) { if (Dumpy.delivery) Dumpy.delivery.mount(root); }

  // Accept, Mark handed over, Cancel reservation. Asks first; returns true when done.
  async function ownerAct(act, l, name, btn) {
    var who = name || "this neighbour";
    var ask = {
      accept: "Give “" + l.title + "” to " + who + "? Everyone else who asked will see it's gone.",
      handed: "Mark “" + l.title + "” as handed over to " + who + "? This closes the item.",
      cancel: "Cancel " + who + "'s reservation? “" + l.title + "” goes back up, and the others who asked get their turn again."
    }[act];
    if (!confirm(ask)) return false;
    setBusy(btn, true, { accept: "Accepting…", handed: "Saving…", cancel: "Cancelling…" }[act]);
    try {
      if (act === "accept") await Dumpy.data.acceptRequest(btn.dataset.request);
      else if (act === "handed") await Dumpy.data.markHandedOver(l.id);
      else await Dumpy.data.cancelReservation(l.id);
    } catch (err) {
      setBusy(btn, false);
      alert(problem(err));
      return false;
    }
    return true;
  }

  /* ---------- My items ---------- */
  async function initMyItems(state, again) {
    var list = $("#listings");
    var mineReq = $("#my-requests");
    if (!again) {
      wireTabs();
      list.innerHTML = '<li class="empty"><p>Loading…</p></li>';
    }
    var d;
    try {
      d = await Dumpy.data.myItems(state.user.id, state.society.society_id);
    } catch (err) {
      list.innerHTML = '<li class="empty"><p>' + esc(problem(err)) + "</p></li>";
      return;
    }
    if (Dumpy.pay) await Dumpy.pay.loadStatus(d.listings.concat(d.outgoing.map(function (r) { return r.listing; })));

    list.innerHTML = d.listings.length ? d.listings.map(function (l) {
      var waiting = d.incoming.filter(function (r) { return r.listing_id === l.id && r.status === "pending"; });
      var extra = "";
      if (l.status === "available" && waiting.length) {
        extra = '<div class="requests"><p class="requests__title">' + plural(waiting.length, "person wants", "people want") + " this</p>" +
          waiting.map(function (r) {
            return '<div class="request"><div class="person"><span class="avatar" aria-hidden="true">' + initial(r.requester.display_name) + "</span>" +
              '<div class="row-card__main"><p class="person__name">' + esc(r.requester.display_name) +
              ' <span class="person__meta">· ' + esc(tower(r.requester.tower)) + " · " + timeAgo(r.created_at) + "</span></p>" +
              (r.message ? '<p class="request__msg">“' + esc(r.message) + "”</p>" : "") +
              '<div class="btn-row"><button type="button" class="btn btn--primary btn--sm" data-act="accept" data-request="' + esc(r.id) +
              '" data-name="' + esc(r.requester.display_name) + '" aria-label="Accept ' + esc(r.requester.display_name) + '">Accept</button></div>' +
              "</div></div></div>";
          }).join("") + "</div>";
      } else if (l.status === "reserved" || l.status === "done") {
        extra = '<div class="requests">' + contactCard(l.contact, l, true) +
          (l.status === "reserved"
            ? '<div class="btn-row"><button type="button" class="btn btn--primary btn--sm" data-act="handed">Mark handed over</button>' +
              '<button type="button" class="btn btn--danger btn--sm" data-act="cancel">Cancel reservation</button></div>'
            : "") + "</div>";
      }
      return '<li class="row-card" data-listing="' + esc(l.id) + '" data-title="' + esc(l.title) + '"' +
        (l.contact ? ' data-taker="' + esc(l.contact.display_name) + '"' : "") + '><div class="row-card__top">' +
        '<a class="row-card__thumb" href="item.html?id=' + esc(l.id) + '" tabindex="-1" aria-hidden="true">' + photo(l.photos[0], "") + "</a>" +
        '<div class="row-card__main"><a class="row-card__title" href="item.html?id=' + esc(l.id) + '"><span>' + esc(l.title) + "</span></a>" +
        '<p class="row-card__meta">' + priceText(l.price_inr) + " · posted " + timeAgo(l.created_at) + "</p>" +
        statusPill(l.status) + "</div></div>" + ownerActions(l) + extra + "</li>";
    }).join("") : '<li class="empty"><p>You have not posted anything yet.</p><a class="btn btn--primary" href="post.html">Post an item</a></li>';

    if (!again) list.addEventListener("click", async function (e) {
      var b = e.target.closest("button[data-act]");
      if (!b || b.disabled) return;
      var li = b.closest("[data-listing]");
      var id = li.dataset.listing;
      var act = b.dataset.act;
      if (act === "accept" || act === "handed" || act === "cancel") {
        var l = { id: id, title: li.dataset.title };
        if (await ownerAct(act, l, act === "accept" ? b.dataset.name : li.dataset.taker, b)) initMyItemsAgain(state);
        return;
      }
      var withdrawing = act === "withdraw";
      if (withdrawing && !confirm("Withdraw “" + li.dataset.title + "”? Neighbours will stop seeing it. You can post it again later.")) return;
      li.querySelectorAll("button").forEach(function (x) { x.disabled = true; });
      setBusy(b, true, withdrawing ? "Withdrawing…" : "Saving…");
      try {
        await (withdrawing ? Dumpy.data.withdraw(id) : Dumpy.data.relist(id));
      } catch (err) {
        setBusy(b, false);
        li.querySelectorAll("button").forEach(function (x) { x.disabled = false; });
        alert(problem(err));
        return;
      }
      initMyItemsAgain(state);
    });

    mineReq.innerHTML = d.outgoing.length ? d.outgoing.map(function (r) {
      var l = r.listing;
      if (!l) {
        // Withdrawn, expired or hidden: the database no longer shows it to you.
        return '<li class="row-card"><div class="row-card__top"><span class="row-card__thumb">' + photo(null, "") + "</span>" +
          '<div class="row-card__main"><p class="row-card__title"><span>An item that is no longer listed</span></p>' +
          '<p class="row-card__meta">Asked ' + timeAgo(r.created_at) + "</p>" + statusPill(r.status === "pending" ? "withdrawn" : r.status) + "</div></div></li>";
      }
      var gone = (l.status === "reserved" || l.status === "done") && r.status !== "accepted";
      var pill = gone ? "gone" : r.status === "accepted" && l.status === "done" ? "done" : r.status;
      var extra = r.status === "accepted" && l.contact !== undefined ? '<div class="requests">' + contactCard(l.contact, l, false) + "</div>" : "";
      return '<li class="row-card"><div class="row-card__top">' +
        '<a class="row-card__thumb" href="item.html?id=' + esc(l.id) + '" tabindex="-1" aria-hidden="true">' + photo(l.photos[0], "") + "</a>" +
        '<div class="row-card__main"><a class="row-card__title" href="item.html?id=' + esc(l.id) + '"><span>' + esc(l.title) + "</span></a>" +
        '<p class="row-card__meta">' + priceText(l.price_inr) + " · " + esc(l.owner.display_name) + (l.owner.tower ? ", " + esc(tower(l.owner.tower)) : "") + "</p>" +
        statusPill(pill) + "</div></div>" + extra + "</li>";
    }).join("") : '<li class="empty"><p>You have not asked for anything yet.</p><a class="btn btn--primary" href="../index.html">Browse items</a></li>';
    mountDelivery(list);
    mountDelivery(mineReq);
  }

  // Edit and Withdraw for available items; Edit and Post again for withdrawn
  // ones; Edit and Renew for expired ones. Reserved and handed-over items get Mark handed over and Cancel
  // reservation next to the taker's details instead.
  function ownerActions(l) {
    var edit = '<a class="btn btn--outline btn--sm" href="post.html?id=' + esc(l.id) + '">Edit</a>';
    if (l.status === "available") {
      return '<div class="btn-row">' + edit + '<button type="button" class="btn btn--danger btn--sm" data-act="withdraw">Withdraw</button></div>';
    }
    if (l.status === "withdrawn") {
      return '<div class="btn-row">' + edit + '<button type="button" class="btn btn--primary btn--sm" data-act="relist">Post again</button></div>';
    }
    if (l.status === "expired") {
      return '<p class="small muted row-card__note">Items come down after 30 days. Renew to show it to neighbours again.</p>' +
        '<div class="btn-row">' + edit + '<button type="button" class="btn btn--primary btn--sm" data-act="relist">Renew</button></div>';
    }
    if (l.status === "hidden") return '<p class="small muted row-card__note">Your society admin hid this item.</p>';
    return "";
  }

  // Redraw My items after a change, keeping the tab and scroll position.
  function initMyItemsAgain(state) {
    var y = window.scrollY;
    initMyItems(state, true).then(function () { window.scrollTo(0, y); });
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

    // The email also carries a short code. Typing it signs in right here,
    // which matters in the home-screen app: on iPhone it keeps its own
    // sign-in, separate from the browser that opens the email's link.
    var codeForm = $("#code-form");
    var codeErr = $("#code-error");
    codeForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      codeErr.hidden = true;
      var code = $("#code").value.replace(/\D/g, "");
      if (code.length < 6) {
        codeErr.querySelector("span").textContent = "Type the code from the email (6 or more digits).";
        codeErr.hidden = false;
        $("#code").focus();
        return;
      }
      var btn = codeForm.querySelector("button[type=submit]");
      setBusy(btn, true, "Signing in…");
      var res = await db().auth.verifyOtp({ email: $("#sent-email").textContent, token: code, type: "email" });
      if (res.error) {
        setBusy(btn, false);
        codeErr.querySelector("span").textContent = /expired|invalid/i.test(res.error.message || "")
          ? "That code is wrong or has expired. Check the newest email, or send a new one."
          : problem(res.error);
        codeErr.hidden = false;
        return;
      }
      await Dumpy.goHome();
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
          statusPill(m.status === "approved" ? (m.role === "admin" ? "admin" : "approved") : m.status) + "</div>" +
          memberAction(m) + "</li>";
      }).join("");
    }

    // Suspend or Restore anyone but yourself (stage 10). A suspended member
    // keeps their account but sees nothing until restored.
    function memberAction(m) {
      if (m.user_id === state.user.id) return "";
      var name = ' data-user="' + esc(m.user_id) + '" data-name="' + esc(m.display_name || "this person") + '"';
      return m.status === "suspended"
        ? '<div class="btn-row"><button type="button" class="btn btn--outline btn--sm" data-act="restore"' + name + ">Restore</button></div>"
        : '<div class="btn-row"><button type="button" class="btn btn--danger btn--sm" data-act="suspend"' + name + ">Suspend</button></div>";
    }

    $("#members").addEventListener("click", async function (e) {
      var btn = e.target.closest("button[data-act]");
      if (!btn || btn.disabled) return;
      var suspend = btn.dataset.act === "suspend";
      if (suspend && !confirm("Suspend " + btn.dataset.name + "? They will not be able to see or post items until you restore them.")) return;
      setBusy(btn, true, suspend ? "Suspending…" : "Restoring…");
      var res = await db().from("memberships").update({ status: suspend ? "suspended" : "approved" })
        .eq("society_id", sid).eq("user_id", btn.dataset.user).select("user_id");
      if (res.error || !res.data || !res.data.length) {
        alert(res.error ? problem(res.error) : "That did not work. Reload the page and try again.");
      }
      await load();
    });

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
  var ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-12.3 7.5L3 21l2-5.5A8.5 8.5 0 1 1 21 11.5z"/></svg>';
  var ICON_PHONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/></svg>';
  var ICON_BOX = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="m3 7.5 9 4.5 9-4.5M12 12v9"/></svg>';

  var pages = {
    feed: initHome, item: initItem, "my-items": initMyItems,
    profile: initProfile, "sign-in": initSignIn, join: initJoin, admin: initAdmin
  };
  var init = pages[body.dataset.page];
  if (init && Dumpy.ready) {
    Dumpy.ready.then(init).catch(function (err) { console.error(err); });
  }

  // Shared helpers for js/post.js and later stages.
  Dumpy.render = { esc: esc, timeAgo: timeAgo, rupees: rupees, priceBadge: priceBadge, itemCard: itemCard, statusPill: statusPill, photo: photo, problem: problem, setBusy: setBusy };
})();
