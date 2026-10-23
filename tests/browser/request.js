// Stage 6 browser test: browsing the feed, asking for an item, and the owner
// handing it to exactly one person, in a 360 x 740 phone viewport against the
// local stand-in for Supabase (see lib.js and run.sh). All people and items
// are made up.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path = require('path');
const L = require('./lib');
const { SITE, USERS, SOCIETY, PHONE, check, sql, sqlTry, wire, magicLink, settle, noSideScroll, smallTargets } = L;

const shot = L.shooter(path.join(L.S, '../../docs/screenshots/stage-6'));
const OWNER = USERS.owner;                 // Demo Owner, Tower B, flat B-202
const ASKER = USERS.admin;                 // Demo Admin, Tower A, flat A-101, has a phone
const OTHER = { id: 'aaaaaaaa-0000-4000-8000-000000000005', email: 'demo.taker@example.com' }; // no phone
const SHELF = '11111111-0000-4000-8000-000000000060';

const q1 = (query) => sql(query).split('\n').filter(Boolean).pop() || '';

// Wait until the feed has finished loading after a tap or a search.
async function feedReady(p) {
  await p.waitForFunction(() => {
    const m = document.querySelector('#feed-meta').textContent;
    return m && !/Loading/.test(m) && !document.querySelector('#load-more').disabled || document.querySelector('#feed .empty');
  }, null, { timeout: 10000 });
  await p.waitForTimeout(150);
}
// Type in the search box and wait for the (slightly delayed) search to finish.
async function searchFor(p, text) { await p.fill('#search', text); await p.waitForTimeout(450); await feedReady(p); }
const cardIds = (p) => p.$$eval('#feed .item-card', (as) => as.map((a) => new URL(a.href).searchParams.get('id')));
const cardTitles = (p) => p.$$eval('#feed .item-card__title', (hs) => hs.map((h) => h.textContent));

(async () => {
  // People and items for this test.
  sql(`insert into auth.users (id, aud, role, email, created_at, updated_at) values
         ('${OTHER.id}','authenticated','authenticated','${OTHER.email}', now(), now()) on conflict do nothing;
       insert into public.profiles (user_id, display_name, tower, flat) values ('${OTHER.id}','Demo Taker','C','C-303') on conflict do nothing;
       insert into public.memberships (user_id, society_id, role, status) values ('${OTHER.id}','${SOCIETY}','member','approved') on conflict do nothing;
       update public.profiles set phone = '9000000003' where user_id = '${OWNER.id}';
       insert into public.listings (society_id, owner_id, title, category, condition, price_inr, created_at)
         select '${SOCIETY}', '${OTHER.id}', 'Demo item ' || lpad(n::text, 2, '0'),
                (array['books','kids','kitchen','clothes'])[1 + n % 4], 'good', case when n % 2 = 0 then 0 else 50 end,
                now() - interval '10 days' - n * interval '1 hour'
         from generate_series(1, 24) n;
       insert into public.listings (id, society_id, owner_id, title, description, category, condition, price_inr) values
         ('${SHELF}','${SOCIETY}','${OWNER.id}','Small bookshelf','Three shelves, easy to carry.','furniture','good',200);`);

  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const errors = [];
  async function personPage(user, scheme) {
    const ctx = await browser.newContext({ ...PHONE, colorScheme: scheme || 'light' });
    await wire(ctx);
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) errors.push(m.text()); });
    p.on('dialog', (d) => d.accept());
    await p.goto(magicLink(user)); await settle(p);
    return p;
  }
  const o = await personPage(OWNER);
  const a = await personPage(ASKER);
  const t = await personPage(OTHER);

  // 1. Feed: 20 at a time, Load more, filters and search.
  const available = Number(q1(`select count(*) from public.listings where society_id = '${SOCIETY}' and status = 'available'`));
  await t.goto(SITE + '/'); await settle(t); await feedReady(t);
  check((await t.locator('#feed .item-card').count()) === 20, 'The feed shows the newest 20 items first');
  check(await t.isVisible('#load-more'), 'A Load more button appears when there are more');
  check((await cardTitles(t))[0] === 'Small bookshelf', 'Newest item comes first');
  await noSideScroll(t, 'home'); await smallTargets(t, 'home');
  await shot(t, 'home-light', false);
  while (await t.isVisible('#load-more')) { await t.click('#load-more'); await feedReady(t); }
  const all = await cardIds(t);
  check(all.length === available && new Set(all).size === available, `Load more brings in every available item once (${all.length} of ${available})`);
  await t.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await shot(t, 'home-end-light', false);

  await t.evaluate(() => window.scrollTo(0, 0));
  await t.click('.chip[data-filter=free]'); await feedReady(t);
  const freeIds = await cardIds(t);
  const freeDb = q1(`select count(*) from public.listings where society_id = '${SOCIETY}' and status = 'available' and price_inr = 0`);
  check(freeIds.length === Math.min(20, Number(freeDb)) && (await t.$$eval('#feed .badge', (b) => b.every((x) => x.textContent === 'Free'))),
    `Free shows only free items (${freeIds.length})`);
  await t.click('.chip[data-filter=paid]'); await feedReady(t);
  check(await t.$$eval('#feed .badge', (b) => b.length > 0 && b.every((x) => x.textContent.startsWith('₹'))), 'Paid shows only items with a price');
  await t.click('.chip[data-filter=books]'); await feedReady(t);
  const bookIds = await cardIds(t);
  const booksDb = q1(`select string_agg(id::text, ',') from public.listings where society_id = '${SOCIETY}' and status = 'available' and category = 'books'`).split(',');
  check(bookIds.length > 0 && bookIds.every((id) => booksDb.includes(id)) && bookIds.length === Math.min(20, booksDb.length), `Books shows only books (${bookIds.length})`);
  await t.click('.chip[data-filter=all]'); await feedReady(t);
  await searchFor(t, 'LAMP');
  check((await cardTitles(t)).join() === 'Bedside lamp', 'Search matches the title, ignoring case');
  await t.click('.chip[data-filter=free]'); await feedReady(t);
  check((await t.locator('#feed .item-card').count()) === 0 && (await t.textContent('#feed')).includes('Nothing matches'), 'Search and a filter work together (the lamp is not free)');
  await t.click('.chip[data-filter=all]'); await feedReady(t);
  await searchFor(t, 'item_0');
  check((await t.locator('#feed .item-card').count()) === 0, 'An underscore in a search is a plain character, not a wildcard');
  await searchFor(t, '100%');
  check((await t.locator('#feed .item-card').count()) === 0, 'A % in a search is a plain character, not a wildcard');
  await searchFor(t, 'demo item 2');
  check((await cardTitles(t)).sort().join() === 'Demo item 20,Demo item 21,Demo item 22,Demo item 23,Demo item 24', 'Search finds words inside titles');
  await shot(t, 'home-search-light', false);

  // 2. Two neighbours ask for the bookshelf.
  await a.goto(SITE + '/pages/item.html?id=' + SHELF); await settle(a);
  await a.waitForSelector('.item-head h1');
  check(await a.isEnabled('#want-btn') && (await a.textContent('#want-btn')) === 'I want this', 'A neighbour sees I want this');
  check(!(await a.content()).includes('B-202'), 'The owner\'s flat is not on the page before a request is accepted');
  await a.click('#want-btn');
  await a.waitForSelector('#request-sheet[open]');
  await a.fill('#request-msg', 'I can pick it up after 6 pm today.');
  await smallTargets(a, 'request sheet');
  await shot(a, 'item-request-light', false);
  await a.click('#request-form button[type=submit]');
  await a.waitForSelector('#sent-note:not([hidden])');
  check(!(await a.isVisible('#request-sheet')) && (await a.textContent('#want-btn')) === 'Request sent' && await a.isDisabled('#want-btn'), 'Sending the request closes the sheet and shows Request sent');
  check(q1(`select status || '|' || message from public.requests where listing_id = '${SHELF}' and requester_id = '${ASKER.id}'`) === 'pending|I can pick it up after 6 pm today.', 'The request is saved as pending with its message');
  await a.reload(); await settle(a); await a.waitForSelector('.item-head h1');
  check((await a.textContent('#want-btn')) === 'Request sent' && await a.isVisible('#sent-note'), 'After a reload the page still shows Request sent');
  check(!!sqlTry(`insert into public.requests (listing_id, society_id, requester_id) values ('${SHELF}','${SOCIETY}','${ASKER.id}')`, ASKER.id).error, 'The database refuses a second request from the same person');

  await t.goto(SITE + '/pages/item.html?id=' + SHELF); await settle(t); await t.waitForSelector('.item-head h1');
  await t.click('#want-btn'); await t.waitForSelector('#request-sheet[open]');
  await t.click('#request-form button[type=submit]');               // message is optional
  await t.waitForSelector('#sent-note:not([hidden])');
  check(q1(`select count(*) from public.requests where listing_id = '${SHELF}' and status = 'pending'`) === '2', 'A second neighbour asks without a message');

  // 3. The owner sees both and accepts one.
  await o.goto(SITE + '/pages/item.html?id=' + SHELF); await settle(o); await o.waitForSelector('.item-head h1');
  check((await o.textContent('#item')).includes('2 neighbours have asked for this'), 'The owner\'s item page says how many people asked');
  await o.goto(SITE + '/pages/my-items.html'); await settle(o);
  const card = `[data-listing="${SHELF}"]`;
  await o.waitForSelector(`${card} [data-act=accept]`);
  const reqText = await o.textContent(card);
  check(reqText.includes('2 people want this') && reqText.includes('Demo Admin') && reqText.includes('Tower A') && reqText.includes('after 6 pm') && reqText.includes('Demo Taker'),
    'My items lists each request with name, tower and message');
  check(!reqText.includes('A-101') && !reqText.includes('9000000001'), 'Requesters\' flats and phones stay hidden before accepting');
  await noSideScroll(o, 'my items'); await smallTargets(o, 'my items');
  await shot(o, 'my-items-requests-light', false);

  check(!!sqlTry(`select public.accept_request((select id from public.requests where listing_id = '${SHELF}' and requester_id = '${OTHER.id}'))`, ASKER.id).error,
    'A requester cannot accept a request (database refuses)');
  check(!!sqlTry(`update public.listings set status = 'reserved' where id = '${SHELF}'`, OWNER.id).error, 'The owner cannot reserve by a plain update');

  await o.click(`${card} [data-act=accept][data-name="Demo Admin"]`);
  await o.waitForSelector(`${card} [data-act=handed]`);
  check(q1(`select status from public.listings where id = '${SHELF}'`) === 'reserved', 'Accepting reserves the item');
  check(q1(`select string_agg(p.display_name || '=' || r.status, ',' order by p.display_name) from public.requests r join public.profiles p on p.user_id = r.requester_id where r.listing_id = '${SHELF}'`) === 'Demo Admin=accepted,Demo Taker=declined',
    'One request is accepted and the other declined');
  const ownerView = await o.textContent(card);
  check(ownerView.includes('Reserved for') && ownerView.includes('Flat A-101') && ownerView.includes('Tower A'), 'The owner now sees the taker\'s tower and flat');
  check(await o.getAttribute(`${card} a[href^="https://wa.me/"]`, 'href') === 'https://wa.me/919000000001?text=' + encodeURIComponent('Hi Demo Admin, this is about “Small bookshelf” on Dumpy.'),
    'The owner gets a WhatsApp button for the taker\'s number');
  await smallTargets(o, 'my items reserved');
  await shot(o, 'my-items-reserved-light', false);

  // 4. The taker sees the owner's details; the other requester sees it's gone.
  await a.goto(SITE + '/pages/item.html?id=' + SHELF); await settle(a); await a.waitForSelector('.contact');
  const takerView = await a.textContent('#main');
  check((await a.textContent('#want-btn')) === 'Reserved for you' && takerView.includes('Flat B-202') && takerView.includes('Demo Owner'), 'The taker sees Reserved for you and the owner\'s flat');
  check(takerView.includes('Pay the owner directly by UPI or cash'), 'The taker is reminded to pay the owner directly');
  check((await a.getAttribute('.contact a[href^="https://wa.me/"]', 'href')).startsWith('https://wa.me/919000000003?text='), 'The taker gets a WhatsApp button for the owner');
  check((await a.getAttribute('.contact a[href^="tel:"]', 'href')) === 'tel:+919000000003', 'and a Call button');
  await noSideScroll(a, 'item reserved'); await smallTargets(a, 'item reserved');
  await shot(a, 'item-reserved-taker-light');

  await t.goto(SITE + '/pages/item.html?id=' + SHELF); await settle(t); await t.waitForSelector('.item-head h1');
  check((await t.textContent('#want-btn')) === 'Reserved for someone else' && await t.isDisabled('#want-btn'), 'The other requester sees Reserved for someone else');
  check(!(await t.content()).includes('B-202') && !(await t.content()).includes('9000000003'), 'The other requester never gets the owner\'s flat or phone');
  check((await t.evaluate((id) => window.Dumpy.db.rpc('get_contact', { p_listing_id: id }).then((r) => (r.data || []).length), SHELF)) === 0,
    'get_contact gives the other requester nothing, even when called directly');
  await t.goto(SITE + '/pages/my-items.html#requests'); await settle(t);
  await t.waitForSelector('#my-requests .row-card');
  check((await t.textContent('#my-requests')).includes('Gone to someone else'), 'My requests tells the other requester the item is gone');
  await shot(t, 'my-requests-gone-light', false);
  await t.goto(SITE + '/'); await settle(t); await feedReady(t);
  check(!(await cardTitles(t)).includes('Small bookshelf'), 'A reserved item leaves the feed');

  // 5. Two accepts at the same moment (a double tap, or two phones): one wins.
  sql(`insert into public.listings (id, society_id, owner_id, title) values ('11111111-0000-4000-8000-000000000061','${SOCIETY}','${OWNER.id}','Race test item');
       insert into public.requests (listing_id, society_id, requester_id) values
         ('11111111-0000-4000-8000-000000000061','${SOCIETY}','${ASKER.id}'), ('11111111-0000-4000-8000-000000000061','${SOCIETY}','${OTHER.id}');`);
  const race = await o.evaluate(async () => {
    const db = window.Dumpy.db;
    const reqs = (await db.from('requests').select('id').eq('listing_id', '11111111-0000-4000-8000-000000000061')).data;
    const res = await Promise.all(reqs.map((r) => db.rpc('accept_request', { p_request_id: r.id })));
    return res.map((r) => (r.error ? 'refused' : 'ok')).sort().join();
  });
  check(race === 'ok,refused' && q1(`select count(*) from public.requests where listing_id = '11111111-0000-4000-8000-000000000061' and status = 'accepted'`) === '1',
    `Two accepts at once: exactly one wins (${race})`);

  // 6. Cancel the reservation, give it to the other person, hand it over.
  await o.goto(SITE + '/pages/my-items.html'); await settle(o);
  await o.click(`${card} [data-act=cancel]`);
  await o.waitForSelector(`${card} [data-act=accept]`);
  check(q1(`select status from public.listings where id = '${SHELF}'`) === 'available'
    && q1(`select string_agg(p.display_name || '=' || r.status, ',' order by p.display_name) from public.requests r join public.profiles p on p.user_id = r.requester_id where r.listing_id = '${SHELF}'`) === 'Demo Admin=cancelled,Demo Taker=pending',
    'Cancel reservation puts the item back and gives the other requester their turn');
  await a.goto(SITE + '/pages/item.html?id=' + SHELF); await settle(a); await a.waitForSelector('.item-head h1');
  check(!(await a.content()).includes('B-202') && (await a.textContent('#want-btn')).includes('cancelled'), 'After the cancel, the first taker loses the owner\'s details');

  await o.click(`${card} [data-act=accept][data-name="Demo Taker"]`);
  await o.waitForSelector(`${card} [data-act=handed]`);
  check((await o.textContent(card)).includes('has not added a phone number') && (await o.textContent(card)).includes('C-303'), 'With no phone on file, the owner is told the taker\'s flat instead');
  await o.goto(SITE + '/pages/item.html?id=' + SHELF); await settle(o); await o.waitForSelector('.contact');
  check((await o.textContent('#want-btn')) === 'Mark handed over', 'The owner\'s item page offers Mark handed over');
  await smallTargets(o, 'item reserved (owner)');
  await shot(o, 'item-reserved-owner-light');
  await o.click('#want-btn');
  await o.waitForFunction(() => document.querySelector('#want-btn') && document.querySelector('#want-btn').textContent === 'Handed over');
  check(q1(`select status from public.listings where id = '${SHELF}'`) === 'done', 'Mark handed over closes the item as done');
  await shot(o, 'item-done-owner-light', false);

  await t.goto(SITE + '/pages/my-items.html#requests'); await settle(t); await t.waitForSelector('#my-requests .contact');
  const tv = await t.textContent('#my-requests');
  check(tv.includes('Handed over') && tv.includes('Flat B-202'), 'The taker\'s My requests shows it handed over, with the owner\'s details');
  await a.goto(SITE + '/pages/my-items.html#requests'); await settle(a); await a.waitForSelector('#my-requests .row-card');
  const shelfRow = await a.textContent('#my-requests .row-card:has-text("Small bookshelf")');
  check(shelfRow.includes('Gone to someone else') && !shelfRow.includes('B-202'), 'The first taker sees it went to someone else, with no contact details');

  // 7. Dark mode.
  const d = await personPage(OWNER, 'dark');
  await d.goto(SITE + '/'); await settle(d); await feedReady(d);
  await shot(d, 'home-dark', false);
  await d.goto(SITE + '/pages/my-items.html'); await settle(d); await d.waitForSelector(`${card} .contact`);
  await shot(d, 'my-items-dark', false);
  const ad = await personPage(OTHER, 'dark');
  await ad.goto(SITE + '/pages/item.html?id=' + SHELF); await settle(ad); await ad.waitForSelector('.contact');
  await shot(ad, 'item-done-taker-dark');

  check(errors.length === 0, 'No script errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  console.log(L.failed() ? `\n${L.failed()} FAILED` : '\nAll stage 6 browser checks passed');
  process.exit(L.failed() ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
