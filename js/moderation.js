/* Stage 10: reporting items, and the admin's Reported items queue.
   Loaded after js/render.js on the item page and the admin page.
   The database decides who may report, read reports or hide items
   (supabase/migrations/*_moderation.sql); this file only draws the controls. */
(function () {
  var Dumpy = window.Dumpy;
  if (!Dumpy || !Dumpy.db) return;
  var db = Dumpy.db;
  var R = Dumpy.render;
  var esc = R.esc;

  var REASONS = [
    ["not_allowed", "Not allowed", "Medicines, alcohol, weapons or anything else on the not-allowed list"],
    ["spam", "Spam", "Ads, repeats, or not a real item"],
    ["offensive", "Offensive", "Rude, hurtful or inappropriate"],
    ["other", "Other", "Something else is wrong"]
  ];
  function reasonLabel(v) {
    for (var i = 0; i < REASONS.length; i++) if (REASONS[i][0] === v) return REASONS[i][1];
    return v;
  }

  function check(res) {
    if (res.error) throw res.error;
    return res.data;
  }

  // "B" -> "Tower B", as on the other pages.
  function tower(t) {
    t = (t || "").trim();
    return !t || /^(tower|wing|block|building)\b/i.test(t) ? t : "Tower " + t;
  }

  /* ---------- Data ---------- */

  // The signed-in person's own report on an item, or null.
  async function myReport(listingId, userId) {
    var rows = check(await db.from("reports").select("id, reason, status")
      .eq("listing_id", listingId).eq("reporter_id", userId).limit(1));
    return rows[0] || null;
  }

  async function report(listing, userId, reason, note) {
    var res = await db.from("reports").insert({
      listing_id: listing.id, society_id: listing.society_id, reporter_id: userId,
      reason: reason, note: note || ""
    });
    if (res.error && res.error.code === "23505") throw new Error("You have already reported this item.");
    if (res.error && res.error.code === "42501") throw new Error("This item can't be reported any more. It may have been taken down already.");
    check(res);
  }

  // Open reports in the society, grouped by item, oldest first.
  async function queue(societyId) {
    var rows = check(await db.from("reports").select("id, listing_id, reason, note, created_at")
      .eq("society_id", societyId).eq("status", "open").order("created_at"));
    var byListing = {};
    var order = [];
    rows.forEach(function (r) {
      if (!byListing[r.listing_id]) { byListing[r.listing_id] = []; order.push(r.listing_id); }
      byListing[r.listing_id].push(r);
    });
    var listings = await Promise.all(order.map(function (id) { return Dumpy.data.listing(id).catch(function () { return null; }); }));
    return order.map(function (id, i) { return { listing: listings[i], id: id, reports: byListing[id] }; });
  }

  async function resolve(listingId, hide) {
    check(await db.rpc("resolve_reports", { p_listing_id: listingId, p_hide: hide }));
  }

  /* ---------- Item page: Report this item ---------- */

  var sheet = null;
  function buildSheet() {
    sheet = document.createElement("dialog");
    sheet.className = "sheet";
    sheet.id = "report-sheet";
    sheet.setAttribute("aria-labelledby", "report-title");
    sheet.innerHTML =
      '<div class="sheet__grip" aria-hidden="true"></div>' +
      '<form id="report-form" class="stack" novalidate>' +
        '<h2 id="report-title">Report this item</h2>' +
        '<p class="small muted">Your society admin sees the reason and decides whether to take it down. The owner is not told who reported it.</p>' +
        '<p class="notice notice--error" id="report-error" role="alert" hidden><span></span></p>' +
        '<fieldset class="fieldset"><legend class="label">What is wrong?</legend><div class="reasons">' +
          REASONS.map(function (r, i) {
            return '<label class="reason"><input type="radio" name="reason" value="' + r[0] + '"' + ">" +
              "<span><strong>" + esc(r[1]) + '</strong><span class="small muted">' + esc(r[2]) + "</span></span></label>";
          }).join("") +
        "</div></fieldset>" +
        '<div class="field"><label class="label" for="report-note">Anything to add? <span class="label__opt">(optional)</span></label>' +
          '<textarea class="textarea" id="report-note" maxlength="300"></textarea></div>' +
        '<p class="small"><a href="not-allowed.html">What is not allowed on Dumpy?</a></p>' +
        '<div class="btn-row">' +
          '<button type="button" class="btn btn--outline" id="report-cancel">Cancel</button>' +
          '<button type="submit" class="btn btn--primary">Send report</button>' +
        "</div>" +
      "</form>";
    document.body.appendChild(sheet);
    sheet.querySelector("#report-cancel").addEventListener("click", function () { sheet.close(); });
    sheet.querySelector(".reasons").addEventListener("change", function () { sheet.querySelector("#report-error").hidden = true; });
  }

  // Adds "Report this item" under someone else's item that is still up.
  async function reportLink(l, state) {
    if (l.owner_id === state.user.id || (l.status !== "available" && l.status !== "reserved")) return;
    var box = document.createElement("section");
    box.className = "section report-box";
    document.getElementById("item").appendChild(box);

    var done = function () {
      box.innerHTML = '<p class="small muted">You reported this item. Your society admin will take a look.</p>';
    };
    var mine = await myReport(l.id, state.user.id).catch(function () { return null; });
    if (mine) { done(); return; }

    box.innerHTML = '<button type="button" class="btn btn--quiet" id="report-btn">' + ICON_FLAG + "Report this item</button>";
    if (!sheet) buildSheet();
    var form = sheet.querySelector("form");
    var err = sheet.querySelector("#report-error");

    box.querySelector("#report-btn").addEventListener("click", function () {
      err.hidden = true;
      form.reset();
      if (sheet.showModal) sheet.showModal(); else sheet.setAttribute("open", "");
    });
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      err.hidden = true;
      var picked = form.querySelector('input[name="reason"]:checked');
      if (!picked) {
        err.querySelector("span").textContent = "Pick what is wrong with this item.";
        err.hidden = false;
        return;
      }
      var send = form.querySelector("button[type=submit]");
      R.setBusy(send, true, "Sending…");
      try {
        await report(l, state.user.id, picked.value, sheet.querySelector("#report-note").value.trim());
      } catch (ex) {
        R.setBusy(send, false);
        err.querySelector("span").textContent = R.problem(ex);
        err.hidden = false;
        return;
      }
      R.setBusy(send, false);
      sheet.close();
      done();
    });
  }

  /* ---------- Admin page: Reported items ---------- */

  async function adminQueue(state) {
    var list = document.getElementById("reports");
    var count = document.getElementById("reports-count");
    var sid = state.society.society_id;

    async function load() {
      var items;
      try {
        items = await queue(sid);
      } catch (err) {
        list.innerHTML = '<li class="card-box empty"><p>' + esc(R.problem(err)) + "</p></li>";
        return;
      }
      count.textContent = items.length ? items.length + " to check" : "";
      count.hidden = !items.length;
      list.innerHTML = items.length ? items.map(card).join("")
        : '<li class="card-box empty"><p>No reports. When a neighbour reports an item, it shows up here.</p></li>';
    }

    function card(it) {
      var l = it.listing;
      var reasons = {};
      it.reports.forEach(function (r) { reasons[r.reason] = (reasons[r.reason] || 0) + 1; });
      var summary = Object.keys(reasons).map(function (k) {
        return reasonLabel(k) + (reasons[k] > 1 ? " ×" + reasons[k] : "");
      }).join(", ");
      var notes = it.reports.filter(function (r) { return r.note; }).map(function (r) {
        return '<p class="request__msg">“' + esc(r.note) + "”</p>";
      }).join("");
      var n = it.reports.length;
      var title = l ? '<a class="row-card__title" href="item.html?id=' + esc(l.id) + '"><span>' + esc(l.title) + "</span></a>"
        : '<p class="row-card__title"><span>An item</span></p>';
      var who = l ? esc(l.owner.display_name) + (l.owner.tower ? ", " + esc(tower(l.owner.tower)) : "") + " · " + R.timeAgo(l.created_at) : "";
      return '<li class="row-card" data-listing="' + esc(it.id) + '" data-title="' + esc(l ? l.title : "this item") + '">' +
        '<div class="row-card__top">' +
          (l ? '<a class="row-card__thumb" href="item.html?id=' + esc(l.id) + '" tabindex="-1" aria-hidden="true">' + R.photo(l.photos[0], "") + "</a>"
             : '<span class="row-card__thumb">' + R.photo(null, "") + "</span>") +
          '<div class="row-card__main">' + title +
            '<p class="row-card__meta">' + who + "</p>" +
            (l && l.status !== "available" ? R.statusPill(l.status) : "") +
          "</div></div>" +
        '<div class="requests"><p class="requests__title">' + n + (n === 1 ? " report: " : " reports: ") + esc(summary) + "</p>" + notes + "</div>" +
        '<div class="btn-row">' +
          (l && l.status !== "hidden"
            ? '<button type="button" class="btn btn--danger-solid btn--sm" data-act="hide">Hide item</button>' : "") +
          '<button type="button" class="btn btn--outline btn--sm" data-act="dismiss">' + (l && l.status === "hidden" ? "Close reports" : "Dismiss") + "</button>" +
        "</div></li>";
    }

    list.addEventListener("click", async function (e) {
      var b = e.target.closest("button[data-act]");
      if (!b || b.disabled) return;
      var li = b.closest("[data-listing]");
      var hide = b.dataset.act === "hide";
      li.querySelectorAll("button").forEach(function (x) { x.disabled = true; });
      R.setBusy(b, true, hide ? "Hiding…" : "Dismissing…");
      try {
        await resolve(li.dataset.listing, hide);
      } catch (err) {
        alert(R.problem(err));
      }
      var status = document.getElementById("reports-status");
      status.textContent = hide ? "“" + li.dataset.title + "” is hidden. Only its owner and admins can see it now."
        : "Reports on “" + li.dataset.title + "” dismissed.";
      status.hidden = false;
      await load();
    });

    await load();
  }

  var ICON_FLAG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 22V4M4 4h13l-2 4 2 4H4"/></svg>';

  Dumpy.moderation = { REASONS: REASONS, reportLink: reportLink, adminQueue: adminQueue };

  // The admin page's queue draws itself; the item page's Report button is
  // added by js/render.js once the item has loaded.
  if (Dumpy.ready && document.body.dataset.page === "admin") Dumpy.ready.then(adminQueue);
})();
