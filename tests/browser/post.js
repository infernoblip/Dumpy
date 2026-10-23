// Stage 5 browser test: posting, editing and withdrawing an item with photos,
// in a 360 x 740 phone viewport, against the local stand-in for Supabase
// (see lib.js and run.sh). All people and items are made up.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const path = require('path');
const L = require('./lib');
const { SITE, USERS, SOCIETY, PHONE, STORE, check, sql, wire, magicLink, settle, noSideScroll, smallTargets, storageLog, faults } = L;

const shot = L.shooter(path.join(L.S, '../../docs/screenshots/stage-5'));
const NEIGHBOUR = { id: 'aaaaaaaa-0000-4000-8000-000000000004', email: 'demo.neighbour@example.com' };

// Big made-up "camera" photos, drawn in the browser: soft colours, a few
// shapes and grain, so they compress like real photos (several MB each).
async function cameraPhotos(page, specs) {
  return page.evaluate(async (specs) => {
    const out = [];
    for (const s of specs) {
      const c = document.createElement('canvas');
      c.width = s.w; c.height = s.h;
      const x = c.getContext('2d');
      const g = x.createLinearGradient(0, 0, s.w, s.h);
      g.addColorStop(0, `hsl(${s.hue} 45% 78%)`); g.addColorStop(1, `hsl(${s.hue + 40} 40% 45%)`);
      x.fillStyle = g; x.fillRect(0, 0, s.w, s.h);
      x.fillStyle = `hsl(${s.hue + 180} 35% 35%)`;
      x.fillRect(s.w * 0.25, s.h * 0.45, s.w * 0.5, s.h * 0.08);           // a table top
      x.fillRect(s.w * 0.3, s.h * 0.53, s.w * 0.04, s.h * 0.3);            // legs
      x.fillRect(s.w * 0.66, s.h * 0.53, s.w * 0.04, s.h * 0.3);
      const img = x.getImageData(0, 0, s.w, s.h);
      for (let i = 0; i < img.data.length; i += 4) { const n = (Math.random() - 0.5) * 50; img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n; }
      x.putImageData(img, 0, 0);
      const blob = await new Promise((r) => c.toBlob(r, s.type, 0.95));
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      out.push({ name: s.name, mimeType: s.type, b64: btoa(bin) });
    }
    return out;
  }, specs).then((files) => files.map((f) => ({ name: f.name, mimeType: f.mimeType, buffer: Buffer.from(f.b64, 'base64') })));
}

const q1 = (query) => sql(query).split('\n').filter(Boolean).pop() || '';
const jsonQ = (query) => JSON.parse(q1(`select coalesce(jsonb_agg(t), '[]') from (${query}) t`));

(async () => {
  sql(`insert into auth.users (id, aud, role, email, created_at, updated_at) values ('${NEIGHBOUR.id}','authenticated','authenticated','${NEIGHBOUR.email}', now(), now()) on conflict do nothing;
       insert into public.profiles (user_id, display_name, tower) values ('${NEIGHBOUR.id}','Demo Neighbour','D') on conflict do nothing;
       insert into public.memberships (user_id, society_id, role, status) values ('${NEIGHBOUR.id}','${SOCIETY}','member','approved') on conflict do nothing;`);

  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const O = await browser.newContext(PHONE);   // the owner
  const N = await browser.newContext(PHONE);   // another member, in a second browser profile
  await wire(O); await wire(N);
  const o = await O.newPage();
  const errors = [];
  o.on('pageerror', (e) => errors.push(e.message));
  o.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|internetdisconnected|Failed to fetch/i.test(m.text())) errors.push(m.text()); });
  o.on('dialog', (d) => d.accept());

  // 1. The post form.
  await o.goto(magicLink(USERS.owner)); await settle(o);
  await o.click('.bottom-nav a[href$="post.html"]');
  await o.waitForURL('**/pages/post.html'); await settle(o);
  check(await o.isVisible('#post-form'), 'Post page shows the form');
  check((await o.inputValue('#category')) === '' && (await o.isChecked('input[value=good]')) && (await o.isChecked('#free')), 'Defaults: no category yet, condition Good, Free on');
  await noSideScroll(o, 'post'); await smallTargets(o, 'post');
  await shot(o, 'post-light');

  // 2. Checked on the page first.
  const before = q1('select count(*) from public.listings');
  await o.click('#post-submit');
  check(await o.isVisible('#post-error') && (await o.textContent('#post-error')).includes('title'), 'Empty title is caught on the page');
  await o.fill('#title', 'Folding table');
  await o.click('#post-submit');
  check((await o.textContent('#post-error')).includes('category'), 'Missing category is caught');
  await o.selectOption('#category', 'furniture');
  await o.click('#free');                                  // turn Free off: price appears
  check(await o.isVisible('#price'), 'Turning Free off shows the price field');
  await o.click('#post-submit');
  check((await o.textContent('#post-error')).includes('price'), 'Missing price is caught when not free');
  check(q1('select count(*) from public.listings') === before, 'Nothing reaches the database while the form has mistakes');

  // 3. Photos: five picked, four kept, one removed.
  const files = await cameraPhotos(o, [
    { name: 'IMG_0001.jpg', type: 'image/jpeg', w: 4000, h: 3000, hue: 30 },
    { name: 'IMG_0002.jpg', type: 'image/jpeg', w: 3000, h: 4000, hue: 200 },
    { name: 'IMG_0003.png', type: 'image/png', w: 2400, h: 1800, hue: 120 },
    { name: 'IMG_0004.jpg', type: 'image/jpeg', w: 4000, h: 3000, hue: 300 },
    { name: 'IMG_0005.jpg', type: 'image/jpeg', w: 4000, h: 3000, hue: 60 },
  ]);
  const origSizes = files.map((f) => f.buffer.length);
  console.log('     picked photo sizes (KB):', origSizes.map((n) => Math.round(n / 1024)).join(', '));
  check(origSizes.every((n) => n > 1024 * 1024), 'Test photos are camera-sized (over 1 MB each)');
  await o.setInputFiles('#photos', files);
  await o.waitForFunction(() => document.querySelectorAll('.photo-slot--preview').length === 4);
  check((await o.textContent('#photo-hint')).includes('first 4'), 'Picking 5 photos keeps 4 and says so');
  check(!(await o.isVisible('#photo-add')), 'The Add photo tile hides when 4 photos are in');
  await o.click('.photo-slot__remove >> nth=3');
  check((await o.locator('.photo-slot--preview').count()) === 3 && (await o.isVisible('#photo-add')), 'Removing a photo frees a tile');
  await o.waitForFunction(() => !document.querySelector('.photo-slot--preview[data-state=shrinking]'), null, { timeout: 30000 });
  check((await o.locator('.photo-slot--preview[data-state=ready]').count()) === 3, 'All 3 photos are shrunk and ready');

  await o.fill('#price', '250');
  await o.fill('#description', 'Fits two people. Folds flat behind a door.');
  await o.check('input[value=used]', { force: true });
  await o.evaluate(() => document.activeElement && document.activeElement.blur());
  await noSideScroll(o, 'post with photos'); await smallTargets(o, 'post with photos');
  await shot(o, 'post-filled-light');

  // 4. The connection drops during the first upload: the form stays filled.
  faults.dropUploads = 1;
  await o.click('#post-submit');
  await o.waitForSelector('#post-error:not([hidden])', { timeout: 20000 });
  const errText = await o.textContent('#post-error');
  check(/posted, but a photo didn't upload/.test(errText), 'A failed upload says what happened (' + errText.trim() + ')');
  check((await o.inputValue('#title')) === 'Folding table' && (await o.inputValue('#price')) === '250', 'The form keeps everything typed');
  check((await o.textContent('#post-submit')).trim() === 'Try again', 'The button offers Try again');
  check((await o.locator('.photo-slot--preview[data-state=failed]').count()) === 1, 'The photo that failed is marked');
  const id = q1("select id from public.listings where title = 'Folding table'");
  check(/^[0-9a-f-]{36}$/.test(id), 'The listing itself was saved');
  await noSideScroll(o, 'post retry');
  await shot(o, 'post-retry-light');

  // 5. Try again finishes the job without posting twice.
  await o.click('#post-submit');
  await o.waitForURL('**/item.html?id=' + id, { timeout: 30000 }); await settle(o);
  check(await o.isVisible('#posted-note'), 'After posting, the item page says it is posted');
  check(q1("select count(*) from public.listings where title = 'Folding table'") === '1', 'Try again did not post the item twice');
  const row = jsonQ(`select society_id, owner_id, category, condition, price_inr, status, description from public.listings where id = '${id}'`)[0];
  check(row.owner_id === USERS.owner.id && row.society_id === SOCIETY && row.category === 'furniture' && row.condition === 'used' && row.price_inr === 250 && row.status === 'available',
    'The database has the item with the right owner, society, category, condition, price and status');
  const pics = jsonQ(`select storage_path, position from public.listing_photos where listing_id = '${id}' order by position`);
  check(pics.length === 3 && pics.map((p) => p.position).join() === '0,1,2', 'Three photo rows, in order 0, 1, 2');
  check(pics.every((p) => p.storage_path.startsWith(`${SOCIETY}/${id}/`)), 'Photos sit at society_id/listing_id/ in Storage');
  const objs = jsonQ(`select name, metadata from storage.objects where bucket_id = 'listing-photos' and name like '${SOCIETY}/${id}/%'`);
  check(objs.length === 3 && pics.every((p) => objs.some((x) => x.name === p.storage_path)), 'Each photo row has its file in the bucket');
  const sizes = objs.map((x) => x.metadata.size);
  console.log('     uploaded photo sizes (KB):', sizes.map((n) => Math.round(n / 1024)).join(', '));
  check(sizes.every((n) => n <= 450 * 1024), 'Uploaded photos are shrunk (all under 450 KB)');
  check(objs.every((x) => x.metadata.mimetype === 'image/webp' || x.metadata.mimetype === 'image/jpeg'), 'Uploaded as WebP or JPEG (' + objs.map((x) => x.metadata.mimetype).join(', ') + ')');
  await o.waitForFunction(() => [...document.querySelectorAll('.gallery img')].every((i) => i.complete && i.naturalWidth > 0));
  const dims = await o.evaluate(() => [...document.querySelectorAll('.gallery img')].map((i) => [i.naturalWidth, i.naturalHeight]));
  console.log('     uploaded photo sizes (px):', dims.map((d) => d.join('x')).join(', '));
  check(dims.length === 3 && dims.every((d) => Math.max(d[0], d[1]) <= 1280), 'Long edge of each photo is at most 1280 px');
  check(dims[0][0] === 1280 && dims[0][1] === 960 && dims[1][0] === 960 && dims[1][1] === 1280, 'Landscape and portrait shapes are kept');
  check(await o.isVisible('#edit-btn'), 'The owner sees Edit item instead of a request button');
  await noSideScroll(o, 'item (owner)');
  await shot(o, 'item-posted-light', false);

  // 6. Another member sees it in the feed but cannot edit it.
  const n = await N.newPage();
  n.on('pageerror', (e) => errors.push('neighbour: ' + e.message));
  n.on('dialog', (d) => d.accept());
  await n.goto(magicLink(NEIGHBOUR)); await settle(n);
  await n.waitForSelector('#feed .item-card');
  check((await n.textContent('#feed .item-card >> nth=0')).includes('Folding table'), 'The new item is first in a neighbour\'s feed');
  await n.waitForFunction(() => [...document.querySelectorAll('#feed img')].every((i) => i.complete && i.naturalWidth > 0));
  await shot(n, 'home-light', false);
  await n.goto(SITE + '/pages/item.html?id=' + id); await settle(n);
  await n.waitForSelector('.item-head h1');
  check(!(await n.isVisible('#edit-btn')) && (await n.textContent('#want-btn')).includes('Requests open soon'), 'A neighbour sees no Edit button');
  await n.goto(SITE + '/pages/post.html?id=' + id); await settle(n);
  await n.waitForSelector('#post-missing:not([hidden])');
  check((await n.textContent('#post-missing')).includes('only edit items you posted') && !(await n.isVisible('#post-form')), 'A neighbour opening the edit page is turned away');

  const victimPhoto = pics[0].storage_path;
  const attack = await n.evaluate(async ({ id, society, owner, victimPhoto }) => {
    const db = window.Dumpy.db;
    const r = {};
    r.update = (await db.from('listings').update({ title: 'Mine now' }).eq('id', id).select('id')).data.length;
    r.withdraw = (await db.from('listings').update({ status: 'withdrawn' }).eq('id', id).select('id')).data.length;
    r.asOwner = !!(await db.from('listings').insert({ society_id: society, owner_id: owner, title: 'Fake' }).select('id')).error;
    r.photoRow = !!(await db.from('listing_photos').insert({ listing_id: id, society_id: society, storage_path: society + '/' + id + '/x.jpg', position: 3 })).error;
    r.photoDelete = (await db.from('listing_photos').delete().eq('listing_id', id).select('id')).data.length;
    const blob = new Blob([new Uint8Array([255, 216, 255, 224])], { type: 'image/jpeg' });
    r.upload = !!(await db.storage.from('listing-photos').upload(society + '/' + id + '/sneaky.jpg', blob, { contentType: 'image/jpeg' })).error;
    r.remove = (await db.storage.from('listing-photos').remove([victimPhoto])).data.length;
    r.edit = await window.Dumpy.data.editListing(id, { title: 'Mine now' }).then(() => 'changed', (e) => e.message);
    return r;
  }, { id, society: SOCIETY, owner: USERS.owner.id, victimPhoto });
  check(attack.update === 0 && attack.withdraw === 0, 'A neighbour\'s update or withdraw changes no rows');
  check(attack.edit === 'You can only change your own items.', 'The page explains a refused change');
  check(attack.asOwner, 'A neighbour cannot post an item in the owner\'s name');
  check(attack.photoRow && attack.photoDelete === 0, 'A neighbour cannot add or remove photo rows on it');
  check(attack.upload, 'A neighbour cannot upload into the item\'s Storage folder');
  check(attack.remove === 0 && fs.existsSync(path.join(STORE, victimPhoto)), 'A neighbour cannot delete its photo files');
  check(q1(`select title || '|' || status from public.listings where id = '${id}'`) === 'Folding table|available', 'The item is unchanged after all that');

  // 7. My items: Edit and Withdraw.
  await o.goto(SITE + '/pages/my-items.html'); await settle(o);
  await o.waitForSelector(`[data-listing="${id}"]`);
  const card = o.locator(`[data-listing="${id}"]`);
  check((await card.locator('a.btn', { hasText: 'Edit' }).count()) === 1 && (await card.locator('button[data-act=withdraw]').count()) === 1, 'My items offers Edit and Withdraw on the new item');
  await o.waitForFunction(() => [...document.querySelectorAll('#listings img')].every((i) => i.complete && i.naturalWidth > 0));
  await noSideScroll(o, 'my items'); await smallTargets(o, 'my items');
  await shot(o, 'my-items-light', false);

  // 8. Edit: new title, make it free, drop the cover photo, add another.
  await card.locator('a.btn', { hasText: 'Edit' }).click();
  await o.waitForURL('**/post.html?id=' + id); await settle(o);
  await o.waitForSelector('#post-form:not([hidden])');
  check((await o.textContent('#post-title')) === 'Edit item' && (await o.textContent('#post-submit')).trim() === 'Save changes', 'Edit page is titled Edit item with Save changes');
  check((await o.inputValue('#title')) === 'Folding table' && (await o.inputValue('#price')) === '250' && (await o.isChecked('input[value=used]')) && (await o.inputValue('#category')) === 'furniture', 'Edit page is filled with the saved details');
  await o.waitForFunction(() => [...document.querySelectorAll('.photo-slot--preview img')].length === 3 && [...document.querySelectorAll('.photo-slot--preview img')].every((i) => i.complete && i.naturalWidth > 0));
  check(true, 'Edit page shows the 3 saved photos');
  await noSideScroll(o, 'edit'); await smallTargets(o, 'edit');
  await shot(o, 'edit-light');
  await o.fill('#title', 'Folding table, small');
  await o.click('#free');
  await o.click('.photo-slot__remove >> nth=0');
  const extra = await cameraPhotos(o, [{ name: 'IMG_0006.jpg', type: 'image/jpeg', w: 4000, h: 3000, hue: 160 }]);
  await o.setInputFiles('#photos', extra);
  await o.waitForFunction(() => document.querySelectorAll('.photo-slot--preview').length === 3 && !document.querySelector('.photo-slot--preview[data-state=shrinking]'), null, { timeout: 30000 });
  await o.click('#post-submit');
  await o.waitForURL('**/item.html?id=' + id, { timeout: 30000 }); await settle(o);
  check((await o.textContent('#posted-note')).includes('Changes saved'), 'After saving, the item page says Changes saved');
  check(q1(`select title || '|' || price_inr from public.listings where id = '${id}'`) === 'Folding table, small|0', 'New title saved and the item is now Free');
  const pics2 = jsonQ(`select storage_path, position from public.listing_photos where listing_id = '${id}' order by position`);
  check(pics2.length === 3 && pics2.map((p) => p.position).join() === '0,1,2', 'Still 3 photos, renumbered 0, 1, 2');
  check(pics2[0].storage_path === pics[1].storage_path && pics2[1].storage_path === pics[2].storage_path && !pics.some((p) => p.storage_path === pics2[2].storage_path), 'Old photo 2 is the new cover and the added photo is last');
  check(q1(`select count(*) from storage.objects where name = '${pics[0].storage_path}'`) === '0' && !fs.existsSync(path.join(STORE, pics[0].storage_path)), 'The removed photo\'s file is deleted from Storage');
  check(await o.isVisible('.item-head .badge--free'), 'Item page now shows Free');

  // 9. Withdraw, then post again.
  await o.goto(SITE + '/pages/my-items.html'); await settle(o);
  await o.click(`[data-listing="${id}"] button[data-act=withdraw]`);
  await o.waitForSelector(`[data-listing="${id}"] button[data-act=relist]`);
  check(q1(`select status from public.listings where id = '${id}'`) === 'withdrawn', 'Withdraw sets the item to withdrawn');
  check((await o.textContent(`[data-listing="${id}"] .status`)).includes('Withdrawn'), 'My items shows it as Withdrawn with Post again');
  await shot(o, 'my-items-withdrawn-light', false);
  await n.goto(SITE + '/'); await settle(n);
  await n.waitForSelector('#feed .item-card');
  check(!(await n.textContent('#feed')).includes('Folding table'), 'A withdrawn item leaves the neighbour\'s feed');
  await n.goto(SITE + '/pages/item.html?id=' + id); await settle(n);
  await n.waitForSelector('#item .empty');
  check(true, 'A neighbour opening a withdrawn item sees it is no longer listed');
  await o.click(`[data-listing="${id}"] button[data-act=relist]`);
  await o.waitForSelector(`[data-listing="${id}"] button[data-act=withdraw]`);
  check(q1(`select status || '|' || (expires_at > now() + interval '29 days') from public.listings where id = '${id}'`) === 'available|true', 'Post again makes it available for another 30 days');

  // 10. Dark mode.
  const Dk = await browser.newContext({ ...PHONE, colorScheme: 'dark' });
  await wire(Dk);
  const d = await Dk.newPage();
  await d.goto(magicLink(USERS.owner)); await settle(d);
  await d.goto(SITE + '/pages/post.html?id=' + id); await settle(d);
  await d.waitForFunction(() => [...document.querySelectorAll('.photo-slot--preview img')].length === 3 && [...document.querySelectorAll('.photo-slot--preview img')].every((i) => i.complete && i.naturalWidth > 0));
  await shot(d, 'edit-dark');
  await d.goto(SITE + '/pages/post.html'); await settle(d); await shot(d, 'post-dark');
  await d.goto(SITE + '/pages/my-items.html'); await settle(d);
  await d.waitForFunction(() => [...document.querySelectorAll('#listings img')].every((i) => i.complete && i.naturalWidth > 0));
  await shot(d, 'my-items-dark', false);

  const refused = storageLog.filter((x) => !x.ok).map((x) => x.why);
  check(refused.join() === 'dropped,rls', 'Storage refused only the dropped upload and the neighbour\'s (' + refused.join(', ') + ')');
  check(errors.length === 0, 'No script errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  console.log(L.failed() ? `\n${L.failed()} FAILED` : '\nAll stage 5 browser checks passed');
  process.exit(L.failed() ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
