/* Reads Dumpy data from Supabase and shapes it for js/render.js.
   Every query here is limited by the database rules anyway; the filters only
   pick what the page needs. Stages 5 and 6 add the writes (posting, requests). */
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

  var LISTING_COLUMNS = "id, society_id, owner_id, title, description, category, condition, price_inr, status, created_at";

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

  // Home feed: available items in the society, newest first.
  // Stage 6 adds paging ("Load more"); 100 is plenty until then.
  async function feed(societyId) {
    var rows = check(await db.from("listings").select(LISTING_COLUMNS)
      .eq("society_id", societyId).eq("status", "available")
      .order("created_at", { ascending: false }).limit(100));
    var r = await Promise.all([people(rows.map(function (l) { return l.owner_id; })), photos(rows.map(function (l) { return l.id; }), true)]);
    return rows.map(function (l) { return shape(l, r[0], r[1]); });
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
  async function myItems(userId, societyId) {
    var mine = check(await db.from("listings").select(LISTING_COLUMNS)
      .eq("society_id", societyId).eq("owner_id", userId)
      .order("created_at", { ascending: false }));
    var mineIds = mine.map(function (l) { return l.id; });

    var incoming = mineIds.length ? check(await db.from("requests")
      .select("id, listing_id, requester_id, message, status, created_at")
      .in("listing_id", mineIds).order("created_at")) : [];
    var outgoing = check(await db.from("requests")
      .select("id, listing_id, requester_id, message, status, created_at")
      .eq("society_id", societyId).eq("requester_id", userId)
      .order("created_at", { ascending: false }));

    var askedFor = outgoing.length ? check(await db.from("listings").select(LISTING_COLUMNS)
      .in("id", outgoing.map(function (q) { return q.listing_id; }))) : [];

    var all = mine.concat(askedFor);
    var r = await Promise.all([
      people(all.map(function (l) { return l.owner_id; }).concat(incoming.map(function (q) { return q.requester_id; }))),
      photos(all.map(function (l) { return l.id; }), true)
    ]);
    all.forEach(function (l) { shape(l, r[0], r[1]); });
    incoming.forEach(function (q) { q.requester = r[0][q.requester_id] || { display_name: "A neighbour", tower: "" }; });

    var byId = {};
    askedFor.forEach(function (l) { byId[l.id] = l; });
    outgoing.forEach(function (q) { q.listing = byId[q.listing_id] || null; });

    return { listings: mine, incoming: incoming, outgoing: outgoing };
  }

  Dumpy.data = {
    CATEGORIES: CATEGORIES,
    CONDITIONS: CONDITIONS,
    feed: feed,
    listing: listing,
    myItems: myItems,
    check: check
  };
})();
