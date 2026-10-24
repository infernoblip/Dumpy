// Stage 12 browser test: a second society signs up and runs on its own, the
// platform admin approves it, two societies share "nearby" items, and someone
// in both switches between them. 360 x 740 phone viewport, against the local
// stand-in for Supabase (see lib.js and run.sh). All people, societies and
// items are made up.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path = require('path');
const L = require('./lib');
const { SITE, USERS, SOCIETY, PHONE, check, sql, sqlTry, wire, magicLink, settle, noSideScroll, smallTargets } = L;

const shot = L.shooter(path.join(L.S, '../../docs/screenshots/stage-12'));
const ADMIN = USERS.admin;     // admin of Demo Society
const OWNER = USERS.owner;     // member of Demo Society
const STARTER = { id: 'aaaaaaaa-0000-4000-8000-000000001201', email: 'second.admin@example.com' };
const PLATFORM = { id: 'aaaaaaaa-0000-4000-8000-000000001202', email: 'runs.dumpy@example.com' };
const TWO = 'Demo Society Two';
const CHAIR = '11111111-0000-4000-8000-000000001203';   // Demo Society, shared as nearby later
const LAMP = '11111111-0000-4000-8000-000000000002';    // Demo Society, never shared
const KETTLE = '11111111-0000-4000-8000-000000001201';  // Society Two, nearby
const TOASTER = '11111111-0000-4000-8000-000000001202'; // Society Two, society only

const q1 = (query) => sql(query).split('\n').filter(Boolean).pop() || '';
const asUser = (query, id) => {
  const r = sqlTry(query, id);
  return r.error ? 'ERROR ' + r.error : (r.out || '').split('\n').filter(Boolean).pop() || '';
};

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
         ('${STARTER.id}','authenticated','authenticated','${STARTER.email}', now(), now()),
         ('${PLATFORM.id}','authenticated','authenticated','${PLATFORM.email}', now(), now()) on conflict do nothing;
       insert into public.profiles (user_id, display_name, tower, flat) values ('${PLATFORM.id}','Dumpy Team', null, null) on conflict do nothing;
       insert into public.platform_admins (user_id) values ('${PLATFORM.id}') on conflict do nothing;
       insert into public.listings (id, society_id, owner_id, title, description, category, condition, price_inr) values
         ('${CHAIR}','${SOCIETY}','${OWNER.id}','Folding chair','Light, folds flat.','furniture','good',0) on conflict do nothing;`);

  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const errors = [];
  async function newPage(scheme) {
    const ctx = await browser.newContext({ ...PHONE, colorScheme: scheme || 'light' });
    await wire(ctx);
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) errors.push(m.text()); });
    p.on('dialog', (d) => d.type() === 'prompt' ? d.accept('') : d.accept());
    return p;
  }
  async function personPage(user, scheme) {
    const p = await newPage(scheme);
    await p.goto(magicLink(user)); await settle(p);
    return p;
  }

  // 1. A visitor finds "Start Dumpy in your society", signs in and asks.
  const s = await newPage();
  await s.goto(SITE + '/'); await settle(s);
  await s.click('a[href="pages/start.html"]');
  await s.waitForURL('**/pages/start.html'); await settle(s);
  check(await s.isVisible('#step-intro') && !(await s.isVisible('#start-form')), 'Signed out, the start page explains the steps and asks to sign in');
  await noSideScroll(s, 'start (signed out)'); await smallTargets(s, 'start (signed out)');
  await shot(s, 'start-signed-out-light');
  await s.click('#start-sign-in');
  await s.waitForURL('**/pages/sign-in.html'); await settle(s);
  await s.goto(magicLink(STARTER));
  await s.waitForURL('**/pages/profile.html'); await settle(s);
  await s.fill('#display_name', 'Second Admin'); await s.fill('#tower', 'K'); await s.fill('#flat', 'K-101');
  await s.click('#profile-submit');
  await s.waitForURL('**/pages/start.html'); await settle(s);
  check(true, 'After signing in and setting up a profile, they come back to the start page');
  check((await s.textContent('#start-email')) === STARTER.email, 'The form shows the email they signed in with');
  await s.click('#start-form button[type=submit]');
  check(await s.isVisible('#start-error'), 'An empty society name is caught on the page');
  await s.fill('#society-name', '  Demo   Society Two ');
  await s.fill('#society-city', 'Demo City');
  await noSideScroll(s, 'start form'); await smallTargets(s, 'start form');
  await shot(s, 'start-form-light');
  await s.click('#start-form button[type=submit]');
  await s.waitForSelector('#start-requests li');
  check((await s.textContent('#start-requests')).includes(TWO) && (await s.textContent('#start-requests')).includes('Waiting for approval'),
    'The request shows as waiting for approval');
  check(q1(`select name || '|' || city || '|' || contact_email || '|' || status from public.society_requests`) === `${TWO}|Demo City|${STARTER.email}|pending`,
    'The database holds one pending request with their sign-in email');
  await shot(s, 'start-waiting-light');
  await s.goto(SITE + '/pages/join.html'); await settle(s);
  check(await s.isVisible('#start-waiting') && (await s.textContent('#start-waiting')).includes(TWO), 'The join page reminds them of the society they asked to start');
  await shot(s, 'join-start-waiting-light', false);

  // 2. A society admin is not a platform admin.
  const a = await personPage(ADMIN);
  await a.goto(SITE + '/pages/profile.html'); await settle(a);
  await a.waitForTimeout(300);
  check(!(await a.isVisible('#platform-link')), 'A society admin gets no "Run Dumpy" link');
  await a.goto(SITE + '/pages/platform.html'); await settle(a);
  await a.waitForSelector('#not-platform:not([hidden])');
  check(!(await a.isVisible('#platform')), 'A society admin opening the platform page sees "for the people who run Dumpy"');
  check(asUser('select count(*) from public.platform_society_requests()', ADMIN.id) === '0', 'and the database gives them no requests');

  // 3. The platform admin approves.
  const pa = await personPage(PLATFORM);
  await pa.goto(SITE + '/pages/profile.html'); await settle(pa);
  await pa.waitForSelector('#platform-link:not([hidden])');
  await pa.click('#platform-link a');
  await pa.waitForURL('**/pages/platform.html'); await settle(pa);
  await pa.waitForSelector('#waiting [data-act=approve]');
  const w = await pa.textContent('#waiting');
  check(w.includes(TWO) && w.includes('Demo City') && w.includes('Second Admin') && w.includes(STARTER.email), 'The platform admin sees the request with city, name and email');
  check((await pa.textContent('#all-societies')).includes('Demo Society'), 'and the societies already on Dumpy');
  await noSideScroll(pa, 'platform'); await smallTargets(pa, 'platform');
  await shot(pa, 'platform-light');
  await pa.click('#waiting [data-act=approve]');
  await pa.waitForSelector('#platform-status:not([hidden])');
  const code = q1(`select invite_code from public.societies where name = '${TWO}'`);
  const TWO_ID = q1(`select id from public.societies where name = '${TWO}'`);
  check(code.length === 8 && (await pa.textContent('#platform-status')).includes(code), 'Approve creates the society and shows its new invite code');
  check(q1(`select role || '/' || status from public.memberships where society_id = '${TWO_ID}' and user_id = '${STARTER.id}'`) === 'admin/approved',
    'The person who asked is its approved admin');
  await shot(pa, 'platform-approved-light');

  // 4. The new admin opens their society: it runs on its own.
  await s.goto(SITE + '/pages/start.html'); await settle(s);
  await s.waitForSelector('#start-requests [data-act=open]');
  check((await s.textContent('#start-requests')).includes('Approved'), 'The start page shows the request approved');
  await shot(s, 'start-approved-light');
  await s.click('#start-requests [data-act=open]');
  await s.waitForURL('**/pages/admin.html'); await settle(s);
  await s.waitForFunction(() => document.querySelector('#invite-code').textContent !== '…');
  check((await s.textContent('#admin-society')) === TWO && (await s.textContent('#invite-code')) === code, 'Their admin page is for the new society, with its invite code');
  await s.waitForFunction(() => !/…/.test(document.querySelector('#link-code').textContent));
  sql(`insert into public.listings (id, society_id, owner_id, title, description, category, condition, price_inr, visibility) values
         ('${KETTLE}','${TWO_ID}','${STARTER.id}','Electric kettle','1.5 litre, works fine.','kitchen','good',0,'nearby'),
         ('${TOASTER}','${TWO_ID}','${STARTER.id}','Pop-up toaster','Two slots.','kitchen','used',200,'society')`);
  await s.goto(SITE + '/'); await settle(s); await feedReady(s);
  let t = await feedTitles(s);
  check(t.length === 2 && t.includes('Electric kettle') && t.includes('Pop-up toaster'), 'The new society\'s feed has only its own items');
  check(!(await s.$('.chip[data-filter=nearby]')), 'No "Nearby societies" chip before any sharing');
  check(asUser(`select count(*) from public.listings where society_id = '${SOCIETY}'`, STARTER.id) === '0'
        && asUser(`select count(*) from public.admin_list_members('${SOCIETY}')`, STARTER.id) === '0',
    'The new admin can read nothing of Demo Society');
  const o = await personPage(OWNER);
  await feedReady(o);
  t = await feedTitles(o);
  check(!t.includes('Electric kettle') && !t.includes('Pop-up toaster'), 'Demo Society sees nothing of the new society');

  // 5. The two admins agree to share nearby items.
  await a.goto(SITE + '/pages/admin.html'); await settle(a);
  await a.waitForFunction(() => !/…/.test(document.querySelector('#link-code').textContent));
  const demoLink = (await a.textContent('#link-code')).trim();
  check(demoLink.length === 8 && demoLink !== q1(`select invite_code from public.societies where id = '${SOCIETY}'`), 'The admin page shows a link code, different from the invite code');
  await s.goto(SITE + '/pages/admin.html'); await settle(s);
  await s.fill('#link-input', 'WRONG234');
  await s.click('#link-form button[type=submit]');
  await s.waitForSelector('#link-error:not([hidden])');
  check((await s.textContent('#link-error')).includes("doesn't match"), 'A wrong link code shows a clear error');
  await s.fill('#link-input', demoLink.toLowerCase());
  await s.click('#link-form button[type=submit]');
  await s.waitForSelector('#nearby-list li');
  check((await s.textContent('#nearby-list')).includes('Demo Society') && (await s.textContent('#nearby-list')).includes('Waiting for them'), 'Asking shows "Waiting for them"');
  check(asUser(`select count(*) from public.listings where society_id = '${TWO_ID}'`, OWNER.id) === '0', 'Before Demo Society agrees, nothing is shared');
  await noSideScroll(s, 'admin nearby'); await smallTargets(s, 'admin nearby');
  await shot(s, 'admin-nearby-asked-light');
  await a.reload(); await settle(a);
  await a.waitForSelector('#nearby-list [data-act=accept]');
  check((await a.textContent('#nearby-list')).includes(TWO) && (await a.textContent('#nearby-count')) === '1 new', 'Demo Society\'s admin sees the ask');
  await shot(a, 'admin-nearby-asking-light');
  await a.click('#nearby-list [data-act=accept]');
  await a.waitForSelector('#nearby-list .status--approved');
  check((await a.textContent('#nearby-list')).includes('Sharing'), 'After agreeing, both sides share');
  await shot(a, 'admin-nearby-linked-light');

  // 6. Nearby items: only the ones marked nearby, look but no asking.
  await o.goto(SITE + '/'); await settle(o);
  await o.waitForSelector('.chip[data-filter=nearby]');
  await feedReady(o);
  check(!(await feedTitles(o)).includes('Electric kettle'), '"All" still shows only your own society\'s items');
  await o.click('.chip[data-filter=nearby]'); await feedReady(o);
  t = await feedTitles(o);
  check(t.length === 1 && t[0] === 'Electric kettle', 'The Nearby chip shows only the other society\'s nearby item (not its society-only toaster)');
  check((await o.textContent('#feed .item-card__meta')).includes(TWO) && (await o.textContent('#feed-meta')).includes('from nearby societies'), 'The card says which society it is from');
  await noSideScroll(o, 'home nearby'); await smallTargets(o, 'home nearby');
  await shot(o, 'home-nearby-light');
  await o.click('#feed .item-card');
  await o.waitForURL('**/item.html?id=' + KETTLE); await settle(o);
  await o.waitForSelector('#owner-h');
  check((await o.textContent('#owner-h')) === 'From a nearby society' && (await o.textContent('#want-btn')) === 'In a nearby society'
        && await o.isDisabled('#want-btn'), 'The item page shows where it is from, with no "I want this"');
  check(!(await o.textContent('#item')).includes('Second Admin') && !(await o.textContent('#item')).includes('K-101'), 'It never shows the owner\'s name or flat');
  check(!(await o.$('#report-btn')), 'There is no Report button on a nearby item');
  await noSideScroll(o, 'item nearby'); await smallTargets(o, 'item nearby');
  await shot(o, 'item-nearby-light');
  const tried = await o.evaluate(async (args) => {
    const db = window.Dumpy.db;
    const r = {};
    r.req = (await db.from('requests').insert({ listing_id: args.k, society_id: args.two, requester_id: args.me, message: 'hi' })).error;
    r.profiles = (await db.from('profiles').select('user_id, display_name').eq('user_id', args.owner)).data;
    r.members = (await db.from('memberships').select('user_id').eq('society_id', args.two)).data;
    r.toaster = (await db.from('listings').select('id').eq('id', args.t)).data;
    r.society = (await db.from('societies').select('id, invite_code').eq('id', args.two)).data;
    r.contact = (await db.rpc('get_contact', { p_listing_id: args.k })).data;
    return r;
  }, { k: KETTLE, t: TOASTER, two: TWO_ID, me: OWNER.id, owner: STARTER.id });
  check(tried.req && tried.req.code === '42501', 'Asking for a nearby item straight from the database is refused');
  check(tried.profiles.length === 0 && tried.members.length === 0 && tried.toaster.length === 0 && tried.society.length === 0 && (tried.contact || []).length === 0,
    'Straight from the database: no owner profile, no members, no society-only items, no invite code, no contact');

  // 7. An owner shares their own item with nearby societies from the post form.
  await o.goto(SITE + '/pages/post.html?id=' + CHAIR); await settle(o);
  await o.waitForSelector('#nearby-box:not([hidden])');
  check((await o.textContent('#nearby-names')) === TWO, 'The edit form offers "Also show to nearby societies", naming them');
  await o.check('#nearby');
  await noSideScroll(o, 'post nearby'); await smallTargets(o, 'post nearby');
  await shot(o, 'post-nearby-light');
  await o.click('#post-submit');
  await o.waitForURL('**/item.html?id=' + CHAIR + '*');
  check(q1(`select visibility from public.listings where id = '${CHAIR}'`) === 'nearby', 'Saving stores the item as nearby');
  await s.goto(SITE + '/'); await settle(s);
  await s.waitForSelector('.chip[data-filter=nearby]');
  await s.click('.chip[data-filter=nearby]'); await feedReady(s);
  t = await feedTitles(s);
  check(t.length === 1 && t[0] === 'Folding chair', 'The other society now sees just that one item from Demo Society');

  // 8. Someone in both societies switches between them.
  await o.goto(SITE + '/pages/join.html'); await settle(o);
  await o.fill('#code', code); await o.click('#join-form button[type=submit]');
  await o.waitForURL('**/join.html?waiting=1');
  await s.goto(SITE + '/pages/admin.html'); await settle(s);
  await s.waitForSelector('#pending [data-act=approve]');
  await s.click('#pending [data-act=approve]');
  await s.waitForSelector('#pending .empty');
  await o.goto(SITE + '/pages/profile.html'); await settle(o);
  await o.waitForSelector('#switch-box:not([hidden])');
  const opts = await o.$$eval('#switch-list label', (ls) => ls.map((l) => l.textContent));
  check(opts.length === 2 && opts.includes('Demo Society') && opts.includes(TWO), 'Profile lists both societies to switch between');
  await noSideScroll(o, 'profile switcher'); await smallTargets(o, 'profile switcher');
  await shot(o, 'profile-switcher-light');
  await o.click(`#switch-list label:has-text("${TWO}")`);
  await o.waitForURL(SITE + '/index.html'); await settle(o); await feedReady(o);
  t = await feedTitles(o);
  check((await o.textContent('#society-name')) === TWO && t.includes('Pop-up toaster') && !t.includes('Bedside lamp'), 'After switching, the feed shows the other society\'s items, including society-only ones');
  await o.goto(SITE + '/pages/post.html'); await settle(o);
  check(await o.evaluate(() => window.Dumpy.state.society.society_name) === TWO, 'Posting now goes to the chosen society');
  await o.goto(SITE + '/pages/my-items.html'); await settle(o);
  await o.waitForSelector('#listings .empty');
  check(true, 'My items shows only what they posted in the chosen society');
  await o.goto(SITE + '/pages/profile.html'); await settle(o);
  await o.click('#switch-list label:has-text("Demo Society")');
  await o.waitForURL(SITE + '/index.html'); await settle(o); await feedReady(o);
  check((await o.textContent('#society-name')) === 'Demo Society' && (await feedTitles(o)).includes('Bedside lamp'), 'Switching back shows Demo Society again');

  // 9. Either admin stops sharing.
  await s.goto(SITE + '/pages/admin.html'); await settle(s);
  await s.waitForSelector('#nearby-list [data-act=unlink]');
  await s.click('#nearby-list [data-act=unlink]');
  await s.waitForFunction(() => !document.querySelector('#nearby-list li'));
  check(asUser(`select count(*) from public.listings where society_id = '${SOCIETY}'`, STARTER.id) === '0', 'Once one side stops sharing, nothing crosses over');
  await a.goto(SITE + '/'); await settle(a); await feedReady(a);
  check(!(await a.$('.chip[data-filter=nearby]')), 'and the Nearby chip is gone');
  check(asUser(`select count(*) from public.listings where id = '${LAMP}'`, STARTER.id) === '0', 'The never-shared lamp was never visible to them');

  // 10. Dark mode.
  const sd = await newPage('dark');
  await sd.goto(SITE + '/pages/start.html'); await settle(sd);
  await shot(sd, 'start-signed-out-dark');
  const pd = await personPage(PLATFORM, 'dark');
  sql(`insert into public.society_requests (name, city, contact_email, requested_by) values ('Demo Society Three', 'Demo City', '${OWNER.email}', '${OWNER.id}')`);
  await pd.goto(SITE + '/pages/platform.html'); await settle(pd); await pd.waitForSelector('#waiting [data-act=approve]');
  await shot(pd, 'platform-dark');
  await pd.click('#waiting [data-act=reject]');
  await pd.waitForSelector('#platform-status:not([hidden])');
  check(q1(`select status from public.society_requests where name = 'Demo Society Three'`) === 'rejected', 'Turn down marks the request rejected');
  const od = await personPage(OWNER, 'dark');
  await od.goto(SITE + '/pages/profile.html'); await settle(od);
  await od.waitForSelector('#switch-box:not([hidden])');
  await shot(od, 'profile-switcher-dark');

  check(errors.length === 0, 'No page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  if (L.failed()) { console.log(L.failed() + ' check(s) failed'); process.exit(1); }
  console.log('All stage 12 browser checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
