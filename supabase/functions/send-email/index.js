// send-email Edge Function. The logic lives in handler.js; this file only
// connects it to Deno and to SMTP. See docs/stage-9-setup.md.
import { makeHandler } from "./handler.js";

// SMTP (for example Gmail with an app password, port 465). Supabase blocks
// outgoing ports 25 and 587, so use 465. Loaded only when SMTP is used.
async function smtpSend(env, to, mail) {
  const { SMTPClient } = await import("https://deno.land/x/denomailer@1.6.0/mod.ts");
  const client = new SMTPClient({
    connection: {
      hostname: env.SMTP_HOST,
      port: Number(env.SMTP_PORT || 465),
      tls: true,
      auth: { username: env.SMTP_USER, password: env.SMTP_PASS }
    }
  });
  try {
    await client.send({
      from: env.EMAIL_FROM || env.SMTP_USER,
      to,
      subject: mail.subject,
      content: mail.text
    });
  } finally {
    await client.close();
  }
}

Deno.serve(makeHandler({
  env: Deno.env.toObject(),
  fetch: (url, init) => fetch(url, init),
  smtpSend
}));
