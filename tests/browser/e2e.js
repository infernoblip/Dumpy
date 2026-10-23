// Stage 4 browser test: the real pages in a 360 x 740 phone viewport, talking to
// a local Postgres + PostgREST that stands in for Supabase. Run it with
// tests/browser/run.sh (see the README next to this file).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path = require('path');
const { S, SITE, USERS, PHONE, check, failed, wire, magicLink, settle, noSideScroll, smallTargets, shooter, otpCalls } = require('./lib');

const shot = shooter(path.join(S, '../../docs/screenshots/stage-4'));

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const opts = PHONE;
  const A = await browser.newContext(opts);           // the new neighbour
  const B = await browser.newContext(opts);           // the admin, in a second browser profile
  await wire(A); await wire(B);
  const a = await A.newPage();
  const errors = [];
  a.on('pageerror', (e) => errors.push(e.message));
  a.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  a.on('response', (r) => { if (r.status() >= 400) console.log('     (expected?) HTTP', r.status(), r.request().method(), r.url().replace(/^https:\/\/[^/]+/, '').slice(0, 90)); });

  // 1. Signed out: public landing; private pages bounce to it.
  await a.goto(SITE + '/');
  await settle(a);
  check(await a.isVisible('#landing') && !(await a.isVisible('#main')), 'Signed-out visitor sees the public landing');
  check(!(await a.isVisible('.bottom-nav')), 'Landing has no app navigation');
  await noSideScroll(a, 'landing'); await smallTargets(a, 'landing');
  await shot(a, 'landing-light');
  await a.goto(SITE + '/pages/item.html?id=11111111-0000-4000-8000-000000000001');
  await a.waitForURL(SITE + '/index.html');
  check(true, 'Signed-out visitor opening an item is sent to the landing');

  // 2. Sign in by email.
  await a.goto(SITE + '/index.html'); await settle(a);
  await a.click('#landing a.btn');
  await a.waitForURL('**/pages/sign-in.html'); await settle(a);
  await noSideScroll(a, 'sign-in'); await smallTargets(a, 'sign-in');
  await shot(a, 'sign-in-light');
  await a.fill('#email', USERS.newbie.email);
  await a.click('button[type=submit]');
  await a.waitForSelector('#step-sent:not([hidden])');
  check(otpCalls.length === 1 && otpCalls[0].body.email === USERS.newbie.email, 'Send link asks Supabase for a magic link to that email');
  check(otpCalls[0].redirect === SITE + '/', 'The link comes back to the site root (' + otpCalls[0].redirect + ')');
  check((await a.textContent('#sent-email')) === USERS.newbie.email, '"Check your email" shows the address');
  await shot(a, 'sign-in-sent-light');

  // Expired link
  await a.goto(SITE + '/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
  await a.waitForURL('**/sign-in.html?link=expired'); await settle(a);
  check(await a.isVisible('#link-expired'), 'An expired link lands on sign-in with an explanation');
  await shot(a, 'sign-in-expired-light');

  // 3. Clicking the magic link: session from the address, then profile set-up.
  await a.goto(magicLink(USERS.newbie));
  await a.waitForURL('**/pages/profile.html'); await settle(a);
  check(true, 'New person arriving from the link is sent to set up a profile');
  check(!(await a.isVisible('.bottom-nav')), 'Profile set-up hides the app navigation');
  await noSideScroll(a, 'profile setup'); await smallTargets(a, 'profile setup');
  await shot(a, 'profile-setup-light');
  await a.fill('#display_name', 'New Neighbour');
  await a.fill('#tower', 'C');
  await a.fill('#flat', 'c-303');
  await a.fill('#phone', '98765 43210');
  await a.fill('#upi_id', 'bad upi');
  await a.click('#profile-submit');
  check(await a.isVisible('#profile-error'), 'A bad UPI ID is caught on the page');
  await a.fill('#upi_id', 'new.neighbour@okdemo');
  await a.click('#profile-submit');
  await a.waitForURL('**/pages/join.html'); await settle(a);
  check(true, 'After the profile, the person is sent to join');
  await noSideScroll(a, 'join'); await smallTargets(a, 'join');
  await shot(a, 'join-light');

  // 4. Join with an invite code.
  await a.fill('#code', 'NOPE2345');
  await a.click('#join-form button[type=submit]');
  await a.waitForSelector('#join-error:not([hidden])');
  check((await a.textContent('#join-error')).includes("doesn't match"), 'A wrong code shows a clear error');
  await a.fill('#code', ' demo 2345 ');
  await a.click('#join-form button[type=submit]');
  await a.waitForSelector('#step-wait:not([hidden])');
  check((await a.textContent('#wait-society')) === 'Demo Society', 'Waiting screen names the society');
  await noSideScroll(a, 'waiting'); await smallTargets(a, 'waiting');
  await shot(a, 'waiting-light');

  // 5. While pending: the app pages bounce, and the database shows nothing private.
  for (const p of ['/index.html', '/pages/item.html?id=11111111-0000-4000-8000-000000000001', '/pages/my-items.html', '/pages/post.html', '/pages/admin.html']) {
    await a.goto(SITE + p);
    await a.waitForURL('**/pages/join.html'); await settle(a);
    check(await a.isVisible('#step-wait'), `Pending person opening ${p} sees the waiting screen`);
  }
  const leak = await a.evaluate(async () => {
    const db = window.Dumpy.db;
    const r = {};
    r.listings = (await db.from('listings').select('id')).data;
    r.photos = (await db.from('listing_photos').select('id')).data;
    r.profiles = (await db.from('profiles').select('user_id, display_name')).data;
    r.societies = (await db.from('societies').select('id, invite_code')).data;
    r.members = (await db.rpc('admin_list_members', { p_society_id: '5d000000-0000-4000-8000-000000000001' })).data;
    const flat = await db.from('profiles').select('flat');
    r.flatError = flat.error && flat.error.code;
    return r;
  });
  check(leak.listings.length === 0, 'Pending person reads no listings straight from the database');
  check(leak.photos.length === 0, 'Pending person reads no photos');
  check(leak.profiles.length === 1 && leak.profiles[0].display_name === 'New Neighbour', 'Pending person reads only their own profile');
  check(leak.societies.length === 0, 'Pending person cannot read the society row or its invite code');
  check(leak.members.length === 0, 'Pending person gets nothing from the admin member list');
  check(leak.flatError === '42501', 'Nobody can select flat numbers directly');

  // 6. The admin, in a second browser profile, approves.
  const b = await B.newPage();
  b.on('pageerror', (e) => errors.push('admin: ' + e.message));
  await b.goto(magicLink(USERS.admin));
  await settle(b); check(b.url() === SITE + '/', 'Address is tidy after the link (' + b.url() + ')');
  check(await b.isVisible('#feed .item-card'), 'Admin lands on the feed');
  await b.goto(SITE + '/pages/profile.html'); await settle(b);
  check(await b.isVisible('#admin-link'), 'Admin sees the Society admin link');
  await b.click('#admin-link a');
  await b.waitForURL('**/admin.html'); await settle(b);
  await b.waitForSelector('#pending [data-user]');
  check((await b.textContent('#invite-code')) === 'DEMO2345', 'Admin page shows the invite code');
  const row = await b.textContent('#pending [data-user]');
  check(row.includes('New Neighbour') && row.includes('Tower C') && row.includes('C-303'), 'Pending row shows name, tower and flat');
  await noSideScroll(b, 'admin'); await smallTargets(b, 'admin');
  await shot(b, 'admin-light');
  await b.click('#pending [data-act=approve]');
  await b.waitForFunction(() => !document.querySelector('#pending [data-user]'));
  check((await b.textContent('#members')).includes('New Neighbour'), 'Approved person moves to Members');

  // 7. The new member checks again and gets in.
  // (still on the waiting screen in the first browser)
  await a.click('#step-wait [data-check-again]');
  await a.waitForURL('**/index.html'); await settle(a);
  await a.waitForSelector('#feed .item-card');
  const n = await a.locator('#feed .item-card').count();
  check(n === 3, `Approved member sees the society's 3 items (saw ${n})`);
  check((await a.textContent('#society-name')) === 'Demo Society', 'Header shows the society name');
  await a.waitForFunction(() => [...document.querySelectorAll('#feed img')].every((i) => i.complete && i.naturalWidth > 0));
  await noSideScroll(a, 'home'); await smallTargets(a, 'home');
  await shot(a, 'home-light', false);
  await a.click('.chip[data-filter=free]');
  await a.waitForFunction(() => document.querySelectorAll('#feed .item-card').length === 2, null, { timeout: 5000 }).catch(() => {});
  check((await a.locator('#feed .item-card').count()) === 2, 'Free filter shows the 2 free items');
  await a.click('#feed .item-card >> nth=0');
  await a.waitForURL('**/item.html?id=*'); await settle(a);
  await a.waitForSelector('.item-head h1');
  check((await a.textContent('.item-head h1')) === 'Wooden study chair', 'Item page shows the real item');
  check((await a.textContent('#want-btn')).includes('I want this') && await a.isEnabled('#want-btn'), 'A member can ask for the item (stage 6)');
  await noSideScroll(a, 'item');
  await shot(a, 'item-light', false);
  await a.goto(SITE + '/pages/my-items.html'); await settle(a);
  await a.waitForSelector('#listings li');
  await noSideScroll(a, 'my items');
  await shot(a, 'my-items-light', false);
  await a.goto(SITE + '/pages/profile.html'); await settle(a);
  check(await a.isVisible('.bottom-nav'), 'Members see the app navigation on Profile');
  check(!(await a.isVisible('#admin-link')), 'Plain members do not see the admin link');
  check((await a.inputValue('#flat')) === 'C-303' && (await a.inputValue('#phone')) === '9876543210', 'Profile shows saved private fields (flat upper-cased, phone tidied)');
  await noSideScroll(a, 'profile'); await smallTargets(a, 'profile');
  await shot(a, 'profile-light');
  await a.goto(SITE + '/pages/admin.html');
  await a.waitForURL('**/pages/profile.html');
  check(true, 'A plain member opening the admin page is sent back to Profile');

  // 8. Sign out
  await a.goto(SITE + '/pages/profile.html'); await settle(a);
  await a.click('[data-sign-out]');
  await a.waitForURL(SITE + '/index.html'); await settle(a);
  check(await a.isVisible('#landing'), 'Sign out returns to the public landing');

  // Dark mode screenshots of the new screens
  const D = await browser.newContext({ ...opts, colorScheme: 'dark' });
  await wire(D);
  const d = await D.newPage();
  await d.goto(SITE + '/'); await settle(d); await shot(d, 'landing-dark');
  await d.goto(SITE + '/pages/sign-in.html'); await settle(d); await shot(d, 'sign-in-dark');
  await d.goto(magicLink(USERS.admin)); await settle(d);
  await d.waitForFunction(() => [...document.querySelectorAll('#feed img')].every((i) => i.complete && i.naturalWidth > 0));
  await shot(d, 'home-dark', false);
  await d.goto(SITE + '/pages/admin.html'); await settle(d); await d.waitForSelector('#members li'); await shot(d, 'admin-dark');

  check(errors.length === 0, 'No script errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  console.log(failed() ? `\n${failed()} FAILED` : '\nAll stage 4 browser checks passed');
  process.exit(failed() ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
