// Delivery fee browser test: the platform admin sets a fee on Run Dumpy, the
// pair see it when booking a helper, the taker pays it after the helper
// delivers, and the platform admin confirms it. 360 x 740 phone viewport,
// against the local stand-in for Supabase (see lib.js and run.sh). All people
// are made up.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path = require('path');
const L = require('./lib');
const { SITE, USERS, SOCIETY, PHONE, check, sql, sqlTry, wire, magicLink, settle, noSideScroll, smallTargets } = L;

const shot = L.shooter(path.join(L.S, '../../docs/screenshots/delivery-fee'));
const OWNER = USERS.owner;
const TAKER = { id: 'aaaaaaaa-0000-4000-8000-000000000011', email: 'demo.taker11@example.com' };
const HELPER = { id: 'aaaaaaaa-0000-4000-8000-000000000012', email: 'demo.helper12@example.com' };
const BOSS = { id: 'aaaaaaaa-0000-4000-8000-000000000013', email: 'demo.runs.dumpy@example.com' };
const LAMP = '11111111-0000-4000-8000-000000000090';
const RUG = '11111111-0000-4000-8000-000000000091';

const q1 = (query) => sql(query).split('\n').filter(Boolean).pop() || '';

(async () => {
  sql(`insert into auth.users (id, aud, role, email, created_at, updated_at) values
         ('${TAKER.id}','authenticated','authenticated','${TAKER.email}', now(), now()),
         ('${HELPER.id}','authenticated','authenticated','${HELPER.email}', now(), now()),
         ('${BOSS.id}','authenticated','authenticated','${BOSS.email}', now(), now()) on conflict do nothing;
       insert into public.profiles (user_id, display_name, tower, flat, phone) values
         ('${TAKER.id}','Demo Taker','C','C-301','9000000301'),
         ('${HELPER.id}','Demo Helper','D','D-401','9000000401'),
         ('${BOSS.id}','Demo Runner','A','A-101',null) on conflict do nothing;
       insert into public.memberships (user_id, society_id, role, status) values
         ('${TAKER.id}','${SOCIETY}','member','approved'), ('${HELPER.id}','${SOCIETY}','member','approved') on conflict do nothing;
       insert into public.delivery_helpers (society_id, user_id) values ('${SOCIETY}','${HELPER.id}') on conflict do nothing;
       insert into public.platform_admins (user_id) values ('${BOSS.id}') on conflict do nothing;
       insert into public.listings (id, society_id, owner_id, title, description, category, condition, price_inr) values
         ('${LAMP}','${SOCIETY}','${OWNER.id}','Brass reading lamp','Works, warm light.','other','good',0),
         ('${RUG}','${SOCIETY}','${OWNER.id}','Cotton rug','Washed.','other','good',0);
       insert into public.requests (listing_id, society_id, requester_id) values
         ('${LAMP}','${SOCIETY}','${TAKER.id}'), ('${RUG}','${SOCIETY}','${TAKER.id}');`);
  sql(`select public.accept_request(id) from public.requests where listing_id in ('${LAMP}','${RUG}')`, OWNER.id);

  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const errors = [];
  async function personPage(user, scheme, userAgent) {
    const ctx = await browser.newContext({ ...PHONE, colorScheme: scheme || 'light', ...(userAgent ? { userAgent } : {}) });
    await wire(ctx);
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) errors.push(m.text()); });
    p.on('dialog', (d) => d.accept());
    await p.goto(magicLink(user)); await settle(p);
    return p;
  }
  const box = '.delivery';

  // 1. With the fee off, the delivery form says nothing about a fee.
  const t = await personPage(TAKER);
  await t.goto(SITE + '/pages/item.html?id=' + LAMP); await settle(t);
  await t.waitForSelector(`${box} form`);
  await t.click(`${box} label:has-text("A neighbour helper brings it")`);
  await t.waitForTimeout(300);
  check(await t.isHidden(`${box} [data-fee-note]`), 'While the fee is off, the form shows no fee');

  // 2. The platform admin turns the fee on in Run Dumpy.
  const b = await personPage(BOSS);
  await b.goto(SITE + '/pages/platform.html'); await settle(b);
  await b.waitForSelector('#fees:not([hidden])');
  check((await b.inputValue('#fee-amount')) === '0', 'Run Dumpy shows the fee section, starting at ₹0');
  await b.fill('#fee-amount', '20');
  await b.click('#fee-form button[type=submit]');
  check((await b.textContent('#fee-error')).includes('UPI ID'), 'A fee without a UPI ID is refused with a clear message');
  await b.fill('#fee-upi', 'dumpy.demo@okbank');
  await b.fill('#fee-name', 'Dumpy');
  await b.click('#fee-form button[type=submit]');
  await b.waitForSelector('#fee-saved:not([hidden])');
  check(q1(`select delivery_fee_inr || ' ' || fee_upi_id from public.platform_settings`) === '20 dumpy.demo@okbank', 'The fee settings are saved');
  await noSideScroll(b, 'run dumpy fees'); await smallTargets(b, 'run dumpy fees');
  await shot(b, 'platform-fee-settings-light');

  // Members cannot read or change the settings, even asking the database directly.
  const direct = await t.evaluate(async () => {
    const db = window.Dumpy.db;
    const a = await db.rpc('platform_fee_settings');
    const c = await db.rpc('platform_set_fee_settings', { p_fee: 0, p_upi_id: '', p_payee_name: 'x' });
    const d = await db.from('platform_settings').select('*');
    return [!!a.error, !!c.error, !!d.error || (d.data || []).length === 0];
  });
  check(direct.every(Boolean), 'A member cannot read or change the fee settings');

  // 3. The taker books a helper and sees the fee before saving.
  await t.reload(); await settle(t);
  await t.waitForSelector(`${box} form`);
  await t.click(`${box} label:has-text("A neighbour helper brings it")`);
  await t.waitForSelector(`${box} [data-fee-note]:not([hidden])`);
  check((await t.textContent(`${box} [data-fee-note]`)).includes('You pay Dumpy a ₹20 delivery fee by UPI, once the item arrives'),
    'Choosing a helper shows the ₹20 fee and when it is paid');
  await t.click(`${box} label:has-text("Tomorrow")`);
  await t.click(`${box} label:has-text("6–8 pm")`);
  await t.fill(`${box} [data-tip] input`, '₹30 cash');
  await noSideScroll(t, 'item delivery form with fee'); await smallTargets(t, 'item delivery form with fee');
  await shot(t, 'item-arrange-fee-light');
  await t.click(`${box} button[type=submit]`);
  await t.waitForSelector(`${box} .delivery__plan`);
  const plan = await t.textContent(box);
  check(plan.includes('₹30 cash') && plan.includes('You pay Dumpy a ₹20 delivery fee'), 'The plan shows the helper tip and the Dumpy fee');
  check(q1(`select fee_inr || ' ' || (fee_payer_id = '${TAKER.id}') from public.deliveries where listing_id = '${LAMP}' and status = 'open'`) === '20 true',
    'The delivery carries the ₹20 fee, paid by the taker');

  const o = await personPage(OWNER);
  await o.goto(SITE + '/pages/item.html?id=' + LAMP); await settle(o);
  await o.waitForSelector(`${box} .delivery__plan`);
  check((await o.textContent(box)).includes('Demo Taker pays Dumpy a ₹20 delivery fee'), 'The owner sees that the taker pays the fee');

  // 4. The helper takes and delivers it.
  const did = q1(`select id from public.deliveries where listing_id = '${LAMP}' and status = 'open'`);
  sql(`select public.claim_delivery('${did}')`, HELPER.id);
  sql(`select public.mark_delivered('${did}')`, HELPER.id);

  // 5. The taker pays the fee.
  await t.reload(); await settle(t);
  await t.waitForSelector(`${box} [data-fee]`);
  const href = await t.getAttribute(`${box} [data-pay-link]`, 'href');
  const ref = 'DLV-' + did.replace(/-/g, '').slice(0, 6).toUpperCase();
  check(href.startsWith('upi://pay?pa=dumpy.demo@okbank&pn=Dumpy&am=20.00&cu=INR&tn=') && decodeURIComponent(href).includes('delivery ' + ref),
    `Pay opens a UPI app with ₹20 to Dumpy and the reference ${ref} in the note`);
  check((await t.textContent(`${box} [data-fee]`)).includes('Any tip goes straight to Demo Helper'), 'The fee box reminds the taker the tip goes to the helper');
  check(await t.isVisible(`${box} [data-pay-copy]`), 'Copy UPI ID is offered');
  await noSideScroll(t, 'item fee due'); await smallTargets(t, 'item fee due');
  await shot(t, 'item-fee-due-light');

  // An unpaid fee blocks booking another helper (the rug), but not a free mode.
  await t.goto(SITE + '/pages/item.html?id=' + RUG); await settle(t);
  await t.waitForSelector(`${box} form`);
  await t.click(`${box} label:has-text("A neighbour helper brings it")`);
  await t.click(`${box} label:has-text("Tomorrow")`);
  await t.click(`${box} label:has-text("2–4 pm")`);
  await t.click(`${box} button[type=submit]`);
  await t.waitForSelector(`${box} [data-err]:not([hidden])`);
  check((await t.textContent(`${box} [data-err]`)).includes('unpaid Dumpy delivery fee'), 'With a fee unpaid, booking another helper explains why it cannot');

  await t.goto(SITE + '/pages/item.html?id=' + LAMP); await settle(t);
  await t.waitForSelector(`${box} [data-dact=feepaid]`);
  await t.click(`${box} [data-dact=feepaid]`);
  await t.waitForFunction(() => document.querySelector('.delivery').textContent.includes('You marked this as paid'));
  check(q1(`select fee_marked_paid_at is not null from public.deliveries where id = '${did}'`) === 't', "I've paid is saved");
  await shot(t, 'item-fee-marked-light');

  // 6. The platform admin checks and confirms it.
  await b.reload(); await settle(b);
  await b.waitForSelector(`#fee-list [data-fee="${did}"]`);
  const li = await b.textContent(`#fee-list [data-fee="${did}"]`);
  check(li.includes(ref) && li.includes('Brass reading lamp') && li.includes('Demo Taker') && li.includes('Says paid'), 'Run Dumpy lists the fee as "Says paid", with reference, item and taker');
  check((await b.textContent('#fee-totals')).includes('To check₹20'), 'Totals show ₹20 to check');
  check(!(await b.content()).match(/C-301|9000000301/), 'Run Dumpy shows no flats or phones');
  await noSideScroll(b, 'run dumpy ledger'); await smallTargets(b, 'run dumpy ledger');
  await b.evaluate(() => document.getElementById('fee-list').scrollIntoView());
  await shot(b, 'platform-fee-ledger-light');
  await b.click(`#fee-list [data-fee="${did}"] [data-fact=confirm]`);
  await b.waitForFunction((id) => document.querySelector(`#fee-list [data-fee="${id}"]`).textContent.includes('Received'), did);
  check((await b.textContent('#fee-totals')).includes('Received₹20'), 'Confirm received moves ₹20 to Received');

  await t.reload(); await settle(t);
  await t.waitForFunction(() => document.querySelector('.delivery') && document.querySelector('.delivery').textContent.includes('Dumpy got your fee'));
  check(true, 'The taker sees the fee as received');

  // 7. Now the rug can have a helper. Dark mode shots.
  const td = await personPage(TAKER, 'dark', 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36');
  await td.goto(SITE + '/pages/item.html?id=' + RUG); await settle(td);
  await td.waitForSelector(`${box} form`);
  await td.click(`${box} label:has-text("A neighbour helper brings it")`);
  await td.waitForSelector(`${box} [data-fee-note]:not([hidden])`);
  await shot(td, 'item-arrange-fee-dark');
  sql(`select public.arrange_delivery('${RUG}', 'helper', (((now() at time zone 'Asia/Kolkata')::date + 1) + time '10:00') at time zone 'Asia/Kolkata', '')`, TAKER.id);
  const rid = q1(`select id from public.deliveries where listing_id = '${RUG}' and status = 'open'`);
  check(!!rid, 'Once paid, the taker can book a helper again');
  sql(`select public.claim_delivery('${rid}')`, HELPER.id);
  sql(`select public.mark_delivered('${rid}')`, HELPER.id);
  await td.reload(); await settle(td);
  await td.waitForSelector(`${box} [data-pay-app]`);
  check((await td.getAttribute(`${box} [data-pay-app="PhonePe"]`, 'data-pay-id')) === 'dumpy.demo@okbank' && /3\s*Pay ₹20\s*Add the note DLV-[0-9A-F]{6}/.test(await td.textContent(`${box} .pay-steps`)) && /4\s*Come back and tap I've paid/.test(await td.textContent(`${box} .pay-steps`)), 'On Android the fee box offers PhonePe and the other UPI apps, with the ID to copy and ₹20 to enter');
  await shot(td, 'item-fee-due-dark');

  // A business UPI ID: pasting the business QR link on Run Dumpy fills in the
  // details, and the taker's app opens with ₹20 and the reference filled in.
  await b.goto(SITE + '/pages/platform.html'); await settle(b);
  await b.waitForSelector('#fees:not([hidden])');
  check(await b.isHidden('#fee-mc-field'), 'The merchant code field stays hidden for a personal UPI ID');
  await b.fill('#fee-upi', 'upi://pay?pa=Q987654321@ybl&pn=Dumpy%20Store&mc=5399&mode=02&purpose=00');
  check((await b.inputValue('#fee-upi')) === 'Q987654321@ybl' && (await b.inputValue('#fee-name')) === 'Dumpy Store'
    && await b.isChecked('#fee-business') && (await b.inputValue('#fee-mc')) === '5399',
    'Pasting the business QR link fills in the UPI ID, name and merchant code, and ticks "business"');
  await noSideScroll(b, 'run dumpy business upi'); await smallTargets(b, 'run dumpy business upi');
  await b.evaluate(() => document.getElementById('fee-form').scrollIntoView());
  await shot(b, 'platform-business-upi-light', false);
  await b.click('#fee-form button[type=submit]');
  await b.waitForSelector('#fee-saved:not([hidden])');
  check(q1(`select fee_upi_id || ' ' || fee_upi_business || ' ' || fee_merchant_code from public.platform_settings`) === 'Q987654321@ybl true 5399', 'The business UPI ID is saved');
  await td.reload(); await settle(td);
  await td.waitForSelector(`${box} [data-pay-onetap]`);
  const one = await td.getAttribute(`${box} [data-pay-app="Google Pay"]`, 'href');
  check(one.startsWith('intent://pay?pa=Q987654321@ybl&pn=Dumpy%20Store&am=20.00&cu=INR&tn=') && one.includes('&mc=5399&tr=DLV-')
    && one.endsWith('#Intent;scheme=upi;package=com.google.android.apps.nbu.paisa.user;end'),
    'With a business UPI ID, Google Pay opens with ₹20, the merchant code and the reference filled in\n       ' + one);
  const oneText = await td.textContent(`${box} .pay-steps`);
  check(/2\s*Check it says ₹20, then pay/.test(oneText) && /3\s*Come back and tap I've paid/.test(oneText), 'Business UPI: three steps, tap your app, check ₹20 and pay, tap I\'ve paid');
  await noSideScroll(td, 'fee business'); await smallTargets(td, 'fee business');
  await shot(td, 'item-fee-business-dark');
  const bd = await personPage(BOSS, 'dark');
  await bd.goto(SITE + '/pages/platform.html'); await settle(bd);
  await bd.waitForSelector(`#fee-list [data-fee="${rid}"]`);
  await shot(bd, 'platform-fees-dark');

  // Turn the fee back off so later test files start as before.
  sql(`update public.platform_settings set delivery_fee_inr = 0, fee_upi_id = null, fee_upi_business = false, fee_merchant_code = null`);
  check(!sqlTry(`select 1`).error, 'Fee switched back off');

  check(errors.length === 0, 'No script errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  console.log(L.failed() ? `\n${L.failed()} FAILED` : '\nAll delivery fee browser checks passed');
  process.exit(L.failed() ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
