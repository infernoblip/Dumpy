/* Fake data for the Stage 3 page designs. No real people, flats or society.
   Shapes follow the Stage 2 tables (listings, listing_photos, requests,
   profiles, memberships) so Stages 4 to 6 can swap this file for Supabase
   queries that return the same fields. Photo paths are relative to the site root. */
(function () {
  var HOUR = 3600 * 1000;
  function ago(hours) { return new Date(Date.now() - hours * HOUR).toISOString(); }

  var society = { id: "soc-demo", name: "Demo Society", invite_code: "DEMO42" };

  // The signed-in demo user.
  var me = {
    user_id: "u-me",
    display_name: "Asha",
    tower: "Tower A",
    flat: "A-101",
    phone: "",
    upi_id: "asha@demo",
    email: "asha@example.com",
    role: "admin",
    can_help_deliver: true,
    emails_on: true
  };

  var people = {
    "u-me": { display_name: "Asha", tower: "Tower A" },
    "u-2": { display_name: "Ravi", tower: "Tower B" },
    "u-3": { display_name: "Meena", tower: "Tower C" },
    "u-4": { display_name: "Kabir", tower: "Tower A" },
    "u-5": { display_name: "Sana", tower: "Tower D" }
  };

  function listing(id, owner, title, category, condition, price, hours, photos, description, status) {
    return {
      id: id,
      society_id: society.id,
      owner_id: owner,
      owner: people[owner],
      title: title,
      description: description,
      category: category,
      condition: condition,
      price_inr: price,
      status: status || "available",
      created_at: ago(hours),
      photos: photos.map(function (p) { return "assets/mock/" + p; })
    };
  }

  var listings = [
    listing("l-1", "u-2", "Wooden study chair", "Furniture", "Good", 0, 2, ["chair.svg"],
      "Solid wood chair, a little scratched on one leg. Sturdy and comfortable for a study table."),
    listing("l-2", "u-3", "Class 10 textbooks, set of 6", "Books", "Used", 150, 5, ["books.svg"],
      "Maths, Science, English, Hindi and two Social Science books. Some pencil notes inside."),
    listing("l-3", "u-4", "Electric kettle, 1.5 litre", "Kitchen", "Like new", 300, 20, ["kettle.svg"],
      "Used for a month, still has the box. Auto shut-off works."),
    listing("l-4", "u-5", "Kids bicycle, 16 inch", "Kids", "Good", 1200, 30, ["cycle.svg", "cycle-2.svg"],
      "Fits ages 5 to 8. Training wheels included. Tyres pumped last week."),
    listing("l-5", "u-2", "Bedside table lamp", "Electronics", "Good", 0, 52, ["lamp.svg"],
      "Warm light, bulb included. Switch on the cable."),
    listing("l-6", "u-3", "Bag of soft toys", "Kids", "Used", 0, 75, ["toy.svg"],
      "About ten soft toys, washed. Good for a younger child or a play corner."),
    listing("l-7", "u-4", "Winter jacket, size M", "Clothes", "Like new", 200, 100, ["jacket.svg"],
      "Worn twice on a trip. Warm, with a hood."),
    listing("l-8", "u-5", "Pedestal fan, needs repair", "Electronics", "For parts", 0, 170, ["fan.svg"],
      "Motor hums but the blades do not turn. Could be fixed, or use the parts."),

    // Asha's own listings, shown on My items.
    listing("l-9", "u-me", "Three-seater sofa", "Furniture", "Good", 2500, 26, ["sofa.svg"],
      "Purple fabric sofa, no tears. Needs two people to carry.", "available"),
    listing("l-10", "u-me", "Mixer grinder", "Kitchen", "Used", 400, 80, ["mixer.svg"],
      "Three jars, all blades sharp.", "reserved"),
    listing("l-11", "u-me", "Old comic books", "Books", "Used", 0, 400, ["books.svg"],
      "A pile of comics from the 2000s.", "done")
  ];

  var requests = [
    // Requests other people made on Asha's sofa.
    { id: "r-1", listing_id: "l-9", requester_id: "u-3", requester: people["u-3"], message: "Can I see it this evening?", status: "pending", created_at: ago(3) },
    { id: "r-2", listing_id: "l-9", requester_id: "u-4", requester: people["u-4"], message: "", status: "pending", created_at: ago(1) },
    // Accepted request on the reserved mixer.
    { id: "r-3", listing_id: "l-10", requester_id: "u-2", requester: people["u-2"], message: "Need it for the new flat!", status: "accepted", created_at: ago(30) },
    // Requests Asha made on other people's items.
    { id: "r-4", listing_id: "l-4", requester_id: "u-me", requester: people["u-me"], message: "For my niece", status: "pending", created_at: ago(4) },
    { id: "r-5", listing_id: "l-3", requester_id: "u-me", requester: people["u-me"], message: "", status: "declined", created_at: ago(18) }
  ];

  // People waiting for an admin to approve them (admin page).
  var pendingMembers = [
    { user_id: "u-6", display_name: "Neel", tower: "Tower B", flat: "B-204", requested_at: ago(6) },
    { user_id: "u-7", display_name: "Fatima", tower: "Tower D", flat: "D-1102", requested_at: ago(28) }
  ];

  window.DUMPY_MOCK = {
    society: society,
    me: me,
    listings: listings,
    requests: requests,
    pendingMembers: pendingMembers,
    categories: ["Furniture", "Electronics", "Kitchen", "Books", "Clothes", "Kids", "Other"],
    conditions: ["Like new", "Good", "Used", "For parts"]
  };
})();
