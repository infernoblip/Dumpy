// Tests the send-email function's logic with Node, with fake Supabase and
// Resend servers. Run: node tests/functions/send-email.test.mjs
import assert from "node:assert/strict";
import { buildEmail, makeHandler } from "../../supabase/functions/send-email/handler.js";

const ID = "7e590000-0000-4000-8000-0000000000ff";
const LISTING = "7e590000-0000-4000-8000-0000000c0001";
const row = {
  id: ID, kind: "request_new", email: "test.owner@example.com", recipient_name: "Test Owner",
  listing_id: LISTING, title: "Test chair", price_inr: 0,
  actor_name: "Test One", actor_tower: "B", message: "After 6 pm?"
};
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok - " + name); }

// A fake fetch that records calls. claim returns `claim` once, then nothing.
function fake(claim, resendStatus = 200) {
  const calls = [];
  let claimed = false;
  async function f(url, init) {
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url, headers: init.headers, body });
    const res = (status, data) => new Response(data == null ? null : JSON.stringify(data), { status });
    if (url.endsWith("/rpc/claim_notification")) {
      const out = claimed || !claim ? [] : [claim];
      claimed = true;
      return res(200, out);
    }
    if (url.endsWith("/rpc/finish_notification")) return res(204, null);
    if (url === "https://api.resend.com/emails") return res(resendStatus, { id: "x" });
    throw new Error("unexpected " + url);
  }
  return { f, calls };
}
const env = {
  SUPABASE_URL: "https://demo.supabase.co",
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: "sb_secret_test" }),
  RESEND_API_KEY: "re_test",
  EMAIL_FROM: "Dumpy <test@example.com>"
};
const post = (body) => new Request("https://x/send-email", { method: "POST", body: JSON.stringify(body) });

await test("each kind has a subject and exactly one link, to the item", async () => {
  for (const kind of ["request_new", "request_accepted", "request_declined", "delivery_claimed", "delivered"]) {
    const m = buildEmail({ ...row, kind }, "https://site.example/");
    assert.ok(m.subject.length > 5, kind);
    const links = m.text.match(/https?:\/\/\S+/g);
    assert.deepEqual(links, ["https://site.example/pages/item.html?id=" + LISTING], kind);
  }
});

await test("new-request email names the requester and quotes the message", async () => {
  const m = buildEmail(row);
  assert.equal(m.subject, "Test One asked for your Test chair");
  assert.match(m.text, /Test One \(Tower B\) would like your Test chair/);
  assert.match(m.text, /"After 6 pm\?"/);
  assert.match(m.text, /dumpy\.infernicustrap\.workers\.dev/);
});

await test("a title with line breaks can't add lines to the subject", async () => {
  const m = buildEmail({ ...row, title: "Chair\r\nBcc: someone@example.com" });
  assert.ok(!/[\r\n]/.test(m.subject));
});

await test("unknown kinds build nothing", async () => {
  assert.equal(buildEmail({ ...row, kind: "nope" }), null);
});

await test("sends one email through Resend and records it as sent", async () => {
  const { f, calls } = fake(row);
  const res = await makeHandler({ env, fetch: f })(post({ id: ID }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { sent: true });
  const sends = calls.filter((c) => c.url.includes("resend"));
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].body.to, ["test.owner@example.com"]);
  assert.equal(sends[0].body.from, "Dumpy <test@example.com>");
  const claim = calls.find((c) => c.url.endsWith("claim_notification"));
  assert.equal(claim.headers.apikey, "sb_secret_test");
  assert.equal(claim.headers.Authorization, undefined, "new secret keys must not be sent as Bearer");
  const fin = calls.find((c) => c.url.endsWith("finish_notification"));
  assert.deepEqual(fin.body, { p_id: ID, p_error: null });
});

await test("a second call for the same notification sends nothing", async () => {
  const { f, calls } = fake(row);
  const h = makeHandler({ env, fetch: f });
  await h(post({ id: ID }));
  const res = await h(post({ id: ID }));
  assert.deepEqual(await res.json(), { sent: false });
  assert.equal(calls.filter((c) => c.url.includes("resend")).length, 1);
});

await test("nothing to claim (emails off, or already sent) sends nothing", async () => {
  const { f, calls } = fake(null);
  const res = await makeHandler({ env, fetch: f })(post({ id: ID }));
  assert.deepEqual(await res.json(), { sent: false });
  assert.equal(calls.length, 1);
});

await test("a Resend error is recorded as failed", async () => {
  const { f, calls } = fake(row, 422);
  const res = await makeHandler({ env, fetch: f })(post({ id: ID }));
  const out = await res.json();
  assert.equal(out.sent, false);
  const fin = calls.find((c) => c.url.endsWith("finish_notification"));
  assert.match(fin.body.p_error, /^Resend 422/);
});

await test("uses SMTP when there is no Resend key", async () => {
  const { f, calls } = fake(row);
  const sent = [];
  const smtpEnv = { ...env, RESEND_API_KEY: "", SMTP_HOST: "smtp.example.com" };
  await makeHandler({ env: smtpEnv, fetch: f, smtpSend: async (e, to, mail) => sent.push({ to, mail }) })(post({ id: ID }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "test.owner@example.com");
  assert.equal(calls.filter((c) => c.url.includes("resend")).length, 0);
});

await test("legacy service_role keys are also sent as a Bearer token", async () => {
  const { f, calls } = fake(null);
  const legacy = { ...env, SUPABASE_SECRET_KEYS: "", SUPABASE_SERVICE_ROLE_KEY: "eyJlegacy" };
  await makeHandler({ env: legacy, fetch: f })(post({ id: ID }));
  assert.equal(calls[0].headers.Authorization, "Bearer eyJlegacy");
});

await test("bad input is refused without touching the database", async () => {
  const { f, calls } = fake(row);
  const h = makeHandler({ env, fetch: f });
  assert.equal((await h(post({ id: "1; drop table" }))).status, 400);
  assert.equal((await h(new Request("https://x/", { method: "GET" }))).status, 405);
  assert.equal(calls.length, 0);
});

console.log(passed + " send-email tests passed");
