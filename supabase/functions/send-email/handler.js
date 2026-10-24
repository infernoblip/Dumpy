// The send-email Edge Function's logic, kept free of Deno-only APIs so it can
// be tested with Node (tests/functions/send-email.test.mjs).
//
// The database calls this function with {"id": "<notification id>"} after a
// request or delivery changes (see supabase/migrations/*_notifications.sql).
// The function:
//   1. claims that notification with claim_notification(id): it succeeds only
//      once per notification, and only while the person still wants emails
//   2. writes a short plain-text email with one link back to the item
//   3. sends it through Resend, or through SMTP (for example Gmail) if no
//      Resend key is set
//   4. records the result with finish_notification(id, error)
//
// Settings (Supabase > Edge Functions > Secrets):
//   RESEND_API_KEY   Resend API key (preferred)
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS   used when there is no Resend key
//   EMAIL_FROM       sender, e.g. "Dumpy <notify@dumpyscrappingapp.in>"
//   SITE_URL         website address (default https://dumpy.infernicustrap.workers.dev)
// SUPABASE_URL and the secret key are provided by Supabase automatically.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_SITE = "https://dumpy.infernicustrap.workers.dev";

// "B" -> "Tower B"; leaves "Tower B" or "Wing 2" as typed (same as js/render.js).
function tower(t) {
  t = String(t || "").trim();
  return !t || /^(tower|wing|block|building)\b/i.test(t) ? t : "Tower " + t;
}

// One line, no control characters, not too long: safe for a subject line.
function line(s, max) {
  s = String(s || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// Builds { subject, text } for a claimed notification row.
export function buildEmail(n, siteUrl) {
  const site = String(siteUrl || DEFAULT_SITE).replace(/\/+$/, "");
  const link = site + "/pages/item.html?id=" + encodeURIComponent(n.listing_id);
  const title = line(n.title, 80) || "your item";
  const who = line(n.actor_name, 60) || "A neighbour";
  const where = tower(line(n.actor_tower, 40));
  const whoFull = where ? who + " (" + where + ")" : who;
  const hi = "Hi " + (line(n.recipient_name, 60) || "there") + ",";

  let subject, body;
  switch (n.kind) {
    case "request_new": {
      subject = who + " asked for your " + title;
      const msg = line(n.message, 300);
      body = whoFull + " would like your " + title + "." +
        (msg ? '\n\nTheir message: "' + msg + '"' : "") +
        "\n\nChoose who gets it:\n" + link;
      break;
    }
    case "request_accepted":
      subject = who + " picked you for " + title;
      body = "Good news: " + whoFull + " picked you for " + title + "." +
        "\n\nTheir flat and phone are on the item page. Message them to arrange the handover:\n" + link;
      break;
    case "request_declined":
      subject = title + " went to someone else";
      body = "The owner of " + title + " picked another neighbour this time. Your request is closed." +
        "\n\nThe item:\n" + link;
      break;
    case "delivery_claimed":
      subject = "A helper will deliver " + title;
      body = whoFull + " will deliver " + title + ". You can see the time slot on the item page:\n" + link;
      break;
    case "delivered":
      subject = title + " was delivered";
      body = title + " has been delivered. Thank you for passing things on in your society." +
        "\n\nThe item:\n" + link;
      break;
    default:
      return null;
  }

  const text = hi + "\n\n" + body +
    "\n\n- Dumpy\n\nYou get these emails because email updates are on in your Dumpy profile. You can turn them off there.";
  return { subject: line(subject, 120), text };
}

// The service key, sent the way each kind of key needs: new secret keys
// (sb_secret_...) only as apikey, legacy JWT keys also as a Bearer token.
function serviceHeaders(env) {
  let key = null;
  try {
    const keys = JSON.parse(env.SUPABASE_SECRET_KEYS || "{}");
    key = keys.default || Object.values(keys)[0] || null;
  } catch (_) { key = null; }
  key = key || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("No Supabase secret key in the environment");
  const h = { apikey: key, "Content-Type": "application/json" };
  if (!key.startsWith("sb_")) h.Authorization = "Bearer " + key;
  return h;
}

async function rpc(env, fetchFn, name, args) {
  const res = await fetchFn(env.SUPABASE_URL.replace(/\/+$/, "") + "/rest/v1/rpc/" + name, {
    method: "POST",
    headers: serviceHeaders(env),
    body: JSON.stringify(args)
  });
  if (!res.ok) throw new Error(name + " failed: " + res.status + " " + (await res.text()).slice(0, 200));
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

async function sendResend(env, fetchFn, to, mail) {
  const res = await fetchFn("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.EMAIL_FROM || "Dumpy <onboarding@resend.dev>",
      to: [to],
      subject: mail.subject,
      text: mail.text
    })
  });
  if (!res.ok) throw new Error("Resend " + res.status + ": " + (await res.text()).slice(0, 300));
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// deps: { env, fetch, smtpSend(env, to, mail) }
export function makeHandler(deps) {
  const env = deps.env;
  const fetchFn = deps.fetch;

  return async function handle(req) {
    if (req.method !== "POST") return json(405, { error: "POST only" });
    let id;
    try { id = (await req.json()).id; } catch (_) { id = null; }
    if (!UUID.test(String(id || ""))) return json(400, { error: "Send {\"id\": \"<notification id>\"}" });

    const rows = await rpc(env, fetchFn, "claim_notification", { p_id: id });
    const n = rows && rows[0];
    // Already sent, turned off, or not a real notification: nothing to do.
    if (!n) return json(200, { sent: false });

    let error = null;
    try {
      const mail = buildEmail(n, env.SITE_URL);
      if (!mail) throw new Error("Unknown kind " + n.kind);
      if (!n.email) throw new Error("No email address");
      if (env.RESEND_API_KEY) await sendResend(env, fetchFn, n.email, mail);
      else if (env.SMTP_HOST) await deps.smtpSend(env, n.email, mail);
      else throw new Error("No email provider set (RESEND_API_KEY or SMTP_HOST)");
    } catch (e) {
      error = String((e && e.message) || e).slice(0, 500);
    }
    await rpc(env, fetchFn, "finish_notification", { p_id: id, p_error: error });
    return json(200, error ? { sent: false, error } : { sent: true });
  };
}
