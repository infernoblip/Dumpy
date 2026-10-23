/* Stage 9: the email switch on the profile page, and the share buttons on the
   item page. Runs after js/render.js has drawn the page.

   Emails themselves are sent by the database and the send-email Edge
   Function; the switch only sets profiles.email_notifications, which both of
   them check before sending. */
(function () {
  var Dumpy = window.Dumpy;
  var body = document.body;
  if (!Dumpy || !Dumpy.ready) return;
  function $(sel) { return document.querySelector(sel); }

  /* ---------- Profile: Email updates switch ---------- */
  function initEmailSwitch(state) {
    var box = $("#email-box");
    // Before the profile exists there is nothing to save the switch on.
    if (!box || !state.profile) return;
    var input = $("#emails");
    var status = $("#email-status");
    input.checked = state.profile.email_notifications !== false;
    box.hidden = false;

    input.addEventListener("change", async function () {
      var on = input.checked;
      input.disabled = true;
      status.textContent = "Saving…";
      var res = await Dumpy.db.from("profiles")
        .update({ email_notifications: on })
        .eq("user_id", state.user.id);
      input.disabled = false;
      if (res.error) {
        input.checked = !on;
        status.textContent = "Couldn't save. Check your connection and try again.";
        return;
      }
      state.profile.email_notifications = on;
      status.textContent = on ? "Email updates are on." : "Email updates are off. You won't get any emails from Dumpy.";
    });
  }

  /* ---------- Item: Share on WhatsApp, and the phone's share sheet ---------- */
  async function initShare(state) {
    var box = $("#share-box");
    var id = new URLSearchParams(location.search).get("id");
    if (!box || !/^[0-9a-f-]{36}$/i.test(id || "")) return;

    // Only for items neighbours can still ask for.
    var res = await Dumpy.db.from("listings").select("id, title, price_inr, status").eq("id", id).limit(1);
    var l = res.data && res.data[0];
    if (!l || l.status !== "available") return;

    var link = location.origin + location.pathname + "?id=" + encodeURIComponent(l.id);
    var price = l.price_inr === 0 ? "Free" : "₹" + Number(l.price_inr).toLocaleString("en-IN");
    var text = l.title + " (" + price + ") on Dumpy";

    $("#share-wa").href = "https://wa.me/?text=" + encodeURIComponent(text + ": " + link);

    var more = $("#share-more");
    var data = { title: l.title + " · Dumpy", text: text, url: link };
    if (navigator.share && (!navigator.canShare || navigator.canShare(data))) {
      more.hidden = false;
      more.addEventListener("click", function () {
        navigator.share(data).catch(function () { /* closed the sheet */ });
      });
    }
    box.hidden = false;
  }

  var page = body.dataset.page;
  Dumpy.ready.then(function (state) {
    if (!state || state.status === "signed-out") return;
    if (page === "profile") initEmailSwitch(state);
    if (page === "item") return initShare(state);
  }).catch(function (err) { console.error(err); });
})();
