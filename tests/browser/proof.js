// Delivery proof browser test: the seller confirms the pickup, the helper must
// add a photo to mark it delivered, the buyer is asked whether it arrived, and
// a "no" goes to the society admin, who decides once the helper confirms
// again. 360 x 740 phone viewport, against the local stand-in for Supabase
// (see lib.js and run.sh). All people are made up.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path = require('path');
const L = require('./lib');
const { SITE, USERS, SOCIETY, PHONE, check, sql, wire, magicLink, settle, noSideScroll, smallTargets } = L;

const shot = L.shooter(path.join(L.S, '../../docs/screenshots/delivery-proof'));
const OWNER = USERS.owner;
const ADMIN = USERS.admin;
const TAKER = { id: 'aaaaaaaa-0000-4000-8000-000000000021', email: 'demo.taker21@example.com' };
const HELPER = { id: 'aaaaaaaa-0000-4000-8000-000000000022', email: 'demo.helper22@example.com' };
const SHELF = '11111111-0000-4000-8000-0000000000a1';

const q1 = (query) => sql(query).split('\n').filter(Boolean).pop() || '';

(async () => {
  const phones = q1(`select string_agg(user_id || '=' || coalesce(phone, ''), ',') from public.profiles where user_id in ('${OWNER.id}','${ADMIN.id}')`);
  const ownerUpi = q1(`select coalesce(upi_id, '') from public.profiles where user_id = '${OWNER.id}'`);
  sql(`insert into auth.users (id, aud, role, email, created_at, updated_at) values
         ('${TAKER.id}','authenticated','authenticated','${TAKER.email}', now(), now()),
         ('${HELPER.id}','authenticated','authenticated','${HELPER.email}', now(), now()) on conflict do nothing;
       insert into public.profiles (user_id, display_name, tower, flat, phone) values
         ('${TAKER.id}','Demo Buyer','C','C-303','9000000303'),
         ('${HELPER.id}','Demo Helper','D','D-404','9000000404') on conflict do nothing;
       insert into public.memberships (user_id, society_id, role, status) values
         ('${TAKER.id}','${SOCIETY}','member','approved'), ('${HELPER.id}','${SOCIETY}','member','approved') on conflict do nothing;
       insert into public.delivery_helpers (society_id, user_id) values ('${SOCIETY}','${HELPER.id}') on conflict do nothing;
       update public.profiles set phone = '9000000101', upi_id = 'demo.owner@okaxis' where user_id = '${OWNER.id}';
       update public.profiles set phone = '9000000909' where user_id = '${ADMIN.id}';
       insert into public.listings (id, society_id, owner_id, title, description, category, condition, price_inr) values
         ('${SHELF}','${SOCIETY}','${OWNER.id}','Teak bookshelf','Five shelves.','furniture','good',300);
       insert into public.requests (listing_id, society_id, requester_id) values ('${SHELF}','${SOCIETY}','${TAKER.id}');`);
  sql(`select public.accept_request(id) from public.requests where listing_id = '${SHELF}'`, OWNER.id);
  sql(`select public.arrange_delivery('${SHELF}', 'helper', (((now() at time zone 'Asia/Kolkata')::date + 1) + time '16:00') at time zone 'Asia/Kolkata', '₹30 cash')`, TAKER.id);
  const did = q1(`select id from public.deliveries where listing_id = '${SHELF}' and status = 'open'`);
  sql(`select public.claim_delivery('${did}')`, HELPER.id);

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
  const box = '.delivery';
  const item = SITE + '/pages/item.html?id=' + SHELF;

  // 1. The seller is asked whether the helper picked it up.
  const o = await personPage(OWNER);
  await o.goto(item); await settle(o);
  await o.waitForSelector('dialog[data-ask][open]');
  check((await o.textContent('dialog[data-ask]')).includes('Has Demo Helper picked up the item?'), 'The seller gets a pop-up: has the helper picked it up?');
  await shot(o, 'item-pickup-ask-light', false);
  await o.click('dialog[data-ask] [data-ask="yes"]');
  await o.waitForSelector(`${box} [data-pickup-done]`);
  check(q1(`select pickup_confirmed_at is not null from public.deliveries where id = '${did}'`) === 't', 'Yes records the pickup');
  const plan = await o.textContent(`${box} [data-helper-card]`);
  check(plan.includes('Your helper') && plan.includes('Demo Helper') && /Delivering: Tomorrow, \w{3},? \d{1,2} \w{3}, 4–6 pm/.test(plan),
    'The seller sees the helper and when they deliver, with the date');

  // 2. The buyer sees the helper, the date and the pickup.
  const t = await personPage(TAKER);
  await t.goto(item); await settle(t);
  await t.waitForSelector(`${box} [data-helper-card]`);
  const tplan = await t.textContent(`${box} [data-helper-card]`);
  check(tplan.includes('Demo Helper') && tplan.includes('Tower D') && /Delivering: Tomorrow, \w{3},? \d{1,2} \w{3}, 4–6 pm/.test(tplan) && tplan.includes('The seller confirmed Demo Helper picked it up'),
    'The buyer sees their helper, the date and time, and that the seller confirmed the pickup');
  check(!(await t.locator('dialog[data-ask][open]').count()), 'The buyer gets no pop-up before delivery');
  await noSideScroll(t, 'helper card'); await smallTargets(t, 'helper card');
  await t.evaluate(() => document.querySelector('[data-helper-card]').scrollIntoView());
  await shot(t, 'item-helper-card-light', false);

  // 3. The helper can't mark it delivered without the photo.
  const h = await personPage(HELPER);
  await h.goto(SITE + '/pages/jobs.html'); await settle(h);
  await h.waitForSelector('#my-jobs [data-jact=delivered]');
  check((await h.textContent('#my-jobs')).includes('The seller confirmed you picked it up'), 'The helper sees the seller confirmed the pickup');
  await h.click('#my-jobs [data-jact=delivered]');
  await h.waitForSelector('#my-jobs [data-proof]');
  const form = await h.textContent('#my-jobs [data-proof]');
  check(form.includes('Photo needed') && form.includes('the item') && form.includes('the flat door or flat number') && form.includes('your hand'),
    'Mark delivered asks for one photo showing the item, the flat door or number, and the helper\'s hand');
  await h.click('#my-jobs [data-proof] button[type=submit]');
  check((await h.textContent('#my-jobs [data-proof-err]')).includes('Take a photo first'), 'Without a photo it refuses');
  await h.setInputFiles('#my-jobs [data-proof-file]', await L.doorPhoto(h, 'C-303'));
  await h.waitForSelector('#my-jobs [data-proof-preview]:not([hidden])');
  await h.click('#my-jobs [data-proof] label.choice:has-text("The item")');
  await h.click('#my-jobs [data-proof] button[type=submit]');
  check((await h.textContent('#my-jobs [data-proof-err]')).includes('Tick all three'), 'It needs all three ticked');
  await h.click('#my-jobs [data-proof] label.choice:has-text("flat door")');
  await h.click('#my-jobs [data-proof] label.choice:has-text("My hand")');
  await noSideScroll(h, 'proof form'); await smallTargets(h, 'proof form');
  await h.evaluate(() => document.querySelector('[data-proof]').scrollIntoView()); await h.waitForTimeout(500); // let the ticks finish fading in
  await shot(h, 'jobs-proof-light', false);
  await h.click('#my-jobs [data-proof] button[type=submit]');
  await h.waitForFunction(() => !document.querySelector('#my-jobs [data-proof]') && document.querySelector('#my-jobs').textContent.includes('Delivered'));
  const proof = q1(`select proof_path from public.deliveries where id = '${did}'`);
  check(proof.startsWith(SOCIETY + '/' + did + '/') && L.storageLog.some((x) => x.ok && x.name === proof),
    'The photo is uploaded to the private delivery-proofs folder for this job, then the job is marked delivered');

  // 4. The buyer is asked whether it arrived, with the photo.
  await t.reload(); await settle(t);
  await t.waitForSelector('dialog[data-ask][open]');
  check((await t.textContent('dialog[data-ask]')).includes('Did you receive Teak bookshelf?'), 'The buyer gets a pop-up: did you receive it?');
  await t.waitForSelector(`${box} [data-proof-photo] img:not([hidden])`);
  check(true, 'The buyer sees the helper\'s photo');
  await shot(t, 'item-received-ask-light', false);
  await t.click('dialog[data-ask] [data-ask="no"]');
  await t.waitForSelector(`${box} [data-problem-contacts] a[href^="tel:"]`);
  const prob = await t.textContent(`${box} [data-problem]`);
  check(prob.includes('Problem reported') && prob.includes('Society admin') && prob.includes('Seller') && prob.includes('Demo Owner'),
    'Saying no shows a red problem box with the society admin and the seller to call');
  const tels = await t.$$eval(`${box} [data-problem-contacts] a[href^="tel:"]`, (as) => as.map((a) => a.getAttribute('href')));
  check(tels.includes('tel:+919000000909') && tels.includes('tel:+919000000101'), 'with Call buttons for the society admin and the seller');
  check((await t.textContent('.pay[data-pay]')).includes('Payment on hold') && (await t.locator('.pay[data-pay] [data-pay-app], .pay[data-pay] [data-pay-link]').count()) === 0,
    'The buyer\'s payment is on hold');
  check(q1(`select string_agg(recipient_id::text, ',' order by recipient_id) from public.notifications where kind = 'delivery_problem' and delivery_id = '${did}'`)
    .split(',').sort().join(',') === [ADMIN.id, HELPER.id].sort().join(','), 'The helper and the society admin are emailed');
  await noSideScroll(t, 'problem'); await smallTargets(t, 'problem');
  await t.evaluate(() => document.querySelector('[data-problem]').scrollIntoView());
  await shot(t, 'item-problem-buyer-light', false);

  // 5. The helper is told and confirms again.
  await h.reload(); await settle(h);
  await h.waitForSelector('#my-jobs [data-job-problem]');
  check((await h.textContent('#my-jobs [data-job-problem]')).includes("The buyer says it didn't arrive"), 'The helper sees the buyer says it didn\'t arrive');
  await shot(h, 'jobs-problem-light', false);
  await h.click('#my-jobs [data-jact=reconfirm]');
  await h.waitForFunction(() => /You confirmed again/.test(document.querySelector('#my-jobs').textContent));
  check(q1(`select helper_reconfirmed_at is not null from public.deliveries where id = '${did}'`) === 't', 'The helper\'s second confirmation is saved');

  // 6. The society admin looks at the photo, calls everyone and decides.
  const a = await personPage(ADMIN);
  await a.goto(SITE + '/pages/admin.html'); await settle(a);
  await a.waitForSelector('#problems [data-problem]');
  const card = await a.textContent('#problems [data-problem]');
  check(card.includes('Teak bookshelf') && card.includes('Needs your decision') && card.includes('confirmed again') && card.includes('Helper') && card.includes('Seller') && card.includes('Buyer'),
    'The admin sees the problem, that the helper confirmed again, and the three people to call');
  await a.waitForSelector('#problems [data-problem] img:not([hidden])');
  check(await a.isEnabled('#problems [data-pact=delivered]'), 'and can decide "It was delivered" now that the helper confirmed again');
  await noSideScroll(a, 'admin problems'); await smallTargets(a, 'admin problems');
  await a.evaluate(() => document.getElementById('problems-section').scrollIntoView());
  await shot(a, 'admin-delivery-problem-light', false);
  await a.evaluate(() => document.querySelector('#problems .job__stop').scrollIntoView({ block: 'center' }));
  await shot(a, 'admin-delivery-problem-people-light', false);
  await a.click('#problems [data-pact=delivered]');
  await a.waitForFunction(() => /Decided: delivered/.test(document.getElementById('problems').textContent));
  check(q1(`select problem_outcome from public.deliveries where id = '${did}'`) === 'delivered', 'The admin\'s decision is saved');

  await t.reload(); await settle(t);
  await t.waitForSelector(`${box} [data-problem]`);
  check((await t.textContent(`${box} [data-problem]`)).includes('decided it was delivered') && (await t.locator('.pay[data-pay] [data-pay-app], .pay[data-pay] [data-pay-link]').count()) > 0,
    'The buyer sees the decision, and can pay again');

  // Put the made-up phones and UPI ID back.
  sql(`update public.profiles set upi_id = nullif('${ownerUpi}', '') where user_id = '${OWNER.id}'`);
  phones.split(',').forEach((pair) => { const [id, ph] = pair.split('='); sql(`update public.profiles set phone = nullif('${ph}', '') where user_id = '${id}'`); });

  check(errors.length === 0, 'No script errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  console.log(L.failed() ? `\n${L.failed()} FAILED` : '\nAll delivery proof browser checks passed');
  process.exit(L.failed() ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
