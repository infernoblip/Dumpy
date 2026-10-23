// Shared pieces of the browser tests: a stand-in for Supabase (database API,
// sign-in and Storage) wired into a Playwright browser context, and small
// checks. Used by e2e.js (stage 4) and post.js (stage 5); run them with run.sh.
//
// The database API goes to a local PostgREST. Storage is faked here, but every
// upload, read and delete is checked against the real storage rules from
// supabase/migrations by running it in the local Postgres as the signed-in
// person, so "only the owner can upload" is tested for real.
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const S = __dirname;
const WORK = process.env.WORK_DIR;               // set by run.sh
const PG_PORT = process.env.PG_PORT || '54339';  // set by run.sh
const SITE = 'http://localhost:8000';
const SUPA = 'https://sfezmqsdzwrjdcqpyhln.supabase.co';
const SECRET = 'local-test-secret-local-test-secret-0123'; // only for the throwaway local PostgREST
const BUCKET = { id: 'listing-photos', limit: 2 * 1024 * 1024, types: ['image/jpeg', 'image/png', 'image/webp'] };
const STORE = path.join(WORK || '/tmp', 'storage');
const UMD = WORK ? fs.readFileSync(path.join(WORK, 'package/dist/umd/supabase.js')) : null;

const USERS = {
  admin: { id: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'demo.admin@example.com' },
  newbie: { id: 'aaaaaaaa-0000-4000-8000-000000000002', email: 'new.neighbour@example.com' },
  owner: { id: 'aaaaaaaa-0000-4000-8000-000000000003', email: 'demo.owner@example.com' },
};
const SOCIETY = '5d000000-0000-4000-8000-000000000001';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(u) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64({ sub: u.id, email: u.email, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 3600 });
  const sig = crypto.createHmac('sha256', SECRET).update(h + '.' + p).digest('base64url');
  return `${h}.${p}.${sig}`;
}
function decode(token) { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); }

// Run SQL in the local database, as Postgres itself or as a signed-in person.
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
function sql(query, asUserId) {
  const wrapped = asUserId
    ? `begin; set local role authenticated; select set_config('request.jwt.claims', ${lit(JSON.stringify({ sub: asUserId, role: 'authenticated' }))}, true); ${query}; commit;`
    : query;
  return execFileSync('psql', ['-h', '/tmp', '-p', PG_PORT, '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qAt', '-c', wrapped],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function sqlTry(query, asUserId) {
  try { return { out: sql(query, asUserId) }; } catch (e) { return { error: String(e.stderr || e.message) }; }
}

let failures = 0;
function check(cond, label) {
  console.log((cond ? 'ok   ' : 'FAIL ') + label);
  if (!cond) failures++;
}
function failed() { return failures; }

const storageLog = [];   // every upload the fake Storage accepted or refused
const otpCalls = [];
// Tests can make the next N uploads fail as if the connection dropped.
const faults = { dropUploads: 0 };

async function wire(context) {
  await context.route('https://cdn.jsdelivr.net/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: UMD, headers: { 'access-control-allow-origin': '*' } }));
  await context.route(SUPA + '/**', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
    const json = (status, body) => route.fulfill({ status, headers: cors, contentType: 'application/json', body: JSON.stringify(body) });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const auth = (req.headers()['authorization'] || '').replace(/^Bearer /, '');
    const isJwt = auth.split('.').length === 3;
    const who = isJwt ? decode(auth).sub : null;

    if (u.pathname.startsWith('/rest/v1/')) {
      const headers = {};
      for (const [k, v] of Object.entries(req.headers())) {
        if (['content-type', 'prefer', 'accept', 'range', 'content-profile', 'accept-profile'].includes(k)) headers[k] = v;
      }
      if (isJwt) headers['authorization'] = 'Bearer ' + auth;
      const res = await fetch('http://localhost:3000' + u.pathname.slice(8) + u.search, {
        method: req.method(), headers, body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postDataBuffer(),
      });
      const rh = Object.fromEntries(res.headers.entries());
      delete rh['content-encoding']; delete rh['content-length'];
      return route.fulfill({ status: res.status, headers: { ...rh, ...cors }, body: Buffer.from(await res.arrayBuffer()) });
    }
    if (u.pathname === '/auth/v1/otp') {
      otpCalls.push({ body: req.postDataJSON(), redirect: u.searchParams.get('redirect_to') });
      return json(200, {});
    }
    if (u.pathname === '/auth/v1/user') {
      if (!isJwt) return json(401, { msg: 'no' });
      const c = decode(auth);
      return json(200, { id: c.sub, aud: 'authenticated', role: 'authenticated', email: c.email, app_metadata: { provider: 'email' }, user_metadata: {}, created_at: new Date().toISOString() });
    }
    if (u.pathname === '/auth/v1/logout') return route.fulfill({ status: 204, headers: cors });

    // ---- Storage ----
    const OBJ = '/storage/v1/object/' + BUCKET.id + '/';
    if (u.pathname.startsWith(OBJ) && req.method() === 'POST') {
      const name = decodeURIComponent(u.pathname.slice(OBJ.length));
      if (faults.dropUploads > 0) { faults.dropUploads--; storageLog.push({ name, who, ok: false, why: 'dropped' }); return route.abort('internetdisconnected'); }
      if (!who) return json(400, { statusCode: '403', error: 'Unauthorized', message: 'Invalid JWT' });
      const form = await new Response(req.postDataBuffer(), { headers: { 'content-type': req.headers()['content-type'] } }).formData();
      const file = [...form.values()].find((v) => typeof v === 'object');
      const bytes = Buffer.from(await file.arrayBuffer());
      const type = file.type;
      if (bytes.length > BUCKET.limit) { storageLog.push({ name, who, ok: false, why: 'too big' }); return json(413, { statusCode: '413', error: 'Payload too large', message: 'The object exceeded the maximum allowed size' }); }
      if (!BUCKET.types.includes(type)) { storageLog.push({ name, who, ok: false, why: 'type ' + type }); return json(415, { statusCode: '415', error: 'invalid_mime_type', message: `mime type ${type} is not supported` }); }
      const r = sqlTry(`insert into storage.objects (bucket_id, name, owner_id, metadata) values (${lit(BUCKET.id)}, ${lit(name)}, ${lit(who)}, ${lit(JSON.stringify({ size: bytes.length, mimetype: type }))})`, who);
      if (r.error) {
        storageLog.push({ name, who, ok: false, why: /row-level security/.test(r.error) ? 'rls' : r.error });
        return json(400, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
      }
      fs.mkdirSync(path.dirname(path.join(STORE, name)), { recursive: true });
      fs.writeFileSync(path.join(STORE, name), bytes);
      storageLog.push({ name, who, ok: true, size: bytes.length, type });
      return json(200, { Key: BUCKET.id + '/' + name, Id: crypto.randomUUID() });
    }
    if (u.pathname === '/storage/v1/object/' + BUCKET.id && req.method() === 'DELETE') {
      const { prefixes } = req.postDataJSON();
      const out = sql(`with d as (delete from storage.objects where bucket_id = ${lit(BUCKET.id)} and name = any(${lit('{' + prefixes.map((p) => '"' + p + '"').join(',') + '}')}::text[]) returning name) select coalesce(jsonb_agg(name), '[]') from d`, who);
      const gone = JSON.parse(out.split('\n').filter(Boolean).pop() || '[]');
      gone.forEach((n) => fs.rmSync(path.join(STORE, n), { force: true }));
      return json(200, gone.map((name) => ({ name, bucket_id: BUCKET.id })));
    }
    if (u.pathname === '/storage/v1/object/sign/' + BUCKET.id && req.method() === 'POST') {
      const { paths } = req.postDataJSON();
      return json(200, paths.map((p) => ({ path: p, error: null, signedURL: '/object/sign/' + BUCKET.id + '/' + p + '?token=t' })));
    }
    if (u.pathname.startsWith('/storage/v1/object/sign/' + BUCKET.id + '/')) {
      const name = decodeURIComponent(u.pathname.slice(('/storage/v1/object/sign/' + BUCKET.id + '/').length));
      const stored = path.join(STORE, name);
      if (fs.existsSync(stored)) {
        const type = name.endsWith('.webp') ? 'image/webp' : name.endsWith('.png') ? 'image/png' : 'image/jpeg';
        return route.fulfill({ status: 200, headers: cors, contentType: type, body: fs.readFileSync(stored) });
      }
      return route.fulfill({ status: 200, headers: cors, contentType: 'image/svg+xml', body: fs.readFileSync(path.join(S, 'photos', path.basename(name))) });
    }
    console.log('unhandled', req.method(), u.pathname);
    return route.fulfill({ status: 404, headers: cors, body: '' });
  });
}

function magicLink(u) {
  const t = jwt(u);
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `${SITE}/#access_token=${t}&expires_at=${exp}&expires_in=3600&refresh_token=test-refresh&token_type=bearer&type=magiclink`;
}

async function settle(page) {
  await page.waitForFunction(() => document.body.dataset.auth === 'ready', null, { timeout: 10000 });
  await page.waitForLoadState('networkidle');
}
async function noSideScroll(page, label) {
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  check(w <= 360, `${label}: no sideways scroll (width ${w})`);
}
async function smallTargets(page, label) {
  const bad = await page.evaluate(() => [...document.querySelectorAll('a, button, input, select, textarea')]
    .filter((el) => el.offsetParent !== null && !el.closest('.visually-hidden, .skip-link') && !el.matches('.chip'))
    .filter((el) => !(el.type === 'checkbox' || el.type === 'radio' || el.type === 'file'))
    .map((el) => { const r = el.getBoundingClientRect(); return { t: (el.textContent || el.id || el.tagName).trim().slice(0, 30), w: Math.round(r.width), h: Math.round(r.height), inline: getComputedStyle(el).display === 'inline' }; })
    .filter((r) => !r.inline && (r.h < 44 || r.w < 44)));
  check(bad.length === 0, `${label}: tap targets at least 44 px` + (bad.length ? ' ' + JSON.stringify(bad) : ''));
}
function shooter(dir) {
  fs.mkdirSync(dir, { recursive: true });
  // A full-page shot grows the window to the page's height first, so the
  // fixed bottom bar sits at the bottom as it does on a phone.
  return async (page, name, full = true) => {
    const size = page.viewportSize();
    if (full) {
      await page.evaluate(() => window.scrollTo(0, 0));
      const h = await page.evaluate(() => document.documentElement.scrollHeight);
      if (h > size.height) { await page.setViewportSize({ width: size.width, height: h }); await page.waitForTimeout(100); }
    }
    await page.screenshot({ path: `${dir}/${name}.png` });
    if (full) await page.setViewportSize(size);
  };
}

const PHONE = { viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

module.exports = {
  S, WORK, SITE, SUPA, USERS, SOCIETY, PHONE, STORE,
  jwt, decode, sql, sqlTry, check, failed, wire, magicLink, settle, noSideScroll, smallTargets, shooter,
  otpCalls, storageLog, faults,
};
