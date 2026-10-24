// Stage 10 browser test: reporting an item, the admin's queue (Hide and
// Dismiss), suspending and restoring a member, and items expiring after 30
// days until their owner renews them. 360 x 740 phone viewport, against the
// local stand-in for Supabase (see lib.js and run.sh). All people and items
// are made up.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path = require('path');
const L = require('./lib');
const { SITE, USERS, SOCIETY, PHONE, check, sql, sqlTry, wire, magicLink, settle, noSideScroll, smallTargets } = L;

const shot = L.shooter(path.join(L.S, '../../docs/screenshots/stage-10'));
const ADMIN = USERS.admin;
const OWNER = { id: 'aaaaaaaa-0000-4000-8000-000000000101', email: 'mod.owner@example.com' };
const NEIGHBOUR = { id: 'aaaaaaaa-0000-4000-8000-000000000102', email: 'mod.neighbour@example.com' };
const SYRUP = '11111111-0000-4000-8000-000000000101';   // reported, then hidden
const TOYS = '11111111-0000-4000-8000-000000000102';    // reported, then dismissed
const MIXER = '11111111-0000-4000-8000-000000000103';   // expires, then renewed

const q1 = (query) => sql(query).split('\n').filter(Boolean).pop() || '';
const asUser = (query, id) => (sqlTry(query, id).out || '').split('\n').filter(Boolean).pop() || '';

async function feedReady(p) {
  await p.waitForFunction(() => {
    const m = document.querySelector('#feed-meta').textContent;
    return m && !/Loading/.test(m) || document.querySelector('#feed .empty');
  }, null, { timeout: 10000 });
  await p.waitForTimeout(150);
}
const feedTitles = (p) => p.$$eval('#feed .item-card__title', (hs) => hs.map((h) => h.textContent));

(async () => {
  sql(`insert into auth.users (id, aud, role, email, created_at, updated_at) values
         ('${OWNER.id}','authenticated','authenticated','${OWNER.email}', now(), now()),
         ('${NEIGHBOUR.id}','authenticated','authenticated','${NEIGHBOUR.email}', now(), now()) on conflict do nothing;
       insert into public.profiles (user_id, display_name, tower, flat) values
         ('${OWNER.id}','Demo Seller','D','D-404'), ('${NEIGHBOUR.id}','Demo Neighbour','E','E-505') on conflict do nothing;
       insert into public.memberships (user_id, society_id, role, status) values
         ('${OWNER.id}','${SOCIETY}','member','approved'), ('${NEIGHBOUR.id}','${SOCIETY}','member','approved') on conflict do nothing;
       insert into public.listings (id, society_id, owner_id, title, description, category, condition, price_inr) values
         ('${SYRUP}','${SOCIETY}','${OWNER.id}','Cough syrup, half bottle','Opened last month.','other','used',0),
         ('${TOYS}','${SOCIETY}','${OWNER.id}','Bag of toy cars','About 15 cars.','kids','used',0),
         ('${MIXER}','${SOCIETY}','${OWNER.id}','Old mixer grinder','Works, a bit loud.','kitchen','used',300);`);

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
  const n = await personPage(NEIGHBOUR);
  const o = await personPage(OWNER);
  const a = await personPage(ADMIN);

  // 1. A neighbour reports two items.
  await n.goto(SITE + '/pages/item.html?id=' + SYRUP); await settle(n);
  await n.waitForSelector('#report-btn');
  await n.click('#report-btn');
  await n.waitForSelector('#report-sheet[open]');
  await n.click('#report-sheet button[type=submit]');
  check(await n.isVisible('#report-error'), 'Sending a report without a reason asks for one');
  await n.click('.reason:has-text("Not allowed")');
  await n.fill('#report-note', 'Medicines are on the not-allowed list.');
  await noSideScroll(n, 'report sheet');
  await smallTargets(n, 'report sheet');
  await shot(n, 'item-report-light', false);
  await n.click('#report-sheet button[type=submit]');
  await n.waitForSelector('.report-box:has-text("You reported this item")');
  check(q1(`select reason || '/' || status || '/' || note from public.reports where listing_id = '${SYRUP}'`) === 'not_allowed/open/Medicines are on the not-allowed list.',
    'The report is saved with its reason and note');
  await shot(n, 'item-reported-light');
  await n.reload(); await settle(n); await n.waitForSelector('.report-box p');
  check(!(await n.$('#report-btn')), 'After reload the item still says it was reported, with no second Report button');

  await n.goto(SITE + '/pages/item.html?id=' + TOYS); await settle(n);
  await n.click('#report-btn'); await n.waitForSelector('#report-sheet[open]');
  await n.click('.reason:has-text("Spam")');
  await n.click('#report-sheet button[type=submit]');
  await n.waitForSelector('.report-box:has-text("You reported this item")');

  await o.goto(SITE + '/pages/item.html?id=' + TOYS); await settle(o);
  check(!(await o.$('#report-btn')), 'Owners get no Report button on their own items');
  check(asUser(`select count(*) from public.reports`, OWNER.id) === '0', 'The owner cannot read the reports on their items');

  // 2. The admin's queue: Hide in one tap, Dismiss in one tap.
  await a.goto(SITE + '/pages/admin.html'); await settle(a);
  await a.waitForSelector('#reports .row-card');
  const qText = await a.textContent('#reports');
  check(qText.includes('Cough syrup') && qText.includes('Not allowed') && qText.includes('Medicines are on the not-allowed list.') && qText.includes('Bag of toy cars'),
    'The admin queue shows both reported items with reasons and notes');
  check((await a.textContent('#reports-count')) === '2 to check', 'The queue counts the items to check');
  await noSideScroll(a, 'admin');
  await smallTargets(a, 'admin');
  await shot(a, 'admin-reports-light');
  await a.click(`#reports [data-listing="${SYRUP}"] [data-act=hide]`);
  await a.waitForFunction((id) => !document.querySelector(`#reports [data-listing="${id}"]`), SYRUP);
  check(q1(`select status from public.listings where id = '${SYRUP}'`) === 'hidden', 'One tap on Hide item hides it');
  check(q1(`select status from public.reports where listing_id = '${SYRUP}'`) === 'actioned', 'Its report is marked actioned');
  check((await a.textContent('#reports-status')).includes('is hidden'), 'The admin is told the item is hidden');
  await a.click(`#reports [data-listing="${TOYS}"] [data-act=dismiss]`);
  await a.waitForSelector('#reports .empty');
  check(q1(`select status from public.listings where id = '${TOYS}'`) === 'available'
        && q1(`select status from public.reports where listing_id = '${TOYS}'`) === 'dismissed', 'Dismiss keeps the item up and closes the report');
  await shot(a, 'admin-queue-empty-light', false);

  await n.goto(SITE + '/'); await settle(n); await feedReady(n);
  check(!(await feedTitles(n)).includes('Cough syrup, half bottle'), 'The hidden item has left the feed');
  await o.goto(SITE + '/pages/item.html?id=' + SYRUP); await settle(o);
  await o.waitForSelector('#want-btn');
  check((await o.textContent('#want-btn')) === 'Hidden by your admin', 'The owner sees their item was hidden by the admin');

  // 3. Suspend and restore.
  await a.goto(SITE + '/pages/admin.html'); await settle(a);
  await a.waitForSelector(`#members [data-user="${NEIGHBOUR.id}"][data-act=suspend]`);
  await a.click(`#members [data-user="${NEIGHBOUR.id}"][data-act=suspend]`);
  await a.waitForSelector(`#members [data-user="${NEIGHBOUR.id}"][data-act=restore]`);
  check(q1(`select status from public.memberships where user_id = '${NEIGHBOUR.id}'`) === 'suspended', 'Suspend sets the member to suspended');
  check(!(await a.$(`#members [data-user="${ADMIN.id}"]`)), 'The admin has no Suspend button on themselves');
  await shot(a, 'admin-members-light');

  await n.goto(SITE + '/'); await settle(n);
  check(/join\.html/.test(n.url()) && await n.isVisible('#step-suspended'), 'A suspended member is sent to the suspended screen');
  check(asUser(`select count(*) from public.listings`, NEIGHBOUR.id) === '0', 'A suspended member can read no items from the database');
  await shot(n, 'suspended-light', false);
  await n.goto(SITE + '/pages/item.html?id=' + TOYS); await settle(n);
  check(/join\.html/.test(n.url()), 'A suspended member cannot open an item page');

  await a.click(`#members [data-user="${NEIGHBOUR.id}"][data-act=restore]`);
  await a.waitForSelector(`#members [data-user="${NEIGHBOUR.id}"][data-act=suspend]`);
  await n.goto(SITE + '/'); await settle(n); await feedReady(n);
  check((await feedTitles(n)).includes('Bag of toy cars'), 'Once restored, they see items again');

  // 4. Expiry after 30 days, and Renew.
  sql(`update public.listings set created_at = now() - interval '31 days', expires_at = now() - interval '1 day' where id = '${MIXER}'`);
  await n.reload(); await settle(n); await feedReady(n);
  await n.fill('#search', 'mixer'); await n.waitForTimeout(450); await feedReady(n);
  check(!(await feedTitles(n)).includes('Old mixer grinder'), 'An item past its 30 days drops out of the feed straight away');
  check(Number(q1(`select public.expire_old_listings()`)) >= 1 && q1(`select status from public.listings where id = '${MIXER}'`) === 'expired',
    'The hourly job marks it expired');
  await o.goto(SITE + '/pages/my-items.html'); await settle(o);
  const row = `#listings [data-listing="${MIXER}"]`;
  await o.waitForSelector(`${row} [data-act=relist]`);
  check((await o.textContent(row)).includes('Expired') && (await o.textContent(`${row} [data-act=relist]`)) === 'Renew', 'My items shows it expired, with a Renew button');
  check((await o.textContent(`#listings [data-listing="${SYRUP}"]`)).includes('Your society admin hid this item'), 'My items explains the hidden item');
  await noSideScroll(o, 'my items');
  await smallTargets(o, 'my items');
  await shot(o, 'my-items-expired-light');
  await o.click(`${row} [data-act=relist]`);
  await o.waitForSelector(`${row} [data-act=withdraw]`);
  check(q1(`select status || '/' || (expires_at > now() + interval '29 days') from public.listings where id = '${MIXER}'`) === 'available/true',
    'Renew puts it back up for 30 more days');
  // It keeps its place by posting date, so find it with search.
  await n.reload(); await settle(n); await feedReady(n);
  await n.fill('#search', 'mixer'); await n.waitForTimeout(450); await feedReady(n);
  check((await feedTitles(n)).includes('Old mixer grinder'), 'The renewed item is back in the feed');

  // 5. The not-allowed page, linked from the post form.
  await o.goto(SITE + '/pages/post.html'); await settle(o);
  await o.click('a[href="not-allowed.html"]');
  await o.waitForSelector('.rules');
  const rules = await o.textContent('.rules');
  check(['Medicines', 'Alcohol', 'Tobacco', 'Weapons', 'Expired food', 'illegal'].every((w) => rules.includes(w)), 'The not-allowed page lists every banned kind of item');
  await noSideScroll(o, 'not allowed');
  await smallTargets(o, 'not allowed');
  await shot(o, 'not-allowed-light');
  await o.click('#back');
  await o.waitForURL(/post\.html/);
  check(true, 'Back returns to the post form');

  // 6. Dark mode.
  sql(`insert into public.reports (listing_id, society_id, reporter_id, reason, note)
       values ('${MIXER}','${SOCIETY}','${NEIGHBOUR.id}','other','Same mixer was posted twice.')`);
  const ad = await personPage(ADMIN, 'dark');
  await ad.goto(SITE + '/pages/admin.html'); await settle(ad); await ad.waitForSelector('#reports .row-card');
  await shot(ad, 'admin-dark');
  const od = await personPage(OWNER, 'dark');
  await od.goto(SITE + '/pages/not-allowed.html');
  await shot(od, 'not-allowed-dark', false);
  const nd = await personPage(ADMIN, 'dark');
  await nd.goto(SITE + '/pages/item.html?id=' + TOYS); await settle(nd);
  await nd.click('#report-btn'); await nd.waitForSelector('#report-sheet[open]');
  await nd.click('.reason:has-text("Offensive")');
  await shot(nd, 'item-report-dark', false);

  check(errors.length === 0, 'No script errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  console.log(L.failed() ? `\n${L.failed()} FAILED` : '\nAll stage 10 browser checks passed');
  process.exit(L.failed() ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
