// Stage 9 browser test: the Email updates switch on the profile page, the
// share buttons on the item page, and the emails the database queues when
// people ask for and get items. In a 360 x 740 phone viewport against the
// local stand-in for Supabase (see lib.js and run.sh). All people and items
// are made up. Sending itself is tested in tests/functions/send-email.test.mjs.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path = require('path');
const L = require('./lib');
const { SITE, USERS, PHONE, check, sql, wire, magicLink, settle, noSideScroll, smallTargets } = L;

const shot = L.shooter(path.join(L.S, '../../docs/screenshots/stage-9'));
const OWNER = USERS.owner;   // Demo Owner: owns the chair and the lamp
const ASKER = USERS.admin;   // Demo Admin
const CHAIR = '11111111-0000-4000-8000-000000000001';
const LAMP = '11111111-0000-4000-8000-000000000002';
const q1 = (query) => sql(query).split('\n').filter(Boolean).pop() || '';
const queued = (kind, user, listing) => Number(q1(`select count(*) from public.notifications
  where kind = '${kind}' and recipient_id = '${user}' and listing_id = '${listing}'`));

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const errors = [];
  async function personPage(user, scheme, share) {
    const ctx = await browser.newContext({ ...PHONE, colorScheme: scheme || 'light' });
    await wire(ctx);
    // Record what the phone's share sheet would get.
    if (share) await ctx.addInitScript(() => {
      window.__shared = [];
      navigator.share = (d) => { window.__shared.push(d); return Promise.resolve(); };
      navigator.canShare = () => true;
    });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) errors.push(m.text()); });
    p.on('dialog', (d) => d.accept());
    await p.goto(magicLink(user)); await settle(p);
    return p;
  }

  // 1. Profile: the switch starts on and saves straight away.
  const o = await personPage(OWNER);
  await o.goto(SITE + '/pages/profile.html'); await settle(o);
  await o.waitForSelector('#email-box:not([hidden])');
  check(await o.isChecked('#emails'), 'Email updates start switched on');
  check((await o.textContent('#email-shown')) === OWNER.email, 'The switch says which address the emails go to');
  await noSideScroll(o, 'profile'); await smallTargets(o, 'profile');
  const box = await o.$('#email-box');
  const sw = await (await o.$('#emails')).boundingBox();
  const label = await (await o.$('#email-box .switch')).boundingBox();
  check(sw.width >= 44 && label.height >= 44, 'The switch and its label are at least 44 px to tap');
  await box.scrollIntoViewIfNeeded();
  await shot(o, 'profile-light');

  await o.click('#email-box .switch');
  await o.waitForFunction(() => /off/.test(document.querySelector('#email-status').textContent));
  check(q1(`select email_notifications from public.profiles where user_id = '${OWNER.id}'`) === 'f',
    'Turning the switch off saves it in the database');
  await o.reload(); await settle(o); await o.waitForSelector('#email-box:not([hidden])');
  check(!(await o.isChecked('#emails')), 'The switch stays off after a reload');
  await shot(o, 'profile-off-light', false);

  // 2. With emails off, the owner gets nothing when someone asks.
  const a = await personPage(ASKER, 'light', true);
  await a.goto(SITE + '/pages/item.html?id=' + LAMP); await settle(a);
  await a.waitForSelector('#share-box:not([hidden])');
  await a.click('#want-btn'); await a.click('#request-form button[type=submit]');
  await a.waitForSelector('#sent-note:not([hidden])');
  check(queued('request_new', OWNER.id, LAMP) === 0, 'An owner with emails off gets no email about a new request');

  // 3. Switch back on: the next request queues exactly one email to the owner.
  await o.click('#email-box .switch');
  await o.waitForFunction(() => /are on/.test(document.querySelector('#email-status').textContent));
  check(q1(`select email_notifications from public.profiles where user_id = '${OWNER.id}'`) === 't',
    'Turning the switch back on saves it');
  await a.goto(SITE + '/pages/item.html?id=' + CHAIR); await settle(a);
  await a.waitForSelector('#share-box:not([hidden])');

  // 4. Share buttons.
  const wa = await a.getAttribute('#share-wa', 'href');
  const link = SITE + '/pages/item.html?id=' + CHAIR;
  check(wa === 'https://wa.me/?text=' + encodeURIComponent('Wooden study chair (Free) on Dumpy: ' + link),
    'Share on WhatsApp opens wa.me with the item title and link');
  check(await a.isVisible('#share-more'), 'The phone share button shows when the browser can share');
  await a.click('#share-more');
  const shared = await a.evaluate(() => window.__shared);
  check(shared.length === 1 && shared[0].url === link && /Wooden study chair/.test(shared[0].text),
    'The phone share sheet gets the item title and link');
  await noSideScroll(a, 'item'); await smallTargets(a, 'item');
  await shot(a, 'item-share-light');

  await a.click('#want-btn'); await a.fill('#request-msg', 'Can collect after 6 pm.');
  await a.click('#request-form button[type=submit]');
  await a.waitForSelector('#sent-note:not([hidden])');
  check(queued('request_new', OWNER.id, CHAIR) === 1, 'A new request queues exactly one email, to the owner');
  check(Number(q1(`select count(*) from public.notifications where listing_id = '${CHAIR}'`)) === 1,
    '...and nobody else');

  // 5. Accepting queues one email to the chosen requester.
  await o.goto(SITE + '/pages/my-items.html'); await settle(o);
  await o.click(`li:has-text("Wooden study chair") button[aria-label="Accept Demo Admin"]`);
  await o.waitForFunction(() => document.querySelector('.contact'), null, { timeout: 10000 });
  check(queued('request_accepted', ASKER.id, CHAIR) === 1, 'Accepting queues exactly one email, to the requester');

  // 6. No share box on items that are no longer available, or that don't exist.
  await a.goto(SITE + '/pages/item.html?id=' + CHAIR); await settle(a); await a.waitForSelector('.contact');
  await a.waitForTimeout(300);
  check(!(await a.isVisible('#share-box')), 'A reserved item has no share buttons');
  await a.goto(SITE + '/pages/item.html?id=11111111-0000-4000-8000-0000000000ff'); await settle(a);
  await a.waitForSelector('#item .empty'); await a.waitForTimeout(300);
  check(!(await a.isVisible('#share-box')), 'A missing item has no share buttons');

  // 7. A browser without a share sheet still gets the WhatsApp button.
  const plain = await personPage(OWNER, 'dark');
  await plain.goto(SITE + '/pages/item.html?id=' + LAMP); await settle(plain);
  await plain.waitForSelector('#share-box:not([hidden])');
  const hasShare = await plain.evaluate(() => !!navigator.share);
  check(hasShare || !(await plain.isVisible('#share-more')), 'Without a share sheet only the WhatsApp button shows');
  await shot(plain, 'item-share-dark');
  await plain.goto(SITE + '/pages/profile.html'); await settle(plain);
  await plain.waitForSelector('#email-box:not([hidden])');
  await shot(plain, 'profile-dark');

  check(errors.length === 0, 'No script errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  console.log(L.failed() ? `\n${L.failed()} FAILED` : '\nAll stage 9 browser checks passed');
  process.exit(L.failed() ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
