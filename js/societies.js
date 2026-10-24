/* More societies (stage 12):
     start.html      ask to start Dumpy in a new society, and see the answer
     platform.html   the people who run Dumpy approve or turn down new societies
     profile.html    switch between the societies you belong to
     join.html       a pending "start a society" request, if any
     admin.html      share items with nearby societies (link codes)
   As everywhere, the database decides what each person may see or do; this
   file only draws it. */
(function () {
  var Dumpy = window.Dumpy;
  if (!Dumpy || !Dumpy.ready) return;
  var R = Dumpy.render;
  var esc = R.esc;
  var db = Dumpy.db;
  var body = document.body;
  function $(sel) { return document.querySelector(sel); }
  function check(res) { if (res.error) throw res.error; return res.data; }
  function rpc(name, args) { return db.rpc(name, args || {}).then(check); }

  var REQUEST_LABEL = { pending: "Waiting for approval", approved: "Approved", rejected: "Not approved" };
  function requestPill(status) {
    var cls = status === "rejected" ? "rejected" : status === "approved" ? "approved" : "pending";
    return '<span class="status status--' + cls + '">' + esc(REQUEST_LABEL[status] || status) + "</span>";
  }
  function place(r) { return [r.city].filter(Boolean).join(""); }

  function showError(box, err) {
    box.querySelector("span").textContent = typeof err === "string" ? err : R.problem(err);
    box.hidden = false;
  }

  async function copy(btn, text) {
    try { await navigator.clipboard.writeText(text); btn.textContent = "Copied"; }
    catch (e) { btn.textContent = "Copy failed"; }
    setTimeout(function () { btn.textContent = "Copy"; }, 2000);
  }

  /* ---------- Start Dumpy in your society ---------- */
  async function initStart(state) {
    function step(id) {
      document.querySelectorAll("[data-step]").forEach(function (el) { el.hidden = el.id !== id; });
    }
    if (state.status === "signed-out") {
      step("step-intro");
      $("#start-sign-in").addEventListener("click", function () { Dumpy.comeBackTo("start"); });
      return;
    }
    step("step-form");
    $("#start-email").textContent = state.user.email || "";
    if (state.status !== "member") {
      $("#start-back").textContent = "Join a society with an invite code instead";
      $("#start-back").href = "join.html";
    }

    var list = $("#start-requests");
    async function load() {
      var rows = check(await db.from("society_requests")
        .select("id, name, city, status, society_id, note, created_at, decided_at")
        .order("created_at", { ascending: false }));
      $("#requests-box").hidden = !rows.length;
      list.innerHTML = rows.map(function (r) {
        var extra = "";
        if (r.status === "pending") {
          extra = '<p class="small muted row-card__note">The Dumpy team will look at it soon. Come back here to check.</p>' +
            '<div class="btn-row"><button type="button" class="btn btn--outline btn--sm" data-act="withdraw" data-id="' + esc(r.id) +
            '" data-name="' + esc(r.name) + '">Withdraw</button></div>';
        } else if (r.status === "approved" && r.society_id) {
          extra = '<p class="small muted row-card__note">You are its admin. Share its invite code from Society admin so neighbours can join.</p>' +
            '<div class="btn-row"><button type="button" class="btn btn--primary btn--sm" data-act="open" data-society="' + esc(r.society_id) + '">Open ' + esc(r.name) + "</button></div>";
        } else if (r.status === "rejected") {
          extra = r.note ? '<p class="small row-card__note">“' + esc(r.note) + "”</p>" : "";
        }
        return '<li class="row-card"><p class="person__name">' + esc(r.name) + "</p>" +
          '<p class="row-card__meta">' + esc(place(r)) + " · asked " + R.timeAgo(r.created_at) + "</p>" +
          requestPill(r.status) + extra + "</li>";
      }).join("");
    }

    list.addEventListener("click", async function (e) {
      var b = e.target.closest("button[data-act]");
      if (!b) return;
      if (b.dataset.act === "open") {
        Dumpy.chooseSociety(b.dataset.society);
        location.replace("admin.html");
        return;
      }
      if (!confirm("Withdraw your request to start " + b.dataset.name + "?")) return;
      R.setBusy(b, true, "Withdrawing…");
      var res = await db.from("society_requests").delete().eq("id", b.dataset.id).select("id");
      if (res.error || !res.data || !res.data.length) {
        R.setBusy(b, false);
        alert(res.error ? R.problem(res.error) : "It has already been answered. Reload the page to see the answer.");
      }
      await load();
    });

    var form = $("#start-form");
    var err = $("#start-error");
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      err.hidden = true;
      var name = $("#society-name").value.trim().replace(/\s+/g, " ");
      var city = $("#society-city").value.trim().replace(/\s+/g, " ");
      if (name.length < 2) { showError(err, "Enter your society's name."); $("#society-name").focus(); return; }
      if (city.length < 2) { showError(err, "Enter your city."); $("#society-city").focus(); return; }
      var btn = form.querySelector("button[type=submit]");
      R.setBusy(btn, true, "Sending…");
      var res = await db.rpc("request_society", { p_name: name, p_city: city });
      R.setBusy(btn, false);
      if (res.error) {
        showError(err, res.error.code === "23505" ? "You have already asked to start this society. See below." : res.error);
        return;
      }
      form.reset();
      await load();
      var first = list.querySelector("li");
      if (first) first.scrollIntoView({ block: "center" });
    });

    try { await load(); } catch (ex) { console.error(ex); }
  }

  /* ---------- Run Dumpy (platform admin) ---------- */
  async function initPlatform() {
    var yes = false;
    try { yes = await rpc("is_platform_admin"); } catch (ex) { console.error(ex); }
    if (!yes) { $("#not-platform").hidden = false; return; }
    $("#platform").hidden = false;
    var status = $("#platform-status");

    function card(r, actions) {
      return '<li class="row-card" data-id="' + esc(r.id) + '" data-name="' + esc(r.name) + '">' +
        '<p class="person__name">' + esc(r.name) + "</p>" +
        '<p class="row-card__meta">' + esc(r.city) + " · asked " + R.timeAgo(r.created_at) + "</p>" +
        '<p class="row-card__meta break">By ' + esc(r.requester_name || "someone without a name") + " · " + esc(r.contact_email) + "</p>" +
        (actions ? '<div class="btn-row"><button type="button" class="btn btn--primary btn--sm" data-act="approve">Approve</button>' +
          '<button type="button" class="btn btn--danger btn--sm" data-act="reject">Turn down</button></div>'
          : requestPill(r.status) + (r.note ? '<p class="small muted row-card__note">“' + esc(r.note) + "”</p>" : "")) +
        "</li>";
    }

    async function load() {
      var both = await Promise.all([rpc("platform_society_requests"), rpc("platform_societies")]);
      var rows = both[0] || [];
      var waiting = rows.filter(function (r) { return r.status === "pending"; });
      var answered = rows.filter(function (r) { return r.status !== "pending"; }).slice(0, 20);
      $("#waiting-count").textContent = waiting.length + " new";
      $("#waiting-count").hidden = !waiting.length;
      $("#waiting").innerHTML = waiting.length ? waiting.map(function (r) { return card(r, true); }).join("")
        : '<li class="card-box empty"><p>No new societies are waiting.</p></li>';
      $("#answered").innerHTML = answered.length ? answered.map(function (r) { return card(r, false); }).join("")
        : '<li class="card-box empty"><p>Nothing answered yet.</p></li>';
      var all = both[1] || [];
      $("#all-count").textContent = all.length + (all.length === 1 ? " society" : " societies");
      $("#all-societies").innerHTML = all.map(function (s) {
        return '<li class="row-card"><p class="person__name">' + esc(s.name) + "</p>" +
          '<p class="row-card__meta">' + esc(s.city || "City not given") + " · since " + R.timeAgo(s.created_at) + "</p></li>";
      }).join("");
    }

    $("#waiting").addEventListener("click", async function (e) {
      var b = e.target.closest("button[data-act]");
      if (!b || b.disabled) return;
      var li = b.closest("[data-id]");
      var approve = b.dataset.act === "approve";
      var note = "";
      if (approve) {
        if (!confirm("Start Dumpy for " + li.dataset.name + "? The person who asked becomes its admin.")) return;
      } else {
        note = prompt("Turn down " + li.dataset.name + "? You can add a short note they will see (optional).", "");
        if (note === null) return;
      }
      li.querySelectorAll("button").forEach(function (x) { x.disabled = true; });
      R.setBusy(b, true, approve ? "Approving…" : "Saving…");
      try {
        if (approve) {
          var made = await rpc("approve_society_request", { p_request_id: li.dataset.id });
          status.textContent = li.dataset.name + " is on Dumpy. Its invite code is " + ((made && made[0] && made[0].invite_code) || "on its admin page") + ".";
        } else {
          await rpc("reject_society_request", { p_request_id: li.dataset.id, p_note: note.trim().slice(0, 300) });
          status.textContent = "Turned down " + li.dataset.name + ".";
        }
        status.hidden = false;
      } catch (ex) {
        alert(R.problem(ex));
      }
      await load();
    });

    try { await load(); } catch (ex) {
      $("#waiting").innerHTML = '<li class="empty"><p>' + esc(R.problem(ex)) + "</p></li>";
    }
  }

  /* ---------- Profile: switch society, Run Dumpy link ---------- */
  async function initProfileExtras(state) {
    var approved = (state.memberships || []).filter(function (m) { return m.status === "approved"; });
    if (approved.length > 1 && state.society) {
      var listEl = $("#switch-list");
      listEl.innerHTML = approved.map(function (m) {
        return '<label class="choice"><input type="radio" name="society" value="' + esc(m.society_id) + '"' +
          (m.society_id === state.society.society_id ? " checked" : "") + "><span>" + esc(m.society_name) +
          (m.role === "admin" ? " (admin)" : "") + "</span></label>";
      }).join("");
      listEl.addEventListener("change", function (e) {
        if (!e.target.value) return;
        Dumpy.chooseSociety(e.target.value);
        location.replace("../index.html");
      });
      $("#switch-box").hidden = false;
    }
    try { $("#platform-link").hidden = !(await rpc("is_platform_admin")); } catch (ex) { console.error(ex); }
  }

  /* ---------- Join page: a society you asked to start ---------- */
  async function initJoinExtras(state) {
    if (state.status === "signed-out") return;
    var rows = [];
    try {
      rows = check(await db.from("society_requests").select("name, status").eq("status", "pending").limit(3));
    } catch (ex) { return; }
    if (!rows.length) return;
    var box = $("#start-waiting");
    box.querySelector("span").innerHTML = "You asked to start " + rows.map(function (r) { return "<strong>" + esc(r.name) + "</strong>"; }).join(", ") +
      ' on Dumpy. The Dumpy team will answer soon. <a href="start.html">See your request</a>';
    box.hidden = false;
  }

  /* ---------- Admin: nearby societies ---------- */
  async function initNearby(state) {
    var sid = state.society.society_id;
    var list = $("#nearby-list");
    var err = $("#link-error");

    rpc("society_link_code", { p_society_id: sid }).then(function (code) {
      $("#link-code").textContent = code || "Not available";
    }, function () { $("#link-code").textContent = "Not available"; });
    $("#copy-link-code").addEventListener("click", function () { copy(this, $("#link-code").textContent); });

    var WHAT = {
      linked: ["approved", "Sharing", "Stop sharing"],
      asked: ["pending", "Waiting for them", "Withdraw"],
      asking: ["pending", "Wants to share with you", "Decline"]
    };
    async function load() {
      var rows = await Dumpy.data.nearbySocieties(sid);
      var asking = rows.filter(function (r) { return r.status === "asking"; }).length;
      $("#nearby-count").textContent = asking + " new";
      $("#nearby-count").hidden = !asking;
      list.innerHTML = rows.map(function (r) {
        var w = WHAT[r.status];
        return '<li class="row-card" data-other="' + esc(r.society_id) + '" data-name="' + esc(r.name) + '">' +
          '<p class="person__name">' + esc(r.name) + "</p>" +
          '<p class="row-card__meta">' + esc(r.city || "") + "</p>" +
          '<span class="status status--' + w[0] + '">' + esc(w[1]) + "</span>" +
          '<div class="btn-row">' +
            (r.status === "asking" ? '<button type="button" class="btn btn--primary btn--sm" data-act="accept">Share with them</button>' : "") +
            '<button type="button" class="btn btn--' + (r.status === "linked" ? "danger" : "outline") + ' btn--sm" data-act="unlink">' + w[2] + "</button>" +
          "</div></li>";
      }).join("");
    }

    list.addEventListener("click", async function (e) {
      var b = e.target.closest("button[data-act]");
      if (!b || b.disabled) return;
      var li = b.closest("[data-other]");
      var accept = b.dataset.act === "accept";
      if (!accept && !confirm(b.textContent + " with " + li.dataset.name + "? Items stop showing across straight away.")) return;
      R.setBusy(b, true, "Saving…");
      try {
        await rpc(accept ? "accept_society_link" : "unlink_society", { p_society_id: sid, p_other_id: li.dataset.other });
      } catch (ex) { alert(R.problem(ex)); }
      await load();
    });

    $("#link-form").addEventListener("submit", async function (e) {
      e.preventDefault();
      err.hidden = true;
      var code = $("#link-input").value.replace(/\s+/g, "").toUpperCase();
      if (!code) { $("#link-input").focus(); return; }
      var btn = this.querySelector("button[type=submit]");
      R.setBusy(btn, true, "Asking…");
      var res = await db.rpc("link_society", { p_society_id: sid, p_link_code: code });
      R.setBusy(btn, false);
      if (res.error) {
        showError(err, res.error.code === "P0002" ? "That code doesn't match any society. Check it with their admin." : res.error);
        return;
      }
      $("#link-input").value = "";
      await load();
    });

    try { await load(); } catch (ex) { list.innerHTML = '<li class="empty"><p>' + esc(R.problem(ex)) + "</p></li>"; }
  }

  var page = body.dataset.page;
  Dumpy.ready.then(function (state) {
    if (page === "start") return initStart(state);
    if (page === "platform") return initPlatform(state);
    if (page === "profile") return initProfileExtras(state);
    if (page === "join") return initJoinExtras(state);
    if (page === "admin") return initNearby(state);
  }).catch(function (err) { console.error(err); });
})();
