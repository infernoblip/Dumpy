/* Post an item, or edit one (pages/post.html?id=<listing id>).

   Order of work when the form is sent:
     1. check the form on the page (the database rules make the real check)
     2. create the listing, or save the changes to it
     3. remove photos taken out while editing
     4. upload each new photo (already shrunk by js/photos.js) and record it
     5. put the photos in the order shown
   If a step fails, the form stays filled in and "Try again" carries on from
   where it stopped: the listing is not created twice and photos that already
   went up are not uploaded again. */
(function () {
  var Dumpy = window.Dumpy;
  if (!Dumpy || !Dumpy.ready || document.body.dataset.page !== "post") return;
  var R = Dumpy.render;
  var D = Dumpy.data;
  var MAX_PHOTOS = 4;
  var MAX_PRICE = 100000;

  function $(sel) { return document.querySelector(sel); }

  Dumpy.ready.then(init).catch(function (err) { console.error(err); });

  async function init(state) {
    var editId = new URLSearchParams(location.search).get("id");
    var isNew = !editId;
    var form = $("#post-form");
    var submit = $("#post-submit");
    var errBox = $("#post-error");
    var progress = $("#post-progress");
    var progressText = $("#post-progress-text");
    var progressBar = $("#post-progress-bar");

    // What the page knows about the listing once it exists.
    var listing = null;          // { id, society_id }
    var photos = [];             // in the order shown; see addFiles()
    var removed = [];            // saved photos taken out while editing
    var busy = false;

    /* ---------- Fields ---------- */
    var cat = $("#category");
    cat.innerHTML = '<option value="">Choose one</option>' + D.CATEGORIES.map(function (c) {
      return '<option value="' + R.esc(c[0]) + '">' + R.esc(c[1]) + "</option>";
    }).join("");

    var free = $("#free");
    var price = $("#price");
    function syncPrice() {
      $("#price-field").hidden = free.checked;
      price.required = !free.checked;
      if (free.checked) price.value = "";
    }
    free.addEventListener("change", syncPrice);

    // "Also show to nearby societies" (stage 12): only offered when the
    // society shares with at least one other, or the item is already shared.
    var nearby = $("#nearby");
    async function offerNearby(societyId) {
      var linked = [];
      try { linked = await D.nearbySocieties(societyId); } catch (err) { console.error(err); }
      linked = linked.filter(function (s) { return s.status === "linked"; });
      if (!linked.length && !nearby.checked) return;
      $("#nearby-names").textContent = linked.length
        ? linked.map(function (s) { return s.name; }).join(", ")
        : "No society shares with yours right now";
      $("#nearby-box").hidden = false;
    }

    /* ---------- Editing an existing item ---------- */
    if (editId) {
      document.title = "Edit item · Dumpy";
      $("#post-title").textContent = "Edit item";
      submit.textContent = "Save changes";
      $("#post-cancel").hidden = false;
      form.hidden = true;
      $("#post-loading").hidden = false;
      var l = null;
      try { l = await D.listing(editId); } catch (err) { console.error(err); }
      $("#post-loading").hidden = true;
      var why = !l ? "This item is no longer listed."
        : l.owner_id !== state.user.id ? "You can only edit items you posted."
        : l.status === "hidden" ? "Your society admin has hidden this item, so it can't be edited."
        : null;
      if (why) {
        $("#post-missing-text").textContent = why;
        $("#post-missing").hidden = false;
        return;
      }
      listing = { id: l.id, society_id: l.society_id };
      $("#title").value = l.title;
      $("#description").value = l.description || "";
      cat.value = l.category;
      var cond = form.querySelector('input[name=condition][value="' + l.condition + '"]');
      if (cond) cond.checked = true;
      free.checked = l.price_inr === 0;
      if (l.price_inr > 0) price.value = l.price_inr;
      nearby.checked = l.visibility === "nearby";
      try {
        (await D.photoRows(l.id)).forEach(function (row) {
          photos.push({ row: row, preview: row.url, state: "done" });
        });
      } catch (err) { console.error(err); }
      form.hidden = false;
    }
    syncPrice();
    offerNearby(listing ? listing.society_id : state.society.society_id);

    /* ---------- Photos ---------- */
    var picker = $("#photo-picker");
    var input = $("#photos");
    var addSlot = $("#photo-add");
    var hint = $("#photo-hint");
    var hintText = hint.textContent;

    // Each photo is { file, blob, shrinking (a promise), preview, state, row }.
    // state: shrinking, ready, uploading, done (saved), failed, bad (unreadable).
    function addFiles(files) {
      var room = MAX_PHOTOS - photos.length;
      var list = Array.prototype.slice.call(files, 0, Math.max(0, room));
      list.forEach(function (file) {
        var p = { file: file, preview: URL.createObjectURL(file), state: "shrinking" };
        p.shrinking = queue(function () { return Dumpy.shrinkPhoto(file); }).then(function (blob) {
          p.blob = blob;
          if (p.state === "shrinking") p.state = "ready";
        }, function () {
          p.state = "bad";
        }).then(draw);
        photos.push(p);
      });
      draw();
      hint.textContent = files.length > list.length
        ? "Only " + MAX_PHOTOS + " photos fit. The first " + MAX_PHOTOS + " are kept."
        : hintText;
    }

    // Shrink one photo at a time: several big photos at once can crash a cheap phone.
    var chain = Promise.resolve();
    function queue(job) {
      var run = chain.then(job);
      chain = run.catch(function () {});
      return run;
    }

    var STATE_TEXT = { shrinking: "Getting ready…", uploading: "Uploading…", failed: "Not uploaded", bad: "Can't read this photo" };

    function draw() {
      picker.querySelectorAll(".photo-slot--preview").forEach(function (n) { n.remove(); });
      photos.forEach(function (p, i) {
        var li = document.createElement("li");
        li.className = "photo-slot photo-slot--preview";
        li.dataset.state = p.state;
        var img = document.createElement("img");
        img.alt = "Photo " + (i + 1);
        img.src = p.preview;
        li.appendChild(img);
        if (i === 0 && !STATE_TEXT[p.state]) {
          var cover = document.createElement("span");
          cover.className = "photo-slot__cover";
          cover.textContent = "Cover";
          li.appendChild(cover);
        }
        if (STATE_TEXT[p.state]) {
          var st = document.createElement("span");
          st.className = "photo-slot__state";
          st.textContent = STATE_TEXT[p.state];
          li.appendChild(st);
        }
        var rm = document.createElement("button");
        rm.type = "button";
        rm.className = "photo-slot__remove";
        rm.setAttribute("aria-label", "Remove photo " + (i + 1));
        rm.innerHTML = '<span aria-hidden="true">×</span>';
        rm.disabled = busy;
        rm.addEventListener("click", function () { removeAt(i); });
        li.appendChild(rm);
        picker.insertBefore(li, addSlot);
      });
      addSlot.hidden = photos.length >= MAX_PHOTOS;
      input.disabled = busy;
    }

    function removeAt(i) {
      var p = photos.splice(i, 1)[0];
      if (p.row) removed.push(p.row);
      else if (p.preview) URL.revokeObjectURL(p.preview);
      p.state = "removed";
      hint.textContent = hintText;
      draw();
      var next = picker.querySelector(".photo-slot__remove") || input;
      next.focus();
    }

    input.addEventListener("change", function () {
      addFiles(input.files);
      input.value = ""; // so picking the same photo again still counts
    });
    draw();

    /* ---------- Sending ---------- */
    function showError(text, focusId) {
      errBox.querySelector("span").textContent = text;
      errBox.hidden = false;
      if (focusId) $("#" + focusId).focus();
      else errBox.scrollIntoView({ block: "center" });
    }

    function fields() {
      var checked = form.querySelector("input[name=condition]:checked");
      return {
        title: $("#title").value.trim().replace(/\s+/g, " "),
        description: $("#description").value.trim(),
        category: cat.value,
        condition: checked ? checked.value : "",
        price_inr: free.checked ? 0 : Number(price.value),
        visibility: nearby.checked ? "nearby" : "society"
      };
    }

    function validate(f) {
      if (!f.title) return ["title", "Give the item a title."];
      if (f.title.length > 80) return ["title", "Keep the title to 80 characters."];
      if (f.description.length > 2000) return ["description", "Keep the description to 2000 characters."];
      if (!f.category) return ["category", "Choose a category."];
      if (!f.condition) return [null, "Choose the condition."];
      if (!free.checked) {
        if (!price.value || !Number.isInteger(f.price_inr) || f.price_inr < 1) return ["price", "Enter a price in whole rupees, or turn on Free."];
        if (f.price_inr > MAX_PRICE) return ["price", "Dumpy is for cheap things: keep the price under ₹1,00,000."];
      }
      if (photos.some(function (p) { return p.state === "bad"; })) return [null, "One photo can't be read. Remove it, or pick a different one."];
      return null;
    }

    function setProgress(text, done, total) {
      progress.hidden = false;
      progressText.textContent = text;
      progressBar.value = total ? Math.round((done / total) * 100) : 0;
    }

    function lock(on) {
      busy = on;
      form.querySelectorAll("input, select, textarea").forEach(function (el) { el.disabled = on; });
      draw();
    }

    // A mistake message goes away once the person changes something.
    form.addEventListener("input", function () { if (!busy) errBox.hidden = true; });
    form.addEventListener("change", function () { if (!busy) errBox.hidden = true; });

    window.addEventListener("beforeunload", function (e) {
      if (busy) { e.preventDefault(); e.returnValue = ""; }
    });

    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      if (busy) return;
      errBox.hidden = true;
      var f = fields();
      var bad = validate(f);
      if (bad) { showError(bad[1], bad[0]); return; }

      lock(true);
      R.setBusy(submit, true, isNew && !listing ? "Posting…" : "Saving…");
      var step = "save";
      try {
        // 1. Wait for photos still being shrunk.
        var pending = photos.filter(function (p) { return p.state === "shrinking"; });
        if (pending.length) {
          setProgress("Getting photos ready…", 0, 1);
          await Promise.all(pending.map(function (p) { return p.shrinking; }));
          if (photos.some(function (p) { return p.state === "bad"; })) {
            throw { quiet: "One photo can't be read. Remove it, or pick a different one." };
          }
        }

        // 2. The listing itself.
        setProgress(listing ? "Saving…" : "Posting your item…", 0, 1);
        if (!listing) {
          var id = await D.createListing(state.society.society_id, state.user.id, f);
          listing = { id: id, society_id: state.society.society_id };
        } else {
          await D.editListing(listing.id, f);
        }

        // 3. Photos taken out while editing.
        step = "photos";
        while (removed.length) {
          await D.removePhoto(removed[0]);
          removed.shift();
        }

        // 4. New photos, one at a time, so a slow connection shows steady progress.
        var toSend = photos.filter(function (p) { return !p.row; });
        for (var i = 0; i < toSend.length; i++) {
          var p = toSend[i];
          setProgress("Uploading photo " + (i + 1) + " of " + toSend.length + "…", i, toSend.length);
          p.state = "uploading";
          draw();
          try {
            p.row = await D.addPhoto(listing, p.blob, photos.indexOf(p));
            p.state = "done";
          } catch (err) {
            p.state = "failed";
            throw err;
          } finally {
            draw();
          }
        }
        setProgress("Photos uploaded", 1, 1);

        // 5. Order. Positions follow the order on screen.
        for (var j = 0; j < photos.length; j++) {
          if (photos[j].row.position !== j) await D.movePhoto(photos[j].row, j);
        }
      } catch (err) {
        console.error(err);
        lock(false);
        R.setBusy(submit, false);
        progress.hidden = true;
        submit.textContent = "Try again";
        if (err && err.quiet) { showError(err.quiet); return; }
        var msg = R.problem(err);
        if (step === "photos") {
          msg = (!isNew ? "Your changes are saved, but a photo didn't upload. " : "Your item is posted, but a photo didn't upload. ") +
            (/fetch|network|internet/i.test(msg) ? "Check your connection and tap Try again." : "Tap Try again. (" + msg + ")");
          // From now on the page is editing the item it just created.
          if (isNew) {
            history.replaceState(null, "", "post.html?id=" + encodeURIComponent(listing.id));
          }
        }
        showError(msg);
        return;
      }

      busy = false;
      location.replace("item.html?id=" + encodeURIComponent(listing.id) + "&" + (isNew ? "posted" : "saved") + "=1");
    });
  }
})();
