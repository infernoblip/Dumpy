/* Delivery (stage 7): how an item gets from the owner's flat to the taker's.
   Loaded after js/render.js on the item, My items, profile and jobs pages.

   * The delivery card: render.js leaves an empty
       <div data-delivery-for="<listing id>" data-role="owner|taker" data-other="<name>">
     next to the matched pair's contact details, then calls Dumpy.delivery.mount().
   * The "I can help deliver" switch on the profile page.
   * The jobs page (pages/jobs.html): a helper's own jobs and the open ones.

   Who may see or change what is decided by the database functions in
   supabase/migrations/*_delivery.sql. This file only draws. */
(function () {
  var Dumpy = window.Dumpy;
  if (!Dumpy || !Dumpy.db || !Dumpy.render) return;
  var db = Dumpy.db;
  var R = Dumpy.render;
  var esc = R.esc;
  var body = document.body;

  /* ---------- Time slots (always Indian time, whatever the phone says) ---------- */
  var TZ = "Asia/Kolkata";
  var IST_OFFSET_MIN = 330; // India has no daylight saving
  var HOURS = [8, 10, 12, 14, 16, 18, 20]; // slot start hours; each slot is 2 hours

  // Today's date in India as [year, month (1-12), day].
  function istToday() {
    var p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date()).split("-");
    return [+p[0], +p[1], +p[2]];
  }
  // The moment a slot starts: day 0 = today, 1 = tomorrow, at hour (IST).
  function slotStart(day, hour) {
    var t = istToday();
    return new Date(Date.UTC(t[0], t[1] - 1, t[2] + day, hour, 0) - IST_OFFSET_MIN * 60000);
  }
  function slotOpen(day, hour) { return slotStart(day, hour + 2).getTime() > Date.now(); }

  function hourText(h) {
    var hh = h % 12 || 12;
    return hh + (h < 12 || h === 24 ? " am" : " pm");
  }
  // "8–10 am", "10 am–12 pm", "6–8 pm"
  function windowText(h) {
    var a = hourText(h), b = hourText(h + 2);
    return a.slice(-2) === b.slice(-2) ? a.slice(0, -3) + "–" + b : a + "–" + b;
  }
  // Which day (0 today, 1 tomorrow, other) and hour (IST) a slot starts at.
  function slotParts(iso) {
    var d = new Date(new Date(iso).getTime() + IST_OFFSET_MIN * 60000);
    var t = istToday();
    var day = Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(t[0], t[1] - 1, t[2])) / 864e5);
    return { day: day, hour: d.getUTCHours(), date: d };
  }
  // "Today, 6–8 pm", "Tomorrow, 10 am–12 pm", "Sat 25 Oct, 2–4 pm"
  function slotText(iso) {
    var s = slotParts(iso);
    var dayText = s.day === 0 ? "Today" : s.day === 1 ? "Tomorrow" : s.day === -1 ? "Yesterday"
      : new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(s.date);
    return dayText + ", " + windowText(s.hour);
  }

  /* ---------- Small helpers (same rules as render.js) ---------- */
  function tower(t) {
    t = (t || "").trim();
    return !t || /^(tower|wing|block|building)\b/i.test(t) ? t : "Tower " + t;
  }
  function waNumber(phone) {
    var d = String(phone || "").replace(/\D/g, "");
    if (d.length === 11 && d.charAt(0) === "0") d = d.slice(1);
    if (d.length === 10) d = "91" + d;
    return d.length >= 11 ? d : null;
  }
  function initial(name) { return esc((name || "?").charAt(0).toUpperCase()); }
  function check(res) { if (res.error) throw res.error; return res.data; }

  // WhatsApp and Call buttons for someone, or a note when they have no phone.
  function reachButtons(name, phone, flat, text) {
    var wa = waNumber(phone);
    if (!wa) {
      return '<p class="small muted">' + esc(name) + " has not added a phone number." +
        (flat ? " Knock at flat " + esc(flat) + "." : "") + "</p>";
    }
    return '<div class="btn-row">' +
      '<a class="btn btn--primary btn--sm" href="https://wa.me/' + wa + "?text=" + encodeURIComponent(text) + '" target="_blank" rel="noopener">' + ICON_CHAT + "WhatsApp</a>" +
      '<a class="btn btn--outline btn--sm" href="tel:+' + wa + '">' + ICON_PHONE + "Call</a></div>";
  }

  /* ---------- Data ---------- */
  var feeAsk = null;
  async function rpc(name, args) { return check(await db.rpc(name, args)); }
  var api = {
    get: async function (listingId) { return (await rpc("get_delivery", { p_listing_id: listingId }) || [])[0] || null; },
    arrange: function (listingId, mode, start, tip) {
      return rpc("arrange_delivery", { p_listing_id: listingId, p_mode: mode, p_slot_start: start, p_tip_note: tip || "" });
    },
    cancel: function (id) { return rpc("cancel_delivery", { p_delivery_id: id }); },
    claim: function (id) { return rpc("claim_delivery", { p_delivery_id: id }); },
    release: function (id) { return rpc("release_delivery", { p_delivery_id: id }); },
    delivered: function (id) { return rpc("mark_delivered", { p_delivery_id: id }); },
    openJobs: function (societyId) { return rpc("open_delivery_jobs", { p_society_id: societyId }); },
    myJobs: function (societyId) { return rpc("my_delivery_jobs", { p_society_id: societyId }); },
    // Today's Dumpy fee for a helper delivery (0 = off). Asked once per page;
    // if it fails (for example the fee migration is not applied yet), it is 0.
    fee: function () {
      if (!feeAsk) feeAsk = db.rpc("delivery_fee").then(function (r) { return r.error ? 0 : +r.data || 0; }, function () { return 0; });
      return feeAsk;
    },
    markFeePaid: function (id) { return rpc("mark_delivery_fee_paid", { p_delivery_id: id }); },
    isHelper: async function (societyId) {
      var rows = check(await db.from("delivery_helpers").select("user_id").eq("society_id", societyId).limit(1));
      return rows.length > 0;
    },
    setHelper: async function (societyId, userId, on) {
      if (on) {
        var res = await db.from("delivery_helpers").insert({ society_id: societyId, user_id: userId });
        if (res.error && res.error.code !== "23505") throw res.error; // already on is fine
      } else {
        check(await db.from("delivery_helpers").delete().eq("society_id", societyId).eq("user_id", userId));
      }
    }
  };

  /* ---------- The delivery card ---------- */
  var STATUS = {
    planned: ["Planned", "accepted"],
    waiting: ["Needs a helper", "pending"],
    claimed: ["Helper found", "accepted"],
    delivered: ["Delivered", "done"],
    cancelled: ["Cancelled", "cancelled"]
  };
  function pill(key) {
    return '<span class="status status--' + STATUS[key][1] + '">' + STATUS[key][0] + "</span>";
  }
  function stateKey(d) {
    if (d.status === "open") return d.mode === "helper" ? "waiting" : "planned";
    return d.status;
  }

  // What each mode means, said from where the viewer stands.
  function modeText(mode, role, other, summary) {
    var them = other || (role === "owner" ? "The taker" : "The owner");
    if (mode === "helper") return "A neighbour helper brings it";
    if (role === "owner") {
      return mode === "owner_delivers" ? (summary ? "You bring it over" : "I'll bring it over") : them + " collects it";
    }
    return mode === "owner_delivers" ? them + " brings it over" : (summary ? "You collect it" : "I'll collect it");
  }

  function mount(root) {
    (root || document).querySelectorAll("[data-delivery-for]").forEach(function (box) {
      if (box.dataset.mounted) return;
      box.dataset.mounted = "1";
      box.className = "delivery";
      load(box);
    });
  }

  async function load(box) {
    box.innerHTML = '<div class="card-box"><p class="small muted">Loading delivery…</p></div>';
    var d;
    try { d = await api.get(box.dataset.deliveryFor); }
    catch (err) {
      box.innerHTML = '<div class="card-box"><p class="small muted">' + esc(R.problem(err)) + "</p></div>";
      return;
    }
    if (d && (d.status === "open" || d.status === "claimed")) showPlan(box, d);
    else if (d && d.status === "delivered") showDelivered(box, d);
    else if (box.dataset.listingStatus === "done") box.innerHTML = ""; // handed over without a delivery plan
    else showForm(box, null);
  }

  function showDelivered(box, d) {
    box.innerHTML = '<div class="card-box stack-sm"><div class="delivery__head"><h3>Delivery</h3>' + pill("delivered") + "</div>" +
      '<p class="small muted">' + (d.helper_name ? "Brought over by " + esc(d.helper_name) + "." : "It has reached its new home.") + "</p>" +
      feeBox(d, box.dataset.other) + "</div>";
    var paid = box.querySelector('[data-dact="feepaid"]');
    if (paid) paid.addEventListener("click", async function () {
      if (!confirm("Mark the " + rupees(d.fee_inr) + " Dumpy fee as paid? Only do this once the money has gone from your UPI app, or you have paid in cash.")) return;
      R.setBusy(this, true, "Saving…");
      try { await api.markFeePaid(d.id); }
      catch (err) { R.setBusy(this, false); alert(R.problem(err)); return; }
      load(box);
    });
  }

  /* ---------- Dumpy's delivery fee ---------- */
  function rupees(n) { return "₹" + Number(n).toLocaleString("en-IN"); }
  function hasFee(d) { return d && d.mode === "helper" && d.fee_inr > 0 && d.fee_status && d.fee_status !== "none"; }

  // One line for the plan card and the form: what the fee is and who pays.
  function feeLine(fee, role, other) {
    var who = role === "taker" ? "You pay" : esc(other || "The taker") + " pays";
    return who + " Dumpy a <strong>" + rupees(fee) + " delivery fee</strong> by UPI, once the item arrives. " +
      '<span class="muted">No fee if the delivery is called off.</span>';
  }

  // After a helper delivered it: the taker pays the fee to Dumpy's UPI ID,
  // with the same Pay link, QR and Copy as item payments (js/pay.js).
  function feeBox(d, other) {
    if (!hasFee(d) || d.fee_status === "upcoming") return "";
    var price = rupees(d.fee_inr);
    var hid = "fee-h-" + esc(d.id);
    var head = '<div class="pay" data-fee="' + esc(d.id) + '" role="group" aria-labelledby="' + hid + '">' +
      '<p class="pay__title" id="' + hid + '">Dumpy delivery fee · ' + price + "</p>";
    if (!d.fee_i_pay) {
      var said = { due: "not paid yet", marked: "marked as paid", confirmed: "paid", waived: "waived" }[d.fee_status] || "";
      return head + '<p class="small muted">' + esc(other || "The taker") + " pays this to Dumpy" + (said ? " (" + said + ")" : "") + ".</p></div>";
    }
    if (d.fee_status === "confirmed") return head + '<p class="pay__done">' + ICON_CHECK + "<span>Dumpy got your fee. Thank you!</span></p></div>";
    if (d.fee_status === "waived") return head + '<p class="pay__done">' + ICON_CHECK + "<span>Nothing to pay: this fee was waived.</span></p></div>";
    if (d.fee_status === "marked") {
      return head + '<p class="pay__done">' + ICON_CHECK + "<span>You marked this as paid. Thanks for keeping Dumpy going!</span></p>" +
        '<p class="small muted">Reference ' + esc(d.fee_ref) + ". Dumpy checks it arrived.</p></div>";
    }
    var upi = d.fee_upi_id;
    var P = Dumpy.pay;
    var href = upi && P ? P.link(upi, d.fee_payee_name || "Dumpy", d.fee_inr, "delivery " + d.fee_ref) : null;
    var qr = href ? P.qrSvg(href) : "";
    return head +
      '<p class="small">' + esc(d.helper_name || "The helper") + " brought it over. Please pay Dumpy's " + price +
        " delivery fee. Settle any tip directly with " + esc(d.helper_name || "the helper") + " as you agreed.</p>" +
      (href ? P.buttons(href, "Pay " + price + " to Dumpy") : "") +
      (upi ? '<div class="pay__upi"><p><span class="small muted">UPI ID</span><br><span class="pay__id" translate="no">' + esc(upi) + "</span></p>" +
        '<button type="button" class="btn btn--outline btn--sm" data-pay-copy="' + esc(upi) + '" aria-label="Copy UPI ID ' + esc(upi) + '">' + ICON_COPY + "Copy</button></div>" : "") +
      (qr ? '<details class="pay__qr" data-pay-qr><summary>Show QR code</summary>' +
        '<figure role="img" aria-label="QR code to pay Dumpy ' + price + ' by UPI">' + qr + "</figure>" +
        '<p class="small muted">Scan with any UPI app on another phone.</p></details>' : "") +
      '<p class="small muted">Put reference <strong translate="no">' + esc(d.fee_ref) + "</strong> in the payment note (the Pay buttons fill it in). Then tap I've paid.</p>" +
      '<button type="button" class="btn btn--outline btn--block" data-dact="feepaid">I\'ve paid</button></div>';
  }

  // An arrangement exists: show it, with Change and Cancel.
  function showPlan(box, d) {
    var role = box.dataset.role;
    var other = box.dataset.other;
    var key = stateKey(d);
    var html = '<div class="card-box stack-sm">' +
      '<div class="delivery__head"><h3>Delivery</h3>' + pill(key) + "</div>" +
      '<p class="delivery__plan"><strong>' + esc(modeText(d.mode, role, other, true)) + "</strong><br>" + esc(slotText(d.slot_start)) + "</p>";
    if (d.mode === "helper") {
      html += '<p class="small">' + (d.tip_note ? "Tip for the helper: <strong>" + esc(d.tip_note) + "</strong>. " : "No tip agreed. ") +
        '<span class="muted">Settle any tip directly with the helper. Dumpy never collects it.</span></p>' +
        (hasFee(d) ? '<p class="small" data-fee-line>' + feeLine(d.fee_inr, role, other) + "</p>" : "");
      if (d.status === "claimed") {
        html += '<div class="person"><span class="avatar" aria-hidden="true">' + initial(d.helper_name) + "</span>" +
          '<div><p class="person__name">' + esc(d.helper_name || "A neighbour") + '</p><p class="person__meta">Helper' +
          (d.helper_tower ? " · " + esc(tower(d.helper_tower)) : "") + "</p></div></div>" +
          reachButtons(d.helper_name || "The helper", d.helper_phone, null, "Hi " + (d.helper_name || "") + ", this is about the Dumpy delivery " + slotText(d.slot_start) + ".");
      } else {
        html += '<p class="small muted">Waiting for a helper. Neighbours who help deliver see this job now, with towers only. Your flats and phones stay hidden until one of them takes it.</p>';
      }
    }
    if (role === "owner") {
      html += '<p class="small muted">Once it reaches ' + esc(other || "them") + ", tap Mark handed over.</p>";
    }
    html += '<div class="btn-row">' +
      (d.status === "open" ? '<button type="button" class="btn btn--outline btn--sm" data-dact="change">Change</button>' : "") +
      '<button type="button" class="btn btn--danger btn--sm" data-dact="cancel">Cancel delivery</button></div>' +
      (d.status === "claimed" ? '<p class="small muted">To change the plan now, cancel and arrange it again.</p>' : "") +
      "</div>";
    box.innerHTML = html;

    box.querySelector('[data-dact="cancel"]').addEventListener("click", async function () {
      var msg = d.status === "claimed"
        ? "Cancel this delivery? " + (d.helper_name || "The helper") + " will see it was called off. Tell them on WhatsApp too."
        : "Cancel this delivery plan? The item stays reserved, and you can arrange it again.";
      if (!confirm(msg)) return;
      R.setBusy(this, true, "Cancelling…");
      try { await api.cancel(d.id); }
      catch (err) { R.setBusy(this, false); alert(R.problem(err)); return; }
      load(box);
    });
    var change = box.querySelector('[data-dact="change"]');
    if (change) change.addEventListener("click", function () { showForm(box, d); });
  }

  // Pick who brings it, the day, the 2-hour window, and (for a helper) a tip note.
  function showForm(box, d) {
    var role = box.dataset.role;
    var other = box.dataset.other;
    var id = box.dataset.deliveryFor;
    var n = "d" + id.slice(0, 8);
    var current = d ? slotParts(d.slot_start) : null;
    var todayLeft = HOURS.some(function (h) { return slotOpen(0, h); });
    var day = current && (current.day === 0 || current.day === 1) ? current.day : (todayLeft ? 0 : 1);
    if (day === 0 && !todayLeft) day = 1;
    var mode = d ? d.mode : "";

    function radio(name, value, label, checked, disabled) {
      return '<label class="choice"><input type="radio" name="' + name + '" value="' + esc(value) + '"' +
        (checked ? " checked" : "") + (disabled ? " disabled" : "") + "><span>" + esc(label) + "</span></label>";
    }

    box.innerHTML = '<form class="card-box stack" novalidate>' +
      '<div class="stack-sm"><h3>' + (d ? "Change delivery" : "Arrange delivery") + "</h3>" +
      '<p class="small muted">Agree with ' + esc(other || "them") + " how it gets " + (role === "owner" ? "to their flat" : "to your flat") +
      ", and when. Either of you can set this.</p></div>" +
      '<fieldset class="fieldset"><legend class="label">Who brings it?</legend><div class="choice-col">' +
        ["owner_delivers", "taker_collects", "helper"].map(function (m) {
          return radio(n + "-mode", m, modeText(m, role, other, false), m === mode);
        }).join("") +
      "</div></fieldset>" +
      '<fieldset class="fieldset"><legend class="label">Day</legend><div class="choice-row">' +
        radio(n + "-day", "0", "Today", day === 0, !todayLeft) + radio(n + "-day", "1", "Tomorrow", day === 1) +
      "</div></fieldset>" +
      '<fieldset class="fieldset"><legend class="label">Time</legend><div class="choice-grid" data-slots></div></fieldset>' +
      '<div class="field" data-tip hidden>' +
        '<label class="label" for="' + n + '-tip">Tip for the helper <span class="label__opt">(optional)</span></label>' +
        '<input class="input" id="' + n + '-tip" maxlength="60" placeholder="For example: ₹30 cash" value="' + esc(d ? d.tip_note : "") + '" aria-describedby="' + n + '-tip-hint">' +
        '<span class="hint" id="' + n + '-tip-hint">Whatever you two agree. Pay the helper directly; Dumpy never collects it.</span>' +
      '<p class="small notice" data-fee-note hidden></p>' +
      "</div>" +
      '<p class="notice notice--error" role="alert" data-err hidden>' + ICON_ALERT + "<span></span></p>" +
      '<div class="btn-row">' + (d ? '<button type="button" class="btn btn--outline" data-dact="back">Keep as is</button>' : "") +
        '<button type="submit" class="btn btn--primary">' + (d ? "Save changes" : "Save delivery plan") + "</button></div>" +
      "</form>";

    var form = box.querySelector("form");
    var slots = form.querySelector("[data-slots]");
    var tip = form.querySelector("[data-tip]");
    var err = form.querySelector("[data-err]");

    function drawSlots() {
      var dd = +form.querySelector('input[name="' + n + '-day"]:checked').value;
      var keep = form.querySelector('input[name="' + n + '-slot"]:checked');
      var wanted = keep ? +keep.value : current && current.day === dd ? current.hour : null;
      slots.innerHTML = HOURS.map(function (h) {
        var open = slotOpen(dd, h);
        return open ? radio(n + "-slot", String(h), windowText(h), h === wanted, false) : "";
      }).join("");
    }
    function drawTip() {
      var m = form.querySelector('input[name="' + n + '-mode"]:checked');
      tip.hidden = !(m && m.value === "helper");
    }
    form.addEventListener("change", function (e) {
      err.hidden = true;
      if (e.target.name === n + "-day") drawSlots();
      if (e.target.name === n + "-mode") drawTip();
    });
    drawSlots();
    drawTip();
    // Dumpy's fee for a helper delivery. An already-booked helper delivery
    // keeps the fee it was booked with.
    var keptFee = d && d.mode === "helper" ? d.fee_inr || 0 : null;
    (keptFee !== null ? Promise.resolve(keptFee) : api.fee()).then(function (fee) {
      var note = form.querySelector("[data-fee-note]");
      if (!fee || !note) return;
      note.innerHTML = "<span>" + feeLine(fee, role, other) + "</span>";
      note.hidden = false;
    });

    var back = form.querySelector('[data-dact="back"]');
    if (back) back.addEventListener("click", function () { showPlan(box, d); });

    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      err.hidden = true;
      var m = form.querySelector('input[name="' + n + '-mode"]:checked');
      var dd = form.querySelector('input[name="' + n + '-day"]:checked');
      var s = form.querySelector('input[name="' + n + '-slot"]:checked');
      var problem = !m ? "Choose who brings it." : !s ? "Choose a time." : null;
      if (problem) {
        err.querySelector("span").textContent = problem;
        err.hidden = false;
        (!m ? form.querySelector('input[name="' + n + '-mode"]') : (slots.querySelector("input") || form.querySelector('input[name="' + n + '-day"]:not(:disabled)'))).focus();
        return;
      }
      var btn = form.querySelector("button[type=submit]");
      R.setBusy(btn, true, "Saving…");
      try {
        await api.arrange(id, m.value, slotStart(+dd.value, +s.value).toISOString(),
          m.value === "helper" ? form.querySelector("#" + n + "-tip").value.trim() : "");
      } catch (ex) {
        R.setBusy(btn, false);
        err.querySelector("span").textContent = R.problem(ex);
        err.hidden = false;
        return;
      }
      load(box);
    });
  }

  /* ---------- Profile: "I can help deliver" ---------- */
  async function initHelperSwitch(state) {
    var box = document.getElementById("helper-box");
    if (!box || state.status !== "member") return;
    var input = document.getElementById("helper");
    var link = document.getElementById("jobs-link");
    var sid = state.society.society_id;
    try { input.checked = await api.isHelper(sid); } catch (err) { return; }
    link.hidden = !input.checked;
    box.hidden = false;
    input.addEventListener("change", async function () {
      var on = input.checked;
      input.disabled = true;
      try { await api.setHelper(sid, state.user.id, on); }
      catch (err) { input.checked = !on; alert(R.problem(err)); }
      input.disabled = false;
      link.hidden = !input.checked;
    });
  }

  /* ---------- Jobs page ---------- */
  async function initJobs(state) {
    var sid = state.society.society_id;
    var mine = document.getElementById("my-jobs");
    var open = document.getElementById("open-jobs");
    var off = document.getElementById("jobs-off");

    async function draw() {
      var r;
      try { r = await Promise.all([api.isHelper(sid), api.myJobs(sid), api.openJobs(sid)]); }
      catch (err) {
        open.innerHTML = '<li class="empty"><p>' + esc(R.problem(err)) + "</p></li>";
        return;
      }
      var helper = r[0], my = r[1] || [], jobs = r[2] || [];
      off.hidden = helper;
      document.getElementById("my-jobs-section").hidden = !my.length;
      document.getElementById("open-jobs-section").hidden = !helper;
      mine.innerHTML = my.map(myJobCard).join("");
      open.innerHTML = jobs.length ? jobs.map(openJobCard).join("")
        : '<li class="card-box empty"><p>No open jobs right now. When neighbours ask for a helper, their jobs show up here.</p></li>';
    }

    document.getElementById("main").addEventListener("click", async function (e) {
      var b = e.target.closest("button[data-jact]");
      if (!b || b.disabled) return;
      var li = b.closest("[data-job]");
      var act = b.dataset.jact;
      var title = li.dataset.title;
      var ask = {
        claim: "Take the delivery of “" + title + "”? You'll see both flats and phone numbers, and they'll see yours.",
        delivered: "Mark “" + title + "” as delivered? This closes the item.",
        release: "Give this job back? It goes back on the open list for other helpers."
      }[act];
      if (!confirm(ask)) return;
      R.setBusy(b, true, { claim: "Taking…", delivered: "Saving…", release: "Giving back…" }[act]);
      try { await api[act](li.dataset.job); }
      catch (err) { R.setBusy(b, false); alert(R.problem(err)); await draw(); return; }
      await draw();
      if (act === "claim") {
        var first = mine.querySelector('[data-job="' + li.dataset.job + '"] .row-card__title');
        if (first) first.focus();
      }
    });

    await draw();
  }

  function routeText(from, to) {
    return (tower(from) || "Owner's flat") + " → " + (tower(to) || "taker's flat");
  }

  function openJobCard(j) {
    return '<li class="row-card job" data-job="' + esc(j.id) + '" data-title="' + esc(j.title) + '">' +
      '<p class="row-card__title job__title"><span>' + esc(j.title) + "</span></p>" +
      '<p class="job__route">' + ICON_ROUTE + "<span>" + esc(routeText(j.pickup_tower, j.drop_tower)) + "</span></p>" +
      '<p class="row-card__meta">' + esc(slotText(j.slot_start)) + " · " + (j.tip_note ? "Tip: " + esc(j.tip_note) : "No tip set") + "</p>" +
      '<div class="btn-row"><button type="button" class="btn btn--primary btn--sm" data-jact="claim" aria-label="Take the delivery of ' + esc(j.title) + '">Take this job</button></div>' +
      "</li>";
  }

  function stop(label, name, t, flat, phone, title) {
    return '<div class="job__stop"><p class="requests__title">' + label + "</p>" +
      '<div class="person"><span class="avatar" aria-hidden="true">' + initial(name) + "</span>" +
      '<div><p class="person__name">' + esc(name || "A neighbour") + '</p><p class="person__meta">' +
      esc([tower(t), flat ? "Flat " + flat : ""].filter(Boolean).join(" · ")) + "</p></div></div>" +
      reachButtons(name || "They", phone, flat, "Hi " + (name || "") + ", I'm the Dumpy helper for “" + title + "”.") + "</div>";
  }

  function myJobCard(j) {
    var live = j.status === "claimed";
    var key = live ? "claimed" : j.status;
    var html = '<li class="row-card job" data-job="' + esc(j.id) + '" data-title="' + esc(j.title) + '">' +
      '<p class="row-card__title job__title" tabindex="-1"><span>' + esc(j.title) + "</span></p>" +
      '<p class="row-card__meta">' + esc(slotText(j.slot_start)) + " · " + (j.tip_note ? "Tip: " + esc(j.tip_note) : "No tip set") + "</p>" +
      (live ? '<span class="status status--accepted">Yours</span>' : pill(key));
    if (live) {
      html += '<div class="requests stack">' +
        stop("Pick up from", j.pickup_name, j.pickup_tower, j.pickup_flat, j.pickup_phone, j.title) +
        stop("Drop at", j.drop_name, j.drop_tower, j.drop_flat, j.drop_phone, j.title) + "</div>" +
        '<div class="btn-row"><button type="button" class="btn btn--primary btn--sm" data-jact="delivered">Mark delivered</button>' +
        '<button type="button" class="btn btn--outline btn--sm" data-jact="release">Give it back</button></div>';
    } else {
      html += '<p class="small muted row-card__note">' + esc(routeText(j.pickup_tower, j.drop_tower)) +
        (j.status === "cancelled" ? ". The pair called this delivery off." : ". Thanks for helping!") + "</p>";
    }
    return html + "</li>";
  }

  var ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-12.3 7.5L3 21l2-5.5A8.5 8.5 0 1 1 21 11.5z"/></svg>';
  var ICON_PHONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/></svg>';
  var ICON_ALERT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>';
  var ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';
  var ICON_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>';
  var ICON_ROUTE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h8.5a3.5 3.5 0 0 0 0-7h-9a3.5 3.5 0 0 1 0-7H16"/></svg>';

  Dumpy.delivery = { mount: mount, api: api, slotText: slotText };

  if (Dumpy.ready) {
    Dumpy.ready.then(function (state) {
      if (body.dataset.page === "profile") return initHelperSwitch(state);
      if (body.dataset.page === "jobs") return initJobs(state);
    }).catch(function (err) { console.error(err); });
  }
})();
