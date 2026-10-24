/* Reads Dumpy data from Supabase and shapes it for js/render.js.
   Every query here is limited by the database rules anyway; the filters only
   pick what the page needs. Writes (posting, editing, photos) are allowed or
   refused by the same rules: a write the rules refuse changes no rows. */
(function () {
  var Dumpy = (window.Dumpy = window.Dumpy || {});
  var db = Dumpy.db;
  var BUCKET = "listing-photos";

  var CATEGORIES = [
    ["furniture", "Furniture"], ["electronics", "Electronics"], ["kitchen", "Kitchen"],
    ["books", "Books"], ["clothes", "Clothes"], ["kids", "Kids"], ["other", "Other"]
  ];
  var CONDITIONS = [["like_new", "Like new"], ["good", "Good"], ["used", "Used"], ["for_parts", "For parts"]];
  function labelOf(pairs, value) {
    for (var i = 0; i < pairs.length; i++) if (pairs[i][0] === value) return pairs[i][1];
    return value;
  }

  var LISTING_COLUMNS = "id, society_id, owner_id, title, description, category, condition, price_inr, status, visibility, created_at";

  function check(res) {
    if (res.error) throw res.error;
    return res.data;
  }

  // Name and tower of each person, keyed by user_id. Only public columns:
  // flat, phone and UPI ID can't be selected at all.
  async function people(ids) {
    ids = unique(ids);
    if (!ids.length) return {};
    var rows = check(await db.from("profiles").select("user_id, display_name, tower").in("user_id", ids));
    var map = {};
    rows.forEach(function (p) { map[p.user_id] = p; });
    return map;
  }

  // Signed URLs for the photos of these listings, in order, keyed by listing id.
  async function photos(listingIds, firstOnly) {
    listingIds = unique(listingIds);
    if (!listingIds.length) return {};
    var rows = check(await db.from("listing_photos")
      .select("listing_id, storage_path, position")
      .in("listing_id", listingIds)
      .order("position"));
    if (firstOnly) {
      var seen = {};
      rows = rows.filter(function (r) { return seen[r.listing_id] ? false : (seen[r.listing_id] = true); });
    }
    var map = {};
    if (!rows.length) return map;
    var signed = check(await db.storage.from(BUCKET).createSignedUrls(rows.map(function (r) { return r.storage_path; }), 3600));
    rows.forEach(function (r, i) {
      var url = signed[i] && signed[i].signedUrl;
      if (!url) return;
      (map[r.listing_id] = map[r.listing_id] || []).push(url);
    });
    return map;
  }

  function unique(list) {
    return list.filter(function (x, i) { return x && list.indexOf(x) === i; });
  }

  function shape(l, owners, pics) {
    l.owner = owners[l.owner_id] || { display_name: "A neighbour", tower: "" };
    l.photos = pics[l.id] || [];
    l.category_label = labelOf(CATEGORIES, l.category);
    l.condition_label = labelOf(CONDITIONS, l.condition);
    return l;
  }

  // Home feed: available items in the society, newest first, a page at a time.
  //   filter: "all", "free", "paid" or a category value
  //   q:      words to find in the title (case doesn't matter)
  // Returns { items, more }: more is true when another page is waiting.
  //   nearby: ids of linked societies; with filter "nearby" the feed shows
  //           their shared items instead of this society's (stage 12)
  var PAGE = 20;
  async function feed(societyId, opts) {
    opts = opts || {};
    var from = opts.offset || 0;
    var f = opts.filter || "all";
    var query = db.from("listings").select(LISTING_COLUMNS).eq("status", "available");
    if (f === "nearby") {
      var ids = opts.nearby || [];
      if (!ids.length) return { items: [], more: false };
      query = query.in("society_id", ids).eq("visibility", "nearby");
    } else {
      query = query.eq("society_id", societyId);
    }
    if (f === "free") query = query.eq("price_inr", 0);
    else if (f === "paid") query = query.gt("price_inr", 0);
    else if (f !== "all" && f !== "nearby") query = query.eq("category", f);
    var q = (opts.q || "").trim();
    // % and _ are wildcards in ilike; a backslash makes them plain characters.
    if (q) query = query.ilike("title", "%" + q.replace(/[\\%_]/g, "\\$&") + "%");
    // Items past their 30 days leave the feed straight away; the hourly
    // expiry job then marks them expired (stage 10).
    query = query.gt("expires_at", new Date().toISOString());
    // Ask for one extra row to learn whether there is another page.
    var rows = check(await query.order("created_at", { ascending: false }).order("id")
      .range(from, from + PAGE));
    var more = rows.length > PAGE;
    rows = rows.slice(0, PAGE);
    var r = await Promise.all([people(rows.map(function (l) { return l.owner_id; })), photos(rows.map(function (l) { return l.id; }), true)]);
    return { items: rows.map(function (l) { return shape(l, r[0], r[1]); }), more: more };
  }

  // One item, or null if it doesn't exist or the visitor may not see it.
  async function listing(id) {
    if (!/^[0-9a-f-]{36}$/i.test(id || "")) return null;
    var rows = check(await db.from("listings").select(LISTING_COLUMNS).eq("id", id).limit(1));
    if (!rows.length) return null;
    var r = await Promise.all([people([rows[0].owner_id]), photos([id], false)]);
    return shape(rows[0], r[0], r[1]);
  }

  // My items: what I posted in this society (with requests on them), and what I asked for.
  // Reserved and handed-over items also carry the other person's contact
  // details (listing.contact), which only the matched pair can get.
  async function myItems(userId, societyId) {
    var mine = check(await db.from("listings").select(LISTING_COLUMNS)
      .eq("society_id", societyId).eq("owner_id", userId)
      .order("created_at", { ascending: false }));
    var mineIds = mine.map(function (l) { return l.id; });

    var incoming = mineIds.length ? check(await db.from("requests")
      .select(REQUEST_COLUMNS)
      .in("listing_id", mineIds).order("created_at")) : [];
    var outgoing = check(await db.from("requests")
      .select(REQUEST_COLUMNS)
      .eq("society_id", societyId).eq("requester_id", userId)
      .order("created_at", { ascending: false }));

    var askedFor = outgoing.length ? check(await db.from("listings").select(LISTING_COLUMNS)
      .in("id", outgoing.map(function (q) { return q.listing_id; }))) : [];

    var all = mine.concat(askedFor);
    var paired = mine.filter(isMatched).concat(askedFor.filter(function (l) {
      return isMatched(l) && outgoing.some(function (q) { return q.listing_id === l.id && q.status === "accepted"; });
    }));
    var r = await Promise.all([
      people(all.map(function (l) { return l.owner_id; }).concat(incoming.map(function (q) { return q.requester_id; }))),
      photos(all.map(function (l) { return l.id; }), true),
      Promise.all(paired.map(function (l) { return contact(l.id); }))
    ]);
    all.forEach(function (l) { shape(l, r[0], r[1]); });
    paired.forEach(function (l, i) { l.contact = r[2][i]; });
    incoming.forEach(function (q) { q.requester = r[0][q.requester_id] || { display_name: "A neighbour", tower: "" }; });

    var byId = {};
    askedFor.forEach(function (l) { byId[l.id] = l; });
    outgoing.forEach(function (q) { q.listing = byId[q.listing_id] || null; });

    return { listings: mine, incoming: incoming, outgoing: outgoing };
  }

  function isMatched(l) { return l.status === "reserved" || l.status === "done"; }

  /* ---------- Requests and handover (stage 6) ---------- */

  var REQUEST_COLUMNS = "id, listing_id, requester_id, message, status, created_at";

  // The signed-in person's own request for an item, or null.
  async function myRequest(listingId, userId) {
    var rows = check(await db.from("requests").select(REQUEST_COLUMNS)
      .eq("listing_id", listingId).eq("requester_id", userId).limit(1));
    return rows[0] || null;
  }

  // Requests on an item the signed-in person owns (others get none back).
  async function requestsOn(listingId) {
    return check(await db.from("requests").select(REQUEST_COLUMNS)
      .eq("listing_id", listingId).order("created_at"));
  }

  // "I want this". The database allows one request per person per item, only
  // on available items posted by someone else in the same society.
  async function requestItem(listing, userId, message) {
    var res = await db.from("requests").insert({
      listing_id: listing.id, society_id: listing.society_id, requester_id: userId, message: message || ""
    });
    if (res.error && res.error.code === "23505") throw new Error("You have already asked for this item.");
    if (res.error && res.error.code === "42501") throw new Error("This item is no longer available.");
    check(res);
  }

  // Owner actions. Each one runs in the database as a single step, and the
  // database checks that the caller owns the item.
  async function rpc(name, args) { check(await db.rpc(name, args)); }
  function acceptRequest(requestId) { return rpc("accept_request", { p_request_id: requestId }); }
  function markHandedOver(listingId) { return rpc("mark_handed_over", { p_listing_id: listingId }); }
  function cancelReservation(listingId) { return rpc("cancel_reservation", { p_listing_id: listingId }); }

  // The other person's name, tower, flat and phone, or null. Only the owner and
  // the accepted requester of a reserved or handed-over item get anything.
  async function contact(listingId) {
    var rows = check(await db.rpc("get_contact", { p_listing_id: listingId }));
    return (rows && rows[0]) || null;
  }

  /* ---------- More societies (stage 12) ---------- */

  // Societies this one shares items with. Members get "linked" rows; admins
  // also get "asked" (waiting for them) and "asking" (they asked us).
  async function nearbySocieties(societyId) {
    return check(await db.rpc("nearby_societies", { p_society_id: societyId })) || [];
  }

  /* ---------- Writes (stage 5) ---------- */

  // The listing fields a person may set. Everything else (owner, society,
  // status on insert) is fixed by the database rules.
  var EDITABLE = ["title", "description", "category", "condition", "price_inr", "visibility"];
  function pick(fields) {
    var row = {};
    EDITABLE.forEach(function (k) { if (k in fields) row[k] = fields[k]; });
    return row;
  }

  // A refused update changes no rows and returns none, without an error.
  function oneRow(rows) {
    if (!rows || !rows.length) throw new Error("You can only change your own items.");
    return rows[0];
  }

  // Post a new item. Returns its id.
  async function createListing(societyId, ownerId, fields) {
    var row = Object.assign(pick(fields), { society_id: societyId, owner_id: ownerId });
    return check(await db.from("listings").insert(row).select("id").single()).id;
  }

  async function updateListing(id, fields) {
    return oneRow(check(await db.from("listings").update(fields).eq("id", id).select("id, status")));
  }

  function editListing(id, fields) { return updateListing(id, pick(fields)); }

  function withdraw(id) { return updateListing(id, { status: "withdrawn" }); }

  // Put a withdrawn or expired item back up for another 30 days. The database
  // sets the new date from its own clock (stage 10).
  function relist(id) {
    return rpc("renew_listing", { p_listing_id: id });
  }

  // A listing's photo rows, in order, each with a signed URL to show it.
  async function photoRows(listingId) {
    var rows = check(await db.from("listing_photos")
      .select("id, storage_path, position").eq("listing_id", listingId).order("position"));
    if (!rows.length) return rows;
    var signed = check(await db.storage.from(BUCKET).createSignedUrls(rows.map(function (r) { return r.storage_path; }), 3600));
    rows.forEach(function (r, i) { r.url = signed[i] && signed[i].signedUrl; });
    return rows;
  }

  function randomName() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  // Upload one shrunk photo to <society_id>/<listing_id>/<random>.<ext> and
  // record it. If the record can't be saved, the file is removed again.
  async function addPhoto(listing, blob, position) {
    var ext = blob.type === "image/webp" ? "webp" : blob.type === "image/png" ? "png" : "jpg";
    var path = listing.society_id + "/" + listing.id + "/" + randomName() + "." + ext;
    check(await db.storage.from(BUCKET).upload(path, blob, { contentType: blob.type, cacheControl: "31536000", upsert: false }));
    var res = await db.from("listing_photos")
      .insert({ listing_id: listing.id, society_id: listing.society_id, storage_path: path, position: position })
      .select("id, storage_path, position").single();
    if (res.error) {
      await db.storage.from(BUCKET).remove([path]);
      throw res.error;
    }
    return res.data;
  }

  async function removePhoto(row) {
    oneRow(check(await db.from("listing_photos").delete().eq("id", row.id).select("id")));
    // The record is gone, so nobody sees the photo any more; a file left
    // behind by a failed delete is harmless.
    await db.storage.from(BUCKET).remove([row.storage_path]);
  }

  async function movePhoto(row, position) {
    oneRow(check(await db.from("listing_photos").update({ position: position }).eq("id", row.id).select("id")));
    row.position = position;
  }

  Dumpy.data = {
    CATEGORIES: CATEGORIES,
    CONDITIONS: CONDITIONS,
    feed: feed,
    listing: listing,
    myItems: myItems,
    myRequest: myRequest,
    requestsOn: requestsOn,
    requestItem: requestItem,
    acceptRequest: acceptRequest,
    markHandedOver: markHandedOver,
    cancelReservation: cancelReservation,
    contact: contact,
    nearbySocieties: nearbySocieties,
    createListing: createListing,
    editListing: editListing,
    withdraw: withdraw,
    relist: relist,
    photoRows: photoRows,
    addPhoto: addPhoto,
    removePhoto: removePhoto,
    movePhoto: movePhoto,
    check: check
  };
})();
