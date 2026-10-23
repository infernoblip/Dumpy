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
    var qr = qrSvg(href);
    return head +
      '<a class="btn btn--primary btn--lg btn--block" href="' + esc(href) + '" data-pay-link>Pay ' + price + "</a>" +
      '<div class="pay__upi"><p><span class="small muted">UPI ID</span><br><span class="pay__id" translate="no">' + esc(upi) + "</span></p>" +
      '<button type="button" class="btn btn--outline btn--sm" data-pay-copy="' + esc(upi) + '" aria-label="Copy UPI ID ' + esc(upi) + '">' + ICON_COPY + "Copy</button></div>" +
      (qr ? '<details class="pay__qr" data-pay-qr><summary>Show QR code</summary>' +
        '<figure role="img" aria-label="QR code to pay ' + esc(c.display_name) + " " + price + ' by UPI">' + qr + "</figure>" +
        '<p class="small muted">Scan with any UPI app on another phone.</p></details>' : "") +
      '<p class="small muted">Pay opens your UPI app with ' + price + " filled in. If nothing opens (on iPhone, for example), copy the UPI ID and pay in any UPI app, or pay in cash. Dumpy never holds money.</p>" +
      "</div>";
  }

  // Open the QR code by default on larger screens, where there is room and the
  // person is likely to scan it with their phone. Each code is opened once, so
  // closing it by hand sticks.
  var wide = window.matchMedia ? window.matchMedia("(min-width: 600px)") : { matches: false };
  function openQrOnWide() {
    if (!wide.matches) return;
    document.querySelectorAll("[data-pay-qr]:not([data-seen])").forEach(function (d) {
      d.dataset.seen = "1";
      d.open = true;
    });
  }
  if (window.MutationObserver) {
    new MutationObserver(function () { openQrOnWide(); })
      .observe(document.documentElement, { childList: true, subtree: true });
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

  Dumpy.pay = { link: link, card: card, loadStatus: loadStatus, setPaid: setPaid, qrSvg: qrSvg };
})();
