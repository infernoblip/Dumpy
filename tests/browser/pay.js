// Stage 8 browser test: paying for a paid item by UPI, in a 360 x 740 phone
// viewport against the local stand-in for Supabase (see lib.js and run.sh).
// All people, items and UPI IDs are made up.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path = require('path');
const L = require('./lib');
const { SITE, USERS, SOCIETY, PHONE, check, sql, sqlTry, wire, magicLink, settle, noSideScroll, smallTargets } = L;

const shot = L.shooter(path.join(L.S, '../../docs/screenshots/stage-8'));
const OWNER = USERS.owner;   // Demo Owner, sells the table; has a UPI ID
const TAKER = USERS.admin;   // Demo Admin, buys the table; no UPI ID
const TABLE = '11111111-0000-4000-8000-000000000080';   // ₹250, Demo Owner -> Demo Admin
const CHAIR = '11111111-0000-4000-8000-000000000081';   // free, Demo Owner -> Demo Admin
const RACK = '11111111-0000-4000-8000-000000000082';    // ₹80, Demo Admin (no UPI ID) -> Demo Owner
const UPI = 'demo.owner@okaxis';

const q1 = (query) => sql(query).split('\n').filter(Boolean).pop() || '';

const errors = [];
(async () => {
  sql(`update public.profiles set upi_id = '${UPI}', phone = '9000000003' where user_id = '${OWNER.id}';
       update public.profiles set upi_id = null where user_id = '${TAKER.id}';
       insert into public.listings (id, society_id, owner_id, title, description, category, condition, price_inr) values
         ('${TABLE}','${SOCIETY}','${OWNER.id}','Folding study table & stool','Folds flat. Stool included.','furniture','good',250),
         ('${CHAIR}','${SOCIETY}','${OWNER.id}','Plastic garden chair','','furniture','used',0),
         ('${RACK}','${SOCIETY}','${TAKER.id}','Shoe rack','Holds 12 pairs.','furniture','good',80);
       insert into public.requests (listing_id, society_id, requester_id) values
         ('${TABLE}','${SOCIETY}','${TAKER.id}'), ('${CHAIR}','${SOCIETY}','${TAKER.id}'), ('${RACK}','${SOCIETY}','${OWNER.id}');`);
  sql(`select public.accept_request(id) from public.requests where listing_id in ('${TABLE}','${CHAIR}')`, OWNER.id);
  sql(`select public.accept_request(id) from public.requests where listing_id = '${RACK}'`, TAKER.id);

  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  async function personPage(user, opts) {
    const ctx = await browser.newContext({ ...PHONE, colorScheme: 'light', ...(opts || {}) });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: SITE });
    await wire(ctx);
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) errors.push(m.text()); });
    p.on('dialog', (d) => d.accept());
    await p.goto(magicLink(user)); await settle(p);
    return p;
  }
  const t = await personPage(TAKER);
  const o = await personPage(OWNER);

  // 1. The taker of a paid item gets a Pay button with the amount and note filled in.
  await t.goto(SITE + '/pages/item.html?id=' + TABLE); await settle(t); await t.waitForSelector('.pay');
  const href = await t.getAttribute('[data-pay-link]', 'href');
  const expected = 'upi://pay?pa=' + UPI + '&pn=Demo%20Owner&am=250.00&cu=INR&tn=' + encodeURIComponent('Dumpy: Folding study table & stool');
  check(href === expected, 'Pay opens upi://pay with the owner\'s UPI ID, name, amount, INR and a note\n       ' + href);
  const u = new URL(href.replace('upi://', 'https://upi.example/'));
  check(u.searchParams.get('pa') === UPI && u.searchParams.get('am') === '250.00' && u.searchParams.get('cu') === 'INR'
    && u.searchParams.get('tn') === 'Dumpy: Folding study table & stool', 'A UPI app reads back the same ID, amount and note (the & in the title is escaped)');
  check((await t.textContent('[data-pay-link]')).trim() === 'Pay ₹250', 'The button says Pay ₹250');
  check(!(await t.evaluate(() => !!window.qrcode)) || (await t.locator('[data-pay-qr] svg path').count()) === 1, 'A QR code of the same link is drawn in the browser');
  check(await t.evaluate(() => !!window.qrcode), 'The pinned QR library loaded');
  check(!(await t.evaluate(() => document.querySelector('[data-pay-qr]').open)), 'On a phone the QR code starts folded away');
  await noSideScroll(t, 'item pay'); await smallTargets(t, 'item pay');
  await shot(t, 'item-pay-light');

  // On phones, Pay offers one button per UPI app, so the phone can't hand the
  // payment to WhatsApp. Android gets intent links naming each app's package.
  const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  const query = expected.slice(expected.indexOf('?'));
  const ta = await personPage(TAKER, { userAgent: ANDROID });
  await ta.goto(SITE + '/pages/item.html?id=' + TABLE); await settle(ta); await ta.waitForSelector('.pay [data-pay-app]');
  const apps = await ta.$$eval('.pay [data-pay-app]', (els) => els.map((e) => [e.textContent.trim(), e.getAttribute('href')]));
  check(JSON.stringify(apps.map((a) => a[0])) === '["Google Pay","PhonePe","Paytm"]', 'On Android, Pay offers Google Pay, PhonePe and Paytm');
  check(apps[0][1] === 'intent://pay' + query + '#Intent;scheme=upi;package=com.google.android.apps.nbu.paisa.user;end'
    && apps[1][1].endsWith(';package=com.phonepe.app;end') && apps[2][1].endsWith(';package=net.one97.paytm;end'),
    'Each Android button opens that app by its package, with the same payment details\n       ' + apps[0][1]);
  check((await ta.getAttribute('[data-pay-link]', 'href')) === expected && (await ta.textContent('[data-pay-link]')).trim() === 'Other app',
    'Other app keeps the plain upi:// link');
  check(!(await ta.content()).includes('whatsapp://pay'), 'No button hands the payment to WhatsApp');
  await noSideScroll(ta, 'item pay android'); await smallTargets(ta, 'item pay android');
  await shot(ta, 'item-pay-android-light');
  const ti = await personPage(TAKER, { userAgent: IPHONE });
  await ti.goto(SITE + '/pages/item.html?id=' + TABLE); await settle(ti); await ti.waitForSelector('.pay [data-pay-app]');
  const iapps = await ti.$$eval('.pay [data-pay-app]', (els) => els.map((e) => e.getAttribute('href')));
  check(iapps[0] === 'gpay://upi/pay' + query && iapps[1] === 'phonepe://pay' + query && iapps[2] === 'paytmmp://upi/pay' + query,
    'On iPhone each button uses that app\'s own link');

  // 2. Copy UPI ID, the fallback for iPhones and phones where the link opens nothing.
  await t.click('[data-pay-copy]');
  await t.waitForFunction(() => /Copied/.test(document.querySelector('[data-pay-copy]').textContent));
  check((await t.evaluate(() => navigator.clipboard.readText())) === UPI, 'Copy puts the UPI ID on the clipboard');
  await t.click('[data-pay-qr] summary');
  await shot(t, 'item-pay-qr-light');

  // Read the QR code back with a QR decoder (jsQR), and compare it with the link.
  const jsqrDir = path.join(L.WORK, 'jsqr');
  require('fs').mkdirSync(jsqrDir, { recursive: true });
  require('child_process').execSync('npm pack -q jsqr@1.4.0 >/dev/null && tar xzf jsqr-1.4.0.tgz', { cwd: jsqrDir });
  await t.addScriptTag({ path: path.join(jsqrDir, 'package/dist/jsQR.js') });
  const decoded = await t.evaluate(async () => {
    const svg = document.querySelector('[data-pay-qr] svg');
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg));
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = 400;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, 400, 400);
    const d = g.getImageData(0, 0, 400, 400);
    const r = window.jsQR(d.data, 400, 400);
    return r && r.data;
  });
  check(decoded === href, 'Scanning the QR code gives exactly the Pay link');

  // 3. Free items never show payment.
  await t.goto(SITE + '/pages/item.html?id=' + CHAIR); await settle(t); await t.waitForSelector('.contact');
  const free = await t.content();
  check((await t.locator('.pay, [data-pay-link], [data-pay-copy]').count()) === 0 && !free.includes('upi://') && !free.includes(UPI),
    'A free item shows no Pay button, UPI ID or QR code');
  await t.goto(SITE + '/pages/my-items.html#requests'); await settle(t); await t.waitForSelector('#my-requests .contact');
  check((await t.locator(`#my-requests .pay`).count()) === 1, 'My requests shows the payment box for the paid item only');
  await noSideScroll(t, 'my requests pay'); await smallTargets(t, 'my requests pay');
  await shot(t, 'my-requests-pay-light');

  // 4. An owner without a UPI ID: the taker is told to pay in cash.
  await o.goto(SITE + '/pages/item.html?id=' + RACK); await settle(o); await o.waitForSelector('.pay');
  check((await o.textContent('.pay')).includes('Demo Admin has not added a UPI ID. Pay ₹80 in cash')
    && (await o.locator('[data-pay-link]').count()) === 0, 'If the owner has no UPI ID, the taker is told to pay in cash');

  // 5. The owner marks it paid; the taker sees it.
  check(!!sqlTry(`update public.requests set paid_at = now() where listing_id = '${TABLE}'`, TAKER.id).error, 'The taker cannot mark it paid in the database');
  check(!!sqlTry(`select public.set_paid('${TABLE}', true)`, TAKER.id).error, 'The taker cannot call set_paid');
  await o.goto(SITE + '/pages/my-items.html'); await settle(o);
  const card = `[data-listing="${TABLE}"]`;
  await o.waitForSelector(`${card} [data-pay-toggle]`);
  check(!(await o.isChecked(`${card} [data-pay-toggle]`)) && (await o.textContent(`${card} .pay`)).includes('Demo Admin pays you ₹250 by UPI or cash'),
    'The owner sees Mark as paid, off, with who pays how much');
  check((await o.locator(`[data-listing="${CHAIR}"] .pay`).count()) === 0, 'The owner\'s free item has no payment box');
  await noSideScroll(o, 'my items pay'); await smallTargets(o, 'my items pay');
  await shot(o, 'my-items-mark-paid-light');
  await o.click(`${card} .pay__switch`);
  await o.waitForFunction((c) => /^Paid\./.test(document.querySelector(c + ' [data-pay-status]').textContent), card);
  check(q1(`select paid_at is not null from public.requests where listing_id = '${TABLE}' and status = 'accepted'`) === 't', 'Mark as paid saves the flag');
  check(q1(`select count(*) from information_schema.columns where table_name = 'requests' and column_name ~ 'upi|amount|txn|transaction'`) === '0',
    'Nothing about the transaction itself is stored');
  await shot(o, 'my-items-paid-light');

  await t.goto(SITE + '/pages/item.html?id=' + TABLE); await settle(t); await t.waitForSelector('.pay');
  check((await t.textContent('.pay')).includes('Demo Owner marked this as paid') && (await t.locator('[data-pay-link]').count()) === 0,
    'The taker sees it marked paid, and the Pay button goes away');
  await shot(t, 'item-paid-light');

  await o.reload(); await settle(o); await o.waitForSelector(`${card} [data-pay-toggle]`);
  check(await o.isChecked(`${card} [data-pay-toggle]`), 'After a reload the owner still sees it paid');
  await o.click(`${card} .pay__switch`);
  await o.waitForFunction((c) => /Not paid/.test(document.querySelector(c + ' [data-pay-status]').textContent), card);
  check(q1(`select paid_at is null from public.requests where listing_id = '${TABLE}' and status = 'accepted'`) === 't', 'The owner can undo it');

  // 6. Larger screens show the QR code straight away; dark mode.
  const wide = await personPage(TAKER, { viewport: { width: 1024, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });
  await wide.goto(SITE + '/pages/item.html?id=' + TABLE); await settle(wide); await wide.waitForSelector('.pay');
  check(await wide.evaluate(() => document.querySelector('[data-pay-qr]').open), 'On a larger screen the QR code is shown straight away');
  await shot(wide, 'item-pay-wide-light');
  const dark = await personPage(TAKER, { colorScheme: 'dark' });
  await dark.goto(SITE + '/pages/item.html?id=' + TABLE); await settle(dark); await dark.waitForSelector('.pay');
  await shot(dark, 'item-pay-dark');

  // 7. Profile: UPI ID check.
  await o.goto(SITE + '/pages/profile.html'); await settle(o);
  await o.fill('#upi_id', 'not a upi id');
  await o.click('#profile-submit');
  check(await o.isVisible('#profile-error') && (await o.textContent('#profile-error')).includes('name@bank'), 'Profile refuses a UPI ID that is not like name@bank');
  check(!!sqlTry(`update public.profiles set upi_id = 'nope' where user_id = '${OWNER.id}'`, OWNER.id).error, 'The database refuses it too');
  await o.fill('#upi_id', 'demo.owner2@ybl');
  await o.click('#profile-submit');
  await o.waitForSelector('#saved-note:not([hidden])');
  check(q1(`select upi_id from public.profiles where user_id = '${OWNER.id}'`) === 'demo.owner2@ybl', 'A good UPI ID is saved');
  await shot(o, 'profile-upi-light');

  check(errors.length === 0, 'No script errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  if (L.failed()) { console.log(`\n${L.failed()} check(s) failed`); process.exit(1); }
  console.log('\nAll stage 8 browser checks passed');
})().catch((e) => { console.error(e, errors); process.exit(1); });
