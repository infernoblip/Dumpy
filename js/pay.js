/* Paying for cheap items (stage 8).
   Dumpy never touches money: the taker pays the owner straight from their own
   UPI app, or in cash. This file only builds the UPI link and QR code, offers
   a Copy UPI ID fallback, and lets the owner mark the item as paid. The owner's
   UPI ID comes from get_contact (stage 6), which gives it only to the accepted
   taker of a paid item. Free items never show any of this.

   Used by js/render.js:
     Dumpy.pay.loadStatus(listings)   fills l.paid_at for paid, matched items
     Dumpy.pay.card(l, contact, ownerView)   HTML for the payment box ("" if free)
   Buttons inside the box work by themselves (event delegation below). */
(function () {
  var Dumpy = (window.Dumpy = window.Dumpy || {});

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function rupees(n) { return "₹" + Number(n).toLocaleString("en-IN"); }
  function isPaid(l) { return l && l.price_inr > 0; }
  function matched(l) { return l.status === "reserved" || l.status === "done"; }

  var UPI_RE = /^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9.]{1,63}$/;

  // upi://pay?pa=<upi id>&pn=<owner name>&am=<price>&cu=INR&tn=Dumpy: <title>
  // Every UPI app (Google Pay, PhonePe, Paytm, BHIM, bank apps) understands it.
  // The note is kept short because some apps cut or refuse long notes.
  function link(upiId, name, amount, title) {
    var note = "Dumpy: " + String(title || "").trim();
    if (note.length > 50) note = note.slice(0, 49).trim() + "…";
    return "upi://pay?pa=" + encodeURIComponent(upiId).replace(/%40/g, "@") +
      "&pn=" + encodeURIComponent(String(name || "Dumpy seller").slice(0, 50)) +
      "&am=" + Number(amount).toFixed(2) +
      "&cu=INR" +
      "&tn=" + encodeURIComponent(note);
  }

  // Paying on a phone. Two things go wrong with a payment link (upi://pay with
  // the amount filled in):
  //   * the phone picks which app opens it, and on many phones that is
  //     WhatsApp, which registers for UPI links too
  //   * Google Pay treats a link that pays a personal UPI ID as risky and
  //     refuses it with "bank limit reached", although paying the same person
  //     by hand works
  // So on phones each app button copies the UPI ID and opens the app itself.
  // The person pastes the ID and types the amount, which the app sees as an
  // ordinary payment. "Pay with link" keeps the filled-in link for apps and
  // business UPI IDs that accept it.
  //   Android  an intent naming the app's package (Chrome opens the app, or
  //            its Play Store page if it is not installed)
  //   iPhone   the app's own link scheme
  var APPS = [
    { name: "Google Pay", android: "com.google.android.apps.nbu.paisa.user", ios: "gpay://" },
    { name: "PhonePe", android: "com.phonepe.app", ios: "phonepe://" },
    { name: "Paytm", android: "net.one97.paytm", ios: "paytmmp://" }
  ];
  function phoneKind() {
    var ua = navigator.userAgent || "";
    if (/Android/i.test(ua)) return "android";
    if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) return "ios";
    return null;
  }
  function openHref(app, kind) {
    return kind === "android"
      ? "intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=" + app.android + ";end"
      : app.ios;
  }
  function linkParam(href, key) {
    var m = new RegExp("[?&]" + key + "=([^&]*)").exec(href);
    return m ? decodeURIComponent(m[1]) : "";
  }
  function copyRow(upi) {
    return '<div class="pay__upi"><p><span class="small muted">UPI ID</span><br><span class="pay__id" translate="no">' + esc(upi) + "</span></p>" +
      '<button type="button" class="btn btn--outline btn--sm" data-pay-copy="' + esc(upi) + '" aria-label="Copy UPI ID ' + esc(upi) + '">' + ICON_COPY + "Copy</button></div>";
  }
  function step(n, title, body) {
    return '<li class="pay-step"><span class="pay-step__n" aria-hidden="true">' + n + '</span><div class="pay-step__body">' +
      '<p class="pay-step__t">' + title + "</p>" + (body || "") + "</div></li>";
  }

  // How to pay, as numbered steps. Used for item payments and the Dumpy fee.
  //   href   the upi://pay link (UPI ID, name, amount, note)
  //   price  "₹250"
  //   note   a reference to type as the payment note, or ""
  //   last   [title, html] for a final step (for example "Tap I've paid"), or null
  //   qrLabel  what the QR code pays, for screen readers
  function steps(href, price, note, last, qrLabel) {
    var kind = phoneKind();
    var upi = linkParam(href, "pa");
    var qr = qrSvg(href);
    var qrBox = qr ? '<figure class="pay__qrcode" role="img" aria-label="QR code to pay ' + esc(qrLabel) + '">' + qr + "</figure>" : "";
    var amountText = "Enter <strong class=\"pay__amount\">" + esc(price) + "</strong>" +
      (note ? ', add the note <strong translate="no">' + esc(note) + "</strong>," : "") + " and pay";
    var n = 0;
    var html = '<ol class="pay-steps">';
    if (kind) {
      html += step(++n, "Tap the app you pay with",
        '<div class="pay__apps">' + APPS.map(function (a) {
          return '<a class="btn btn--primary" href="' + esc(openHref(a, kind)) + '" data-pay-app="' + esc(a.name) + '" data-pay-id="' + esc(upi) + '">' + esc(a.name) + "</a>";
        }).join("") + "</div>" +
        '<p class="small muted">Dumpy copies the UPI ID and opens the app.</p>' +
        '<p class="small pay__apps-status" data-pay-status-line role="status" aria-live="polite"></p>');
      html += step(++n, "Paste the UPI ID",
        '<p class="small muted">In the app, choose “Pay UPI ID” or “To UPI ID” and paste.</p>' + copyRow(upi));
      html += step(++n, amountText);
    } else {
      html += step(++n, "Scan this code with your phone",
        '<p class="small muted">Use any UPI app: Google Pay, PhonePe, Paytm or your bank\'s app.</p>' + qrBox + copyRow(upi));
      html += step(++n, amountText);
    }
    if (last) html += step(++n, last[0], last[1]);
    html += "</ol>";
    html += '<details class="pay__more" data-pay-qr><summary>Other ways to pay</summary><div class="stack-sm">' +
      '<a class="btn btn--outline btn--block" href="' + esc(href) + '" data-pay-link>Open payment link</a>' +
      '<p class="small muted">Fills in the amount for you. Some apps, like Google Pay, refuse these links for personal UPI IDs.</p>' +
      (kind && qrBox ? qrBox + '<p class="small muted">Or scan this code with another phone.</p>' : "") +
      "<p class=\"small muted\">You can also pay " + esc(price) + " in cash. Dumpy never holds money.</p></div></details>";
    return html;
  }

  // A QR code of the link as inline SVG, drawn by the pinned qrcode-generator
  // library. Returns "" if the library did not load.
  function qrSvg(text) {
    var lib = window.qrcode;
    if (!lib) return "";
    try {
      if (lib.stringToBytesFuncs && lib.stringToBytesFuncs["UTF-8"]) lib.stringToBytes = lib.stringToBytesFuncs["UTF-8"];
      var qr = lib(0, "M");
      qr.addData(text);
      qr.make();
      return qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
    } catch (e) {
      console.error(e);
      return "";
    }
  }

  // Whether each paid, matched item was marked paid. Reads the accepted
  // request's paid_at; the database shows it only to the owner and the taker.
  // If this fails (for example the stage 8 migration is not applied yet), the
  // items just show as unpaid and nothing else breaks.
  async function loadStatus(listings) {
    var want = (listings || []).filter(function (l) { return l && isPaid(l) && matched(l); });
    if (!want.length || !Dumpy.db) return;
    var res = await Dumpy.db.from("requests").select("listing_id, paid_at")
      .in("listing_id", want.map(function (l) { return l.id; })).eq("status", "accepted");
    if (res.error) { console.error(res.error); return; }
    var byId = {};
    (res.data || []).forEach(function (r) { byId[r.listing_id] = r.paid_at; });
    want.forEach(function (l) { l.paid_at = byId[l.id] || null; });
  }

  async function setPaid(listingId, paid) {
    var res = await Dumpy.db.rpc("set_paid", { p_listing_id: listingId, p_paid: paid });
    if (res.error) throw res.error;
    return res.data;
  }

  var ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';
  var ICON_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>';

  // The payment box, shown inside the matched pair's contact card.
  //   l          the listing (price_inr, status, title, paid_at)
  //   c          get_contact's row: the other person (null if it didn't load)
  //   ownerView  true for the owner, false for the taker
  function card(l, c, ownerView) {
    if (!isPaid(l) || !matched(l)) return "";
    var price = rupees(l.price_inr);
    var paid = !!l.paid_at;
    var other = c ? c.display_name : (ownerView ? "the taker" : "the owner");
    var hid = "pay-h-" + esc(l.id);
    var head = '<div class="pay" data-pay="' + esc(l.id) + '" role="group" aria-labelledby="' + hid + '">' +
      '<p class="pay__title" id="' + hid + '">Payment · ' + price + "</p>";

    if (ownerView) {
      var myUpi = Dumpy.state && Dumpy.state.profile && Dumpy.state.profile.upi_id;
      return head +
        '<label class="switch pay__switch"><span class="switch__text"><strong>Mark as paid</strong><br>' +
        '<span class="small muted" data-pay-status>' + (paid ? "Paid. Thanks for using Dumpy." : esc(other) + " pays you " + price + " by UPI or cash.") + "</span></span>" +
        '<input type="checkbox" data-pay-toggle' + (paid ? " checked" : "") + ' aria-describedby="' + hid + '"></label>' +
        (paid || myUpi ? "" : '<p class="small muted">Add your UPI ID in <a href="profile.html">Profile</a> so ' + esc(other) + " can pay you by UPI.</p>") +
        "</div>";
    }

    if (paid) {
      return head + '<p class="pay__done">' + ICON_CHECK + "<span>" + esc(other) + " marked this as paid.</span></p></div>";
    }

    var upi = c && c.upi_id && UPI_RE.test(c.upi_id) ? c.upi_id : null;
    if (!upi) {
      return head + '<p class="small">' + esc(other) + " has not added a UPI ID. Pay " + price + " in cash when you collect it.</p></div>";
    }

    var href = link(upi, c.display_name, l.price_inr, l.title);
    return head + steps(href, price, "", null, esc(c.display_name) + " " + price) + "</div>";
  }

  async function copy(text) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    // Older browsers: select a hidden field and copy.
    var t = document.createElement("textarea");
    t.value = text;
    t.setAttribute("readonly", "");
    t.style.position = "fixed";
    t.style.opacity = "0";
    document.body.appendChild(t);
    t.select();
    var ok = document.execCommand && document.execCommand("copy");
    t.remove();
    if (!ok) throw new Error("copy failed");
  }

  // App buttons: copy the UPI ID first, then open the app.
  document.addEventListener("click", async function (e) {
    var a = e.target.closest && e.target.closest("[data-pay-app]");
    if (!a) return;
    e.preventDefault();
    var line = a.closest(".pay").querySelector("[data-pay-status-line]");
    var said = "";
    try { await copy(a.dataset.payId); said = "UPI ID copied. Opening " + a.dataset.payApp + "…"; }
    catch (err) { said = "Opening " + a.dataset.payApp + ". Copy the UPI ID below if it isn't filled in."; }
    if (line) line.textContent = said;
    var go = a.getAttribute("href");
    setTimeout(function () { window.location.href = go; }, 400);
  });

  document.addEventListener("click", async function (e) {
    var b = e.target.closest && e.target.closest("[data-pay-copy]");
    if (!b) return;
    var label = b.innerHTML;
    try { await copy(b.dataset.payCopy); b.innerHTML = ICON_CHECK + "Copied"; }
    catch (err) { b.textContent = "Copy failed"; }
    setTimeout(function () { b.innerHTML = label; }, 2000);
  });

  document.addEventListener("change", async function (e) {
    var input = e.target;
    if (!input.matches || !input.matches("[data-pay-toggle]")) return;
    var box = input.closest("[data-pay]");
    var status = box.querySelector("[data-pay-status]");
    var want = input.checked;
    var before = status.textContent;
    input.disabled = true;
    status.textContent = "Saving…";
    try {
      await setPaid(box.dataset.pay, want);
      status.textContent = want ? "Paid. Thanks for using Dumpy." : "Not paid yet.";
    } catch (err) {
      input.checked = !want;
      status.textContent = before;
      var msg = (Dumpy.render && Dumpy.render.problem) ? Dumpy.render.problem(err) : (err.message || "That did not work.");
      alert(msg);
    }
    input.disabled = false;
  });

  Dumpy.pay = { link: link, steps: steps, card: card, loadStatus: loadStatus, setPaid: setPaid, qrSvg: qrSvg };
})();
