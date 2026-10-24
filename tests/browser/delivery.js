// Stage 7 browser test: arranging delivery, a helper claiming the job, and
// marking it delivered, in a 360 x 740 phone viewport against the local
// stand-in for Supabase (see lib.js and run.sh). All people are made up.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path = require('path');
const L = require('./lib');
const { SITE, USERS, SOCIETY, PHONE, check, sql, sqlTry, wire, magicLink, settle, noSideScroll, smallTargets } = L;

const shot = L.shooter(path.join(L.S, '../../docs/screenshots/stage-7'));
const OWNER = USERS.owner;                 // Demo Owner, Tower B, flat B-202
const PLAIN = USERS.admin;                 // Demo Admin: a member who is not a helper
const TAKER = { id: 'aaaaaaaa-0000-4000-8000-000000000007', email: 'demo.taker7@example.com' };
const HELPER = { id: 'aaaaaaaa-0000-4000-8000-000000000008', email: 'demo.helper@example.com' };
const DESK = '11111111-0000-4000-8000-000000000070';

const q1 = (query) => sql(query).split('\n').filter(Boolean).pop() || '';

(async () => {
  // A reserved item: the owner accepted the taker's request.
  sql(`insert into auth.users (id, aud, role, email, created_at, updated_at) values
         ('${TAKER.id}','authenticated','authenticated','${TAKER.email}', now(), now()),
         ('${HELPER.id}','authenticated','authenticated','${HELPER.email}', now(), now()) on conflict do nothing;
       insert into public.profiles (user_id, display_name, tower, flat, phone) values
         ('${TAKER.id}','Demo Taker','C','C-303','9000000303'),
         ('${HELPER.id}','Demo Helper','D','D-404','9000000404') on conflict do nothing;
       insert into public.memberships (user_id, society_id, role, status) values
         ('${TAKER.id}','${SOCIETY}','member','approved'), ('${HELPER.id}','${SOCIETY}','member','approved') on conflict do nothing;
       update public.profiles set phone = '9000000202' where user_id = '${OWNER.id}';
       insert into public.listings (id, society_id, owner_id, title, description, category, condition, price_inr) values
         ('${DESK}','${SOCIETY}','${OWNER.id}','Folding study desk','Folds flat, fits in a lift.','furniture','good',0);
       insert into public.requests (listing_id, society_id, requester_id, message) values ('${DESK}','${SOCIETY}','${TAKER.id}','Can it come to my flat?');`);
  sql(`select public.accept_request((select id from public.requests where listing_id = '${DESK}'))`, OWNER.id);

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
  const t = await personPage(TAKER);
  const h = await personPage(HELPER);
  const n = await personPage(PLAIN);
  const box = '.delivery';

  // 1. Both sides see the delivery card once the request is accepted.
  await o.goto(SITE + '/pages/my-items.html'); await settle(o);
  await o.waitForSelector(`[data-listing="${DESK}"] ${box} form`);
  const ownerCard = await o.textContent(`[data-listing="${DESK}"] ${box}`);
  check(ownerCard.includes('Arrange delivery') && ownerCard.includes("I'll bring it over") && ownerCard.includes('Demo Taker collects it') && ownerCard.includes('A neighbour helper brings it'),
    'The owner sees Arrange delivery with the three ways, in their words');
  await noSideScroll(o, 'my items delivery form'); await smallTargets(o, 'my items delivery form');
  await shot(o, 'my-items-arrange-light');

  await t.goto(SITE + '/pages/item.html?id=' + DESK); await settle(t);
  await t.waitForSelector(`${box} form`);
  check((await t.textContent(box)).includes("I'll collect it") && (await t.textContent(box)).includes('Demo Owner brings it over'), 'The taker sees the same card on the item page, in their words');
  const slotCount = await t.locator(`${box} [data-slots] input`).count();
  await t.click(`${box} label:has-text("Tomorrow")`);
  check((await t.locator(`${box} [data-slots] input`).count()) === 7, `Tomorrow offers seven 2-hour windows, 8 am to 10 pm (today has ${slotCount} left)`);
  check(await t.isHidden(`${box} [data-tip]`), 'The tip field stays hidden until a helper is chosen');

  // Saving with nothing picked says what is missing.
  await t.click(`${box} button[type=submit]`);
  check((await t.textContent(`${box} [data-err]`)).includes('Choose who brings it'), 'Saving without a choice says what is missing');

  // 2. The taker asks for a helper, tomorrow 6 to 8 pm, ₹30 tip.
  await t.click(`${box} label:has-text("A neighbour helper brings it")`);
  check(await t.isVisible(`${box} [data-tip]`), 'Choosing a helper shows the tip field');
  await t.click(`${box} label:has-text("6–8 pm")`);
  await t.fill(`${box} [data-tip] input`, '₹30 cash');
  await noSideScroll(t, 'item delivery form'); await smallTargets(t, 'item delivery form');
  await shot(t, 'item-arrange-taker-light');
  await t.click(`${box} button[type=submit]`);
  await t.waitForSelector(`${box} .delivery__plan`);
  const plan = await t.textContent(box);
  check(plan.includes('Needs a helper') && plan.includes('A neighbour helper brings it') && plan.includes('Tomorrow, 6–8 pm') && plan.includes('₹30 cash'),
    'The plan shows Needs a helper, the slot and the tip');
  const row = q1(`select mode || '|' || status || '|' || tip_note || '|' || to_char(slot_start at time zone 'Asia/Kolkata', 'HH24:MI') || '|' || ((slot_start at time zone 'Asia/Kolkata')::date - (now() at time zone 'Asia/Kolkata')::date)
                  from public.deliveries where listing_id = '${DESK}'`);
  check(row === 'helper|open|₹30 cash|18:00|1', `The database holds a helper delivery, open, tomorrow 18:00 Indian time (${row})`);
  await shot(t, 'item-plan-waiting-light');

  // The owner sees it too and moves it to 4 to 6 pm.
  await o.reload(); await settle(o);
  await o.waitForSelector(`[data-listing="${DESK}"] ${box} .delivery__plan`);
  await o.click(`[data-listing="${DESK}"] ${box} [data-dact=change]`);
  await o.click(`[data-listing="${DESK}"] ${box} label:has-text("4–6 pm")`);
  await o.click(`[data-listing="${DESK}"] ${box} button[type=submit]`);
  await o.waitForSelector(`[data-listing="${DESK}"] ${box} .delivery__plan`);
  check((await o.textContent(`[data-listing="${DESK}"] ${box}`)).includes('Tomorrow, 4–6 pm')
    && q1(`select count(*) from public.deliveries where listing_id = '${DESK}'`) === '1',
    'The owner changes the time; it is still one delivery');

  // 3. A member who is not a helper never sees open jobs.
  await n.goto(SITE + '/pages/jobs.html'); await settle(n);
  await n.waitForSelector('#jobs-off:not([hidden])');
  check(await n.isHidden('#open-jobs-section') && !(await n.textContent('#main')).includes('Folding study desk'), 'A non-helper sees "not signed up as a helper" and no jobs');
  const direct = await n.evaluate(async (sid) => {
    const db = window.Dumpy.db;
    const a = await db.rpc('open_delivery_jobs', { p_society_id: sid });
    const b = await db.from('deliveries').select('id');
    return (a.data || []).length + (b.data || []).length;
  }, SOCIETY);
  check(direct === 0, 'Asking the database directly, a non-helper still gets no jobs');
  await noSideScroll(n, 'jobs (not a helper)'); await smallTargets(n, 'jobs (not a helper)');
  await shot(n, 'jobs-not-helper-light');

  // 4. The helper switches on "I can help deliver".
  await h.goto(SITE + '/pages/profile.html'); await settle(h);
  await h.waitForSelector('#helper-box:not([hidden])');
  check(!(await h.isChecked('#helper')) && await h.isHidden('#jobs-link'), 'Profile shows the helper switch, off');
  await h.click('#helper-box .switch');
  await h.waitForSelector('#jobs-link:not([hidden])');
  check(q1(`select count(*) from public.delivery_helpers where user_id = '${HELPER.id}' and society_id = '${SOCIETY}'`) === '1', 'Switching it on saves straight away');
  await noSideScroll(h, 'profile'); await smallTargets(h, 'profile');
  await h.evaluate(() => document.getElementById('helper-box').scrollIntoView());
  await shot(h, 'profile-helper-light', false);

  // 5. The helper sees the open job (towers only) and takes it.
  await h.click('#jobs-link'); await settle(h);
  await h.waitForSelector('#open-jobs [data-job]');
  const job = await h.textContent('#open-jobs');
  check(job.includes('Folding study desk') && job.includes('Tower B → Tower C') && job.includes('Tomorrow, 4–6 pm') && job.includes('₹30 cash'),
    'The open job shows pickup and drop towers, slot and tip');
  check(!(await h.content()).match(/B-202|C-303|9000000202|9000000303/), 'Before taking it, the helper sees no flats or phones');
  await noSideScroll(h, 'jobs (open)'); await smallTargets(h, 'jobs (open)');
  await shot(h, 'jobs-open-light');
  await h.click('#open-jobs [data-jact=claim]');
  await h.waitForSelector('#my-jobs [data-jact=delivered]');
  const mine = await h.textContent('#my-jobs');
  check(mine.includes('Pick up from') && mine.includes('Flat B-202') && mine.includes('Drop at') && mine.includes('Flat C-303'), 'Once taken, the helper sees both flats');
  check((await h.getAttribute('#my-jobs .job__stop:first-child a[href^="https://wa.me/"]', 'href')).startsWith('https://wa.me/919000000202?text='), 'and can WhatsApp the owner');
  check(q1(`select status || '|' || (helper_id = '${HELPER.id}') from public.deliveries where listing_id = '${DESK}'`) === 'claimed|true', 'The database records the helper as holding the job');
  await noSideScroll(h, 'jobs (mine)'); await smallTargets(h, 'jobs (mine)');
  await shot(h, 'jobs-mine-light');
  check(!!sqlTry(`select public.claim_delivery((select id from public.deliveries where listing_id = '${DESK}'))`, PLAIN.id).error, 'Nobody else can claim it now');

  // 6. The pair see who is bringing it.
  await t.reload(); await settle(t); await t.waitForSelector(`${box} .delivery__plan`);
  const claimed = await t.textContent(box);
  check(claimed.includes('Helper found') && claimed.includes('Demo Helper') && claimed.includes('Tower D'), 'The taker sees Helper found, with the helper\'s name and tower');
  check((await t.getAttribute(`${box} a[href^="https://wa.me/"]`, 'href')).startsWith('https://wa.me/919000000404?text='), 'and a WhatsApp button for the helper');
  check(await t.isHidden(`${box} [data-dact=change]`), 'Once a helper has it, Change is replaced by cancel-and-rearrange');
  await noSideScroll(t, 'item helper found'); await smallTargets(t, 'item helper found');
  await shot(t, 'item-helper-found-light');

  // 7. The helper marks it delivered; the item closes as done.
  await h.click('#my-jobs [data-jact=delivered]');
  await h.waitForFunction(() => !document.querySelector('#my-jobs [data-jact=delivered]') && document.querySelector('#my-jobs').textContent.includes('Delivered'));
  check(q1(`select l.status || '|' || d.status from public.listings l join public.deliveries d on d.listing_id = l.id where l.id = '${DESK}'`) === 'done|delivered',
    'Mark delivered closes the delivery and the item becomes done');
  check(!(await h.content()).match(/B-202|C-303/), 'After delivery the helper no longer sees the flats');
  await shot(h, 'jobs-delivered-light', false);
  await o.goto(SITE + '/pages/item.html?id=' + DESK); await settle(o); await o.waitForSelector('.contact');
  check((await o.textContent('#want-btn')) === 'Handed over', 'The owner\'s item page shows Handed over');

  // 8. Dark mode.
  sql(`insert into public.listings (id, society_id, owner_id, title, category, price_inr) values
         ('11111111-0000-4000-8000-000000000071','${SOCIETY}','${OWNER.id}','Plastic stool','furniture',40);
       insert into public.requests (listing_id, society_id, requester_id) values ('11111111-0000-4000-8000-000000000071','${SOCIETY}','${TAKER.id}');`);
  sql(`select public.accept_request((select id from public.requests where listing_id = '11111111-0000-4000-8000-000000000071'))`, OWNER.id);
  const od = await personPage(OWNER, 'dark');
  await od.goto(SITE + '/pages/item.html?id=11111111-0000-4000-8000-000000000071'); await settle(od);
  await od.waitForSelector(`${box} form`);
  await od.click(`${box} label:has-text("A neighbour helper brings it")`);
  await shot(od, 'item-arrange-owner-dark');
  const hd = await personPage(HELPER, 'dark');
  await hd.goto(SITE + '/pages/jobs.html'); await settle(hd); await hd.waitForSelector('#my-jobs [data-job]');
  await shot(hd, 'jobs-dark');

  check(errors.length === 0, 'No script errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  console.log(L.failed() ? `\n${L.failed()} FAILED` : '\nAll stage 7 browser checks passed');
  process.exit(L.failed() ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
