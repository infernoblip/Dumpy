// Stage 11 browser test: the home-screen app (manifest, icons, Chrome's own
// installability check), the service worker (saves the site's files, never
// Supabase answers, opens offline), the install hint on Android and iPhone,
// the first-visit tip card, signing in with the code from the email, visit
// stats only on the live host, and the A4 poster printing on one page.
// 360 x 740 phone viewport against the local stand-in for Supabase (see
// lib.js and run.sh). All people are made up.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./lib');
const { SITE, USERS, PHONE, check, wire, magicLink, settle, noSideScroll, smallTargets, otpCalls } = L;

const ROOT = path.join(L.S, '../..');
const shot = L.shooter(path.join(ROOT, 'docs/screenshots/stage-11'));
const OWNER = USERS.owner;
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const launchOpts = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};

const pngSize = (file) => { const b = fs.readFileSync(file); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

(async () => {
  const errors = [];
  const watch = (p) => {
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) errors.push(m.text()); });
  };

  // 1. Manifest and icons.
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  check(manifest.name === 'Dumpy' && manifest.short_name === 'Dumpy' && manifest.display === 'standalone' && !!manifest.theme_color,
    'manifest.json has name, short name, standalone display and theme colour');
  for (const want of ['192x192', '512x512']) {
    const icon = manifest.icons.find((i) => i.sizes === want && i.purpose !== 'maskable');
    const real = icon && pngSize(path.join(ROOT, icon.src)).join('x');
    check(real === want, `manifest lists a ${want} icon and the PNG really is ${real}`);
  }
  const mask = manifest.icons.find((i) => i.purpose === 'maskable');
  check(!!mask && pngSize(path.join(ROOT, mask.src)).join('x') === '512x512', 'there is a 512 px maskable icon for Android');
  check(pngSize(path.join(ROOT, 'assets/apple-touch-icon.png')).join('x') === '180x180', 'iPhone gets a 180 px PNG home-screen icon');
  const pages = ['index.html'].concat(fs.readdirSync(path.join(ROOT, 'pages')).filter((f) => f.endsWith('.html')).map((f) => 'pages/' + f));
  const missing = pages.filter((f) => {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    return !/rel="manifest"/.test(html) || !/js\/app\.js/.test(html) || !/apple-touch-icon\.png/.test(html);
  });
  check(missing.length === 0, `every page links the manifest, the PNG touch icon and js/app.js` + (missing.length ? ' (missing: ' + missing.join(', ') + ')' : ''));

  // 2. Chrome's installability check (the one Lighthouse used for its PWA
  //    audit). It refuses incognito windows, so use a real profile.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dumpy-profile-'));
  const real = await chromium.launchPersistentContext(profile, { ...launchOpts, ...PHONE });
  await wire(real);
  const rp = real.pages()[0] || await real.newPage();
  watch(rp);
  await rp.goto(SITE + '/index.html'); await settle(rp);
  await rp.evaluate(() => navigator.serviceWorker.ready);
  const cdp = await real.newCDPSession(rp);
  const inst = await cdp.send('Page.getInstallabilityErrors');
  check(inst.installabilityErrors.length === 0, 'Chrome finds no installability errors' +
    (inst.installabilityErrors.length ? ' ' + JSON.stringify(inst.installabilityErrors) : ''));
  const man = await cdp.send('Page.getAppManifest');
  check(man.errors.length === 0 && /manifest\.json$/.test(man.url), 'Chrome reads the manifest without errors');
  await real.close();
  fs.rmSync(profile, { recursive: true, force: true });

  const browser = await chromium.launch(launchOpts);

  // 3. Service worker: saves the site's own files, never Supabase answers,
  //    and the app still opens offline.
  const ctx = await browser.newContext({ ...PHONE, colorScheme: 'light' });
  await wire(ctx);
  const p = await ctx.newPage();
  watch(p);
  await p.goto(magicLink(OWNER)); await settle(p);
  await p.evaluate(() => navigator.serviceWorker.ready);
  await p.reload(); await settle(p); // now the worker controls the page
  check(await p.evaluate(() => !!navigator.serviceWorker.controller), 'the service worker controls the page after a reload');
  await p.waitForTimeout(500);
  const keys = await p.evaluate(async () => {
    const out = [];
    for (const name of await caches.keys()) for (const r of await (await caches.open(name)).keys()) out.push(r.url);
    return out;
  });
  const want = ['/', '/css/style.css', '/js/app.js', '/js/render.js', '/pages/item', '/pages/sign-in', '/manifest.json'];
  check(want.every((w) => keys.includes(SITE + w)), 'pages, CSS and JS are saved for fast repeat loads');
  check(keys.every((k) => k.startsWith(SITE + '/')), 'nothing from Supabase or a CDN is saved (' + keys.filter((k) => !k.startsWith(SITE)).length + ' others)');

  // A change on the server shows on the next load (network first).
  const cssPath = path.join(ROOT, 'css/style.css');
  const css = fs.readFileSync(cssPath, 'utf8');
  try {
    fs.writeFileSync(cssPath, css + '\n/* deploy-marker */\n');
    await p.reload(); await settle(p);
    const fresh = await p.evaluate(async () => (await (await fetch('css/style.css')).text()).includes('deploy-marker'));
    check(fresh, 'a new deploy is used straight away, not an old saved copy');
  } finally {
    fs.writeFileSync(cssPath, css);
  }

  await ctx.setOffline(true);
  await p.goto(SITE + '/pages/item.html?id=11111111-0000-4000-8000-000000000001').catch(() => {});
  const offlineShell = await p.evaluate(() => !!document.querySelector('#action-bar') && !!document.querySelector('link[href="../css/style.css"]')).catch(() => false);
  check(offlineShell, 'offline, a saved page (item page) still opens from the saved copy');
  await ctx.setOffline(false);

  // 4. First-visit tip card on the home feed, then the install hint.
  await p.goto(SITE + '/index.html'); await settle(p);
  await p.evaluate(() => localStorage.removeItem('dumpy.tipSeen'));
  await p.reload(); await settle(p);
  await p.waitForSelector('#tip-card:not([hidden])');
  check(/Free/.test(await p.textContent('#tip-card')) && /UPI or cash/.test(await p.textContent('#tip-card')) && /tip you both agree/.test(await p.textContent('#tip-card')),
    'first visit: the tip card explains Free, Paid (UPI or cash) and delivery');
  await noSideScroll(p, 'home with tip card');
  await smallTargets(p, 'home with tip card');
  await shot(p, 'home-tip-light', false);

  // Android: Chrome offers its install prompt (faked here; headless Chrome never fires it).
  await p.evaluate(() => {
    const e = new Event('beforeinstallprompt', { cancelable: true });
    e.prompt = () => { window.__prompted = true; };
    e.userChoice = Promise.resolve({ outcome: 'accepted' });
    window.dispatchEvent(e);
  });
  check(await p.isHidden('#install-hint'), 'the install hint waits while the tip card is showing');
  await p.click('[data-tip-done]');
  check(await p.isHidden('#tip-card'), 'Got it closes the tip card');
  await p.waitForSelector('#install-hint:not([hidden]) button:has-text("Install")');
  check(true, 'Android: the hint offers an Install button');
  await noSideScroll(p, 'home with install hint');
  await smallTargets(p, 'home with install hint');
  await shot(p, 'home-install-android-light', false);
  await p.click('#install-hint button:has-text("Install")');
  check(await p.evaluate(() => window.__prompted === true), 'Install opens Chrome\'s install prompt');
  await p.reload(); await settle(p);
  check(await p.isHidden('#tip-card') && await p.isHidden('#install-hint'), 'after reload neither card comes back');
  await ctx.close();

  // iPhone: a one-line Share tip, in dark mode.
  const ictx = await browser.newContext({ ...PHONE, userAgent: IPHONE_UA, colorScheme: 'dark' });
  await wire(ictx);
  const ip = await ictx.newPage();
  watch(ip);
  await ip.goto(magicLink(OWNER)); await settle(ip);
  await ip.evaluate(() => localStorage.setItem('dumpy.tipSeen', '1'));
  await ip.reload(); await settle(ip);
  await ip.waitForSelector('#install-hint:not([hidden])');
  const itext = await ip.textContent('#install-hint');
  check(/Share/.test(itext) && /Add to Home Screen/.test(itext) && !(await ip.$('#install-hint button:has-text("Install")')),
    'iPhone: the hint says "tap Share, then Add to Home Screen"');
  await noSideScroll(ip, 'iPhone install hint');
  await smallTargets(ip, 'iPhone install hint');
  await shot(ip, 'home-install-iphone-dark', false);
  await ip.click('#install-hint button:has-text("Not now")');
  await ip.reload(); await settle(ip);
  check(await ip.isHidden('#install-hint'), 'Not now hides the hint for good');
  await ictx.close();

  // The home-screen app itself never shows the install hint.
  const sctx = await browser.newContext({ ...PHONE, userAgent: IPHONE_UA });
  await wire(sctx);
  await sctx.addInitScript(() => { Object.defineProperty(navigator, 'standalone', { get: () => true }); });
  const sp = await sctx.newPage();
  await sp.goto(magicLink(OWNER)); await settle(sp);
  await sp.evaluate(() => localStorage.setItem('dumpy.tipSeen', '1'));
  await sp.reload(); await settle(sp); await sp.waitForTimeout(300);
  check(await sp.isHidden('#install-hint'), 'opened from the home screen, no install hint');
  await sctx.close();

  // Signed-out visitors see the landing, with no tip card or hint.
  const octx = await browser.newContext({ ...PHONE });
  await wire(octx);
  const op = await octx.newPage();
  watch(op);
  await op.goto(SITE + '/index.html'); await settle(op); await op.waitForTimeout(300);
  check(await op.isVisible('#landing') && await op.isHidden('#tip-card') && await op.isHidden('#install-hint'), 'signed out: landing only, no tip card or install hint');

  // 5. Signing in with the code from the email (for the home-screen app).
  await op.goto(SITE + '/pages/sign-in.html'); await settle(op);
  await op.fill('#email', OWNER.email);
  await op.click('#sign-in-form button[type=submit]');
  await op.waitForSelector('#step-sent:not([hidden])');
  await noSideScroll(op, 'sign-in code step');
  await smallTargets(op, 'sign-in code step');
  await shot(op, 'sign-in-code-light');
  await op.fill('#code', '12');
  await op.click('#code-form button[type=submit]');
  check(await op.isVisible('#code-error'), 'a too-short code is caught on the page');
  await op.fill('#code', '999999');
  await op.click('#code-form button[type=submit]');
  await op.waitForSelector('#code-error:not([hidden]):has-text("wrong or has expired")');
  check(true, 'a wrong code says it is wrong or expired');
  await op.fill('#code', '123 456');
  await op.click('#code-form button[type=submit]');
  await op.waitForURL(/\/index\.html$/);
  await settle(op);
  check(await op.evaluate(() => document.body.dataset.status) === 'member', 'the right code signs in and opens the feed');
  const v = otpCalls.filter((c) => c.verify).pop();
  check(v && v.verify.email === OWNER.email && v.verify.type === 'email', 'the code is checked by Supabase for that email');
  await octx.close();

  // 6. Visit stats: the Cloudflare beacon loads only with a token, on the live host.
  async function beaconLoads(configBody) {
    const c = await browser.newContext({ ...PHONE });
    await wire(c);
    let hit = false;
    await c.route('https://static.cloudflareinsights.com/**', (r) => { hit = true; r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }); });
    if (configBody) await c.route(SITE + '/js/config.js', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: configBody }));
    const pg = await c.newPage();
    await pg.goto(SITE + '/index.html'); await settle(pg); await pg.waitForTimeout(300);
    const cookies = await c.cookies();
    await c.close();
    return { hit, cookies: cookies.length };
  }
  const cfg = fs.readFileSync(path.join(ROOT, 'js/config.js'), 'utf8');
  check(!(await beaconLoads(cfg.replace(/analyticsToken: "[^"]*"/, 'analyticsToken: ""').replace(/siteUrl: "[^"]*"/, 'siteUrl: "http://localhost:8000/"'))).hit, 'no token set, even on the live host: no analytics script');
  check(!(await beaconLoads(cfg.replace(/analyticsToken: "[^"]*"/, 'analyticsToken: "test-token"'))).hit, 'token set but not the live host (a preview): no analytics script');
  const live = await beaconLoads(cfg.replace(/analyticsToken: "[^"]*"/, 'analyticsToken: "test-token"').replace(/siteUrl: "[^"]*"/, 'siteUrl: "http://localhost:8000/"'));
  check(live.hit && live.cookies === 0, 'token set on the live host: the Cloudflare beacon loads, and no cookies are set');

  // 7. Poster: QR code, no society name, one A4 page.
  const pctx = await browser.newContext({ ...PHONE, colorScheme: 'light' });
  await wire(pctx);
  const pp = await pctx.newPage();
  watch(pp);
  await pp.goto(SITE + '/pages/poster.html');
  await pp.waitForSelector('#qr svg');
  check((await pp.textContent('#url')) === 'dumpy.infernicustrap.workers.dev', 'the poster shows the live address under the QR code');
  const ptext = await pp.textContent('#poster');
  check(/Sign in/.test(ptext) && /Join/.test(ptext) && /Post or grab/.test(ptext), 'the poster has the three steps');
  check(!/Demo Society/.test(ptext) && /Our society/.test(ptext), 'the poster names no society: there is a box to write it in');
  await noSideScroll(pp, 'poster');
  await smallTargets(pp, 'poster');
  await shot(pp, 'poster-light');
  const pdf = await pp.pdf({ preferCSSPageSize: true, printBackground: true });
  fs.writeFileSync(path.join(os.tmpdir(), 'dumpy-poster.pdf'), pdf);
  const pdfText = pdf.toString('latin1');
  const pageCount = (pdfText.match(/\/Type\s*\/Page[^s]/g) || []).length;
  const box = (pdfText.match(/\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\]/) || []).slice(1).map(Number);
  check(pageCount === 1, `the poster prints on one page (got ${pageCount})`);
  check(Math.abs(box[0] - 595) < 2 && Math.abs(box[1] - 842) < 2, `the page is A4 (${box.join(' x ')} pt)`);
  const dctx = await browser.newContext({ ...PHONE, colorScheme: 'dark' });
  await wire(dctx);
  const dp = await dctx.newPage();
  await dp.goto(SITE + '/pages/poster.html'); await dp.waitForSelector('#qr svg');
  await shot(dp, 'poster-dark');
  await dctx.close();
  await pctx.close();

  // The admin page links to the poster.
  const actx = await browser.newContext({ ...PHONE, colorScheme: 'light' });
  await wire(actx);
  const ap = await actx.newPage();
  watch(ap);
  await ap.goto(magicLink(USERS.admin)); await settle(ap);
  await ap.goto(SITE + '/pages/admin.html'); await settle(ap);
  check(await ap.isVisible('a[href="poster.html"]'), 'the admin page links to the poster');
  await noSideScroll(ap, 'admin');
  await smallTargets(ap, 'admin');
  await shot(ap, 'admin-poster-link-light', false);
  await actx.close();

  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''));
  await browser.close();
  if (L.failed()) { console.log(`\n${L.failed()} check(s) failed`); process.exit(1); }
  console.log('\nall stage 11 checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
