/* Run Dumpy: delivery fees (pages/platform.html).
   The people who run Dumpy set the fee for helper deliveries and the UPI ID
   it is paid to, and check off fees as the money arrives.

   Who may see or change what is decided by the database functions in
   supabase/migrations/*_delivery_fee.sql (platform admins only). This file
   only draws. */
(function () {
  var Dumpy = window.Dumpy;
  if (!Dumpy || !Dumpy.db || !Dumpy.render || document.body.dataset.page !== "platform") return;
  var db = Dumpy.db;
  var R = Dumpy.render;
  var esc = R.esc;
  function $(sel) { return document.querySelector(sel); }
  function rupees(n) { return "₹" + Number(n || 0).toLocaleString("en-IN"); }
  async function rpc(name, args) {
    var res = await db.rpc(name, args || {});
    if (res.error) throw res.error;
    return res.data;
  }

  var UPI_RE = /^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9.]{1,63}$/;
  var PILL = {
    due: ["Not paid", "pending"],
    marked: ["Says paid", "reserved"],
    confirmed: ["Received", "accepted"],
    waived: ["Waived", "cancelled"]
  };

  function totals(t) {
    t = t || {};
    var cells = [["Received", t.confirmed_inr], ["To check", t.marked_inr], ["Not paid yet", t.due_inr], ["Booked, not delivered", t.upcoming_inr]];
    $("#fee-totals").innerHTML = cells.map(function (c) {
      return '<div class="fee-totals__cell"><dt>' + c[0] + "</dt><dd>" + rupees(c[1]) + "</dd></div>";
    }).join("");
  }

  function row(f) {
    var p = PILL[f.fee_status] || PILL.due;
    var buttons = {
      due: [["confirm", "Mark received", "primary"], ["waive", "Waive", "outline"]],
      marked: [["confirm", "Confirm received", "primary"], ["unpaid", "Not received", "danger"]],
      confirmed: [["unpaid", "Undo", "outline"]],
      waived: [["unpaid", "Undo", "outline"]]
    }[f.fee_status] || [];
    return '<li class="row-card" data-fee="' + esc(f.id) + '" data-ref="' + esc(f.fee_ref) + '">' +
      '<p class="person__name">' + rupees(f.fee_inr) + ' · <span translate="no">' + esc(f.fee_ref) + "</span></p>" +
      '<p class="row-card__meta">' + esc(f.title) + " · " + esc(f.society_name) + "</p>" +
      '<p class="row-card__meta">Paid by ' + esc(f.payer_name || "a neighbour") + " · delivered by " + esc(f.helper_name || "a helper") +
        " · " + R.timeAgo(f.delivered_at) + "</p>" +
      '<span class="status status--' + p[1] + '">' + p[0] + "</span>" +
      (buttons.length ? '<div class="btn-row">' + buttons.map(function (b) {
        return '<button type="button" class="btn btn--' + b[2] + ' btn--sm" data-fact="' + b[0] + '">' + b[1] + "</button>";
      }).join("") + "</div>" : "") +
      "</li>";
  }

  async function load() {
    var r = await Promise.all([rpc("platform_delivery_fees", { p_limit: 100 }), rpc("platform_delivery_fee_totals")]);
    var list = r[0] || [];
    totals((r[1] || [])[0]);
    var toCheck = list.filter(function (f) { return f.fee_status === "marked"; }).length;
    $("#fees-waiting").textContent = toCheck + " to check";
    $("#fees-waiting").hidden = !toCheck;
    $("#fee-list").innerHTML = list.length ? list.map(row).join("")
      : '<li class="card-box empty"><p>No fees yet. They show up here once a helper delivers an item.</p></li>';
  }

  async function init() {
    var s;
    try {
      if (!(await rpc("is_platform_admin"))) return;
      s = ((await rpc("platform_fee_settings")) || [])[0] || {};
    } catch (ex) {
      console.error(ex); // the fee migration is not applied yet: leave the section hidden
      return;
    }
    $("#fees").hidden = false;
    var form = $("#fee-form");
    var err = $("#fee-error");
    var saved = $("#fee-saved");
    $("#fee-amount").value = s.delivery_fee_inr || 0;
    $("#fee-upi").value = s.fee_upi_id || "";
    $("#fee-name").value = s.fee_payee_name || "Dumpy";
    $("#fee-business").checked = !!s.fee_upi_business;
    $("#fee-mc").value = s.fee_merchant_code || "";
    function showMc() { $("#fee-mc-field").hidden = !$("#fee-business").checked; }
    showMc();
    $("#fee-business").addEventListener("change", showMc);

    // A pasted QR link (upi://pay?pa=...&pn=...&mc=...) fills in the fields.
    // A merchant code in it means a business UPI ID.
    $("#fee-upi").addEventListener("input", function () {
      var v = this.value.trim();
      if (!/^upi:\/\/pay\?/i.test(v)) return;
      var q = new URLSearchParams(v.slice(v.indexOf("?") + 1));
      if (q.get("pa")) this.value = q.get("pa");
      if (q.get("pn")) $("#fee-name").value = q.get("pn").slice(0, 50);
      if (q.get("mc")) { $("#fee-business").checked = true; $("#fee-mc").value = q.get("mc").slice(0, 4); }
      showMc();
    });

    form.addEventListener("input", function () { err.hidden = true; saved.hidden = true; });
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      var fee = $("#fee-amount").value.trim() === "" ? 0 : Number($("#fee-amount").value);
      var upi = $("#fee-upi").value.trim();
      var business = $("#fee-business").checked;
      var mc = $("#fee-mc").value.trim();
      var problem = !Number.isInteger(fee) || fee < 0 || fee > 500 ? ["#fee-amount", "The fee is a whole number of rupees from 0 to 500."]
        : upi && !UPI_RE.test(upi) ? ["#fee-upi", "That does not look like a UPI ID. It looks like name@okaxis."]
        : fee > 0 && !upi ? ["#fee-upi", "Add the UPI ID the fee is paid to."]
        : business && mc && !/^[0-9]{4}$/.test(mc) ? ["#fee-mc", "The merchant code is 4 digits, like 5399."] : null;
      if (problem) {
        err.querySelector("span").textContent = problem[1];
        err.hidden = false;
        $(problem[0]).focus();
        return;
      }
      var btn = form.querySelector("button[type=submit]");
      R.setBusy(btn, true, "Saving…");
      try {
        await rpc("platform_set_fee_settings", { p_fee: fee, p_upi_id: upi, p_payee_name: $("#fee-name").value.trim(), p_business: business, p_merchant_code: business ? mc : "" });
        saved.querySelector("span").textContent = fee > 0 ? "Saved. New helper deliveries carry a " + rupees(fee) + " fee." : "Saved. The delivery fee is off.";
        saved.hidden = false;
      } catch (ex) {
        err.querySelector("span").textContent = R.problem(ex);
        err.hidden = false;
      }
      R.setBusy(btn, false);
    });

    $("#fee-list").addEventListener("click", async function (e) {
      var b = e.target.closest("button[data-fact]");
      if (!b || b.disabled) return;
      var li = b.closest("[data-fee]");
      var act = b.dataset.fact;
      var ask = {
        confirm: "Confirm the money for " + li.dataset.ref + " is in your account?",
        unpaid: "Set " + li.dataset.ref + " back to not paid? The taker sees Pay again, and can't book a helper until they pay.",
        waive: "Waive the fee for " + li.dataset.ref + "? The taker won't owe it any more."
      }[act];
      if (!confirm(ask)) return;
      li.querySelectorAll("button").forEach(function (x) { x.disabled = true; });
      R.setBusy(b, true, "Saving…");
      try { await rpc("platform_settle_delivery_fee", { p_delivery_id: li.dataset.fee, p_action: act }); }
      catch (ex) { alert(R.problem(ex)); }
      try { await load(); } catch (ex) { console.error(ex); }
    });

    try { await load(); } catch (ex) {
      $("#fee-list").innerHTML = '<li class="empty"><p>' + esc(R.problem(ex)) + "</p></li>";
    }
  }

  Dumpy.ready.then(init).catch(function (err) { console.error(err); });
})();
